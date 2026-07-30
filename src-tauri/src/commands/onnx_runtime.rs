//! On-demand download of the ONNX Runtime *native library* itself
//! (`docs/10-decisions.md` D16, `docs/07-tech-stack.md` §6).
//!
//! `segment`'s `load-dynamic` build (D15) already made "download the runtime
//! on first use" possible structurally: `ort` compiles with zero system or
//! network dependencies and `dlopen`s a real `libonnxruntime.so` only when
//! [`crate::segment::Segmenter::load`] is called with a path. What was still
//! missing — the actual gap D16 identifies — is anything that *fetches* that
//! `.so`. This module is that piece, and it deliberately mirrors
//! `commands::segment`'s on-demand *model* download almost exactly: a static
//! info command (no network, safe on mount), a local status check (no
//! network), and a save command that verifies an already-downloaded byte
//! buffer and persists it — the actual `fetch()` happens in the frontend
//! (`src/segment/modelDownload.ts`'s `downloadConsentedFile`, generalized in
//! this same change so both downloads share one implementation rather than
//! two parallel ones), and the bytes cross into Rust over the same
//! raw-invoke-body transport (`docs/10-decisions.md` D13) `save_downloaded_
//! segmentation_model` already uses.
//!
//! **One real wrinkle the model download does not have.** Upstream
//! (`microsoft/onnxruntime` GitHub Releases) ships the runtime as a
//! `.tar.gz` containing several files — the real `libonnxruntime.so.<ver>`,
//! two symlinks to it, and a small `libonnxruntime_providers_shared.so` — not
//! a single file. [`verify_and_extract`] verifies the sha256 of the *whole
//! downloaded archive* first (so a corrupted or tampered download is
//! rejected before anything is decompressed at all), then extracts only the
//! one real regular file this project actually needs and writes *that* to
//! disk under a fixed name — the symlinks are not needed, since
//! `Segmenter::load` takes an explicit path rather than relying on the
//! dynamic linker's conventional-name search.
//!
//! **Pipeline wiring is still out of scope here**, exactly as
//! `commands::segment`'s own doc comment says about the model download: this
//! module's contract ends at "the library is on disk and its checksum is
//! verified." Nothing here calls `Segmenter::load`.

use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

/// The native ONNX Runtime release this project downloads. Does not need to
/// match `ort`'s own crate version (`2.0.0-rc.13`, `Cargo.toml`) — the crate
/// talks to ONNX Runtime's stable C API — but pinning one exact native
/// release keeps the checksum below meaningful.
pub const RUNTIME_VERSION: &str = "1.28.0";
const RUNTIME_ARCHIVE_URL: &str =
    "https://github.com/microsoft/onnxruntime/releases/download/v1.28.0/onnxruntime-linux-x64-1.28.0.tgz";
/// sha256 of the exact archive at the URL above, computed against a real
/// download of it in this environment before this module was wired up
/// (`docs/10-decisions.md` D16) — GitHub Releases does not itself publish a
/// checksum for this project to trust, so this project's own verification
/// against a real download *is* what "checksum verification" means here,
/// the same way `commands::segment`'s MD5 constant was checked against a
/// real download rather than copied from a webpage.
const RUNTIME_ARCHIVE_SHA256: &str =
    "a3e1b79d7bb1bf09696ce675f49e4064e6c81f6202b8225624fff0e93f8d6407";
/// Real `Content-Length` of the compressed archive (checked 2026-07-30) — the
/// number the confirm dialog states as the actual network cost.
const RUNTIME_ARCHIVE_APPROX_BYTES: u64 = 9_125_960;
/// The one regular file inside the archive this project needs — the real ELF
/// shared object, not either of the two symlinks that sit alongside it in
/// the same archive entry list.
const RUNTIME_ARCHIVE_ENTRY: &str = "onnxruntime-linux-x64-1.28.0/lib/libonnxruntime.so.1.28.0";
/// Size of that one entry once extracted (checked 2026-07-30) — what
/// actually lands on disk, separate from the compressed download above.
const RUNTIME_EXTRACTED_APPROX_BYTES: u64 = 24_268_848;
const RUNTIME_LICENSE: &str = "MIT";
/// Filename this module writes the extracted library under. Any name works,
/// since `Segmenter::load` takes an explicit path rather than depending on
/// the dynamic linker finding it by a conventional `so`-name search.
const RUNTIME_FILENAME: &str = "libonnxruntime.so";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxRuntimeInfo {
    pub version: String,
    pub filename: String,
    pub source_url: String,
    pub approx_bytes: u64,
    pub extracted_approx_bytes: u64,
    pub license: String,
}

