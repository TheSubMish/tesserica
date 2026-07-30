//! Stage [1]'s post-processing on whatever earlier step produced a mask —
//! today that is only the flood-fill fallback (`background_removal.rs`), later
//! it will also be a real ONNX segmentation model's matte
//! (`docs/04-image-pipeline.md` §8.3 step 5: "threshold, morphological close to
//! fill holes, optional feather").
//!
//! Mirrors `src/pipeline/maskPostProcess.ts`.
//!
//! All three operate on the **alpha channel only**. Straight alpha
//! (`docs/02-architecture.md` §9) never needs a transparent pixel's RGB to
//! change, and none of these transforms are colour operations — Oklab
//! (`CLAUDE.md` invariant 5) is for colour *distance*, which is not what a mask
//! edge is.
//!
//! `post_process_mask` runs the three in the fixed order §8.3 lists them in —
//! threshold, then close, then feather — and each is independently optional so
//! a mask that is already exactly what a caller wants (the flood-fill
//! fallback's own binary output, with no holes) is untouched by default.

use super::buffer::PixelBuffer;
use super::settings::BackgroundRemovalSettings;

/// Binarize the alpha channel at `cutoff` (§8.3 step 5): alpha below the cutoff
/// becomes fully transparent, alpha at or above becomes fully opaque.
///
/// "Below" is exclusive, matching the existing `alpha_threshold` convention
/// (`quantize.rs`) — a cutoff of 0 still does something (any nonzero alpha
/// snaps up to fully opaque) rather than being a silent no-op.
pub fn threshold_mask(image: &PixelBuffer, cutoff: u8) -> PixelBuffer {
    let mut out = image.data.clone();
    for px in out.chunks_exact_mut(4) {
        px[3] = if px[3] < cutoff { 0 } else { 255 };
    }
    PixelBuffer {
        width: image.width,
        height: image.height,
        data: out,
    }
}

/// Dilate the alpha channel by one pixel, 4-connected — the same connectivity
/// `background_removal.rs`'s own flood and `cleanup.rs`'s despeckle use, for
/// the same reason: 8-connectivity would leak through a diagonal gap a person
/// would read as a separating edge.
///
/// Grayscale (max over the neighbourhood), not a hard binary rule, so a soft
/// mask's untouched interior keeps its real alpha value rather than being
/// forced to 0/255 everywhere. A missing (out-of-bounds) neighbour simply does
/// not enter the max — equivalent to treating the world outside the canvas as
/// "nothing here to grow from", which is dilation's correct identity.
fn dilate_alpha(alpha: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = alpha.to_vec();
    for y in 0..height {
        for x in 0..width {
            let p = y * width + x;
            let mut v = alpha[p];
            if x > 0 {
                v = v.max(alpha[p - 1]);
            }
            if x + 1 < width {
                v = v.max(alpha[p + 1]);
            }
            if y > 0 {
                v = v.max(alpha[p - width]);
            }
            if y + 1 < height {
                v = v.max(alpha[p + width]);
            }
            out[p] = v;
        }
    }
    out
}

/// Erode the alpha channel by one pixel, the inverse of [`dilate_alpha`] (min
/// over the 4-connected neighbourhood).
///
/// A missing neighbour is treated as fully opaque (255), not 0 — the standard
/// boundary condition for the *second* half of a closing pass: dilation
/// already used "nothing outside the canvas" as its identity, so erosion has
/// to use the opposite one, or closing would erode real content sitting at the
/// image's own edge on every pass.
fn erode_alpha(alpha: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = alpha.to_vec();
    for y in 0..height {
        for x in 0..width {
            let p = y * width + x;
            let mut v = alpha[p];
            v = v.min(if x > 0 { alpha[p - 1] } else { 255 });
            v = v.min(if x + 1 < width { alpha[p + 1] } else { 255 });
            v = v.min(if y > 0 { alpha[p - width] } else { 255 });
            v = v.min(if y + 1 < height {
                alpha[p + width]
            } else {
                255
            });
            out[p] = v;
        }
    }
    out
}

