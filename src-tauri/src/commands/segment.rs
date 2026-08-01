//! On-demand runtime download of a larger segmentation model, gated on
//! explicit user consent (`docs/08-roadmap.md` Phase 5 "on-demand download
//! for larger models with explicit consent", `docs/04-image-pipeline.md`
//! §8.1, `CLAUDE.md` "No network calls in the core").
//!
//! Unlike the bundled `u2netp` (fetched at **build time** by `npm run
//! models:fetch`, `segment::bundled_model_path`), this crosses the boundary
//! at **runtime**, only after a user clicks "Download larger model" in
//! Convert mode's Background section and confirms a dialog that states the
//! size and source first (`src/segment/modelDownload.ts`).
//!
//! **Rust makes no network call of its own here.** The actual HTTP fetch
//! happens in the frontend with a plain `fetch()` — the WebView already has
//! full network access and this app's CSP is unset — because that is the
//! one piece that is genuinely "network activity" and the thing consent has
//! to gate. This module's job starts *after* that: receive the
//! already-downloaded bytes over the same raw-invoke-body transport
//! `crate::staging` uses for editor layers (`docs/02-architecture.md` §6.2,
//! D13) — never a JSON command argument, which would be even more
//! inappropriate here than for a pixel buffer given this file is ~170 MB —
//! verify their checksum against the one the source itself publishes, and
//! write them to the OS app-data directory.
//!
//! **Pipeline integration**: [`segmentation_availability`] and
//! [`ensure_loaded`] are the piece that actually wires a model into
//! `segment::Segmenter` — checking whether both a model (bundled `u2netp`,
//! preferred, or a downloaded larger one) and the ONNX Runtime library
//! (`commands::onnx_runtime`) are present on disk, and loading them into the
//! app-wide `Mutex<Segmenter>` (`lib.rs`) if so. `commands::source::
//! export_conversion` calls [`ensure_loaded`] before running ML background
//! removal; `segmentation_availability` is the same check exposed to the
//! frontend so Convert mode's UI can show/hide the ML option honestly rather
//! than offering something that will silently fall back.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::segment::Segmenter;

/// The one larger model this dispatch offers as an on-demand download.
/// `docs/04-image-pipeline.md` §8.1 lists it as "Best general quality —
/// recommended default" among the models not bundled by default.
///
/// Sourced from the same `rembg` GitHub Releases used for `u2netp`
/// (`rembg/rembg/sessions/dis_general_use.py`, whose `name()` classmethod
/// returns `"isnet-general-use"` — checked 2026-07-30, the file itself is
/// named `isnet-general-use.onnx` in that release). Its weights are the DIS
/// (Dichotomous Image Segmentation) project's, `xuebinqin/DIS`, which is
/// Apache-2.0 licensed on GitHub — re-verified the same way `u2netp`'s
/// license was before offering it.
pub const LARGER_MODEL_ID: &str = "isnet-general-use";
const LARGER_MODEL_FILENAME: &str = "isnet-general-use.onnx";
const LARGER_MODEL_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx";
/// MD5 `rembg` itself publishes for this exact file (its own `pooch.retrieve`
/// call), verified in this environment against a real download before this
/// was wired up.
const LARGER_MODEL_MD5: &str = "fc16ebd8b0c10d971d3513d564d01e29";
/// Exact `Content-Length` observed from the real release asset (2026-07-30),
/// not a rounded estimate — the confirm dialog can state a real number.
const LARGER_MODEL_APPROX_BYTES: u64 = 178_648_008;
const LARGER_MODEL_LICENSE: &str = "Apache-2.0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationModelInfo {
    pub id: String,
    pub filename: String,
    pub source_url: String,
    pub approx_bytes: u64,
    pub license: String,
}

/// Static metadata for the frontend's confirm dialog.
///
/// Reading this is **not** a network call — it is a plain, always-safe
/// query over data baked into the binary — so it is fine to call whenever
/// the Background section mounts. What must stay gated on explicit consent
/// is [`save_downloaded_segmentation_model`], which only runs after the
/// frontend has both shown this info to the user *and* received an explicit
/// confirmation click.
#[tauri::command]
pub fn segmentation_model_info() -> SegmentationModelInfo {
    SegmentationModelInfo {
        id: LARGER_MODEL_ID.to_string(),
        filename: LARGER_MODEL_FILENAME.to_string(),
        source_url: LARGER_MODEL_URL.to_string(),
        approx_bytes: LARGER_MODEL_APPROX_BYTES,
        license: LARGER_MODEL_LICENSE.to_string(),
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::invalid(format!("could not resolve app data directory: {err}")))?
        .join("models");
    Ok(dir)
}