/// Static metadata for the frontend's confirm dialog.
///
/// Reading this is **not** a network call, mirroring
/// `segmentation_model_info` exactly — safe to call whenever the Background
/// section mounts. What must stay gated on explicit consent is
/// [`save_downloaded_onnx_runtime`].
#[tauri::command]
pub fn onnx_runtime_info() -> OnnxRuntimeInfo {
    OnnxRuntimeInfo {
        version: RUNTIME_VERSION.to_string(),
        filename: RUNTIME_FILENAME.to_string(),
        source_url: RUNTIME_ARCHIVE_URL.to_string(),
        approx_bytes: RUNTIME_ARCHIVE_APPROX_BYTES,
        extracted_approx_bytes: RUNTIME_EXTRACTED_APPROX_BYTES,
        license: RUNTIME_LICENSE.to_string(),
    }
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::invalid(format!("could not resolve app data directory: {err}")))?
        .join("onnxruntime");
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxRuntimeStatus {
    pub present: bool,
    pub path: String,
}

/// Whether the runtime library has already been downloaded and extracted. A
/// local filesystem check only — never touches the network — mirroring
/// `segmentation_model_status`.
#[tauri::command]
pub fn onnx_runtime_status(app: AppHandle) -> Result<OnnxRuntimeStatus, AppError> {
    let path = runtime_dir(&app)?.join(RUNTIME_FILENAME);
    Ok(OnnxRuntimeStatus {
        present: path.is_file(),
        path: path.display().to_string(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedOnnxRuntime {
    pub path: String,
    pub bytes: usize,
}

/// Accept the raw bytes of an already-downloaded `.tar.gz` archive — fetched
/// by the frontend only after explicit user confirmation — verify its
/// sha256 against the checksum this project computed, extract the single
/// real shared-object entry it contains, and persist *that* to the app-data
/// runtime directory.
///
/// A checksum mismatch, or an archive missing the expected entry, is
/// reported as an `AppError` and **nothing is ever written to the final
/// path** in either case — the same "verify before install" discipline
/// `commands::segment::verify_and_persist` already uses. Overwriting a
/// previous download is fine: a re-download after a failed/partial attempt
/// should always win.
#[tauri::command]
pub fn save_downloaded_onnx_runtime(
    request: Request<'_>,
    app: AppHandle,
) -> Result<SavedOnnxRuntime, AppError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err(AppError::invalid(
                "save_downloaded_onnx_runtime expects a raw ArrayBuffer body, not JSON",
            ));
        }
    };

    let dir = runtime_dir(&app)?;
    verify_and_extract(
        bytes,
        RUNTIME_ARCHIVE_SHA256,
        RUNTIME_ARCHIVE_ENTRY,
        RUNTIME_FILENAME,
        &dir,
    )
}

/// The verify-decompress-extract-write logic, factored out so it can be
/// exercised against small in-memory fixture archives in unit tests instead
/// of needing a real ~9 MB download to exercise any path (the `#[tauri::
/// command]` above always calls this with the real production constants).
fn verify_and_extract(
    archive_bytes: &[u8],
    expected_sha256: &str,
    entry_path: &str,
    filename: &str,
    dir: &std::path::Path,
) -> Result<SavedOnnxRuntime, AppError> {
    let mut hasher = Sha256::new();
    hasher.update(archive_bytes);
    let digest = format!("{:x}", hasher.finalize());
    if digest != expected_sha256 {
        return Err(AppError::invalid(format!(
            "downloaded ONNX Runtime archive failed checksum verification (got {digest}, \
             expected {expected_sha256}) — refusing to install it. Try downloading again."
        )));
    }

    let gz = flate2::read::GzDecoder::new(archive_bytes);
    let mut archive = tar::Archive::new(gz);
    let wanted = std::path::Path::new(entry_path);
    let mut extracted: Option<Vec<u8>> = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_path_buf();
        if path == wanted {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            extracted = Some(buf);
            break;
        }
    }

    let bytes = extracted.ok_or_else(|| {
        AppError::invalid(format!(
            "downloaded archive did not contain the expected entry {entry_path} — the \
             upstream release layout may have changed. Try downloading again, or report this."
        ))
    })?;

    std::fs::create_dir_all(dir)?;
    let path = dir.join(filename);

    // Temp file + rename, so a process killed mid-write never leaves a
    // truncated library at the final path — the same discipline as
    // `commands::segment::verify_and_persist`.
    let tmp_path = dir.join(format!("{filename}.download"));
    std::fs::write(&tmp_path, &bytes)?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(SavedOnnxRuntime {
        path: path.display().to_string(),
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn onnx_runtime_info_matches_the_hardcoded_constants() {
        let info = onnx_runtime_info();
        assert_eq!(info.version, RUNTIME_VERSION);
        assert_eq!(info.filename, RUNTIME_FILENAME);
        assert_eq!(info.source_url, RUNTIME_ARCHIVE_URL);
        assert_eq!(info.approx_bytes, RUNTIME_ARCHIVE_APPROX_BYTES);
        assert_eq!(info.extracted_approx_bytes, RUNTIME_EXTRACTED_APPROX_BYTES);
        assert_eq!(info.license, "MIT");
    }

    #[test]
    fn a_known_input_produces_the_expected_sha256() {
        // Sanity-checks this module's checksum call against a value anyone
        // can verify independently (`printf 'abc' | sha256sum`), so a future
        // refactor of the digest call itself would be caught here rather
        // than only failing on the real ~9 MB download.
        let mut hasher = Sha256::new();
        hasher.update(b"abc");
        let digest = format!("{:x}", hasher.finalize());
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// A fresh, unique temp directory per test, cleaned up on drop — same
    /// shape as `commands::segment::tests::TempDir`.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tesserica-onnx-runtime-test-{label}-{}-{:?}",
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

    const FIXTURE_ENTRY: &str = "onnxruntime-fixture-1.0.0/lib/libonnxruntime.so.1.0.0";
    const FIXTURE_FILENAME: &str = "libonnxruntime.so";

    /// Builds a real, valid `.tar.gz` in memory containing exactly one
    /// regular-file entry, so tests exercise the real decompress+untar code
    /// path against small fixture bytes rather than needing the real ~9 MB
    /// release archive.
    fn build_fixture_archive(entry_name: &str, content: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, entry_name, content)
            .expect("appending a fixture entry should succeed");
        let tar_bytes = builder
            .into_inner()
            .expect("finishing the tar should succeed");

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&tar_bytes)
            .expect("gzip-encoding the fixture tar should succeed");
        encoder
            .finish()
            .expect("finishing gzip encoding should succeed")
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    #[test]
    fn verify_and_extract_rejects_a_checksum_mismatch_and_writes_nothing() {
        let dir = TempDir::new("mismatch");
        let archive = build_fixture_archive(FIXTURE_ENTRY, b"not the real library bytes");
        let wrong_expected = "0".repeat(64);

        let err = verify_and_extract(
            &archive,
            &wrong_expected,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &dir.0,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(!dir.0.join(FIXTURE_FILENAME).exists());
    }

    #[test]
    fn verify_and_extract_extracts_the_expected_entry_and_persists_it() {
        let dir = TempDir::new("success");
        let content = b"a real fixture standing in for libonnxruntime.so bytes";
        let archive = build_fixture_archive(FIXTURE_ENTRY, content);
        let expected_sha256 = sha256_hex(&archive);

        let saved = verify_and_extract(
            &archive,
            &expected_sha256,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &dir.0,
        )
        .expect("a valid archive with a matching checksum should extract cleanly");

        assert_eq!(saved.bytes, content.len());
        assert_eq!(
            std::fs::read(dir.0.join(FIXTURE_FILENAME)).unwrap(),
            content
        );
        // The temp file used for the atomic rename never lingers behind.
        assert!(!dir.0.join(format!("{FIXTURE_FILENAME}.download")).exists());
    }

    #[test]
    fn verify_and_extract_rejects_an_archive_missing_the_expected_entry() {
        let dir = TempDir::new("missing-entry");
        let archive = build_fixture_archive("some/other/path.so", b"unrelated content");
        let expected_sha256 = sha256_hex(&archive);

        let err = verify_and_extract(
            &archive,
            &expected_sha256,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &dir.0,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(!dir.0.join(FIXTURE_FILENAME).exists());
    }

    #[test]
    fn verify_and_extract_overwrites_a_previous_download() {
        let dir = TempDir::new("overwrite");

        let old_archive = build_fixture_archive(FIXTURE_ENTRY, b"old library bytes");
        let old_sha256 = sha256_hex(&old_archive);
        verify_and_extract(
            &old_archive,
            &old_sha256,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &dir.0,
        )
        .unwrap();

        let new_archive = build_fixture_archive(FIXTURE_ENTRY, b"new, different library bytes");
        let new_sha256 = sha256_hex(&new_archive);
        verify_and_extract(
            &new_archive,
            &new_sha256,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &dir.0,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dir.0.join(FIXTURE_FILENAME)).unwrap(),
            b"new, different library bytes"
        );
    }

    #[test]
    fn verify_and_extract_creates_the_directory_if_it_does_not_exist_yet() {
        let dir = TempDir::new("nested");
        let nested = dir.0.join("a").join("b");
        let content = b"nested-dir fixture bytes";
        let archive = build_fixture_archive(FIXTURE_ENTRY, content);
        let expected_sha256 = sha256_hex(&archive);

        verify_and_extract(
            &archive,
            &expected_sha256,
            FIXTURE_ENTRY,
            FIXTURE_FILENAME,
            &nested,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(nested.join(FIXTURE_FILENAME)).unwrap(),
            content
        );
    }

    /// A manually-run, real end-to-end proof against the actual production
    /// constants — not part of ordinary `cargo test` since it needs a real
    /// ~9 MB archive on disk, which this repo never bundles or checks in.
    ///
    /// Point `TESSERICA_TEST_ORT_ARCHIVE` at a real downloaded copy of
    /// `onnxruntime-linux-x64-1.28.0.tgz` (in this dispatch, one was fetched
    /// via a real `curl` against the real GitHub Releases URL and
    /// independently checksummed with `sha256sum` before this test existed —
    /// see the dispatch report) to confirm the exact code path a real
    /// runtime download would take (`verify_and_extract` with
    /// `RUNTIME_ARCHIVE_SHA256`/`RUNTIME_ARCHIVE_ENTRY`) succeeds against the
    /// real payload, not just a small fixture. Run with:
    /// `TESSERICA_TEST_ORT_ARCHIVE=/path/to/onnxruntime-linux-x64-1.28.0.tgz cargo test commands::onnx_runtime -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a real ~9 MB onnxruntime-linux-x64-1.28.0.tgz on disk, never bundled or checked in"]
    fn smoke_test_the_real_archive_passes_checksum_and_extracts() {
        let path = std::env::var("TESSERICA_TEST_ORT_ARCHIVE")
            .expect("set TESSERICA_TEST_ORT_ARCHIVE to a real onnxruntime-linux-x64-1.28.0.tgz");
        let bytes = std::fs::read(&path).expect("real archive file should be readable");
        assert_eq!(
            bytes.len(),
            RUNTIME_ARCHIVE_APPROX_BYTES as usize,
            "unexpected archive size"
        );

        let dir = TempDir::new("real-archive");
        let saved = verify_and_extract(
            &bytes,
            RUNTIME_ARCHIVE_SHA256,
            RUNTIME_ARCHIVE_ENTRY,
            RUNTIME_FILENAME,
            &dir.0,
        )
        .unwrap();

        assert_eq!(saved.bytes, RUNTIME_EXTRACTED_APPROX_BYTES as usize);
        println!(
            "verified checksum and extracted {} real bytes from {path} to {:?}",
            saved.bytes, dir.0
        );
    }
}
