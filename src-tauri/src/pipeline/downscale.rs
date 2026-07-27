//! Stage [4] — downscale to the target grid (`docs/04-image-pipeline.md` §3).
//!
//! Mirrors `src/pipeline/downscale.ts`.
//!
//! This step decides whether the output looks like pixel art or like a broken
//! thumbnail, and it is where the most common bug in naive converters lives:
//! averaging a transparent pixel's RGB bleeds a dark fringe into every edge.
//! `Box` therefore weights colour by alpha and averages alpha separately.
//!
//! Cell boundaries are computed with **integer** arithmetic, not by accumulating
//! a float step, so the two implementations partition the source identically by
//! construction rather than by luck.

use std::collections::HashMap;

use super::buffer::PixelBuffer;
use super::oklab;
use super::settings::DownscaleMode;

/// Inclusive-exclusive source range covering output column/row `i`.
pub fn cell_range(i: u32, dst: u32, src: u32) -> (u32, u32) {
    let (i, dst, src64) = (i as u64, dst as u64, src as u64);
    let start = ((i * src64) / dst).min(src64 - 1);
    let end = (((i + 1) * src64) / dst).max(start + 1).min(src64);
    (start as u32, end as u32)
}

/// Source index of the sample point at the centre of output column/row `i`.
pub fn cell_centre(i: u32, dst: u32, src: u32) -> u32 {
    let (i, dst, src64) = (i as u64, dst as u64, src as u64);
    ((((2 * i) + 1) * src64) / (2 * dst)).min(src64 - 1) as u32
}

pub fn downscale(
    src: &PixelBuffer,
    target_width: u32,
    target_height: u32,
    mode: DownscaleMode,
) -> Result<PixelBuffer, String> {
    if target_width < 1 || target_height < 1 {
        return Err(format!(
            "target size must be at least 1x1, got {target_width}x{target_height}"
        ));
    }
    if target_width == src.width && target_height == src.height {
        return Ok(src.clone());
    }

    match mode {
        DownscaleMode::Box => downscale_box(src, target_width, target_height),
        DownscaleMode::Nearest => downscale_nearest(src, target_width, target_height),
        DownscaleMode::Dominant => downscale_dominant(src, target_width, target_height),
    }
}

/// Alpha-weighted box average, computed in **linear light**.
///
/// Two things are load-bearing:
///
/// - **Alpha weighting.** RGB is averaged weighted by alpha; alpha is averaged on
///   its own. Without this, a transparent pixel's RGB (usually black) drags every
///   edge dark — the classic converter fringe (`docs/04` §4.4).
/// - **Linear light.** Averaging gamma-encoded values darkens texture and
///   mid-tones. Averaging in linear light and re-encoding once is what "average
///   the pixels in the cell" has to mean to be photometrically correct.
fn downscale_box(src: &PixelBuffer, dst_w: u32, dst_h: u32) -> Result<PixelBuffer, String> {
    let mut out = vec![0u8; dst_w as usize * dst_h as usize * 4];

    for y in 0..dst_h {
        let (y0, y1) = cell_range(y, dst_h, src.height);
        for x in 0..dst_w {
            let (x0, x1) = cell_range(x, dst_w, src.width);

            let mut sum_r = 0.0f64;
            let mut sum_g = 0.0f64;
            let mut sum_b = 0.0f64;
            let mut sum_a = 0.0f64;
            let mut count = 0.0f64;

            for sy in y0..y1 {
                let mut i = src.offset(x0, sy);
                for _sx in x0..x1 {
                    let a = src.data[i + 3];
                    sum_a += a as f64;
                    count += 1.0;
                    if a != 0 {
                        let w = a as f64;
                        sum_r += oklab::srgb8_to_linear(src.data[i]) * w;
                        sum_g += oklab::srgb8_to_linear(src.data[i + 1]) * w;
                        sum_b += oklab::srgb8_to_linear(src.data[i + 2]) * w;
                    }
                    i += 4;
                }
            }

            let o = (y as usize * dst_w as usize + x as usize) * 4;
            if sum_a > 0.0 {
                out[o] = to8(oklab::linear_to_srgb(sum_r / sum_a));
                out[o + 1] = to8(oklab::linear_to_srgb(sum_g / sum_a));
                out[o + 2] = to8(oklab::linear_to_srgb(sum_b / sum_a));
            }
            out[o + 3] = (sum_a / count).round().clamp(0.0, 255.0) as u8;
        }
    }

    PixelBuffer::from_data(dst_w, dst_h, out)
}

