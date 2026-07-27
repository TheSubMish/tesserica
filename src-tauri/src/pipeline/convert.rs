//! The pipeline driver — stage order per `docs/04-image-pipeline.md` §2.
//!
//! Mirrors `src/pipeline/convert.ts`.
//!
//! ```text
//!   [1] background removal   Rust only, Phase 5 — not yet in the chain
//!   [2] crop / fit-to-subject
//!   [3] colour adjustments   BEFORE quantization, deliberately (§2.1)
//!   [4] downscale to grid
//!   [5] quantize + dither
//!   [6] cleanup
//! ```
//!
//! **The order is fixed and identical in both implementations.** It is not a
//! default that a caller may vary: adjusting after quantization pushes colours
//! off the palette and forces a second mapping, compounding error.

use super::adjust::{self, AdjustParams};
use super::buffer::PixelBuffer;
use super::cleanup;
use super::crop;
use super::downscale::downscale;
use super::quantize::{self, AlphaPolicy, PreparedPalette, QuantizeResult, TRANSPARENT_INDEX};
use super::settings::{ConvertSettings, DitherMode, PaletteSpec};

#[derive(Debug, Clone)]
pub struct ConvertResult {
    pub image: PixelBuffer,
    /// One entry per output pixel; `TRANSPARENT_INDEX` where transparent.
    pub indices: Vec<u16>,
    /// The palette actually used — the resolved one when `palette` was `auto`.
    pub palette: PreparedPalette,
}

/// Padding added around the subject's bounding box by `fit_to_subject`.
///
/// `docs/04` §8.5 says "add padding" without naming an amount, and §2.2 has no
/// field for it. Zero is the smallest thing that is not wrong; when a control
/// for it appears, it belongs in `ConvertSettings`.
pub const FIT_TO_SUBJECT_PADDING: i64 = 0;

pub fn resolve_palette(
    spec: &PaletteSpec,
    _source: &PixelBuffer,
) -> Result<PreparedPalette, String> {
    match spec {
        PaletteSpec::Fixed { colors } => quantize::prepare_palette(colors.clone()),
        // §4.3 — Wu followed by k-means in Oklab. Lands with the auto-palette
        // step; until then this is an explicit failure rather than a silent
        // fallback to some other palette, which would diverge preview from
        // export.
        PaletteSpec::Auto { .. } => {
            Err("auto palette is not implemented yet (docs/04 §4.3)".to_string())
        }
    }
}

pub fn convert(source: &PixelBuffer, settings: &ConvertSettings) -> Result<ConvertResult, String> {
    // [2] framing
    let mut image = match settings.crop {
        Some(rect) => crop::crop(source, rect)?,
        None => source.clone(),
    };
    if settings.fit_to_subject {
        image = crop::fit_to_subject(&image, settings.alpha_threshold, FIT_TO_SUBJECT_PADDING)?;
    }

    // [3] adjustments — before quantization (§2.1)
    image = adjust::apply_adjustments(&image, AdjustParams::from_settings(settings))?;

    // [4] downscale
    image = downscale(
        &image,
        settings.target_width,
        settings.target_height,
        settings.downscale_mode,
    )?;

    // [5] quantize + dither
    let palette = resolve_palette(&settings.palette, &image)?;
    let policy = AlphaPolicy::from_settings(settings);
    let quantized: QuantizeResult = match settings.dither {
        DitherMode::None => {
            quantize::quantize_none(&image, &palette, settings.color_space, policy)?
        }
        // The dither modes land with the dithering module (§5); until then an
        // unimplemented mode fails loudly rather than silently producing
        // undithered output the user did not ask for.
        other => {
            return Err(format!(
                "dither mode {other:?} is not implemented yet (docs/04 §5)"
            ))
        }
    };

    // [6] cleanup
    let mut indices = quantized.indices;
    let mut alpha = extract_alpha(&quantized.image);

    if settings.despeckle > 0 {
        indices = cleanup::despeckle(image.width, image.height, &indices, settings.despeckle);
        alpha = alpha_for_indices(&indices, &alpha);
    }

    if let Some(outline_settings) = &settings.outline {
        let (i, a) = cleanup::outline(
            image.width,
            image.height,
            &indices,
            &alpha,
            &palette,
            outline_settings,
        );
        indices = i;
        alpha = a;
    }

    Ok(ConvertResult {
        image: quantize::render_indices(image.width, image.height, &indices, &palette, &alpha)?,
        indices,
        palette,
    })
}

fn extract_alpha(image: &PixelBuffer) -> Vec<u8> {
    image.data.chunks_exact(4).map(|px| px[3]).collect()
}

