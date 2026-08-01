//! Tauri command surface (`docs/02-architecture.md` §5).
//!
//! Every command here takes and returns **metadata only**. Pixels move through
//! `crate::staging`, which uses the raw IPC body instead of JSON.

pub mod animation_export;
pub mod ase_import;
pub mod batch_convert;
pub mod export;
pub mod onnx_runtime;
pub mod pattern_chart;
pub mod project;
pub mod segment;
pub mod source;
pub mod tilemap_export;