/// Sample the centre of each cell. Correct for sources that are already pixel art.
fn downscale_nearest(src: &PixelBuffer, dst_w: u32, dst_h: u32) -> Result<PixelBuffer, String> {
    let mut out = vec![0u8; dst_w as usize * dst_h as usize * 4];
    for y in 0..dst_h {
        let sy = cell_centre(y, dst_h, src.height);
        for x in 0..dst_w {
            let sx = cell_centre(x, dst_w, src.width);
            let i = src.offset(sx, sy);
            let o = (y as usize * dst_w as usize + x as usize) * 4;
            out[o..o + 4].copy_from_slice(&src.data[i..i + 4]);
        }
    }
    PixelBuffer::from_data(dst_w, dst_h, out)
}

/// Most frequent colour in the cell, after a coarse pre-quantize.
///
/// The pre-quantize key is the top 5 bits per channel — the same key the
/// nearest-colour cache uses (`docs/04` §4.2), so "coarse" means one thing in
/// this codebase rather than two.
///
/// Concretely, since §3.1 leaves it open:
/// - only pixels with `alpha != 0` vote;
/// - the winning bucket is the one with the most votes, ties going to the lowest
///   key, so the result never depends on iteration order (which matters here:
///   `HashMap` has none);
/// - the output colour is the **first pixel in scanline order** belonging to that
///   bucket — a real colour from the source, not an average that would
///   reintroduce exactly the invented colours this mode exists to avoid;
/// - alpha is the plain mean over the whole cell, as in `Box`, so edges keep
///   their softness.
fn downscale_dominant(src: &PixelBuffer, dst_w: u32, dst_h: u32) -> Result<PixelBuffer, String> {
    let mut out = vec![0u8; dst_w as usize * dst_h as usize * 4];
    let mut counts: HashMap<u32, u32> = HashMap::new();

    for y in 0..dst_h {
        let (y0, y1) = cell_range(y, dst_h, src.height);
        for x in 0..dst_w {
            let (x0, x1) = cell_range(x, dst_w, src.width);

            counts.clear();
            let mut sum_a = 0.0f64;
            let mut count = 0.0f64;

            for sy in y0..y1 {
                let mut i = src.offset(x0, sy);
                for _sx in x0..x1 {
                    let a = src.data[i + 3];
                    sum_a += a as f64;
                    count += 1.0;
                    if a != 0 {
                        let key = coarse_key(src.data[i], src.data[i + 1], src.data[i + 2]);
                        *counts.entry(key).or_insert(0) += 1;
                    }
                    i += 4;
                }
            }

            let o = (y as usize * dst_w as usize + x as usize) * 4;
            out[o + 3] = (sum_a / count).round().clamp(0.0, 255.0) as u8;

            if counts.is_empty() {
                continue;
            }

            let mut best_key = 0u32;
            let mut best_count = 0u32;
            for (&key, &n) in counts.iter() {
                if n > best_count || (n == best_count && key < best_key) {
                    best_key = key;
                    best_count = n;
                }
            }

            // First pixel of the winning bucket, scanline order.
            'found: for sy in y0..y1 {
                let mut i = src.offset(x0, sy);
                for _sx in x0..x1 {
                    if src.data[i + 3] != 0
                        && coarse_key(src.data[i], src.data[i + 1], src.data[i + 2]) == best_key
                    {
                        out[o..o + 3].copy_from_slice(&src.data[i..i + 3]);
                        break 'found;
                    }
                    i += 4;
                }
            }
        }
    }

    PixelBuffer::from_data(dst_w, dst_h, out)
}

/// Top 5 bits per channel — the same key as the nearest-colour cache (§4.2).
pub fn coarse_key(r: u8, g: u8, b: u8) -> u32 {
    ((r as u32 >> 3) << 10) | ((g as u32 >> 3) << 5) | (b as u32 >> 3)
}