/// Reconcile alpha with an index map that despeckle just changed.
///
/// A pixel that was transparent and became a colour needs an alpha, and one that
/// went the other way needs zero. With `preserve_alpha` off there is one answer
/// (255); with it on there is no source value to restore for a pixel that was
/// transparent, so 255 is the only honest choice there too.
fn alpha_for_indices(indices: &[u16], alpha: &[u8]) -> Vec<u8> {
    indices
        .iter()
        .zip(alpha)
        .map(|(&idx, &a)| {
            if idx == TRANSPARENT_INDEX {
                0
            } else if a == 0 {
                255
            } else {
                a
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::settings::{DownscaleMode, OutlineSettings};

    fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelBuffer {
        let mut b = PixelBuffer::new(width, height).unwrap();
        for px in b.data.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        b
    }

    fn two_colors() -> PaletteSpec {
        PaletteSpec::Fixed {
            colors: vec![[0, 0, 0, 255], [255, 255, 255, 255]],
        }
    }

    #[test]
    fn a_white_image_converts_to_the_white_palette_entry() {
        let src = solid(8, 8, [255, 255, 255, 255]);
        let settings = ConvertSettings::new(4, 4, two_colors());
        let out = convert(&src, &settings).unwrap();
        assert_eq!((out.image.width, out.image.height), (4, 4));
        assert!(out.indices.iter().all(|&i| i == 1));
        assert_eq!(&out.image.data[0..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn transparent_source_stays_transparent_all_the_way_through() {
        let src = solid(8, 8, [0, 255, 0, 0]);
        let settings = ConvertSettings::new(4, 4, two_colors());
        let out = convert(&src, &settings).unwrap();
        assert!(out.indices.iter().all(|&i| i == TRANSPARENT_INDEX));
        assert!(out.image.data.chunks_exact(4).all(|px| px[3] == 0));
    }

    #[test]
    fn adjustments_run_before_quantization() {
        // sRGB 90 is Oklab L≈0.447, so it sits nearer black in this palette;
        // brightening first must flip it to white. If adjustments ran after
        // quantization it could not.
        let src = solid(4, 4, [90, 90, 90, 255]);
        let mut settings = ConvertSettings::new(2, 2, two_colors());
        settings.downscale_mode = DownscaleMode::Nearest;

        let plain = convert(&src, &settings).unwrap();
        assert!(plain.indices.iter().all(|&i| i == 0));

        settings.brightness = 0.9;
        let bright = convert(&src, &settings).unwrap();
        assert!(bright.indices.iter().all(|&i| i == 1));
    }

    #[test]
    fn auto_palette_fails_loudly_rather_than_silently_substituting_one() {
        let src = solid(4, 4, [1, 2, 3, 255]);
        let settings = ConvertSettings::new(2, 2, PaletteSpec::Auto { max_colors: 8 });
        assert!(convert(&src, &settings).is_err());
    }

    #[test]
    fn an_unimplemented_dither_mode_fails_loudly() {
        let src = solid(4, 4, [1, 2, 3, 255]);
        let mut settings = ConvertSettings::new(2, 2, two_colors());
        settings.dither = DitherMode::Atkinson;
        assert!(convert(&src, &settings).is_err());
    }

    #[test]
    fn despeckle_runs_after_quantization() {
        // A 5x5 white field with one black pixel, converted 1:1. Despeckle must
        // absorb the black pixel.
        let mut src = solid(5, 5, [255, 255, 255, 255]);
        let o = src.offset(2, 2);
        src.data[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);

        let mut settings = ConvertSettings::new(5, 5, two_colors());
        settings.downscale_mode = DownscaleMode::Nearest;

        let without = convert(&src, &settings).unwrap();
        assert_eq!(without.indices[12], 0);

        settings.despeckle = 1;
        let with = convert(&src, &settings).unwrap();
        assert_eq!(with.indices[12], 1);
    }

    #[test]
    fn outline_runs_last_and_lands_on_transparent_pixels() {
        let mut src = solid(3, 3, [0, 0, 0, 0]);
        let o = src.offset(1, 1);
        src.data[o..o + 4].copy_from_slice(&[255, 255, 255, 255]);

        let mut settings = ConvertSettings::new(3, 3, two_colors());
        settings.downscale_mode = DownscaleMode::Nearest;
        settings.outline = Some(OutlineSettings {
            color: [0, 0, 0, 255],
            thickness: 1,
            corners: true,
        });

        let out = convert(&src, &settings).unwrap();
        assert_eq!(out.indices[4], 1, "subject untouched");
        assert!(out.indices.iter().all(|&i| i != TRANSPARENT_INDEX));
        assert_eq!(&out.image.data[0..4], &[0, 0, 0, 255]);
    }

    #[test]
    fn crop_narrows_the_source_before_anything_else() {
        let mut src = solid(4, 2, [0, 0, 0, 255]);
        for x in 2..4u32 {
            for y in 0..2u32 {
                let o = src.offset(x, y);
                src.data[o..o + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        let mut settings = ConvertSettings::new(2, 2, two_colors());
        settings.downscale_mode = DownscaleMode::Nearest;
        settings.crop = Some(crate::pipeline::settings::CropRect {
            x: 2,
            y: 0,
            w: 2,
            h: 2,
        });
        let out = convert(&src, &settings).unwrap();
        assert!(out.indices.iter().all(|&i| i == 1));
    }
}
