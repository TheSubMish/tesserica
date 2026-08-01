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
//! No model is loaded by default — constructing a [`Segmenter`] never touches
//! the filesystem or the ONNX Runtime dynamic library on its own, and calling
//! [`Segmenter::segment`] before [`Segmenter::load`] succeeds reports
//! [`SegmentOutcome::NoModelLoaded`] cleanly rather than as an error. Callers
//! (`commands::segment`, `pipeline::convert`'s Rust-side caller) degrade to
//! the flood-fill fallback (`pipeline::background_removal`) in that case;
//! nothing here panics if segmentation is unavailable.
//!
//! ### Real inference (`04` §8.3 steps 1-4)
//!
//! Once a session is loaded, [`Segmenter::segment`] runs the actual model:
//!
//! 1. **Resize** the source RGBA to the model's own declared input
//!    resolution — read from the loaded session's input metadata rather than
//!    assumed, though the bundled `u2netp.onnx` reports a concrete
//!    `[1, 3, 320, 320]` (checked directly via `ort` session metadata while
//!    building this). Alpha is dropped (the model takes RGB only, matching
//!    `rembg`'s own `img.convert("RGB")`); the resize filter is Lanczos3,
//!    matching `rembg`'s `Image.Resampling.LANCZOS` exactly, since feeding
//!    the model the same resampling it was validated against matters more
//!    here than this project's usual nearest-neighbour-only rule, which is
//!    about *rendering* pixel art, not this internal preprocessing buffer.
//! 2. **Normalize**: divide by the resized image's own max byte value (not a
//!    fixed 255 — this replicates U-2-Net's and `rembg`'s own
//!    `im_ary / max(np.max(im_ary), 1e-6)`, verified against both upstream
//!    sources), then per-channel ImageNet mean/std ([`MEAN`]/[`STD`]).
//! 3. **Run** the session and take the *first* declared output — verified
//!    against the bundled model to be the fused final saliency map (U-2-Net
//!    exports 7 outputs for its deep-supervision side heads; only the first,
//!    `d0`, is the one every reference inference script actually uses).
//! 4. **Post-process the raw output** with U-2-Net's own `normPRED`: per-image
//!    min-max normalize to `0..1`, then scale to a `0..255` mask — and
//!    **upscale back to source resolution with bilinear, not nearest**.
//!    `docs/04-image-pipeline.md` §8.3 step 4 already calls this out
//!    explicitly ("bilinear here is correct — it is a mask, not pixel art"):
//!    `CLAUDE.md`'s nearest-neighbour invariant governs *rendered pixel-art
//!    output*, not this internal soft-alpha buffer, and a mask meant to be
//!    thresholded/feathered later benefits from the smoother edge bilinear
//!    gives it.
//!
//! Threshold / morphological close / feather (§8.3 step 5) are *not* applied
//! here — that is [`crate::pipeline::mask_post_process::post_process_mask`],
//! run by callers on this matte the same way it already runs on the
//! flood-fill fallback's mask, so both methods share one post-processing path
//! rather than two.
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

use std::path::{Path, PathBuf};

use image::{imageops, ImageBuffer, Luma, Rgb};
use ort::session::Session;
use ort::value::{Tensor, ValueType};

/// ImageNet mean/std U-2-Net's own reference preprocessing uses
/// (`NathanUA/U-2-Net`'s `data_loader.py::ToTensorLab`, `flag=0`) — verified
/// 2026-08-01 against both the upstream U-2-Net repository and `rembg`'s
/// `sessions/u2net.py`/`sessions/base.py::normalize` (the maintained source
/// this project's own `u2netp.onnx` is fetched from, `assets/models/
/// README.md`), which reproduce the same three constants per channel, in RGB
/// order. This is *not* a guess or a generic ImageNet default reused by
/// coincidence — both reference implementations hardcode exactly these
/// values for this model family.
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Fallback model input resolution, used only if the ONNX graph's own
/// declared input shape is dynamic (a `-1`/unset dimension). The bundled
/// `u2netp.onnx` does not hit this fallback — its real input shape was
/// inspected directly via `ort` session metadata during this dispatch and is
/// a concrete `[1, 3, 320, 320]` — but a future model swap (e.g. the
/// on-demand `isnet-general-use`, `docs/04-image-pipeline.md` §8.1) might
/// export with dynamic spatial dims, and 320 is U-2-Net's own documented
/// default resolution, so it is a reasonable floor rather than an arbitrary
/// number.
const FALLBACK_INPUT_SIZE: u32 = 320;

