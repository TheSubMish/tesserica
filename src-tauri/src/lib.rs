//! Tesserica — Rust backend.
//!
//! Per `docs/02-architecture.md` §3, this side owns everything where correctness
//! at full resolution matters: export, ONNX inference, file encode/decode. The
//! frontend owns interactive rendering and the approximate live preview.
//!
//! The image *pipeline* (`src-tauri/src/pipeline/`) mirrors `src/pipeline/`
//! module for module; `docs/04-image-pipeline.md` is normative for both.

pub mod commands;
pub mod error;
pub mod model;
pub mod pipeline;
pub mod staging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Pixels crossing IPC land here, never in a command argument
        // (`docs/02-architecture.md` §6.2).
        .manage(staging::Staging::default())
        .invoke_handler(tauri::generate_handler![
            staging::stage_bytes,
            staging::fetch_staged,
            staging::release_staged,
            commands::export::export_png,
            commands::project::save_project,
            commands::project::load_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tesserica");
}
