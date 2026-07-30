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
//! **Pipeline integration is out of scope for this dispatch.** Nothing here
//! wires a downloaded model into `segment::Segmenter` or the background-
//! removal pipeline; that is later Phase 5 work. This module's contract ends
//! at "the file is on disk and its checksum is verified."

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

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