fn to8(v: f64) -> u8 {
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(width: u32, height: u32, pixels: &[[u8; 4]]) -> PixelBuffer {
        let data: Vec<u8> = pixels.iter().flat_map(|p| p.iter().copied()).collect();
        PixelBuffer::from_data(width, height, data).unwrap()
    }

    #[test]
    fn cells_partition_the_source_exactly() {
        for src in 1u32..40 {
            for dst in 1u32..40 {
                let mut covered = vec![0u32; src as usize];
                for i in 0..dst {
                    let (a, b) = cell_range(i, dst, src);
                    assert!(a < b, "empty cell {i} for {src}->{dst}");
                    for c in a..b {
                        covered[c as usize] += 1;
                    }
                }
                if dst <= src {
                    // Downscaling: every source pixel belongs to exactly one cell.
                    assert!(
                        covered.iter().all(|&c| c == 1),
                        "coverage {covered:?} for {src}->{dst}"
                    );
                }
            }
        }
    }

    #[test]
    fn box_averages_a_two_by_two_block() {
        let src = buf(
            2,
            2,
            &[
                [0, 0, 0, 255],
                [255, 255, 255, 255],
                [255, 255, 255, 255],
                [0, 0, 0, 255],
            ],
        );
        let out = downscale(&src, 1, 1, DownscaleMode::Box).unwrap();
        // Half black, half white, averaged in linear light: mid-grey is 188,
        // not 128. Averaging gamma-encoded values would give 128 and visibly
        // darken every texture in the image.
        assert_eq!(out.data, vec![188, 188, 188, 255]);
    }

    #[test]
    fn box_never_bleeds_a_transparent_pixels_rgb_into_the_average() {
        // Transparent *green* next to opaque orange. An unweighted average
        // would drag the result toward green; alpha weighting keeps it orange.
        let src = buf(2, 1, &[[245, 120, 40, 255], [0, 255, 0, 0]]);
        let out = downscale(&src, 1, 1, DownscaleMode::Box).unwrap();
        assert_eq!(&out.data[0..3], &[245, 120, 40]);
        assert_eq!(out.data[3], 128, "alpha is the plain mean");
    }

    #[test]
    fn box_on_a_fully_transparent_cell_stays_transparent_black() {
        let src = buf(2, 1, &[[10, 20, 30, 0], [40, 50, 60, 0]]);
        let out = downscale(&src, 1, 1, DownscaleMode::Box).unwrap();
        assert_eq!(out.data, vec![0, 0, 0, 0]);
    }

    #[test]
    fn nearest_recovers_an_upscaled_sprite_exactly() {
        // A 2x2 sprite scaled 4x, taken back down to 2x2.
        let mut src = PixelBuffer::new(8, 8).unwrap();
        let colors = [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 0, 255],
        ];
        for y in 0..8u32 {
            for x in 0..8u32 {
                let c = colors[((y / 4) * 2 + (x / 4)) as usize];
                let o = src.offset(x, y);
                src.data[o..o + 4].copy_from_slice(&c);
            }
        }
        let out = downscale(&src, 2, 2, DownscaleMode::Nearest).unwrap();
        let expected: Vec<u8> = colors.iter().flat_map(|c| c.iter().copied()).collect();
        assert_eq!(out.data, expected);
    }

    #[test]
    fn dominant_picks_the_most_common_colour_not_the_average() {
        let src = buf(
            4,
            1,
            &[
                [200, 0, 0, 255],
                [200, 0, 0, 255],
                [200, 0, 0, 255],
                [0, 0, 200, 255],
            ],
        );
        let out = downscale(&src, 1, 1, DownscaleMode::Dominant).unwrap();
        assert_eq!(&out.data[0..3], &[200, 0, 0]);
    }

    #[test]
    fn dominant_ignores_transparent_pixels_when_voting() {
        let src = buf(3, 1, &[[0, 255, 0, 0], [0, 255, 0, 0], [200, 0, 0, 255]]);
        let out = downscale(&src, 1, 1, DownscaleMode::Dominant).unwrap();
        assert_eq!(&out.data[0..3], &[200, 0, 0]);
    }

    #[test]
    fn a_no_op_resize_returns_the_source() {
        let src = buf(2, 1, &[[1, 2, 3, 4], [5, 6, 7, 8]]);
        for mode in [
            DownscaleMode::Box,
            DownscaleMode::Nearest,
            DownscaleMode::Dominant,
        ] {
            assert_eq!(downscale(&src, 2, 1, mode).unwrap().data, src.data);
        }
    }
}
