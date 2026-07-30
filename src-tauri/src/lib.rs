//! Tesserica — Rust backend.
//!
//! Per `docs/02-architecture.md` §3, this side owns everything where correctness
//! at full resolution matters: export, ONNX inference, file encode/decode. The
//! frontend owns interactive rendering and the approximate live preview.
//!
//! The image *pipeline* (`src-tauri/src/pipeline/`) mirrors `src/pipeline/`
//! module for module; `docs/04-image-pipeline.md` is normative for both.

/// The Q7 transport benchmark. Debug builds only — a release bundle contains no
/// benchmark commands and no `bench://` protocol.
#[cfg(debug_assertions)]
pub mod bench;
pub mod commands;
pub mod error;
pub mod model;
pub mod pipeline;
pub mod segment;
pub mod staging;

/// The command list.
///
/// Spelled out twice rather than composed, because `generate_handler!` takes
/// literal paths and cannot expand another macro inside itself — and because
/// `invoke_handler` may only be called once, so the debug build needs *one*
/// longer list rather than a second call that would silently replace the first.
#[cfg(debug_assertions)]
macro_rules! all_commands {
    () => {
        tauri::generate_handler![
            staging::stage_bytes,
            staging::fetch_staged,
            staging::release_staged,
            commands::export::export_png,
            commands::animation_export::export_spritesheet,
            commands::animation_export::export_gif,
            commands::project::save_project,
            commands::project::load_project,
            commands::source::open_source,
            commands::source::release_source,
            commands::source::source_proxy,
            commands::source::export_conversion,
            commands::segment::segmentation_model_info,
            commands::segment::segmentation_model_status,
            commands::segment::save_downloaded_segmentation_model,
            commands::onnx_runtime::onnx_runtime_info,
            commands::onnx_runtime::onnx_runtime_status,
            commands::onnx_runtime::save_downloaded_onnx_runtime,
            bench::bench_mode,
            bench::bench_json,
            bench::bench_raw,
            bench::bench_read_file,
            bench::bench_report,
            bench::bench_finish,
        ]
    };
}

#[cfg(not(debug_assertions))]
macro_rules! all_commands {
    () => {
        tauri::generate_handler![
            staging::stage_bytes,
            staging::fetch_staged,
            staging::release_staged,
            commands::export::export_png,
            commands::animation_export::export_spritesheet,
            commands::animation_export::export_gif,
            commands::project::save_project,
            commands::project::load_project,
            commands::source::open_source,
            commands::source::release_source,
            commands::source::source_proxy,
            commands::source::export_conversion,
            commands::segment::segmentation_model_info,
            commands::segment::segmentation_model_status,
            commands::segment::save_downloaded_segmentation_model,
            commands::onnx_runtime::onnx_runtime_info,
            commands::onnx_runtime::onnx_runtime_status,
            commands::onnx_runtime::save_downloaded_onnx_runtime,
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Transport C in the Q7 benchmark: a binary body straight off the WebView's
    // network stack, never through the IPC bridge.
    #[cfg(debug_assertions)]
    let builder = builder.register_uri_scheme_protocol("bench", |_ctx, request| {
        let answer = bench::bench_protocol_response(request.body());
        tauri::http::Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .body(answer)
            .expect("bench response builds")
    });

    builder
        // Pixels crossing IPC land here, never in a command argument
        // (`docs/02-architecture.md` §6.2).
        .manage(staging::Staging::default())
        // Source images are opened by Rust and stay in Rust; the frontend holds
        // only a `SourceId` (`docs/02-architecture.md` §6.2).
        .manage(commands::source::Sources::default())
        .invoke_handler(all_commands!())
        .run(tauri::generate_context!())
        .expect("error while running Tesserica");
}
