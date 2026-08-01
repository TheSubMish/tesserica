//! Batch conversion (`docs/06-workflows.md` W5) and its CLI headless
//! companion (`src-tauri/src/cli.rs`).
//!
//! **Runs entirely in Rust.** The frontend sends a folder path and the same
//! `ConvertSettings` the interactive converter already uses
//! (`pipeline::settings::ConvertSettings`) — no parallel settings type. Rust
//! enumerates the folder, converts every file through the existing
//! `pipeline::convert::convert` in parallel via `rayon`, and writes PNGs to
//! the output folder. Progress streams back over a Tauri **Channel**
//! (`docs/02-architecture.md` §6.2, D13) as the batch runs — never
//! accumulated and returned only at the end — because that is this project's
//! own established, benchmarked reason for Rust→frontend bulk/streaming data.
//!
//! **Cancellation** is cooperative: `cancel_batch_convert` flips an
//! `AtomicBool` a separate command can reach while `batch_convert` is still
//! running (mirrors `commands::source::Sources`' handle-table shape), and the
//! per-file rayon closure checks it before starting each file. Already
//! in-flight files still finish; no new ones start.
//!
//! A per-file failure (unreadable/corrupt/unsupported image) is reported as a
//! `FileFailed` event and does not stop the rest of the batch — the folder is
//! not pre-filtered by extension, so a stray non-image file sitting in the
//! source folder is exactly this case, not a special one.
//!
//! **`backgroundRemoval.method: 'ml'` degrades to flood-fill here.** ML
//! segmentation needs the app-managed `Mutex<Segmenter>`
//! (`commands::segment::ensure_loaded`), which only `commands::source::
//! export_conversion` is wired to reach; this module calls
//! `pipeline::convert::convert` directly, and `convert`'s own flood-fill stage
//! does not branch on `method` at all, so a batch or CLI (`cli.rs`) run
//! requesting ML background removal silently gets flood-fill instead —
//! honestly documented here as unwired rather than pretended-away. Wiring the
//! interactive single-image export path (the concrete `[ Edit → ]`/export
//! product surface) came first; extending the same orchestration to this
//! `rayon`-parallel path is tracked as follow-up work.

use std::collections::HashMap;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::export::{scale_nearest, ALLOWED_SCALES};
use crate::error::AppError;
use crate::pipeline::buffer::PixelBuffer;
use crate::pipeline::convert::convert;
use crate::pipeline::quantize::TRANSPARENT_INDEX;
use crate::pipeline::settings::{target_size_for_pixel_size, ConvertSettings};