/// Where the build-time-fetched bundled `u2netp.onnx` lives in a checkout of
/// this repository.
///
/// `scripts/fetch-model.ts` (`npm run models:fetch`) downloads it into
/// `assets/models/u2netp.onnx` at the repository root — gitignored, fetched
/// once per checkout, never committed (`docs/08-roadmap.md` Phase 5,
/// `assets/models/README.md`). `CARGO_MANIFEST_DIR` is a compile-time
/// constant pointing at `src-tauri/`, one level below the repository root, so
/// this resolves the same way whether invoked via `cargo test`/`cargo run`
/// directly or through `tauri dev`/`tauri build` (both of which shell out to
/// `cargo` from the same directory).
///
/// **Dev-build resolution only.** How a *shipped* installer bundles this file
/// (`tauri.conf.json` resources, alongside the ONNX Runtime `.so` itself) is
/// the separate "Resolve the ONNX Runtime size question" roadmap item, not
/// solved here.
pub fn bundled_model_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/models/u2netp.onnx")
}

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

    /// No ONNX model is loaded (`Segmenter::load` was never called, or the
    /// most recent call failed) — callers should fall back to
    /// `pipeline::background_removal`'s flood-fill rather than surfacing
    /// this as a user-facing error.
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
    /// model has been loaded.
    ///
    /// Takes `&mut self` because `ort::Session::run` does (an ONNX Runtime
    /// session mutates internal scratch state on every inference pass);
    /// callers holding a `Segmenter` behind shared state need a `Mutex`
    /// around it, the same shape `commands::source::Sources` already uses
    /// for its own interior-mutable handle table.
    ///
    /// See the module-level doc comment for the four preprocessing/inference/
    /// postprocessing steps this runs (`04` §8.3 steps 1-4). Any ONNX Runtime
    /// failure during preprocessing, the run itself, or an unexpected output
    /// shape is reported as [`SegmentError::Runtime`] — never a panic —
    /// exactly like every other failure mode this module already reports,
    /// so callers can degrade to flood-fill rather than crash.
    pub fn segment(
        &mut self,
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

        let Some(session) = self.session.as_mut() else {
            return Ok(SegmentOutcome::NoModelLoaded);
        };

        let (in_h, in_w) = model_input_hw(session);

        // --- [1]-[2] resize + normalize (module doc comment) ---
        let input = preprocess(rgba, width, height, in_w, in_h);
        let shape = vec![1i64, 3, in_h as i64, in_w as i64];
        let tensor = Tensor::from_array((shape, input))
            .map_err(|err| SegmentError::Runtime(err.to_string()))?;

        let input_name = session
            .inputs()
            .first()
            .map(|outlet| outlet.name().to_string())
            .ok_or_else(|| SegmentError::Runtime("model declares no input".to_string()))?;

        // --- [3] run ---
        let outputs = session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(|err| SegmentError::Runtime(err.to_string()))?;
        if outputs.len() == 0 {
            return Err(SegmentError::Runtime(
                "model produced no outputs".to_string(),
            ));
        }
        // The first declared output is U-2-Net's fused final saliency map
        // (`d0`); the remaining six are deep-supervision side heads used only
        // during training. Verified against the bundled `u2netp.onnx`'s own
        // export order while building this.
        let (out_shape, out_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|err| SegmentError::Runtime(err.to_string()))?;
        if out_shape.len() != 4 || out_shape[2] as u32 != in_h || out_shape[3] as u32 != in_w {
            return Err(SegmentError::Runtime(format!(
                "unexpected model output shape {out_shape:?}, expected [_, _, {in_h}, {in_w}]"
            )));
        }

        // --- [4] postprocess (normPRED) + upscale ---
        let mask_at_model_res = norm_pred_to_mask_bytes(out_data);
        let small = ImageBuffer::<Luma<u8>, Vec<u8>>::from_raw(in_w, in_h, mask_at_model_res)
            .ok_or_else(|| SegmentError::Runtime("mask buffer size mismatch".to_string()))?;
        let resized = if (in_w, in_h) == (width, height) {
            small
        } else {
            // `bilinear here is correct — it is a mask, not pixel art`
            // (`docs/04-image-pipeline.md` §8.3 step 4) — see the
            // module-level doc comment for the full reasoning.
            imageops::resize(&small, width, height, imageops::FilterType::Triangle)
        };

        Ok(SegmentOutcome::Matte {
            width,
            height,
            alpha: resized.into_raw(),
        })
    }
}

