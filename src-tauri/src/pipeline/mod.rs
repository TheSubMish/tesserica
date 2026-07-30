//! The image pipeline, Rust half.
//!
//! Mirrors `src/pipeline/` module for module, function for function, parameter
//! struct for parameter struct — deliberately, so the two can be reviewed side
//! by side (`docs/02-architecture.md` §3.3). **When you touch one, touch the
//! other in the same change.**
//!
//! This half owns full-resolution export: correctness at 12 MP, `rayon` where
//! the stage allows it. The TS half owns the live preview on a ~1024px proxy
//! and is deliberately approximate.
//!
//! `docs/04-image-pipeline.md` is normative for both. The stage order in its §2
//! is fixed and identical here.

pub mod adjust;
pub mod autopalette;
pub mod background_removal;
pub mod buffer;
pub mod cleanup;
pub mod convert;
pub mod crop;
pub mod dither;
pub mod downscale;
pub mod oklab;
pub mod quantize;
pub mod settings;
