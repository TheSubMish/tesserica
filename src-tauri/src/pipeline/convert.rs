//! The pipeline driver — stage order per `docs/04-image-pipeline.md` §2.
//!
//! Mirrors `src/pipeline/convert.ts`.
//!
//! ```text
//!   [1] background removal   flood-fill (§8.5) OR ML segmentation (§8);
//!                            see below — ML runs *outside* this function
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
//!
//! **This function only ever runs the flood-fill method itself.** ML
//! segmentation (`crate::segment::Segmenter`) needs an ONNX Runtime session,
//! which this module deliberately has no dependency on — `pipeline` stays
//! free of `ort` the same way `segment`'s own doc comment isolates `ort` from
//! the rest of the app. `commands::source::export_conversion` (the only
//! caller with access to the app-managed `Segmenter`) runs stage [1] itself
//! when `settings.background_removal.method` is `Ml` — segment, mask,
//! post-process — *before* calling this function with `background_removal`
//! cleared, so the mask still lands at exactly the same point in the fixed
//! stage order, just orchestrated one level up.

use super::adjust::{self, AdjustParams};
use super::autopalette::auto_palette;
use super::background_removal::remove_background_flood_fill;
use super::buffer::PixelBuffer;
use super::cleanup;
use super::crop;
use super::dither;
use super::downscale::downscale;
use super::mask_post_process::post_process_mask;
use super::quantize::{
    self, AlphaPolicy, NearestCache, PreparedPalette, QuantizeResult, TRANSPARENT_INDEX,
};
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

/// Resolve the settings' palette against the image being converted.
///
/// `Auto` is derived from the **downscaled** image, not the source: those are
/// the colours that will actually be quantized, and choosing against the source
/// would spend palette entries on detail the downscale is about to average away.
pub fn resolve_palette(
    spec: &PaletteSpec,
    image: &PixelBuffer,
    alpha_threshold: u8,
) -> Result<PreparedPalette, String> {
    match spec {
        PaletteSpec::Fixed { colors } => quantize::prepare_palette(colors.clone()),
        PaletteSpec::Auto { max_colors } => {
            quantize::prepare_palette(auto_palette(image, *max_colors, alpha_threshold)?)
        }
    }
}

/// Stage [5]'s dispatcher.
///
/// `color_space` reaches only the undithered path: §5.1 says the error-diffusion
/// working buffer is in Oklab, unconditionally, and ordered dithering shares
/// that buffer's units so that `spread` means one thing.
pub fn quantize_with_dither(
    image: &PixelBuffer,
    palette: &PreparedPalette,
    policy: AlphaPolicy,
    settings: &ConvertSettings,
) -> Result<QuantizeResult, String> {
    let strength = settings.dither_strength;
    match settings.dither {
        DitherMode::None => quantize::quantize_none(
            image,
            palette,
            settings.color_space,
            policy,
            Some(&mut NearestCache::new(1)),
        ),
        // The two error-diffusion modes deliberately get no cache (§4.2), and
        // could not use one: their lookups are on arbitrary Oklab floats, not on
        // a colour with a 24-bit key.
        DitherMode::FloydSteinberg => dither::quantize_error_diffusion(
            image,
            palette,
            policy,
            dither::FLOYD_STEINBERG,
            strength,
        ),
        DitherMode::Atkinson => {
            dither::quantize_error_diffusion(image, palette, policy, dither::ATKINSON, strength)
        }
        DitherMode::Bayer2 => dither::quantize_ordered(
            image,
            palette,
            policy,
            2,
            strength,
            Some(&mut NearestCache::new(4)),
        ),
        DitherMode::Bayer4 => dither::quantize_ordered(
            image,
            palette,
            policy,
            4,
            strength,
            Some(&mut NearestCache::new(16)),
        ),
        DitherMode::Bayer8 => dither::quantize_ordered(
            image,
            palette,
            policy,
            8,
            strength,
            Some(&mut NearestCache::new(64)),
        ),
    }
}