/// Morphological close (§8.3 step 5): `radius` dilations followed by `radius`
/// erosions. Fills holes and gaps up to about `2 * radius` pixels across
/// without permanently growing the mask's outer boundary — the dilation and
/// erosion counts match exactly, so a region's true edge returns to where it
/// started; only a hole small enough to be swallowed by the dilation, and
/// whose surroundings stay opaque through the matching erosion, stays filled.
///
/// `radius == 0` is a no-op (0 is "off", matching `despeckle`'s own 0-off
/// convention).
pub fn morphological_close(image: &PixelBuffer, radius: u32) -> PixelBuffer {
    if radius == 0 {
        return image.clone();
    }
    let (w, h) = (image.width as usize, image.height as usize);
    let mut alpha: Vec<u8> = image.data.chunks_exact(4).map(|px| px[3]).collect();
    for _ in 0..radius {
        alpha = dilate_alpha(&alpha, w, h);
    }
    for _ in 0..radius {
        alpha = erode_alpha(&alpha, w, h);
    }
    with_alpha(image, &alpha)
}

/// One-dimensional box blur along image rows, edge-clamped by *shrinking* the
/// window rather than replicating a border value: a pixel `radius` from the
/// edge averages over however many real neighbours exist, not over a padded
/// fiction. That keeps a mask that runs up against the canvas edge from
/// softening at the canvas border itself — only a real internal edge feathers.
///
/// Implemented with a running prefix sum so the cost is `O(width)` per row
/// regardless of `radius`, since this runs at source resolution (before
/// downscale) and a naive `O(width * radius)` scan would be the slow way to
/// get the same numbers.
fn box_blur_rows(alpha: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut out = vec![0u8; alpha.len()];
    let mut prefix = vec![0f64; width + 1];
    for y in 0..height {
        let base = y * width;
        prefix[0] = 0.0;
        for x in 0..width {
            prefix[x + 1] = prefix[x] + alpha[base + x] as f64;
        }
        for x in 0..width {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius).min(width - 1);
            let count = (hi - lo + 1) as f64;
            let sum = prefix[hi + 1] - prefix[lo];
            out[base + x] = (sum / count).round() as u8;
        }
    }
    out
}

/// Same as [`box_blur_rows`], along columns instead.
fn box_blur_cols(alpha: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut out = vec![0u8; alpha.len()];
    let mut prefix = vec![0f64; height + 1];
    for x in 0..width {
        prefix[0] = 0.0;
        for y in 0..height {
            prefix[y + 1] = prefix[y] + alpha[y * width + x] as f64;
        }
        for y in 0..height {
            let lo = y.saturating_sub(radius);
            let hi = (y + radius).min(height - 1);
            let count = (hi - lo + 1) as f64;
            let sum = prefix[hi + 1] - prefix[lo];
            out[y * width + x] = (sum / count).round() as u8;
        }
    }
    out
}

/// Feather the mask edge (§8.3 step 5, "optional feather"): a separable box
/// blur of the alpha channel over `radius` pixels, softening a hard aliased
/// cutout into a gradient instead. `radius == 0` is a no-op.
///
/// A box blur, not a Gaussian: `docs/04` names no specific kernel, and a box
/// blur is the smallest reasonable thing that produces a real falloff, is
/// exact integer arithmetic (no `libm` divergence risk between languages,
/// unlike Oklab), and is already the shape this codebase reaches for
/// elsewhere (alpha-weighted box downscale, §4's own box mode).
pub fn feather_mask(image: &PixelBuffer, radius: u32) -> PixelBuffer {
    if radius == 0 {
        return image.clone();
    }
    let (w, h) = (image.width as usize, image.height as usize);
    let alpha: Vec<u8> = image.data.chunks_exact(4).map(|px| px[3]).collect();
    let horizontal = box_blur_rows(&alpha, w, h, radius as usize);
    let both = box_blur_cols(&horizontal, w, h, radius as usize);
    with_alpha(image, &both)
}

/// Run threshold, then close, then feather — whichever are configured — in
/// that fixed order (§8.3 step 5). Each is skipped entirely when left at its
/// "off" value, so a `BackgroundRemovalSettings` with none of the three set is
/// a complete no-op, byte for byte.
pub fn post_process_mask(image: &PixelBuffer, settings: &BackgroundRemovalSettings) -> PixelBuffer {
    let mut out = image.clone();
    if let Some(cutoff) = settings.threshold {
        out = threshold_mask(&out, cutoff);
    }
    if settings.close > 0 {
        out = morphological_close(&out, settings.close);
    }
    if settings.feather > 0 {
        out = feather_mask(&out, settings.feather);
    }
    out
}