/// Where the on-demand-downloaded larger model would live if
/// [`save_downloaded_segmentation_model`] has run — a plain path join, not a
/// filesystem check. Used by [`resolve_model_path`] to decide whether ML
/// background removal has anything to load.
fn larger_model_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(models_dir(app)?.join(LARGER_MODEL_FILENAME))
}

/// The model `ensure_loaded`/`segmentation_availability` should try: the
/// on-demand larger model if the user has explicitly downloaded one — the
/// entire point of that download is better quality
/// (`docs/04-image-pipeline.md` §8.1's own "best general quality" note), so
/// once present it should actually be used, not shadowed by the smaller
/// bundled default — else the bundled `u2netp` (the common case for a normal
/// checkout after `npm run models:fetch`), else `None`.
///
/// **Not hot-swapped mid-session.** `ensure_loaded` only calls this when no
/// session is loaded yet; downloading the larger model *after* ML
/// segmentation has already loaded the bundled one does not retroactively
/// switch it — the next app restart picks up the change. Documented here
/// rather than solved, since nothing in this dispatch's scope needs it.
fn resolve_model_path(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
    let larger = larger_model_path(app)?;
    if larger.is_file() {
        return Ok(Some(larger));
    }
    let bundled = crate::segment::bundled_model_path();
    if bundled.is_file() {
        return Ok(Some(bundled));
    }
    Ok(None)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationAvailability {
    pub available: bool,
    /// A human-readable reason ML segmentation is unavailable — `None` iff
    /// `available` is `true`. Convert mode's UI shows this next to a
    /// disabled option rather than just hiding it silently.
    pub reason: Option<String>,
}

/// Whether ML background removal can actually run right now: is a model on
/// disk (bundled or downloaded), is the ONNX Runtime library on disk
/// (`commands::onnx_runtime`), and does `Segmenter::load` accept them.
///
/// A local filesystem check plus (if both files are present and no session
/// is loaded yet) an attempt to actually load one — never a network call.
/// Safe to call on mount, mirroring `segmentation_model_status`/
/// `onnx_runtime_status`, except this one has the side effect of preloading
/// the session so the first real conversion does not pay that cost.
#[tauri::command]
pub fn segmentation_availability(
    app: AppHandle,
    segmenter: State<'_, Mutex<Segmenter>>,
) -> Result<SegmentationAvailability, AppError> {
    Ok(match ensure_loaded(&app, &segmenter) {
        Ok(()) => SegmentationAvailability {
            available: true,
            reason: None,
        },
        Err(reason) => SegmentationAvailability {
            available: false,
            reason: Some(reason),
        },
    })
}

/// Make sure `segmenter` has a loaded session, loading one from whatever is
/// on disk if it does not yet. Idempotent and cheap once loaded (`Segmenter::
/// is_available` short-circuits). Returns the reason as an `Err(String)`
/// when unavailable, rather than a `SegmentError`/`AppError`, since every
/// caller of this function treats "not available" as a fallback signal, not
/// a fatal error — the same "degrade rather than block" posture
/// `docs/10-decisions.md` D15/D16 already established.
pub(crate) fn ensure_loaded(app: &AppHandle, segmenter: &Mutex<Segmenter>) -> Result<(), String> {
    let mut seg = segmenter.lock().expect("segmenter poisoned");
    if seg.is_available() {
        return Ok(());
    }

    let runtime_lib =
        crate::commands::onnx_runtime::runtime_lib_path(app).map_err(|err| err.to_string())?;
    if !runtime_lib.is_file() {
        return Err(
            "ONNX Runtime library not downloaded — download it in Convert mode's Background \
             section to enable ML segmentation."
                .to_string(),
        );
    }

    let model_path = resolve_model_path(app).map_err(|err| err.to_string())?;
    let Some(model_path) = model_path else {
        return Err(
            "no segmentation model available — the bundled model is missing (run `npm run \
             models:fetch`) and no larger model has been downloaded."
                .to_string(),
        );
    };

    seg.load(&runtime_lib, &model_path)
        .map_err(|err| err.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationModelStatus {
    pub present: bool,
    pub path: String,
}

/// Whether the larger model has already been downloaded. A local filesystem
/// check only — never touches the network — so, like
/// [`segmentation_model_info`], it is safe to call on mount to decide
/// whether the UI should say "Download" or "Already downloaded".
#[tauri::command]
pub fn segmentation_model_status(app: AppHandle) -> Result<SegmentationModelStatus, AppError> {
    let path = models_dir(&app)?.join(LARGER_MODEL_FILENAME);
    Ok(SegmentationModelStatus {
        present: path.is_file(),
        path: path.display().to_string(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSegmentationModel {
    pub path: String,
    pub bytes: usize,
}

/// Accept the raw bytes of an already-downloaded model — fetched by the
/// frontend only after explicit user confirmation — verify their MD5 against
/// the checksum the source publishes, and persist them to the app-data
/// models directory.
///
/// A checksum mismatch is reported as an `AppError` and **nothing is ever
/// written to the final path** in that case, the same "verify before
/// install" discipline `scripts/fetch-model.ts`'s build-time fetch already
/// uses. Overwriting an existing file is fine — a re-download after a
/// previous failed/partial attempt should always win.
#[tauri::command]
pub fn save_downloaded_segmentation_model(
    request: Request<'_>,
    app: AppHandle,
) -> Result<SavedSegmentationModel, AppError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err(AppError::invalid(
                "save_downloaded_segmentation_model expects a raw ArrayBuffer body, not JSON",
            ));
        }
    };

    let dir = models_dir(&app)?;
    verify_and_persist(bytes, LARGER_MODEL_MD5, LARGER_MODEL_FILENAME, &dir)
}

/// The verify-then-write logic, factored out so it can be exercised in a
/// unit test against a real temp directory without needing a live
/// `AppHandle` (`app_data_dir()` only resolves inside a running Tauri app).
/// `expected_md5`/`filename` are parameters (rather than reading the module
/// constants directly) purely so tests can drive the real function with
/// fixture bytes and a matching fixture checksum, instead of needing an
/// actual ~170 MB download to exercise the success path. The
/// `#[tauri::command]` above always calls this with the real constants.
fn verify_and_persist(
    bytes: &[u8],
    expected_md5: &str,
    filename: &str,
    dir: &std::path::Path,
) -> Result<SavedSegmentationModel, AppError> {
    let digest = format!("{:x}", md5::compute(bytes));
    if digest != expected_md5 {
        return Err(AppError::invalid(format!(
            "downloaded model failed checksum verification (got {digest}, expected \
             {expected_md5}) — refusing to install it. Try downloading again."
        )));
    }

    std::fs::create_dir_all(dir)?;
    let path = dir.join(filename);

    // Temp file + rename, so a process killed mid-write never leaves a
    // truncated file at the final path — the same discipline as
    // `scripts/fetch-model.ts`'s build-time fetch.
    let tmp_path = dir.join(format!("{filename}.download"));
    std::fs::write(&tmp_path, bytes)?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(SavedSegmentationModel {
        path: path.display().to_string(),
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segmentation_model_info_matches_the_hardcoded_constants() {
        let info = segmentation_model_info();
        assert_eq!(info.id, LARGER_MODEL_ID);
        assert_eq!(info.filename, LARGER_MODEL_FILENAME);
        assert_eq!(info.source_url, LARGER_MODEL_URL);
        assert_eq!(info.approx_bytes, LARGER_MODEL_APPROX_BYTES);
        assert_eq!(info.license, "Apache-2.0");
    }

    #[test]
    fn checksum_verification_rejects_bytes_that_do_not_match() {
        let digest = format!("{:x}", md5::compute(b"not the real model"));
        assert_ne!(digest, LARGER_MODEL_MD5);
    }

    #[test]
    fn a_known_input_produces_the_expected_md5() {
        // Sanity-checks this module's checksum call against a value anyone
        // can verify independently (`printf 'abc' | md5sum`), so a future
        // refactor of the digest call itself would be caught here rather
        // than only failing on the real 170 MB download.
        let digest = format!("{:x}", md5::compute(b"abc"));
        assert_eq!(digest, "900150983cd24fb0d6963f7d28e17f72");
    }

    /// A manually-run, real end-to-end proof against the actual production
    /// constants — not part of ordinary `cargo test` since it needs a real
    /// ~170 MB file on disk, which this repo never bundles or checks in.
    ///
    /// Point `TESSERICA_TEST_LARGER_MODEL` at a real downloaded copy of
    /// `isnet-general-use.onnx` (in this dispatch, one was fetched via a
    /// real `curl` earlier in the session and independently checksummed
    /// with `md5sum` before this test existed — see the dispatch report) to
    /// confirm the exact code path a real runtime download would take
    /// (`verify_and_persist` with `LARGER_MODEL_MD5`/`LARGER_MODEL_FILENAME`)
    /// succeeds against the real payload, not just a small fixture. Run
    /// with:
    /// `TESSERICA_TEST_LARGER_MODEL=/path/to/isnet-general-use.onnx cargo test commands::segment -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a real ~170 MB isnet-general-use.onnx on disk, never bundled or checked in"]
    fn smoke_test_the_real_larger_model_passes_checksum_and_persists() {
        let path = std::env::var("TESSERICA_TEST_LARGER_MODEL")
            .expect("set TESSERICA_TEST_LARGER_MODEL to a real isnet-general-use.onnx path");
        let bytes = std::fs::read(&path).expect("real model file should be readable");
        assert_eq!(
            bytes.len(),
            LARGER_MODEL_APPROX_BYTES as usize,
            "unexpected file size"
        );

        let dir = TempDir::new("real-larger-model");
        let saved =
            verify_and_persist(&bytes, LARGER_MODEL_MD5, LARGER_MODEL_FILENAME, &dir.0).unwrap();

        assert_eq!(saved.bytes, bytes.len());
        assert_eq!(
            std::fs::read(dir.0.join(LARGER_MODEL_FILENAME)).unwrap(),
            bytes
        );
        println!(
            "verified checksum and persisted {} real bytes from {path} to {:?}",
            saved.bytes, dir.0
        );
    }

    /// A fresh, unique temp directory per test, cleaned up on drop.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tesserica-segment-test-{label}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const FIXTURE_FILENAME: &str = "fixture-model.onnx";

    #[test]
    fn verify_and_persist_rejects_a_checksum_mismatch_and_writes_nothing() {
        let dir = TempDir::new("mismatch");
        let bytes = b"not the expected model bytes";
        let wrong_expected_md5 = "0123456789abcdef0123456789abcdef";

        let err =
            verify_and_persist(bytes, wrong_expected_md5, FIXTURE_FILENAME, &dir.0).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(!dir.0.join(FIXTURE_FILENAME).exists());
    }

    #[test]
    fn verify_and_persist_writes_the_file_when_the_checksum_matches() {
        let dir = TempDir::new("match");
        let bytes = b"real fixture bytes standing in for a model download";
        let expected_md5 = format!("{:x}", md5::compute(bytes));

        let saved = verify_and_persist(bytes, &expected_md5, FIXTURE_FILENAME, &dir.0).unwrap();

        assert_eq!(saved.bytes, bytes.len());
        assert_eq!(std::fs::read(dir.0.join(FIXTURE_FILENAME)).unwrap(), bytes);
        // The temp file used for the atomic rename never lingers behind.
        assert!(!dir.0.join(format!("{FIXTURE_FILENAME}.download")).exists());
    }

    #[test]
    fn verify_and_persist_creates_the_directory_if_it_does_not_exist_yet() {
        let dir = TempDir::new("nested");
        let nested = dir.0.join("a").join("b");
        let bytes = b"nested-dir fixture bytes";
        let expected_md5 = format!("{:x}", md5::compute(bytes));

        verify_and_persist(bytes, &expected_md5, FIXTURE_FILENAME, &nested).unwrap();

        assert_eq!(std::fs::read(nested.join(FIXTURE_FILENAME)).unwrap(), bytes);
    }

    #[test]
    fn verify_and_persist_overwrites_a_previous_download() {
        let dir = TempDir::new("overwrite");
        let old = b"old model bytes";
        let old_md5 = format!("{:x}", md5::compute(old));
        verify_and_persist(old, &old_md5, FIXTURE_FILENAME, &dir.0).unwrap();

        let new = b"new, different model bytes";
        let new_md5 = format!("{:x}", md5::compute(new));
        verify_and_persist(new, &new_md5, FIXTURE_FILENAME, &dir.0).unwrap();

        assert_eq!(std::fs::read(dir.0.join(FIXTURE_FILENAME)).unwrap(), new);
    }
}
