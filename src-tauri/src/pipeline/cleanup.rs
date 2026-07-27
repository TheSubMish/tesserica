//! Stage [6] — cleanup (`docs/04-image-pipeline.md` §6).
//!
//! Mirrors `src/pipeline/cleanup.ts`.
//!
//! Operates on the **index map**, not on RGBA. After quantization the colours
//! are already palette entries, so "is this the same colour as its neighbour" is
//! an integer comparison rather than a distance, and connected components are
//! exact.

use std::collections::HashMap;

use super::oklab::{self, NEAREST_EPSILON};
use super::quantize::{PreparedPalette, TRANSPARENT_INDEX};
use super::settings::{OutlineSettings, Rgba};

/// Remove islands of `min_area` pixels or fewer, replacing each with the most
/// common index among its neighbours (§6.1).
///
/// Three things §6.1 leaves open, settled here and identically in TypeScript:
///
/// - **Area threshold is inclusive** — `despeckle: 1` removes single pixels. The
///   document's "area < despeckle" would make level 1 a no-op, which cannot be
///   what a 0–3 control means.
/// - **4-connectivity** for components. 8-connectivity would chain diagonal
///   single-pixel details, which in pixel art are usually deliberate.
/// - **Transparent regions participate**, since `TRANSPARENT_INDEX` is just
///   another label. Tiny holes get filled too, which is the same defect wearing
///   a different colour.
///
/// One pass: every replacement is decided from the *original* map, so the result
/// does not depend on the order components are visited.
pub fn despeckle(width: u32, height: u32, indices: &[u16], min_area: u32) -> Vec<u16> {
    if min_area < 1 {
        return indices.to_vec();
    }

    let (w, h) = (width as usize, height as usize);
    let n = w * h;
    let mut visited = vec![false; n];
    let mut out = indices.to_vec();
    let mut stack: Vec<usize> = Vec::new();
    let mut members: Vec<usize> = Vec::new();
    let mut neighbour_counts: HashMap<u16, u32> = HashMap::new();

    for seed in 0..n {
        if visited[seed] {
            continue;
        }
        let value = indices[seed];
        members.clear();
        stack.clear();
        stack.push(seed);
        visited[seed] = true;

        while let Some(p) = stack.pop() {
            members.push(p);
            for q in neighbours4(p, w, h) {
                if !visited[q] && indices[q] == value {
                    visited[q] = true;
                    stack.push(q);
                }
            }
        }

        if members.len() as u32 > min_area {
            continue;
        }

        neighbour_counts.clear();
        for &p in &members {
            for q in neighbours4(p, w, h) {
                if indices[q] == value {
                    continue;
                }
                *neighbour_counts.entry(indices[q]).or_insert(0) += 1;
            }
        }

        // Ties go to the lowest index, so the result never depends on map order
        // (which matters here: `HashMap` has none). TRANSPARENT_INDEX being
        // 0xffff means a real colour always wins a tie against transparency,
        // which is the behaviour you want when erasing noise next to an edge.
        let mut best_index: i32 = -1;
        let mut best_count = 0u32;
        for (&idx, &count) in neighbour_counts.iter() {
            if count > best_count || (count == best_count && (idx as i32) < best_index) {
                best_index = idx as i32;
                best_count = count;
            }
        }
        if best_index >= 0 {
            for &p in &members {
                out[p] = best_index as u16;
            }
        }
    }

    out
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

/// Add a border around non-transparent regions (§6.2).
///
/// `thickness` successive one-pixel dilations into transparent space, using
/// 8-connectivity when `corners` is set (rounder corners) and 4-connectivity
/// otherwise.
///
/// The outline colour is snapped to the **nearest palette entry**: the output is
/// by definition constrained to the palette, and quietly introducing a colour
/// that is not in it would be a worse surprise than the snap. Pick an outline
/// colour that is in the palette.
pub fn outline(
    width: u32,
    height: u32,
    indices: &[u16],
    alpha: &[u8],
    palette: &PreparedPalette,
    settings: &OutlineSettings,
) -> (Vec<u16>, Vec<u8>) {
    if settings.thickness < 1 {
        return (indices.to_vec(), alpha.to_vec());
    }

    let (w, h) = (width as i64, height as i64);
    let mut out_indices = indices.to_vec();
    let mut out_alpha = alpha.to_vec();
    let color_index = nearest_palette_index(palette, settings.color);
    let color_alpha = settings.color[3];

    for _ring in 0..settings.thickness {
        let previous = out_indices.clone();
        for y in 0..h {
            for x in 0..w {
                let p = (y * w + x) as usize;
                if previous[p] != TRANSPARENT_INDEX {
                    continue;
                }
                if has_opaque_neighbour(&previous, w, h, x, y, settings.corners) {
                    out_indices[p] = color_index;
                    out_alpha[p] = color_alpha;
                }
            }
        }
    }

    (out_indices, out_alpha)
}

fn has_opaque_neighbour(indices: &[u16], w: i64, h: i64, x: i64, y: i64, corners: bool) -> bool {
    for dy in -1..=1i64 {
        for dx in -1..=1i64 {
            if dx == 0 && dy == 0 {
                continue;
            }
            if !corners && dx != 0 && dy != 0 {
                continue;
            }
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            if indices[(ny * w + nx) as usize] != TRANSPARENT_INDEX {
                return true;
            }
        }
    }
    false
}

/// Nearest palette entry to a colour, in Oklab, with the D12 tie-break.
pub fn nearest_palette_index(palette: &PreparedPalette, color: Rgba) -> u16 {
    let c = oklab::srgb8_to_oklab(color[0], color[1], color[2]);
    let mut best = 0usize;
    let mut best_d = oklab::distance_sq(c, palette.lab[0]);
    for (i, entry) in palette.lab.iter().enumerate().skip(1) {
        let d = oklab::distance_sq(c, *entry);
        if d < best_d - NEAREST_EPSILON {
            best_d = d;
            best = i;
        }
    }
    best as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::quantize::prepare_palette;

    #[test]
    fn despeckle_removes_a_lone_pixel() {
        // 3x3 of index 0 with a single 1 in the middle.
        let mut indices = vec![0u16; 9];
        indices[4] = 1;
        let out = despeckle(3, 3, &indices, 1);
        assert_eq!(out, vec![0u16; 9]);
    }

    #[test]
    fn despeckle_leaves_a_region_larger_than_the_threshold() {
        let mut indices = vec![0u16; 9];
        indices[4] = 1;
        indices[5] = 1;
        let out = despeckle(3, 3, &indices, 1);
        assert_eq!(out, indices);
    }

    #[test]
    fn despeckle_is_off_at_zero() {
        let mut indices = vec![0u16; 9];
        indices[4] = 1;
        assert_eq!(despeckle(3, 3, &indices, 0), indices);
    }

    #[test]
    fn despeckle_fills_a_one_pixel_transparent_hole() {
        let mut indices = vec![3u16; 9];
        indices[4] = TRANSPARENT_INDEX;
        let out = despeckle(3, 3, &indices, 1);
        assert_eq!(out[4], 3);
    }

    #[test]
    fn despeckle_leaves_a_uniform_image_alone() {
        // The whole image is one component with no outside neighbours; there is
        // nothing to replace it with, and it must not be blanked.
        let indices = vec![2u16; 4];
        assert_eq!(despeckle(2, 2, &indices, 4), indices);
    }

    #[test]
    fn outline_rings_a_single_opaque_pixel() {
        let palette = prepare_palette(vec![[255, 255, 255, 255], [0, 0, 0, 255]]).unwrap();
        let mut indices = vec![TRANSPARENT_INDEX; 9];
        indices[4] = 0;
        let alpha = vec![0u8, 0, 0, 0, 255, 0, 0, 0, 0];

        let (out, out_alpha) = outline(
            3,
            3,
            &indices,
            &alpha,
            &palette,
            &OutlineSettings {
                color: [0, 0, 0, 255],
                thickness: 1,
                corners: true,
            },
        );
        assert!(out.iter().all(|&i| i != TRANSPARENT_INDEX));
        assert_eq!(out[0], 1);
        assert_eq!(out_alpha[0], 255);
        assert_eq!(out[4], 0, "the subject itself is untouched");
    }

    #[test]
    fn outline_without_corners_leaves_the_diagonals_alone() {
        let palette = prepare_palette(vec![[255, 255, 255, 255], [0, 0, 0, 255]]).unwrap();
        let mut indices = vec![TRANSPARENT_INDEX; 9];
        indices[4] = 0;
        let alpha = vec![0u8; 9];

        let (out, _) = outline(
            3,
            3,
            &indices,
            &alpha,
            &palette,
            &OutlineSettings {
                color: [0, 0, 0, 255],
                thickness: 1,
                corners: false,
            },
        );
        assert_eq!(out[0], TRANSPARENT_INDEX, "corner should stay empty");
        assert_eq!(out[1], 1, "edge should be outlined");
    }

    #[test]
    fn outline_colour_snaps_to_the_palette() {
        let palette = prepare_palette(vec![[255, 255, 255, 255], [10, 10, 10, 255]]).unwrap();
        // Near-black, not in the palette.
        assert_eq!(nearest_palette_index(&palette, [4, 4, 4, 255]), 1);
    }
}