fn with_alpha(image: &PixelBuffer, alpha: &[u8]) -> PixelBuffer {
    let mut out = image.data.clone();
    for (i, px) in out.chunks_exact_mut(4).enumerate() {
        px[3] = alpha[i];
    }
    PixelBuffer {
        width: image.width,
        height: image.height,
        data: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelBuffer {
        let mut b = PixelBuffer::new(width, height).unwrap();
        for px in b.data.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        b
    }

    fn alpha_at(image: &PixelBuffer, x: u32, y: u32) -> u8 {
        image.data[image.offset(x, y) + 3]
    }

    // --- threshold ---

    #[test]
    fn threshold_is_exclusive_below_and_inclusive_at_the_cutoff() {
        let mut image = solid(3, 1, [1, 2, 3, 0]);
        let (o0, o1, o2) = (image.offset(0, 0), image.offset(1, 0), image.offset(2, 0));
        image.data[o0 + 3] = 127;
        image.data[o1 + 3] = 128;
        image.data[o2 + 3] = 200;

        let out = threshold_mask(&image, 128);
        assert_eq!(alpha_at(&out, 0, 0), 0, "127 is below 128: transparent");
        assert_eq!(alpha_at(&out, 1, 0), 255, "128 is at the cutoff: opaque");
        assert_eq!(alpha_at(&out, 2, 0), 255, "200 is above: opaque");
    }

    #[test]
    fn threshold_leaves_rgb_untouched() {
        let mut image = solid(1, 1, [10, 20, 30, 5]);
        image.data[3] = 5;
        let out = threshold_mask(&image, 128);
        assert_eq!(&out.data[0..3], &[10, 20, 30]);
    }

    #[test]
    fn a_threshold_of_zero_makes_everything_opaque_since_nothing_is_below_zero() {
        // A degenerate but real case worth pinning down: with `cutoff == 0`,
        // "below the cutoff" can never be true, so even a fully transparent
        // source pixel becomes opaque. That is "below is exclusive" doing
        // exactly what it says, not a special no-op case for zero.
        let image = solid(2, 1, [0, 0, 0, 0]);
        let out = threshold_mask(&image, 0);
        assert_eq!(alpha_at(&out, 0, 0), 255);
        assert_eq!(alpha_at(&out, 1, 0), 255);
    }

    #[test]
    fn a_low_nonzero_threshold_distinguishes_exactly_zero_from_barely_nonzero_alpha() {
        let mut image = solid(2, 1, [0, 0, 0, 0]);
        let o = image.offset(1, 0);
        image.data[o + 3] = 1;
        let out = threshold_mask(&image, 1);
        assert_eq!(alpha_at(&out, 0, 0), 0, "alpha 0 is below cutoff 1");
        assert_eq!(alpha_at(&out, 1, 0), 255, "alpha 1 is at cutoff 1");
    }

    // --- morphological close ---

    #[test]
    fn close_fills_a_single_pixel_hole_fully_enclosed_by_opaque_neighbours() {
        // 5x5 opaque field with a 1-pixel transparent hole at its centre.
        let mut image = solid(5, 5, [255, 255, 255, 255]);
        let o = image.offset(2, 2);
        image.data[o + 3] = 0;

        let out = morphological_close(&image, 1);
        assert_eq!(alpha_at(&out, 2, 2), 255, "the hole must be filled");
    }

    #[test]
    fn close_does_not_grow_the_outer_boundary_of_a_large_region() {
        // A 10x10 fully transparent field with an opaque 4x4 square, itself
        // containing one transparent 1px hole, at its centre. After closing
        // with radius 1, the hole must be gone but the background far from
        // the square (more than 1px away from its boundary) must still read
        // fully transparent — closing must not have expanded the square.
        let mut image = solid(10, 10, [255, 255, 255, 0]);
        for y in 3..7u32 {
            for x in 3..7u32 {
                let o = image.offset(x, y);
                image.data[o + 3] = 255;
            }
        }
        let hole_o = image.offset(4, 4);
        image.data[hole_o + 3] = 0;

        let out = morphological_close(&image, 1);
        assert_eq!(alpha_at(&out, 4, 4), 255, "interior hole filled");
        // Two pixels away from the square's boundary in every direction:
        // must remain untouched background.
        assert_eq!(alpha_at(&out, 0, 0), 0, "far corner must stay transparent");
        assert_eq!(alpha_at(&out, 9, 9), 0, "far corner must stay transparent");
        assert_eq!(
            alpha_at(&out, 1, 5),
            0,
            "2px away from the square's left edge must stay transparent"
        );
    }

    #[test]
    fn close_with_radius_zero_is_a_no_op() {
        let mut image = solid(3, 3, [0, 0, 0, 0]);
        let o = image.offset(1, 1);
        image.data[o + 3] = 200;
        let out = morphological_close(&image, 0);
        assert_eq!(out, image);
    }

    // --- feather ---

    #[test]
    fn feather_produces_a_gradient_spanning_the_configured_radius() {
        // A wide hard edge: opaque left half, transparent right half, wide
        // enough that the blur window never runs off either end of the row.
        let width = 40u32;
        let mut image = PixelBuffer::new(width, 1).unwrap();
        for x in 0..width {
            let o = image.offset(x, 0);
            let a = if x < width / 2 { 255 } else { 0 };
            image.data[o..o + 4].copy_from_slice(&[10, 20, 30, a]);
        }

        let radius = 3u32;
        let out = feather_mask(&image, radius);

        // Far from the edge on either side: unchanged.
        assert_eq!(alpha_at(&out, 2, 0), 255);
        assert_eq!(alpha_at(&out, width - 3, 0), 0);

        // A real gradient across the boundary: strictly decreasing as x
        // increases through the transition band, and every value at the
        // boundary itself is strictly between 0 and 255.
        let edge = width / 2;
        let mut previous = 256i32;
        for dx in -(radius as i32)..=(radius as i32) {
            let x = (edge as i32 + dx).clamp(0, width as i32 - 1) as u32;
            let v = alpha_at(&out, x, 0) as i32;
            assert!(v <= previous, "feather must not increase moving rightward");
            previous = v;
        }
        let midpoint = alpha_at(&out, edge, 0);
        assert!(
            midpoint > 0 && midpoint < 255,
            "the exact edge pixel must be a real blend, got {midpoint}"
        );
    }

    #[test]
    fn feather_with_radius_zero_is_a_no_op() {
        let mut image = solid(4, 4, [0, 0, 0, 0]);
        let o = image.offset(2, 2);
        image.data[o + 3] = 128;
        let out = feather_mask(&image, 0);
        assert_eq!(out, image);
    }

    #[test]
    fn feather_never_softens_at_the_canvas_border_by_itself() {
        // A field that is fully opaque all the way to the image edge: no
        // internal transition exists, so feathering must leave every pixel at
        // full opacity, not decay it toward the (nonexistent) padding.
        let image = solid(6, 6, [1, 2, 3, 255]);
        let out = feather_mask(&image, 2);
        assert!(out.data.chunks_exact(4).all(|px| px[3] == 255));
    }

    // --- ordering ---

    #[test]
    fn post_process_mask_runs_threshold_then_close_then_feather() {
        // A soft mask (alpha 100 everywhere except a fully-opaque 4x4 block
        // with one 1px hole) must first binarize at 128 (dropping the soft
        // 100 background to 0 and the block to 255), then have its hole
        // closed, then get feathered. If threshold ran after close, the
        // close step would be operating on non-binary alpha and the hole
        // might already have blended into the surrounding 100s.
        let mut image = solid(8, 8, [255, 255, 255, 100]);
        for y in 2..6u32 {
            for x in 2..6u32 {
                let o = image.offset(x, y);
                image.data[o + 3] = 255;
            }
        }
        let hole = image.offset(3, 3);
        image.data[hole + 3] = 0;

        let settings = BackgroundRemovalSettings {
            tolerance: 0.0,
            threshold: Some(128),
            close: 1,
            feather: 1,
        };
        let out = post_process_mask(&image, &settings);

        // The background (soft 100, below the 128 cutoff) must have dropped
        // to fully transparent before feathering ran, and the hole in the
        // block must be filled.
        assert_eq!(
            alpha_at(&out, 3, 3),
            255,
            "hole filled after threshold+close"
        );
        assert_eq!(alpha_at(&out, 0, 0), 0, "soft background thresholded away");
    }

    #[test]
    fn post_process_mask_is_a_no_op_when_nothing_is_configured() {
        let mut image = solid(4, 4, [9, 8, 7, 100]);
        let o = image.offset(1, 1);
        image.data[o + 3] = 0;
        let settings = BackgroundRemovalSettings {
            tolerance: 0.02,
            threshold: None,
            close: 0,
            feather: 0,
        };
        let out = post_process_mask(&image, &settings);
        assert_eq!(out, image);
    }
}
