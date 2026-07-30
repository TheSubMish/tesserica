//! Local ONNX-based subject/background segmentation
//! (`docs/04-image-pipeline.md` §8, `docs/07-tech-stack.md` §3.1).
//!
//! **Isolation is the whole point of this module.** `ort` has no stable
//! release — `Cargo.toml` pins the exact `2.0.0-rc.13` (re-verified against
//! crates.io 2026-07-30, no caret range) — so every other part of the app
//! talks to [`Segmenter`], never to `ort` directly. If `ort` ever needs
//! replacing, this is the only module that changes.
//!
//! `rembg-rs` (crates.io, evaluated the same day) was considered first per
//! `07` §3.1's own note to check it before hand-rolling, and rejected: it
//! depends on `ort ^2.0.0-rc.10` itself (so it does not remove `ort` as a
//! dependency, only adds a second version constraint on top of it) and pulls
//! in `imagequant` + `oxipng` — an indexed-color quantization and
//! PNG-recompression pipeline this project does not want, since v1 is
//! RGBA-only (D9) and quantization already happens in `pipeline::quantize`.
//! `rembg-rs` is also very young (first published 2025-10-23) and has had
//! only 747 total downloads at time of evaluation — direct `ort` is
//! both more capable (the model's own preprocessing/postprocessing needs to
//! match `04` §8.3 exactly, which a wrapper crate would fight rather than
//! help with) and no riskier a dependency. See `docs/10-decisions.md` D15
//! for the full write-up.
//!
//! No model is bundled yet — that is the *next* Phase 5 roadmap item. This
//! module's default runtime state is therefore "no model available",
//! reported cleanly through [`SegmentOutcome::NoModelLoaded`] rather than as
//! an error. Background removal degrades to the flood-fill fallback already
//! shipped (`pipeline::background_removal`); nothing in this module panics
//! if segmentation is unavailable, and constructing a [`Segmenter`] never
//! touches the filesystem or the ONNX Runtime dynamic library on its own.
//!
//! ### Why `load-dynamic`, not build-time linking
//!
//! `ort`'s default features include `download-binaries`, which fetches a
//! prebuilt ONNX Runtime binary from the network *at build time* and links
//! against it. `Cargo.toml` disables that (`default-features = false`) and
//! enables `load-dynamic` instead: `ort` compiles with zero system
//! dependencies, and the actual ONNX Runtime shared library is `dlopen`ed at
//! runtime, only when [`Segmenter::load`] is called with a real path. This
//! keeps the build hermetic (no network fetch just to compile this crate)
//! and matches the module's "no model available by default" contract — a
//! missing dylib is a normal, reportable [`SegmentError`], not a build
//! failure.

mod error;

pub use error::SegmentError;

use std::path::Path;

use ort::session::Session;

/// The result of an attempted segmentation pass.
#[derive(Debug)]
pub enum SegmentOutcome {
    /// A subject/background matte: one alpha byte per source pixel
    /// (0 = background, 255 = subject), row-major, already upscaled back to
    /// source resolution (`04` §8.3 step 4). Threshold / morphological
    /// close / feather (`04` §8.3 step 5) are a later roadmap item and are
    /// not applied here.
    Matte {
        width: u32,
        height: u32,
        alpha: Vec<u8>,
    },

    /// No ONNX model is loaded. This is the expected default state until
    /// `u2netp` is bundled (the next Phase 5 roadmap item) — callers should
    /// fall back to `pipeline::background_removal`'s flood-fill rather than
    /// surfacing this as a user-facing error.
    NoModelLoaded,
}

/// Owns at most one loaded ONNX Runtime session for background-removal
/// segmentation.
///
/// Constructing one is always cheap and infallible; only [`Segmenter::load`]
/// touches the filesystem or `ort`.
pub struct Segmenter {
    session: Option<Session>,
}

impl Default for Segmenter {
    fn default() -> Self {
        Self::new()
    }
}

impl Segmenter {
    /// A segmenter with no model loaded — the default state until a model
    /// is bundled or downloaded.
    pub fn new() -> Self {
        Self { session: None }
    }

    /// True once [`Segmenter::load`] has succeeded.
    pub fn is_available(&self) -> bool {
        self.session.is_some()
    }

    /// Load the ONNX Runtime dynamic library from `runtime_lib` and commit
    /// an inference session for the model at `model_path`.
    ///
    /// Every failure mode here is a plain [`SegmentError`], never a panic:
    /// a missing dylib or model file, or a load-time ONNX Runtime error, are
    /// all things a caller is expected to hit (nothing is bundled yet) and
    /// should react to by falling back to flood-fill background removal.
    pub fn load(&mut self, runtime_lib: &Path, model_path: &Path) -> Result<(), SegmentError> {
        if !runtime_lib.exists() {
            return Err(SegmentError::RuntimeUnavailable(
                runtime_lib.display().to_string(),
            ));
        }
        if !model_path.exists() {
            return Err(SegmentError::ModelNotFound(
                model_path.display().to_string(),
            ));
        }

        // `load-dynamic` (Cargo.toml) requires this before any other `ort`
        // API is touched — see the module-level doc comment.
        ort::init_from(runtime_lib)
            .map_err(|err| SegmentError::RuntimeUnavailable(err.to_string()))?
            .commit();

        let session = Session::builder()
            .map_err(|err| SegmentError::Runtime(err.to_string()))?
            .commit_from_file(model_path)
            .map_err(|err| SegmentError::Runtime(err.to_string()))?;

        self.session = Some(session);
        Ok(())
    }