/// In-flight batch jobs' cancellation flags. A job is registered right before
/// its rayon pass starts and removed once that pass returns, so a stale job id
/// simply has nothing to cancel rather than erroring.
#[derive(Default)]
pub struct BatchJobs {
    next: AtomicU64,
    flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl BatchJobs {
    fn start(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.flags
            .lock()
            .expect("batch jobs poisoned")
            .insert(id, flag.clone());
        (id, flag)
    }

    fn finish(&self, id: u64) {
        self.flags.lock().expect("batch jobs poisoned").remove(&id);
    }
}

#[tauri::command]
pub fn cancel_batch_convert(job_id: u64, jobs: State<'_, BatchJobs>) {
    if let Some(flag) = jobs.flags.lock().expect("batch jobs poisoned").get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConvertRequest {
    pub folder: String,
    pub out_folder: String,
    /// Drives `target_width`/`target_height` **per file** (`docs/04` §3.2):
    /// each source image has its own dimensions, unlike the single fixed
    /// source a `ConvertSettings.targetWidth`/`targetHeight` pair normally
    /// describes, so this is resolved against every file individually rather
    /// than taken from `settings` directly.
    pub pixel_size: f64,
    /// Every other stage of the pipeline (palette, dither, adjustments,
    /// background removal, cleanup…), applied identically to each file.
    /// `target_width`/`target_height` on this struct are overwritten per file
    /// and therefore ignored on input.
    pub settings: ConvertSettings,
    /// 1 / 2 / 4 / 8, same convention as every other export path.
    pub scale: u32,
}

// `rename_all` at the enum level only renames the variant tags themselves
// (`Started` -> `"started"`); it does not cascade into a struct variant's own
// fields, so each variant repeats `rename_all = "camelCase"` for its fields —
// confirmed by round-tripping the wire shape in `tests::event_fields_are_camel_case_on_the_wire`
// below rather than assumed.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchConvertEvent {
    #[serde(rename_all = "camelCase")]
    Started { job_id: u64, total: usize },
    #[serde(rename_all = "camelCase")]
    FileStarted { index: usize, file: String },
    #[serde(rename_all = "camelCase")]
    FileSucceeded {
        index: usize,
        file: String,
        output_path: String,
        width: u32,
        height: u32,
        colors_used: u32,
    },
    #[serde(rename_all = "camelCase")]
    FileFailed {
        index: usize,
        file: String,
        error: String,
    },
    #[serde(rename_all = "camelCase")]
    Finished {
        succeeded: usize,
        failed: usize,
        cancelled: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConvertSummary {
    pub job_id: u64,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: bool,
}

/// Every regular file directly inside `folder`, sorted for deterministic
/// per-file progress indices. Not recursive — W5 describes "a folder of
/// source images", not a tree. Nothing here filters by extension: a file
/// `image::open` cannot decode surfaces later as a per-file `FileFailed`,
/// which is the more honest place for that to be reported.
fn enumerate_files(folder: &str) -> Result<Vec<PathBuf>, AppError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    Ok(files)
}

/// Convert one file and write its PNG. Returns the output path, the written
/// (post-scale) dimensions, and the number of distinct palette entries used.
fn convert_one(
    path: &Path,
    out_folder: &Path,
    settings: &ConvertSettings,
    pixel_size: f64,
    scale: u32,
) -> Result<(String, u32, u32, u32), String> {
    let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
    let (sw, sh) = (decoded.width(), decoded.height());
    let source = PixelBuffer::from_data(sw, sh, decoded.into_raw())?;

    let (tw, th) = target_size_for_pixel_size(sw, sh, pixel_size)?;
    let mut file_settings = settings.clone();
    file_settings.target_width = tw;
    file_settings.target_height = th;

    let result = convert(&source, &file_settings)?;
    let (width, height) = (result.image.width, result.image.height);
    let scaled =
        scale_nearest(&result.image.data, width, height, scale).map_err(|e| e.to_string())?;
    let scaled_width = width * scale;
    let scaled_height = height * scale;

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let output_path = out_folder.join(format!("{stem}.png"));

    let file = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(file);
    image::write_buffer_with_format(
        &mut writer,
        &scaled,
        scaled_width,
        scaled_height,
        image::ExtendedColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|e| e.to_string())?;
    drop(writer);

    let mut used = std::collections::HashSet::new();
    for &i in &result.indices {
        if i != TRANSPARENT_INDEX {
            used.insert(i);
        }
    }

    Ok((
        output_path.to_string_lossy().into_owned(),
        scaled_width,
        scaled_height,
        used.len() as u32,
    ))
}

/// The parallel pass over every file, `rayon` across files as W5 requires.
/// Public (not `pub(crate)`) so the CLI headless mode (`cli.rs`) can drive it
/// directly without a Tauri `Channel`/`State` in scope.
pub fn run_batch(
    files: &[PathBuf],
    out_folder: &Path,
    settings: &ConvertSettings,
    pixel_size: f64,
    scale: u32,
    flag: &AtomicBool,
    mut on_event: impl FnMut(BatchConvertEvent) + Send,
) -> (usize, usize, bool) {
    let succeeded = AtomicU64::new(0);
    let failed = AtomicU64::new(0);
    let emit = Mutex::new(&mut on_event);

    files.par_iter().enumerate().for_each(|(index, path)| {
        if flag.load(Ordering::Relaxed) {
            return;
        }
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());

        (emit.lock().expect("emit poisoned"))(BatchConvertEvent::FileStarted {
            index,
            file: file.clone(),
        });

        match convert_one(path, out_folder, settings, pixel_size, scale) {
            Ok((output_path, width, height, colors_used)) => {
                succeeded.fetch_add(1, Ordering::Relaxed);
                (emit.lock().expect("emit poisoned"))(BatchConvertEvent::FileSucceeded {
                    index,
                    file,
                    output_path,
                    width,
                    height,
                    colors_used,
                });
            }
            Err(error) => {
                failed.fetch_add(1, Ordering::Relaxed);
                (emit.lock().expect("emit poisoned"))(BatchConvertEvent::FileFailed {
                    index,
                    file,
                    error,
                });
            }
        }
    });

    let cancelled = flag.load(Ordering::Relaxed);
    (
        succeeded.load(Ordering::Relaxed) as usize,
        failed.load(Ordering::Relaxed) as usize,
        cancelled,
    )
}

/// Batch-convert every image in `request.folder` into `request.outFolder`,
/// streaming per-file progress over `progress` and supporting cancellation
/// via `cancel_batch_convert(jobId)`.
///
/// CPU-bound rayon work runs inside `spawn_blocking`, per `docs/02-architecture.md`
/// §8 ("Tauri async commands must not block the main thread — long jobs go
/// through `spawn_blocking`"), so `cancel_batch_convert` is always reachable
/// while a batch is running rather than queued behind it.
#[tauri::command]
pub async fn batch_convert(
    request: BatchConvertRequest,
    progress: Channel<BatchConvertEvent>,
    jobs: State<'_, BatchJobs>,
) -> Result<BatchConvertSummary, AppError> {
    if !ALLOWED_SCALES.contains(&request.scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {}",
            request.scale
        )));
    }
    if request.pixel_size.is_nan() || request.pixel_size <= 0.0 {
        return Err(AppError::invalid(format!(
            "pixelSize must be > 0, got {}",
            request.pixel_size
        )));
    }

    let files = enumerate_files(&request.folder)?;
    std::fs::create_dir_all(&request.out_folder)?;

    let (job_id, flag) = jobs.start();
    let total = files.len();
    let _ = progress.send(BatchConvertEvent::Started { job_id, total });

    let out_folder = PathBuf::from(&request.out_folder);
    let settings = request.settings.clone();
    let pixel_size = request.pixel_size;
    let scale = request.scale;
    let progress_for_task = progress.clone();
    let flag_for_task = flag.clone();

    let (succeeded, failed, cancelled) = tauri::async_runtime::spawn_blocking(move || {
        run_batch(
            &files,
            &out_folder,
            &settings,
            pixel_size,
            scale,
            &flag_for_task,
            move |event| {
                let _ = progress_for_task.send(event);
            },
        )
    })
    .await
    .map_err(|e| AppError::invalid(format!("batch conversion task panicked: {e}")))?;

    jobs.finish(job_id);
    let _ = progress.send(BatchConvertEvent::Finished {
        succeeded,
        failed,
        cancelled,
    });

    Ok(BatchConvertSummary {
        job_id,
        total,
        succeeded,
        failed,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::settings::{ConvertSettings, PaletteSpec};

    fn two_colors() -> PaletteSpec {
        PaletteSpec::Fixed {
            colors: vec![[0, 0, 0, 255], [255, 255, 255, 255]],
        }
    }

    fn write_png(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            data.extend_from_slice(&color);
        }
        image::save_buffer(path, &data, width, height, image::ColorType::Rgba8).unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tess-batch-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn request_deserializes_the_frontends_camelcase_wire_shape() {
        let json = r#"{
            "folder": "/tmp/in",
            "outFolder": "/tmp/out",
            "pixelSize": 8,
            "settings": {
                "fitToSubject": false,
                "brightness": 0,
                "contrast": 0,
                "saturation": 0,
                "hueShift": 0,
                "targetWidth": 1,
                "targetHeight": 1,
                "downscaleMode": "box",
                "palette": { "kind": "auto", "maxColors": 16 },
                "dither": "none",
                "ditherStrength": 1,
                "colorSpace": "oklab",
                "despeckle": 0,
                "alphaThreshold": 128,
                "preserveAlpha": false
            },
            "scale": 2
        }"#;
        let request: BatchConvertRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.folder, "/tmp/in");
        assert_eq!(request.out_folder, "/tmp/out");
        assert_eq!(request.pixel_size, 8.0);
        assert_eq!(request.scale, 2);
    }

    #[test]
    fn enumerate_files_lists_regular_files_only_and_sorted() {
        let dir = temp_dir("enumerate");
        std::fs::write(dir.join("b.png"), b"x").unwrap();
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        std::fs::create_dir(dir.join("subdir")).unwrap();

        let files = enumerate_files(dir.to_str().unwrap()).unwrap();
        let names: Vec<_> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.png", "b.png"]);
    }

    #[test]
    fn a_mixed_batch_reports_success_and_failure_per_file_not_fatally() {
        let src = temp_dir("mixed-src");
        let out = temp_dir("mixed-out");
        write_png(&src.join("good.png"), 4, 4, [255, 0, 0, 255]);
        std::fs::write(src.join("not_an_image.txt"), b"hello").unwrap();

        let settings = ConvertSettings::new(2, 2, two_colors());
        let files = enumerate_files(src.to_str().unwrap()).unwrap();
        assert_eq!(files.len(), 2);

        let flag = AtomicBool::new(false);
        let events: Mutex<Vec<BatchConvertEvent>> = Mutex::new(Vec::new());
        let (succeeded, failed, cancelled) =
            run_batch(&files, &out, &settings, 2.0, 1, &flag, |e| {
                events.lock().unwrap().push(e);
            });

        assert_eq!(succeeded, 1);
        assert_eq!(failed, 1);
        assert!(!cancelled);
        assert!(out.join("good.png").exists());

        let events = events.into_inner().unwrap();
        assert!(events.iter().any(
            |e| matches!(e, BatchConvertEvent::FileSucceeded { file, .. } if file == "good.png")
        ));
        assert!(events
            .iter()
            .any(|e| matches!(e, BatchConvertEvent::FileFailed { file, .. } if file == "not_an_image.txt")));
    }

    #[test]
    fn output_pngs_decode_back_to_the_expected_converted_pixels() {
        let src = temp_dir("decode-src");
        let out = temp_dir("decode-out");
        // A solid white 8x8 source, converted down to 2x2 against a two-colour
        // (black/white) palette at 1x scale: every output pixel must land on
        // the white palette entry, decoded back from the real file on disk —
        // not just asserted against the in-memory result.
        write_png(&src.join("white.png"), 8, 8, [255, 255, 255, 255]);

        let mut settings = ConvertSettings::new(2, 2, two_colors());
        settings.downscale_mode = crate::pipeline::settings::DownscaleMode::Nearest;

        let files = enumerate_files(src.to_str().unwrap()).unwrap();
        let flag = AtomicBool::new(false);
        let (succeeded, failed, _) = run_batch(&files, &out, &settings, 4.0, 1, &flag, |_| {});
        assert_eq!(succeeded, 1);
        assert_eq!(failed, 0);

        let decoded = image::open(out.join("white.png")).unwrap().to_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (2, 2));
        for px in decoded.pixels() {
            assert_eq!(px.0, [255, 255, 255, 255]);
        }
    }

    #[test]
    fn cancellation_stops_further_files_from_being_processed() {
        let src = temp_dir("cancel-src");
        let out = temp_dir("cancel-out");
        for i in 0..8 {
            write_png(&src.join(format!("{i}.png")), 4, 4, [10, 20, 30, 255]);
        }

        let settings = ConvertSettings::new(2, 2, two_colors());
        let files = enumerate_files(src.to_str().unwrap()).unwrap();
        assert_eq!(files.len(), 8);

        // Cancel before the batch ever starts: a cooperative flag checked
        // before each file must mean *zero* files are processed, not "however
        // many happened to start first" — the strongest, least flaky way to
        // prove the flag is actually honoured rather than ignored.
        let flag = AtomicBool::new(true);
        let (succeeded, failed, cancelled) =
            run_batch(&files, &out, &settings, 2.0, 1, &flag, |_| {});

        assert_eq!(succeeded, 0);
        assert_eq!(failed, 0);
        assert!(cancelled);
        assert!(std::fs::read_dir(&out).unwrap().next().is_none());
    }

    #[test]
    fn export_settings_target_dimensions_are_overwritten_per_file_from_pixel_size() {
        let src = temp_dir("pixelsize-src");
        let out = temp_dir("pixelsize-out");
        // 16x8 at pixel_size 4 must produce a 4x2 output, regardless of
        // whatever target_width/target_height the caller's settings carried
        // in (here deliberately wrong, 99x99) — proving they are overwritten
        // per file rather than trusted from the request.
        write_png(&src.join("wide.png"), 16, 8, [0, 0, 0, 255]);

        let mut settings = ConvertSettings::new(99, 99, two_colors());
        settings.downscale_mode = crate::pipeline::settings::DownscaleMode::Nearest;

        let files = enumerate_files(src.to_str().unwrap()).unwrap();
        let flag = AtomicBool::new(false);
        run_batch(&files, &out, &settings, 4.0, 1, &flag, |_| {});

        let decoded = image::open(out.join("wide.png")).unwrap().to_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (4, 2));
    }

    #[test]
    fn cancel_batch_convert_flips_the_registered_flag() {
        let jobs = BatchJobs::default();
        let (id, flag) = jobs.start();
        assert!(!flag.load(Ordering::Relaxed));

        // Exercise the actual command function body via its State-taking
        // form is awkward outside a running app, so this calls the same
        // registry directly, the way `commands::source`'s own unit tests
        // test handle-table behaviour without a Tauri runtime.
        if let Some(f) = jobs.flags.lock().unwrap().get(&id) {
            f.store(true, Ordering::Relaxed);
        }
        assert!(flag.load(Ordering::Relaxed));

        jobs.finish(id);
        assert!(jobs.flags.lock().unwrap().get(&id).is_none());
    }

    /// `rename_all` at the enum level only renames the variant tags
    /// themselves; without a per-variant `rename_all` too, `job_id` etc. would
    /// serialize as snake_case even though `"kind"` reads `"started"` —
    /// exactly the kind of quiet mismatch the frontend would only discover at
    /// runtime. Asserted directly against the real wire bytes, not inferred.
    #[test]
    fn event_fields_are_camel_case_on_the_wire() {
        let started = serde_json::to_string(&BatchConvertEvent::Started {
            job_id: 1,
            total: 2,
        })
        .unwrap();
        assert_eq!(started, r#"{"kind":"started","jobId":1,"total":2}"#);

        let succeeded = serde_json::to_string(&BatchConvertEvent::FileSucceeded {
            index: 0,
            file: "a.png".into(),
            output_path: "/tmp/a.png".into(),
            width: 1,
            height: 1,
            colors_used: 1,
        })
        .unwrap();
        assert_eq!(
            succeeded,
            r#"{"kind":"fileSucceeded","index":0,"file":"a.png","outputPath":"/tmp/a.png","width":1,"height":1,"colorsUsed":1}"#
        );

        let finished = serde_json::to_string(&BatchConvertEvent::Finished {
            succeeded: 3,
            failed: 1,
            cancelled: false,
        })
        .unwrap();
        assert_eq!(
            finished,
            r#"{"kind":"finished","succeeded":3,"failed":1,"cancelled":false}"#
        );
    }
}
