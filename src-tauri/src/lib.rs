//! Tesserica — Rust backend.
//!
//! Per `docs/02-architecture.md` §3, this side owns everything where correctness
//! at full resolution matters: export, ONNX inference, file encode/decode. The
//! frontend owns interactive rendering and the approximate live preview.
//!
//! Command modules land in Phase 2 (`docs/08-roadmap.md`).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Tesserica");
}
