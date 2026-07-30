//! Stage [1] — background removal, flood-fill fallback (`docs/04-image-pipeline.md`
//! §8.5).
//!
//! Mirrors `src/pipeline/backgroundRemoval.ts`.
//!
//! §8.5 names this explicitly: "Non-ML fallback for simple cases: flood-fill from
//! the corners with a color tolerance. Works on flat/studio backgrounds, needs no
//! model, instant." Unlike the ONNX segmentation model §8 otherwise describes —
//! which is Rust-only and a later Phase 5 item — this fallback needs no runtime
//! and is cheap enough to run identically in both the TS preview and the Rust
//! export pipeline, so it lives in the shared stage-order chain rather than being
//! bolted on as a Rust-only step.
//!
//! What makes this more than a naive chroma key: it floods by **connectivity**,
//! not by colour match alone. A red backdrop and a red prop that only touches it
//! at a corner of the *image*, not of each other, are different connected
//! components — only the one reachable from an image corner is cleared.

use super::buffer::PixelBuffer;
use super::oklab::{self, NEAREST_EPSILON};
use super::settings::BackgroundRemovalSettings;

/// Flood-fill background removal.
///
/// Seeds are the image's four corner pixels (deduplicated automatically for a
/// 1-pixel-wide or -tall image, since two corner indices coincide). For each
/// seed not already claimed by an earlier one's flood, walk its 4-connected
/// component — the same connectivity `cleanup.rs::despeckle` uses, for the same
/// reason: an 8-connected flood would leak through a diagonal gap a person
/// would read as a separating edge.
///
/// A neighbour joins the flood when its colour is within `tolerance` (a plain,
/// un-squared Oklab distance) of **that seed's own colour** — a fixed reference
/// point, not a running average of the region so far. A running average would
/// let the flood slowly drift across a gradient background into the subject;
/// anchoring to the seed keeps the tolerance meaning one thing for the whole
/// component.
///
/// Matched pixels get alpha `0`; their RGB is left untouched, since straight
/// alpha (`docs/02-architecture.md` §9) never needs a transparent pixel's colour
/// to change, and doing so would throw away information a later "undo the
/// removal" gesture might want.
///
/// The inclusion test carries the same `NEAREST_EPSILON` (D12, `docs/04` §4.2)
/// the nearest-colour tie-break uses, for the same reason: Rust and JS Oklab
/// agree to ~6.7e-16 but not bit-for-bit, so a pixel sitting almost exactly on
/// the tolerance boundary could otherwise join the flood in one language and
/// not the other — and because a flood's connectivity depends on every earlier
/// decision, a single such flip can diverge a whole region, not just one pixel.
pub fn remove_background_flood_fill(
    src: &PixelBuffer,
    settings: &BackgroundRemovalSettings,
) -> PixelBuffer {
    let (w, h) = (src.width as usize, src.height as usize);
    let n = w * h;
    let mut out = src.data.clone();
    let mut visited = vec![false; n];
    let threshold_sq = settings.tolerance * settings.tolerance;

    let corners = [0usize, w - 1, (h - 1) * w, (h - 1) * w + w - 1];
    let mut stack: Vec<usize> = Vec::new();

    for &seed in &corners {
        if visited[seed] {
            continue;
        }

        let so = seed * 4;
        let seed_color = oklab::srgb8_to_oklab(src.data[so], src.data[so + 1], src.data[so + 2]);

        stack.clear();
        stack.push(seed);
        visited[seed] = true;

        while let Some(p) = stack.pop() {
            out[p * 4 + 3] = 0;

            for q in neighbours4(p, w, h) {
                if visited[q] {
                    continue;
                }
                let qo = q * 4;
                let q_color =
                    oklab::srgb8_to_oklab(src.data[qo], src.data[qo + 1], src.data[qo + 2]);
                if oklab::distance_sq(q_color, seed_color) <= threshold_sq + NEAREST_EPSILON {
                    visited[q] = true;
                    stack.push(q);
                }
            }
        }
    }

    PixelBuffer {
        width: src.width,
        height: src.height,
        data: out,
    }
}

fn neighbours4(p: usize, w: usize, h: usize) -> impl Iterator<Item = usize> {
    let x = p % w;
    let y = p / w;
    [
        if x > 0 { Some(p - 1) } else { None },
        if x + 1 < w { Some(p + 1) } else { None },
        if y > 0 { Some(p - w) } else { None },
        if y + 1 < h { Some(p + w) } else { None },
    ]
    .into_iter()
    .flatten()
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

    #[test]
    fn a_uniform_image_is_entirely_cleared() {
        let src = solid(4, 4, [200, 200, 200, 255]);
        let out =
            remove_background_flood_fill(&src, &BackgroundRemovalSettings { tolerance: 0.02 });
        assert!(out.data.chunks_exact(4).all(|px| px[3] == 0));
        // RGB is left alone.
        assert_eq!(&out.data[0..3], &[200, 200, 200]);
    }

    #[test]
    fn a_disconnected_interior_patch_of_the_background_colour_survives() {
        // 5x5 white background; a black ring at radius 1 fully encloses a single
        // white centre pixel, so the centre pixel's colour matches the corner
        // seed but is not *connected* to it.
        let mut src = solid(5, 5, [255, 255, 255, 255]);
        for y in 1..4u32 {
            for x in 1..4u32 {
                if x == 2 && y == 2 {
                    continue;
                }
                let o = src.offset(x, y);
                src.data[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        let out =
            remove_background_flood_fill(&src, &BackgroundRemovalSettings { tolerance: 0.02 });
        let centre = src.offset(2, 2);
        assert_eq!(out.data[centre + 3], 255, "enclosed patch must survive");
        assert_eq!(out.data[3], 0, "the actual background must be cleared");
    }

    #[test]
    fn a_neighbour_outside_tolerance_stops_the_flood() {
        // Corner is white; one step in is a clearly different colour that must
        // not be swept up.
        let mut src = solid(3, 3, [255, 255, 255, 255]);
        let o = src.offset(1, 0);
        src.data[o..o + 4].copy_from_slice(&[0, 0, 200, 255]);

        let out =
            remove_background_flood_fill(&src, &BackgroundRemovalSettings { tolerance: 0.02 });
        assert_eq!(out.data[3], 0, "corner cleared");
        assert_eq!(out.data[o + 3], 255, "distinct colour left alone");
    }

    #[test]
    fn tolerance_zero_only_clears_exact_matches() {
        let mut src = solid(3, 3, [10, 10, 10, 255]);
        let o = src.offset(1, 0);
        src.data[o..o + 4].copy_from_slice(&[11, 10, 10, 255]);

        let out = remove_background_flood_fill(&src, &BackgroundRemovalSettings { tolerance: 0.0 });
        assert_eq!(out.data[3], 0, "exact match to the seed cleared");
        assert_eq!(out.data[o + 3], 255, "even a 1-unit-off neighbour is not");
    }

    #[test]
    fn a_one_pixel_tall_image_does_not_panic_on_coincident_corners() {
        let src = solid(4, 1, [128, 64, 32, 255]);
        let out =
            remove_background_flood_fill(&src, &BackgroundRemovalSettings { tolerance: 0.02 });
        assert!(out.data.chunks_exact(4).all(|px| px[3] == 0));
    }
}