    /// Run subject/background segmentation on an RGBA buffer.
    ///
    /// Returns [`SegmentOutcome::NoModelLoaded`] — not an error — when no
    /// model has been loaded, which is this dispatch's default state for
    /// every caller in the app right now.
    ///
    /// Actual inference (resize to model resolution, normalize, run,
    /// upscale the mask — `04` §8.3 steps 1-4) is unimplemented until a
    /// model is bundled (the next Phase 5 roadmap item): with a session
    /// loaded, this reports [`SegmentError::NotImplemented`] rather than
    /// silently returning a wrong mask.
    pub fn segment(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<SegmentOutcome, SegmentError> {
        let expected = (width as usize) * (height as usize) * 4;
        if rgba.len() != expected {
            return Err(SegmentError::InvalidBuffer {
                expected,
                actual: rgba.len(),
            });
        }

        if self.session.is_none() {
            return Ok(SegmentOutcome::NoModelLoaded);
        }

        Err(SegmentError::NotImplemented)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_segmenter_has_no_model_and_touches_nothing() {
        let segmenter = Segmenter::new();
        assert!(!segmenter.is_available());
    }

    #[test]
    fn segment_with_no_model_reports_no_model_loaded_not_an_error() {
        let segmenter = Segmenter::new();
        let rgba = vec![0u8; 4 * 4 * 4];
        let outcome = segmenter
            .segment(&rgba, 4, 4)
            .expect("no-model path is not an error");
        assert!(matches!(outcome, SegmentOutcome::NoModelLoaded));
    }

    #[test]
    fn segment_rejects_a_buffer_of_the_wrong_length() {
        let segmenter = Segmenter::new();
        let rgba = vec![0u8; 10]; // not width*height*4
        let err = segmenter.segment(&rgba, 4, 4).unwrap_err();
        assert!(matches!(
            err,
            SegmentError::InvalidBuffer {
                expected: 64,
                actual: 10
            }
        ));
    }

    #[test]
    fn load_reports_missing_runtime_library_cleanly() {
        let mut segmenter = Segmenter::new();
        let err = segmenter
            .load(
                Path::new("/nonexistent/libonnxruntime.so"),
                Path::new("/nonexistent/u2netp.onnx"),
            )
            .unwrap_err();
        assert!(matches!(err, SegmentError::RuntimeUnavailable(_)));
        assert!(!segmenter.is_available());
    }

    #[test]
    fn load_reports_missing_model_file_cleanly_once_a_real_dylib_path_is_given() {
        // Use this test binary itself as a stand-in "existing file" for the
        // runtime-lib path, so the missing-*model* branch is what's actually
        // exercised, without needing a real ONNX Runtime .so in this
        // environment (docs/07-tech-stack.md §6 — the runtime lib is not
        // bundled until a later Phase 5 step).
        let stand_in_existing_path = std::env::current_exe().expect("test binary path");
        let mut segmenter = Segmenter::new();
        let err = segmenter
            .load(
                &stand_in_existing_path,
                Path::new("/nonexistent/u2netp.onnx"),
            )
            .unwrap_err();
        assert!(matches!(err, SegmentError::ModelNotFound(_)));
        assert!(!segmenter.is_available());
    }

    /// A manually-run smoke test, not part of ordinary `cargo test` (no
    /// ONNX Runtime dylib or model is bundled or checked into this repo
    /// yet — that is a later Phase 5 roadmap item). Point
    /// `TESSERICA_TEST_ORT_LIB` at a real `libonnxruntime.so` and
    /// `TESSERICA_TEST_ORT_MODEL` at any real `.onnx` file to prove, in
    /// this specific environment, that `ort` with the `load-dynamic`
    /// feature actually `dlopen`s a real ONNX Runtime and commits a real
    /// session — evidence for the next dispatch that bundles `u2netp`.
    /// Run with:
    /// `TESSERICA_TEST_ORT_LIB=... TESSERICA_TEST_ORT_MODEL=... cargo test segment -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an external ONNX Runtime .so + model file, neither bundled yet"]
    fn smoke_test_a_real_onnx_runtime_and_model_if_env_vars_point_at_them() {
        let lib = std::env::var("TESSERICA_TEST_ORT_LIB").expect("set TESSERICA_TEST_ORT_LIB");
        let model =
            std::env::var("TESSERICA_TEST_ORT_MODEL").expect("set TESSERICA_TEST_ORT_MODEL");

        let mut segmenter = Segmenter::new();
        segmenter
            .load(Path::new(&lib), Path::new(&model))
            .expect("a real dylib + model should load successfully");
        assert!(segmenter.is_available());
        println!("loaded real ONNX Runtime from {lib} and model from {model} successfully");
    }
}
