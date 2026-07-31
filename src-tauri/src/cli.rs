//! CLI headless mode (`docs/08-roadmap.md` Phase 7 "Batch conversion + CLI
//! headless mode"). `docs/06-workflows.md` W5 calls this "the natural
//! companion feature" once batch conversion's pipeline exists, modelled on
//! Pixelorama's own CLI (`docs/01-reference-analysis.md` §2).
//!
//! Minimal, hand-rolled argument parsing rather than a CLI-parsing crate —
//! this binary has exactly one headless mode and a handful of flags, the same
//! "small and consistent with existing precedent" bar the existing
//! `TESSERICA_BENCH` env-var mode already set for "this binary can do
//! something other than open a window," just via real argument parsing
//! (an env var cannot carry a folder path and a settings file cleanly).
//!
//! ```text
//! tesserica --batch-convert <folder> --out <folder> [--settings <path.json>]
//!           [--pixel-size <n>] [--scale <1|2|4|8>]
//! ```
//!
//! `--settings` points at a JSON file holding a `ConvertSettings` object in
//! the same camelCase wire shape the interactive app already sends over IPC
//! (`pipeline::settings::ConvertSettings`'s own `Deserialize`) — reused, not
//! reinvented. Omit it for an auto-palette default, useful for a quick
//! one-off conversion with no settings file to hand. `target_width`/
//! `target_height` in that file are ignored either way: `--pixel-size` drives
//! them per file, exactly as `commands::batch_convert` does for the GUI path.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::commands::batch_convert::{run_batch, BatchConvertEvent};
use crate::commands::export::ALLOWED_SCALES;
use crate::pipeline::settings::{ConvertSettings, PaletteSpec};

pub const DEFAULT_PIXEL_SIZE: f64 = 8.0;
pub const DEFAULT_SCALE: u32 = 1;

#[derive(Debug, Clone, PartialEq)]
pub struct CliArgs {
    pub folder: String,
    pub out_folder: Option<String>,
    pub settings_path: Option<String>,
    pub pixel_size: f64,
    pub scale: u32,
}

impl CliArgs {
    /// `None` means no `--batch-convert` flag was present — the ordinary
    /// windowed launch, entirely unaffected by anything in this module.
    /// `Some` is returned as soon as that flag is seen, even with missing or
    /// invalid companions, so `run_headless` (not this function) is the one
    /// place that reports a usage error and picks the process exit code —
    /// `parse` itself never fails, it only decides whether headless mode
    /// applies at all.
    pub fn parse(args: impl Iterator<Item = String>) -> Option<Self> {
        let args: Vec<String> = args.collect();
        let folder = find_value(&args, "--batch-convert")?;

        Some(Self {
            folder,
            out_folder: find_value(&args, "--out"),
            settings_path: find_value(&args, "--settings"),
            pixel_size: find_value(&args, "--pixel-size")
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_PIXEL_SIZE),
            scale: find_value(&args, "--scale")
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_SCALE),
        })
    }
}

fn find_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn load_settings(path: Option<&str>) -> Result<ConvertSettings, String> {
    match path {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("cannot read settings file {path}: {e}"))?;
            serde_json::from_str(&text)
                .map_err(|e| format!("cannot parse settings file {path}: {e}"))
        }
        // target_width/target_height are placeholders — overwritten per file
        // from --pixel-size, exactly as the GUI's own batch_convert command
        // does (`commands::batch_convert::convert_one`).
        None => Ok(ConvertSettings::new(
            1,
            1,
            PaletteSpec::Auto { max_colors: 16 },
        )),
    }
}

