//! The Q7 transport benchmark (`docs/09-open-questions.md` Q7).
//!
//! Q7 asks how hand-drawn *editor* layers reach Rust on export. Source images
//! stay in Rust (`commands/source.rs`), but layers the user painted live in the
//! WebView and genuinely have to travel.
//!
//! **This runs inside the real app, against the real WebView**, because the cost
//! being measured is the WebView↔native bridge and nothing else. A microbenchmark
//! in `cargo test` would measure the wrong half. The app is launched with
//! `TESSERICA_BENCH=q7`; the frontend sees that via [`bench_mode`], runs
//! `src/bench/q7.ts`, reports through [`bench_report`], and exits.
//!
//! Compiled only under `debug_assertions`, so a release bundle has no benchmark
//! commands and no `bench://` protocol in it.

use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;

use crate::error::AppError;

/// Fold the bytes so nothing can be optimized away, and so a transport that
/// silently truncated would be caught.
pub fn checksum(bytes: &[u8]) -> u64 {
    let mut sum = 0u64;
    for &b in bytes {
        sum = sum.wrapping_mul(31).wrapping_add(b as u64);
    }
    sum
}

/// `Some("q7")` when the app was started for the benchmark.
#[tauri::command]
pub fn bench_mode() -> Option<String> {
    std::env::var("TESSERICA_BENCH").ok()
}

/// **Transport A — JSON command argument.** The thing `docs/02` §6.2 forbids,
/// measured so the prohibition rests on a number rather than on an assertion.
#[tauri::command]
pub fn bench_json(bytes: Vec<u8>) -> u64 {
    checksum(&bytes)
}

/// **Transport B — raw invoke body**, as `staging.rs` already uses.
#[tauri::command]
pub fn bench_raw(request: Request<'_>) -> Result<u64, AppError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(checksum(bytes)),
        InvokeBody::Json(_) => Err(AppError::invalid("bench_raw expects a raw body")),
    }
}

/// **Transport D — temp file.** Rust reads a file the frontend wrote.
#[tauri::command]
pub fn bench_read_file(path: String) -> Result<u64, AppError> {
    Ok(checksum(&std::fs::read(path)?))
}

/// Print a result line to stdout, where the shell running the benchmark sees it.
#[tauri::command]
pub fn bench_report(line: String) {
    println!("Q7 {line}");
}

#[tauri::command]
pub fn bench_finish(app: AppHandle) {
    app.exit(0);
}

/// **Transport C — custom URI protocol.** The frontend `fetch`es this with a
/// binary body, bypassing the IPC bridge entirely.
pub fn bench_protocol_response(body: &[u8]) -> Vec<u8> {
    checksum(body).to_string().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_is_order_sensitive_and_length_sensitive() {
        assert_ne!(checksum(&[1, 2, 3]), checksum(&[3, 2, 1]));
        assert_ne!(checksum(&[1, 2, 3]), checksum(&[1, 2]));
        assert_eq!(checksum(&[1, 2, 3]), checksum(&[1, 2, 3]));
    }

    #[test]
    fn a_truncated_payload_would_be_caught() {
        let full: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        assert_ne!(checksum(&full), checksum(&full[..999]));
    }
}
