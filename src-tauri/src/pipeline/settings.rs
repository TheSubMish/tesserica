//! `ConvertSettings` — the parameter struct for the whole pipeline
//! (`docs/04-image-pipeline.md` §2.2).
//!
//! Mirrors `src/pipeline/settings.ts` field for field, `camelCase` on the wire
//! in both directions.
//!
//! The pipeline deliberately defines its own `Rgba` rather than reaching into
//! `crate::model`: this code runs standalone here and again, independently, in a
//! Web Worker, and it should not acquire a dependency on the document model to
//! do it.

use serde::{Deserialize, Serialize};

pub type Rgba = [u8; 4];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DitherMode {
    None,
    FloydSteinberg,
    Atkinson,
    Bayer2,
    Bayer4,
    Bayer8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownscaleMode {
    Box,
    Nearest,
    Dominant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorSpace {
    Oklab,
    Srgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSettings {
    pub color: Rgba,
    /// In output pixels.
    pub thickness: u32,
    /// 8-connectivity when true (rounder corners), 4-connectivity when false.
    pub corners: bool,
}

/// Which algorithm produces stage [1]'s mask (`docs/04` §8).
///
/// `FloodFill` needs no model and runs identically in both the TS preview
/// worker and the Rust export pipeline (`pipeline::background_removal`).
/// `Ml` runs the real `u2netp` ONNX model (`crate::segment::Segmenter`) —
/// Rust-only, since there is no ONNX runtime in the browser/worker; the TS
/// mirror (`src/pipeline/convert.ts`) treats this variant as a no-op at
/// preview time rather than silently substituting flood-fill, which would
/// show a result export would not reproduce (`ConvertPanel` surfaces this
/// explicitly next to the toggle).
///
/// `#[serde(default)]` (below, on `BackgroundRemovalSettings::method`) keeps
/// every settings blob saved before this field existed loading as
/// `FloodFill`, its behaviour unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundRemovalMethod {
    #[default]
    FloodFill,
    Ml,
}

/// Stage [1]'s settings (`docs/04` §8) — which method (flood-fill, always
/// available, or ML segmentation, `Ml`) and, for flood-fill, its tolerance.
///
/// `threshold`/`close`/`feather` are the mask post-processing steps §8.3 step 5
/// describes (`pipeline::mask_post_process`), run in that fixed order after
/// *either* method produces its mask — one shared post-processing path, not
/// two. All three are optional/"off by default" — flood-fill's own output is
/// already a clean binary mask, and they are equally applicable to the ML
/// method's softer matte when a caller wants to clean it up too.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRemovalSettings {
    /// Which algorithm produces the mask. Defaults to flood-fill on any
    /// settings blob saved before this field existed.
    #[serde(default)]
    pub method: BackgroundRemovalMethod,
    /// Un-squared Oklab colour distance. Only meaningful for `FloodFill`. A
    /// neighbour joins a corner's flood when it is within this of that
    /// seed's own colour. 0 admits only exact matches; higher values
    /// tolerate more variation (soft shadows, mild gradients) before the
    /// flood stops at an edge.
    pub tolerance: f64,
    /// 0..255. When set, re-binarizes the mask at this cutoff before close and
    /// feather run: alpha below the cutoff goes fully transparent, at or above
    /// goes fully opaque. `None` skips this step entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<u8>,
    /// 0 = off. Structuring-element radius, in pixels, for a dilate-then-erode
    /// closing pass that fills small holes/gaps without growing the mask's
    /// outer boundary.
    #[serde(default)]
    pub close: u32,
    /// 0 = off. Box-blur radius, in pixels, applied to the alpha channel only,
    /// that softens the mask's edge instead of a hard aliased cutoff.
    #[serde(default)]
    pub feather: u32,
}

impl BackgroundRemovalSettings {
    /// Just the flood-fill tolerance, with every post-processing step off —
    /// the shape every call site before this change already assumed.
    pub fn new(tolerance: f64) -> Self {
        Self {
            method: BackgroundRemovalMethod::FloodFill,
            tolerance,
            threshold: None,
            close: 0,
            feather: 0,
        }
    }
}

/// Where the palette comes from.
///
/// `docs/04` §2.2 writes this as "a fixed palette, or `'auto'` with maxColors".
/// A tagged union makes both halves explicit and makes `auto` (§4.3) an
/// extension rather than a special case threaded through every call site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PaletteSpec {
    Fixed {
        colors: Vec<Rgba>,
    },
    #[serde(rename_all = "camelCase")]
    Auto {
        max_colors: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertSettings {
    // [1] background removal — flood-fill fallback only; see BackgroundRemovalSettings
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_removal: Option<BackgroundRemovalSettings>,

    // [2] framing
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<CropRect>,
    /// Crop to the bounding box of what is opaque.
    ///
    /// `docs/04` §8.5 describes this against a segmentation mask. Until Phase 5
    /// produces one, the source's own alpha *is* the mask — exactly right for a
    /// source that already has alpha, and a no-op for one that does not.
    pub fit_to_subject: bool,

    // [3] adjustments — all neutral at 0
    /// -1..1
    pub brightness: f64,
    /// -1..1
    pub contrast: f64,
    /// -1..1
    pub saturation: f64,
    /// -180..180 degrees
    pub hue_shift: f64,

    // [4] downscale
    pub target_width: u32,
    pub target_height: u32,
    pub downscale_mode: DownscaleMode,

    // [5] quantize
    pub palette: PaletteSpec,
    pub dither: DitherMode,
    /// 0..1
    pub dither_strength: f64,
    pub color_space: ColorSpace,

    // [6] cleanup
    /// 0..3; regions of this area or smaller are absorbed. 0 = off.
    pub despeckle: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<OutlineSettings>,

    // alpha (§4.4)
    /// 0..255. Below this, a pixel becomes fully transparent and is not quantized.
    pub alpha_threshold: u8,
    /// Keep the source's alpha for pixels at or above the threshold, instead of
    /// snapping them to fully opaque. Off by default — pixel art is usually
    /// 1-bit alpha (`docs/04` §4.4).
    pub preserve_alpha: bool,
}

impl ConvertSettings {
    /// Neutral settings: nothing adjusted, box downscale, no dither, no cleanup.
    ///
    /// Callers must still supply a palette and a target size, which is why this
    /// takes both rather than being a `Default` impl.
    pub fn new(target_width: u32, target_height: u32, palette: PaletteSpec) -> Self {
        Self {
            background_removal: None,
            crop: None,
            fit_to_subject: false,
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            hue_shift: 0.0,
            target_width,
            target_height,
            downscale_mode: DownscaleMode::Box,
            palette,
            dither: DitherMode::None,
            dither_strength: 1.0,
            color_space: ColorSpace::Oklab,
            despeckle: 0,
            outline: None,
            alpha_threshold: 128,
            preserve_alpha: false,
        }
    }
}

/// Target dimensions from a single "pixel size" control (`docs/04` §3.2).
///
/// The user thinks "how big are the blocks", not "what are my output
/// dimensions". Never smaller than 1×1.
pub fn target_size_for_pixel_size(
    source_width: u32,
    source_height: u32,
    pixel_size: f64,
) -> Result<(u32, u32), String> {
    // NaN must be rejected too, hence the explicit test rather than `!(x > 0)`
    // — which clippy reads as an accidental negated comparison.
    if pixel_size.is_nan() || pixel_size <= 0.0 {
        return Err(format!("pixelSize must be > 0, got {pixel_size}"));
    }
    let w = (source_width as f64 / pixel_size).round().max(1.0) as u32;
    let h = (source_height as f64 / pixel_size).round().max(1.0) as u32;
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_camel_case_on_the_wire() {
        let s = ConvertSettings::new(
            32,
            32,
            PaletteSpec::Fixed {
                colors: vec![[0, 0, 0, 255]],
            },
        );
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(json.contains("\"fitToSubject\""), "{json}");
        assert!(json.contains("\"targetWidth\""), "{json}");
        assert!(json.contains("\"downscaleMode\":\"box\""), "{json}");
        assert!(json.contains("\"alphaThreshold\""), "{json}");
        assert!(json.contains("\"preserveAlpha\""), "{json}");
        assert!(json.contains("\"dither\":\"none\""), "{json}");
    }

    #[test]
    fn dither_modes_use_the_documented_wire_names() {
        assert_eq!(
            serde_json::to_string(&DitherMode::FloydSteinberg).unwrap(),
            "\"floyd-steinberg\""
        );
        assert_eq!(
            serde_json::to_string(&DitherMode::Bayer4).unwrap(),
            "\"bayer4\""
        );
    }

    #[test]
    fn palette_spec_round_trips_through_the_tagged_union() {
        let auto = PaletteSpec::Auto { max_colors: 16 };
        let json = serde_json::to_string(&auto).unwrap();
        assert_eq!(json, r#"{"kind":"auto","maxColors":16}"#);
        assert_eq!(serde_json::from_str::<PaletteSpec>(&json).unwrap(), auto);
    }

    #[test]
    fn pixel_size_never_produces_a_zero_dimension() {
        assert_eq!(target_size_for_pixel_size(100, 50, 8.0), Ok((13, 6)));
        assert_eq!(target_size_for_pixel_size(10, 10, 1000.0), Ok((1, 1)));
        assert!(target_size_for_pixel_size(10, 10, 0.0).is_err());
    }
}
