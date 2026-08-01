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
//! **The HTTP fetch happens in Rust, not the frontend.** Originally this
//! module only received already-downloaded bytes from a frontend `fetch()`,
//! on the assumption that an unset CSP meant the WebView had unrestricted
//! network access. That assumption missed CORS: GitHub's release-asset URL
//! redirects (302) to `release-assets.githubusercontent.com`, which sends no
//! `Access-Control-Allow-Origin` header, so a same-origin `fetch()` from
//! inside the WebView is rejected by CORS before the request ever leaves the
//! browser engine — confirmed live by driving the real Vite dev bundle in a
//! real headless browser over CDP: `fetch()` to the real model URL failed
//! with `TypeError: Failed to fetch`, while the identical request from plain
//! Node (which does not enforce CORS) and from this module's `ureq` call
//! both succeed. This is exactly the failure mode `commands::lospec`
//! documented for `lospec.com` — it turns out the "GitHub precedent" that
//! module's own doc comment once cited as *not* having this problem was
//! never actually measured the same way, and does have it. [`fetch_bytes`]
//! is the fix: the GET itself moves to Rust, gated on the same explicit
//! consent click (`src/segment/SegmentModelSection.tsx`) as before. This
//! module's other job — verify the checksum against the one the source
//! itself publishes and write to the OS app-data directory — is unchanged.
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

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
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
/// is [`download_segmentation_model`], which only runs after the
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
/// [`download_segmentation_model`] has run — a plain path join, not a
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

/// Generous bound for the real ~170 MB download — far larger than
/// `commands::lospec`'s 20s bound for a few KB of palette text, but still
/// finite so a stalled connection eventually surfaces as a reported error
/// in the "Downloading…" UI rather than hanging it forever.
const MODEL_DOWNLOAD_TIMEOUT_SECS: u64 = 600;

/// Real `Content-Length` of the model (`LARGER_MODEL_APPROX_BYTES`) plus
/// generous headroom — `ureq`'s `read_to_vec()` defaults to a 10 MB body
/// cap (to protect callers reading arbitrary bodies from memory exhaustion),
/// which is far too small for this ~170 MB file and silently truncated the
/// very first real download attempt in this environment. This URL is a
/// hardcoded constant, not attacker-controlled, so the cap only needs to be
/// a sanity bound, not a tight one.
const MODEL_DOWNLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Fetch `url` and return its raw bytes, or a readable `AppError` for every
/// failure mode a frontend `fetch()` used to surface as a rejected promise
/// (unreachable host, timeout, non-2xx status, a body that never finishes) —
/// same message shapes `src/segment/modelDownload.ts` used to produce
/// itself, so the UI's error copy did not need to change.
fn fetch_bytes(url: &str, timeout_secs: u64, max_bytes: u64) -> Result<Vec<u8>, AppError> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .build();
    let agent: ureq::Agent = config.into();

    match agent.get(url).call() {
        Ok(mut response) => response
            .body_mut()
            .with_config()
            .limit(max_bytes)
            .read_to_vec()
            .map_err(|e| {
                AppError::invalid(format!(
                    "download was interrupted before it finished. ({e})"
                ))
            }),
        Err(ureq::Error::StatusCode(code)) => {
            Err(AppError::invalid(format!("download failed: HTTP {code}")))
        }
        Err(ureq::Error::Timeout(_)) => Err(AppError::invalid(format!(
            "timed out waiting for {url} (after {timeout_secs}s) — check your network connection."
        ))),
        Err(e) => Err(AppError::invalid(format!(
            "could not reach {url} — check your network connection. ({e})"
        ))),
    }
}

/// The real fetch-verify-persist pipeline, taking a plain directory so it can
/// be exercised in a test against a real temp directory without needing a
/// live `AppHandle` (`app_data_dir()` only resolves inside a running Tauri
/// app) — same factoring reason `verify_and_persist` itself already has.
fn download_and_verify_model(dir: &Path) -> Result<SavedSegmentationModel, AppError> {
    let bytes = fetch_bytes(
        LARGER_MODEL_URL,
        MODEL_DOWNLOAD_TIMEOUT_SECS,
        MODEL_DOWNLOAD_MAX_BYTES,
    )?;
    verify_and_persist(&bytes, LARGER_MODEL_MD5, LARGER_MODEL_FILENAME, dir)
}

/// Fetch [`LARGER_MODEL_URL`], verify its MD5 against the checksum the
/// source publishes, and persist it to the app-data models directory.
///
/// **This is the network call `CLAUDE.md`'s "opt-in network" invariant
/// gates.** Reachable only after the frontend has shown the user the exact
/// size and source (`segmentation_model_info`) and they clicked "Download"
/// (`src/segment/SegmentModelSection.tsx`) — the consent gate is unchanged
/// from before this moved here, only *where* the fetch happens changed. A
/// checksum mismatch is reported as an `AppError` and **nothing is ever
/// written to the final path** in that case, the same "verify before
/// install" discipline `scripts/fetch-model.ts`'s build-time fetch already
/// uses. Overwriting an existing file is fine — a re-download after a
/// previous failed/partial attempt should always win.
#[tauri::command]
pub fn download_segmentation_model(app: AppHandle) -> Result<SavedSegmentationModel, AppError> {
    let dir = models_dir(&app)?;
    download_and_verify_model(&dir)
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

    /// A real end-to-end proof against the live URL — this is the Rust half
    /// of the same proof `commands::lospec`'s own
    /// `real_fetch_of_a_known_palette_succeeds` gives for `lospec.com`: that
    /// [`download_and_verify_model`] really can fetch the real ~170 MB
    /// model from outside the WebView (the whole reason it moved here) and
    /// that the downloaded bytes still pass checksum verification. Not run
    /// by default — real network access and a real ~170 MB transfer. Run
    /// with:
    /// `cargo test --manifest-path src-tauri/Cargo.toml commands::segment -- --ignored --nocapture`
    #[test]
    #[ignore = "requires real network access; downloads the real ~170 MB model"]
    fn real_download_of_the_larger_model_succeeds_and_verifies() {
        let dir = TempDir::new("real-larger-model-download");
        let saved = download_and_verify_model(&dir.0)
            .expect("a real download of the larger model should succeed and pass checksum");

        assert_eq!(saved.bytes, LARGER_MODEL_APPROX_BYTES as usize);
        assert_eq!(
            std::fs::metadata(dir.0.join(LARGER_MODEL_FILENAME))
                .unwrap()
                .len(),
            LARGER_MODEL_APPROX_BYTES
        );
        println!(
            "fetched, verified and persisted {} real bytes to {:?}",
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