/// The model's declared input spatial resolution as `(height, width)`, read
/// from the loaded session's own metadata rather than assumed. Falls back to
/// [`FALLBACK_INPUT_SIZE`] only if the graph's declared dimension is dynamic
/// (`<= 0`) — the bundled `u2netp.onnx` never hits this branch.
fn model_input_hw(session: &Session) -> (u32, u32) {
    if let Some(input) = session.inputs().first() {
        if let ValueType::Tensor { shape, .. } = input.dtype() {
            if shape.len() == 4 && shape[2] > 0 && shape[3] > 0 {
                return (shape[2] as u32, shape[3] as u32);
            }
        }
    }
    (FALLBACK_INPUT_SIZE, FALLBACK_INPUT_SIZE)
}

/// Steps [1]-[2]: drop alpha, resize to the model's input resolution with
/// Lanczos3 (matching `rembg`'s `Image.Resampling.LANCZOS`), then normalize
/// exactly as U-2-Net's own `ToTensorLab`/`rembg`'s `normalize()` do —
/// divide by the resized image's own max byte value, then per-channel
/// ImageNet mean/std — and return a flattened NCHW `f32` buffer.
fn preprocess(rgba: &[u8], width: u32, height: u32, in_w: u32, in_h: u32) -> Vec<f32> {
    let mut rgb = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(width, height);
    for (i, px) in rgb.pixels_mut().enumerate() {
        let o = i * 4;
        *px = Rgb([rgba[o], rgba[o + 1], rgba[o + 2]]);
    }

    let resized = if (width, height) == (in_w, in_h) {
        rgb
    } else {
        imageops::resize(&rgb, in_w, in_h, imageops::FilterType::Lanczos3)
    };

    // `im_ary / max(np.max(im_ary), 1e-6)` (rembg `sessions/base.py`): the
    // divisor is the resized array's own observed maximum byte, not a fixed
    // 255. On the integer domain a floor of 1 (rather than 1e-6) gives the
    // same result — a fully black image has numerator 0 too, so the exact
    // epsilon does not matter, only that it is never zero.
    let max_byte = resized.as_raw().iter().copied().max().unwrap_or(0).max(1) as f32;

    let plane = (in_h as usize) * (in_w as usize);
    let mut out = vec![0f32; 3 * plane];
    for (i, px) in resized.pixels().enumerate() {
        for c in 0..3 {
            let v = px.0[c] as f32 / max_byte;
            out[c * plane + i] = (v - MEAN[c]) / STD[c];
        }
    }
    out
}