pub fn convert(source: &PixelBuffer, settings: &ConvertSettings) -> Result<ConvertResult, String> {
    // [1] background removal — flood-fill only (§8.5); ML runs one level up
    // in `commands::source::export_conversion`, see the module doc comment
    // — then mask post-processing (§8.3 step 5: threshold, close, feather)
    let removed = settings.background_removal.as_ref().map(|bg| {
        let mask = remove_background_flood_fill(source, bg);
        post_process_mask(&mask, bg)
    });
    let source = removed.as_ref().unwrap_or(source);

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
    let palette = resolve_palette(&settings.palette, &image, settings.alpha_threshold)?;
    let policy = AlphaPolicy::from_settings(settings);
    let quantized = quantize_with_dither(&image, &palette, policy, settings)?;

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
    fn an_auto_palette_produces_indices_inside_the_palette_it_chose() {
        let mut src = PixelBuffer::new(32, 32).unwrap();
        for (p, px) in src.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[(p * 5) as u8, (p * 11) as u8, (p * 17) as u8, 255]);
        }
        let settings = ConvertSettings::new(8, 8, PaletteSpec::Auto { max_colors: 6 });
        let out = convert(&src, &settings).unwrap();

        assert!(out.palette.colors.len() <= 6);
        for &i in &out.indices {
            if i != TRANSPARENT_INDEX {
                assert!((i as usize) < out.palette.colors.len());
            }
        }
    }

    #[test]
    fn every_dither_mode_runs_and_stays_inside_the_palette() {
        let src = solid(16, 16, [128, 128, 128, 255]);
        for mode in [
            DitherMode::None,
            DitherMode::FloydSteinberg,
            DitherMode::Atkinson,
            DitherMode::Bayer2,
            DitherMode::Bayer4,
            DitherMode::Bayer8,
        ] {
            let mut settings = ConvertSettings::new(8, 8, two_colors());
            settings.dither = mode;
            let out = convert(&src, &settings).unwrap();
            assert!(
                out.indices.iter().all(|&i| (i as usize) < 2),
                "{mode:?} produced an index outside the palette"
            );
        }
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
    fn background_removal_runs_before_crop_and_fit_to_subject() {
        // A 4x4 opaque white image with a 2x2 black square at its centre.
        // Without background removal, fit-to-subject sees the whole image as
        // opaque and does nothing; with it, the flood clears the white border
        // first and fit-to-subject can crop down to just the black square.
        let mut src = solid(4, 4, [255, 255, 255, 255]);
        for y in 1..=2u32 {
            for x in 1..=2u32 {
                let o = src.offset(x, y);
                src.data[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        let mut settings = ConvertSettings::new(2, 2, two_colors());
        settings.downscale_mode = DownscaleMode::Nearest;
        settings.fit_to_subject = true;
        settings.background_removal = Some(
            crate::pipeline::settings::BackgroundRemovalSettings::new(0.02),
        );

        let out = convert(&src, &settings).unwrap();
        assert!(out.indices.iter().all(|&i| i == 0));
    }

    #[test]
    fn mask_post_processing_close_seals_a_flood_fill_breach_before_quantization() {
        // A 6x6 image: white background, a black 4x4 "ring" (rows/cols 1..=4)
        // enclosing a white 2x2 interior pocket at (2,2)-(3,3), connected to
        // the true exterior background only through a single white 1px gap
        // in the ring's otherwise-solid wall. The corner flood walks in
        // through that one gap and clears the interior pocket to alpha 0 too
        // — a realistic flood-fill artifact (a thin breach in what should be
        // a closed boundary), not a deliberately isolated island.
        //
        // The ring sits with a 3px margin from every canvas edge — wider
        // than the radius-2 close below reaches — so the "far background"
        // check point is unaffected by the closing pass *or* by the corner
        // boundary condition `morphological_close` uses (missing neighbours
        // treated as opaque during erosion), which only matters within
        // `radius` pixels of the canvas edge.
        let mut src = solid(12, 12, [255, 255, 255, 255]);
        for y in 3..=6u32 {
            for x in 3..=6u32 {
                let interior = (4..=5).contains(&x) && (4..=5).contains(&y);
                let gap = x == 3 && y == 4;
                if !interior && !gap {
                    let o = src.offset(x, y);
                    src.data[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
                }
            }
        }

        let palette = PaletteSpec::Fixed {
            colors: vec![[0, 0, 0, 255], [255, 255, 255, 255]],
        };
        let mut settings = ConvertSettings::new(12, 12, palette);
        settings.downscale_mode = DownscaleMode::Nearest;

        // Without any post-processing, the flood's breach reaches the
        // pocket: it comes out transparent.
        settings.background_removal = Some(
            crate::pipeline::settings::BackgroundRemovalSettings::new(0.0),
        );
        let without_close = convert(&src, &settings).unwrap();
        assert_eq!(
            without_close.indices[12 * 4 + 4],
            TRANSPARENT_INDEX,
            "the interior pocket must start out transparent, or this test proves nothing"
        );

        // With a close radius wide enough to bridge the 1px breach, the
        // pocket is sealed back up before quantization ever sees it.
        settings.background_removal = Some(crate::pipeline::settings::BackgroundRemovalSettings {
            method: crate::pipeline::settings::BackgroundRemovalMethod::FloodFill,
            tolerance: 0.0,
            threshold: None,
            close: 2,
            feather: 0,
        });
        let with_close = convert(&src, &settings).unwrap();
        assert_ne!(
            with_close.indices[12 * 4 + 4],
            TRANSPARENT_INDEX,
            "close must have sealed the breach before quantization"
        );

        // A real, unambiguous background pixel far from the ring (the
        // canvas corner, 6px away from the nearest ring cell) must still
        // read transparent either way — closing must not have grown into
        // it.
        assert_eq!(without_close.indices[0], TRANSPARENT_INDEX);
        assert_eq!(with_close.indices[0], TRANSPARENT_INDEX);
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