/// Run a batch conversion with no GUI at all, reporting per-file progress to
/// stdout and returning a real process exit code: `0` on full success, `1`
/// when at least one file failed, `2` on a usage/setup error (bad flags, an
/// unreadable settings file, an unwritable output folder). `run()` in `lib.rs`
/// calls `std::process::exit` with this value directly — no window is ever
/// created on this path.
pub fn run_headless(args: CliArgs) -> i32 {
    let Some(out_folder) = args.out_folder else {
        eprintln!(
            "usage: tesserica --batch-convert <folder> --out <folder> \
             [--settings <path.json>] [--pixel-size <n>] [--scale <1|2|4|8>]"
        );
        eprintln!("error: --out is required");
        return 2;
    };

    if !ALLOWED_SCALES.contains(&args.scale) {
        eprintln!(
            "error: --scale must be one of {ALLOWED_SCALES:?}, got {}",
            args.scale
        );
        return 2;
    }
    if args.pixel_size.is_nan() || args.pixel_size <= 0.0 {
        eprintln!("error: --pixel-size must be > 0, got {}", args.pixel_size);
        return 2;
    }

    let settings = match load_settings(args.settings_path.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return 2;
        }
    };

    let files: Vec<PathBuf> = match std::fs::read_dir(&args.folder) {
        Ok(entries) => {
            let mut files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();
            files
        }
        Err(e) => {
            eprintln!("error: cannot read folder {}: {e}", args.folder);
            return 2;
        }
    };

    if let Err(e) = std::fs::create_dir_all(&out_folder) {
        eprintln!("error: cannot create output folder {out_folder}: {e}");
        return 2;
    }

    println!(
        "Batch converting {} file(s) from {} into {out_folder}",
        files.len(),
        args.folder
    );

    let flag = AtomicBool::new(false);
    let (succeeded, failed, _cancelled) = run_batch(
        &files,
        Path::new(&out_folder),
        &settings,
        args.pixel_size,
        args.scale,
        &flag,
        |event| match event {
            BatchConvertEvent::FileSucceeded {
                file, output_path, ..
            } => {
                println!("  ok   {file} -> {output_path}");
            }
            BatchConvertEvent::FileFailed { file, error, .. } => {
                println!("  FAIL {file}: {error}");
            }
            _ => {}
        },
    );

    println!(
        "{succeeded} succeeded, {failed} failed, {} total",
        files.len()
    );
    if failed > 0 {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> impl Iterator<Item = String> {
        v.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn no_batch_convert_flag_means_no_cli_mode() {
        assert!(CliArgs::parse(args(&["--tauri-something", "foo"])).is_none());
        assert!(CliArgs::parse(std::iter::empty()).is_none());
    }

    #[test]
    fn batch_convert_flag_parses_every_companion() {
        let parsed = CliArgs::parse(args(&[
            "--batch-convert",
            "/tmp/in",
            "--out",
            "/tmp/out",
            "--settings",
            "/tmp/settings.json",
            "--pixel-size",
            "4",
            "--scale",
            "2",
        ]))
        .unwrap();
        assert_eq!(parsed.folder, "/tmp/in");
        assert_eq!(parsed.out_folder.as_deref(), Some("/tmp/out"));
        assert_eq!(parsed.settings_path.as_deref(), Some("/tmp/settings.json"));
        assert_eq!(parsed.pixel_size, 4.0);
        assert_eq!(parsed.scale, 2);
    }

    #[test]
    fn missing_optional_flags_fall_back_to_defaults() {
        let parsed = CliArgs::parse(args(&["--batch-convert", "/tmp/in"])).unwrap();
        assert_eq!(parsed.out_folder, None);
        assert_eq!(parsed.settings_path, None);
        assert_eq!(parsed.pixel_size, DEFAULT_PIXEL_SIZE);
        assert_eq!(parsed.scale, DEFAULT_SCALE);
    }

    #[test]
    fn missing_out_folder_is_a_usage_error_not_a_panic() {
        let code = run_headless(CliArgs {
            folder: "/does/not/matter".into(),
            out_folder: None,
            settings_path: None,
            pixel_size: DEFAULT_PIXEL_SIZE,
            scale: DEFAULT_SCALE,
        });
        assert_eq!(code, 2);
    }

    #[test]
    fn an_invalid_scale_is_a_usage_error() {
        let dir = std::env::temp_dir().join(format!(
            "tess-cli-test-scale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let code = run_headless(CliArgs {
            folder: dir.to_string_lossy().into_owned(),
            out_folder: Some(dir.join("out").to_string_lossy().into_owned()),
            settings_path: None,
            pixel_size: DEFAULT_PIXEL_SIZE,
            scale: 3,
        });
        assert_eq!(code, 2);
    }

    /// The real end-to-end path: a genuine folder of PNGs on disk, run
    /// through `run_headless` exactly as `lib.rs::run()` would dispatch it
    /// from real `argv`, checking the real exit code and decoding the real
    /// output files it wrote — not just that the function returned.
    #[test]
    fn end_to_end_headless_conversion_writes_real_files_and_exits_zero() {
        let base = std::env::temp_dir().join(format!(
            "tess-cli-e2e-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src = base.join("src");
        let out = base.join("out");
        std::fs::create_dir_all(&src).unwrap();

        let mut data = Vec::new();
        for _ in 0..(6 * 6) {
            data.extend_from_slice(&[10u8, 200, 30, 255]);
        }
        image::save_buffer(src.join("green.png"), &data, 6, 6, image::ColorType::Rgba8).unwrap();

        let settings_path = base.join("settings.json");
        let settings = ConvertSettings::new(
            1,
            1,
            PaletteSpec::Fixed {
                colors: vec![[0, 0, 0, 255], [10, 200, 30, 255]],
            },
        );
        std::fs::write(&settings_path, serde_json::to_string(&settings).unwrap()).unwrap();

        let parsed = CliArgs::parse(
            [
                "--batch-convert",
                src.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
                "--settings",
                settings_path.to_str().unwrap(),
                "--pixel-size",
                "2",
                "--scale",
                "2",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        let code = run_headless(parsed);
        assert_eq!(code, 0, "a clean batch must exit 0");

        let output = out.join("green.png");
        assert!(output.exists());
        let decoded = image::open(&output).unwrap().to_rgba8();
        // 6x6 at pixel-size 2 -> 3x3, times --scale 2 -> 6x6.
        assert_eq!((decoded.width(), decoded.height()), (6, 6));
        for px in decoded.pixels() {
            assert_eq!(px.0, [10, 200, 30, 255]);
        }
    }
}