/// U-2-Net's own `normPRED`: per-image min-max normalize the raw output to
/// `0..1`, then scale to `0..255` mask bytes. A degenerate all-equal output
/// (range `~0`) maps to `0` (background) rather than dividing by
/// (near-)zero — a flat prediction carries no usable signal either way.
fn norm_pred_to_mask_bytes(pred: &[f32]) -> Vec<u8> {
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for &v in pred {
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    let range = hi - lo;
    pred.iter()
        .map(|&v| {
            let normalized = if range > 1e-6 { (v - lo) / range } else { 0.0 };
            (normalized.clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
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
        let mut segmenter = Segmenter::new();
        let rgba = vec![0u8; 4 * 4 * 4];
        let outcome = segmenter
            .segment(&rgba, 4, 4)
            .expect("no-model path is not an error");
        assert!(matches!(outcome, SegmentOutcome::NoModelLoaded));
    }

    #[test]
    fn segment_rejects_a_buffer_of_the_wrong_length() {
        let mut segmenter = Segmenter::new();
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

    #[test]
    fn bundled_model_path_points_at_assets_models_u2netp_onnx() {
        let path = bundled_model_path();
        assert!(path.ends_with("assets/models/u2netp.onnx"), "{path:?}");
    }

    /// A manually-run smoke test, not part of ordinary `cargo test` (no
    /// ONNX Runtime `.so` is bundled or checked into this repo yet — that is
    /// the separate "Resolve the ONNX Runtime size question" roadmap item).
    /// Point `TESSERICA_TEST_ORT_LIB` at a real `libonnxruntime.so` to prove,
    /// in this specific environment, that `ort` with the `load-dynamic`
    /// feature actually `dlopen`s a real ONNX Runtime and commits a real
    /// session against the *bundled* `u2netp.onnx` fetched by `npm run
    /// models:fetch` (`bundled_model_path()`) — evidence the build-time fetch
    /// script is actually wired to something `Segmenter::load` can use, not
    /// just present on disk. Set `TESSERICA_TEST_ORT_MODEL` to override the
    /// model path (e.g. to test against a different `.onnx` file); otherwise
    /// defaults to the bundled path. Run with:
    /// `TESSERICA_TEST_ORT_LIB=... cargo test segment -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an external ONNX Runtime .so; the bundled model is fetched via `npm run models:fetch`"]
    fn smoke_test_the_bundled_model_loads_with_a_real_onnx_runtime() {
        let lib = std::env::var("TESSERICA_TEST_ORT_LIB").expect("set TESSERICA_TEST_ORT_LIB");
        let model = std::env::var("TESSERICA_TEST_ORT_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| bundled_model_path());

        assert!(
            model.exists(),
            "model not found at {model:?} — run `npm run models:fetch` first, or set \
             TESSERICA_TEST_ORT_MODEL"
        );

        let mut segmenter = Segmenter::new();
        segmenter
            .load(Path::new(&lib), &model)
            .expect("the bundled u2netp.onnx should load successfully with a real ONNX Runtime");
        assert!(segmenter.is_available());
        println!(
            "loaded real ONNX Runtime from {lib} and bundled model from {model:?} successfully"
        );
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

    /// The real, not-mocked proof that inference itself works: load the real
    /// bundled `u2netp.onnx` with a real ONNX Runtime `.so`, run it against a
    /// synthetic-but-photo-like image with an unambiguous foreground subject
    /// (a bright, high-contrast blob against a very different, low-contrast
    /// background — not a real photograph, but real saliency models respond
    /// to exactly this kind of colour/contrast structure even off their
    /// training distribution), and assert the resulting matte is genuinely
    /// **subject-shaped**: pixels inside the blob score reliably higher than
    /// pixels in the background, not just "the call didn't crash".
    ///
    /// Run with:
    /// `TESSERICA_TEST_ORT_LIB=... cargo test segment -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an external ONNX Runtime .so; the bundled model is fetched via `npm run models:fetch`"]
    fn smoke_test_real_inference_produces_a_subject_shaped_mask() {
        let lib = std::env::var("TESSERICA_TEST_ORT_LIB").expect("set TESSERICA_TEST_ORT_LIB");
        let model = std::env::var("TESSERICA_TEST_ORT_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| bundled_model_path());
        assert!(
            model.exists(),
            "model not found at {model:?} — run `npm run models:fetch` first"
        );

        let mut segmenter = Segmenter::new();
        segmenter
            .load(Path::new(&lib), &model)
            .expect("load should succeed with a real runtime + the bundled model");

        // 256x256: a warm, textured "subject" disk on a cool, flat
        // "background" — big enough that resizing down to the model's
        // 320x320 input does not obliterate the shape.
        let (w, h) = (256u32, 256u32);
        let cx = w as f32 / 2.0;
        let cy = h as f32 / 2.0;
        let radius = 70.0f32;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let o = ((y * w + x) * 4) as usize;
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let inside = (dx * dx + dy * dy).sqrt() < radius;
                let px = if inside {
                    // Warm, mildly textured "subject".
                    [220u8, 160, 60, 255]
                } else {
                    // Flat, cool "background".
                    [30u8, 40, 90, 255]
                };
                rgba[o..o + 4].copy_from_slice(&px);
            }
        }

        let outcome = segmenter
            .segment(&rgba, w, h)
            .expect("inference should succeed against a real session");
        let SegmentOutcome::Matte {
            width,
            height,
            alpha,
        } = outcome
        else {
            panic!("expected a Matte now that a real model is loaded, got {outcome:?}");
        };
        assert_eq!((width, height), (w, h));
        assert_eq!(alpha.len(), (w * h) as usize);

        let mean_at = |cx: i64, cy: i64, r: i64| -> f64 {
            let mut sum = 0u64;
            let mut n = 0u64;
            for y in (cy - r)..(cy + r) {
                for x in (cx - r)..(cx + r) {
                    if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                        continue;
                    }
                    sum += alpha[(y as u32 * w + x as u32) as usize] as u64;
                    n += 1;
                }
            }
            sum as f64 / n as f64
        };

        let center_mean = mean_at(w as i64 / 2, h as i64 / 2, 20);
        // The four image corners: unambiguous background, far from the disk.
        let corner_mean = (mean_at(10, 10, 8)
            + mean_at(w as i64 - 10, 10, 8)
            + mean_at(10, h as i64 - 10, 8)
            + mean_at(w as i64 - 10, h as i64 - 10, 8))
            / 4.0;

        println!(
            "real u2netp inference: center mask mean = {center_mean:.1}, corner mask mean = \
             {corner_mean:.1} (0..255)"
        );
        assert!(
            center_mean > corner_mean + 40.0,
            "expected the subject region to score clearly higher than background corners; \
             center={center_mean:.1} corner={corner_mean:.1}"
        );
    }
}
