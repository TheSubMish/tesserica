//! Error type for [`crate::segment`], deliberately independent of
//! `crate::error::AppError` (which stays free of any ONNX-specific variant)
//! so this module's only coupling to the rest of the crate is the type name
//! a caller converts from — the same shape `crate::pipeline` already uses to
//! stay decoupled from Tauri (`error.rs`'s own doc comment).

#[derive(Debug, thiserror::Error)]
pub enum SegmentError {
    /// The ONNX Runtime dynamic library was not found at the given path.
    /// Expected until a runtime is bundled or downloaded (`docs/07-tech-stack.md`
    /// §6) — callers should fall back to flood-fill background removal
    /// (`pipeline::background_removal`), not treat this as fatal.
    #[error("ONNX Runtime library not available at {0}")]
    RuntimeUnavailable(String),

    /// The model file was not found at the given path. Expected until
    /// `u2netp` is bundled (the next Phase 5 roadmap item).
    #[error("segmentation model not found at {0}")]
    ModelNotFound(String),

    /// ONNX Runtime itself reported an error (bad model file, unsupported
    /// op, dylib version mismatch, etc).
    #[error("ONNX Runtime error: {0}")]
    Runtime(String),

    /// The input buffer's length didn't match `width * height * 4` (RGBA,
    /// `docs/10-decisions.md` D9 — no indexed-color paths, ever).
    #[error("expected an RGBA buffer of {expected} bytes, got {actual}")]
    InvalidBuffer { expected: usize, actual: usize },

    /// A session is loaded but inference is not wired up yet — this
    /// dispatch only scaffolds the module and evaluates the crate choice
    /// (`docs/08-roadmap.md` Phase 5, "`segment` module; evaluate `rembg-rs`
    /// vs direct `ort`").
    #[error("segmentation inference is not implemented yet")]
    NotImplemented,
}
