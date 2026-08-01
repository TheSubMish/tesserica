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
/// CLI headless mode (`docs/08-roadmap.md` Phase 7 "Batch conversion + CLI
/// headless mode"). Parsed and dispatched before the GUI ever opens a window
/// — see `run()` below.
pub mod cli;
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
            commands::tilemap_export::export_tilemap,
            commands::pattern_chart::export_pattern_chart,
            commands::project::save_project,
            commands::project::load_project,
            commands::ase_import::import_ase,
            commands::source::open_source,
            commands::source::release_source,
            commands::source::source_proxy,
            commands::source::export_conversion,
            commands::batch_convert::batch_convert,
            commands::batch_convert::cancel_batch_convert,
            commands::segment::segmentation_model_info,
            commands::segment::segmentation_model_status,
            commands::segment::download_segmentation_model,
            commands::segment::segmentation_availability,
            commands::onnx_runtime::onnx_runtime_info,
            commands::onnx_runtime::onnx_runtime_status,
            commands::onnx_runtime::download_onnx_runtime,
            commands::lospec::fetch_lospec_palette,
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
            commands::tilemap_export::export_tilemap,
            commands::pattern_chart::export_pattern_chart,
            commands::project::save_project,
            commands::project::load_project,
            commands::ase_import::import_ase,
            commands::source::open_source,
            commands::source::release_source,
            commands::source::source_proxy,
            commands::source::export_conversion,
            commands::batch_convert::batch_convert,
            commands::batch_convert::cancel_batch_convert,
            commands::segment::segmentation_model_info,
            commands::segment::segmentation_model_status,
            commands::segment::download_segmentation_model,
            commands::segment::segmentation_availability,
            commands::onnx_runtime::onnx_runtime_info,
            commands::onnx_runtime::onnx_runtime_status,
            commands::onnx_runtime::download_onnx_runtime,
            commands::lospec::fetch_lospec_palette,
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A real CLI invocation (`tesserica --batch-convert <folder> --out
    // <folder> --settings <path> [--scale N]`) skips the GUI entirely and
    // exits with a real process exit code — the natural companion to batch
    // conversion once its pipeline exists (`docs/06-workflows.md` W5), and the
    // same "this binary can do something other than open a window" shape the
    // existing `TESSERICA_BENCH` env-var mode already established, just via
    // real argument parsing rather than an env var since a headless batch job
    // has real inputs (folders, a settings file) an env var cannot carry.
    if let Some(args) = cli::CliArgs::parse(std::env::args().skip(1)) {
        std::process::exit(cli::run_headless(args));
    }

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
        // Batch conversion's cooperative-cancellation registry (`docs/08-roadmap.md`
        // Phase 7 "Batch conversion + CLI headless mode").
        .manage(commands::batch_convert::BatchJobs::default())
        // At most one loaded ONNX Runtime session for ML background removal
        // (`segment::Segmenter`). `Mutex` because `Segmenter::segment` takes
        // `&mut self` (an ONNX Runtime session mutates scratch state on every
        // `run`) — the same interior-mutability shape `commands::source::
        // Sources`' own handle table already uses for shared Tauri state.
        // Empty until `commands::segment::segmentation_availability` (or an
        // export/convert call) successfully loads a model; never touches the
        // filesystem or `ort` on its own.
        .manage(std::sync::Mutex::new(segment::Segmenter::new()))
        .invoke_handler(all_commands!())
        .run(tauri::generate_context!())
        .expect("error while running Tesserica");
}
