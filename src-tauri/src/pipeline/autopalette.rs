//! Auto palette — "the best N colours for this image" (`docs/04` §4.3).
//!
//! Mirrors `src/pipeline/autopalette.ts`.
//!
//! **Wu's algorithm, then k-means in Oklab.** Wu gives a good *deterministic*
//! starting partition by greedily splitting a 3D colour histogram along the axis
//! that removes the most variance; k-means then refines it where perception
//! actually lives. Neither half is optional: k-means from a bad start converges
//! to a bad local minimum, and Wu alone optimizes squared error in RGB, which is
//! not what the eye measures.
//!
//! **Determinism is a correctness requirement, not a nicety.** The same input
//! and settings must produce the same palette in both languages, or preview and
//! export diverge in the most visible way possible — different colours. So:
//! integer-valued moments, no random seeding, a fixed iteration count, and an
//! explicit tie-break everywhere a comparison could be equal.

use std::collections::{HashMap, HashSet};

use super::buffer::PixelBuffer;
use super::oklab::{self, Oklab, NEAREST_EPSILON};
use super::settings::Rgba;

/// Wu bins each channel to 5 bits; index 0 is the below-first-bin guard row.
const SIDE: usize = 33;
const CELLS: usize = SIDE * SIDE * SIDE;

/// `docs/04` §4.3: "~8 iterations of k-means". Fixed, so the result is stable.
pub const KMEANS_ITERATIONS: usize = 8;

const fn at(r: usize, g: usize, b: usize) -> usize {
    (r * SIDE + g) * SIDE + b
}

struct Moments {
    weight: Vec<f64>,
    sum_r: Vec<f64>,
    sum_g: Vec<f64>,
    sum_b: Vec<f64>,
    sum_sq: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct Box3 {
    r0: usize,
    r1: usize,
    g0: usize,
    g1: usize,
    b0: usize,
    b1: usize,
}

/// Build the 3D histogram and turn it into cumulative moments.
///
/// Counts are exact integers held in `f64` — every value is well below 2^53, so
/// this is integer arithmetic that happens to be spelled in doubles, and it is
/// identical in both languages.
fn build_moments(image: &PixelBuffer, alpha_threshold: u8) -> Moments {
    let mut m = Moments {
        weight: vec![0.0; CELLS],
        sum_r: vec![0.0; CELLS],
        sum_g: vec![0.0; CELLS],
        sum_b: vec![0.0; CELLS],
        sum_sq: vec![0.0; CELLS],
    };

    for px in image.data.chunks_exact(4) {
        // Fully transparent pixels have no colour worth spending a palette
        // entry on; including them would tug every centroid toward whatever RGB
        // happens to sit under the transparency.
        if px[3] < alpha_threshold {
            continue;
        }
        let (r, g, b) = (px[0] as f64, px[1] as f64, px[2] as f64);
        let index = at(
            (px[0] >> 3) as usize + 1,
            (px[1] >> 3) as usize + 1,
            (px[2] >> 3) as usize + 1,
        );
        m.weight[index] += 1.0;
        m.sum_r[index] += r;
        m.sum_g[index] += g;
        m.sum_b[index] += b;
        m.sum_sq[index] += r * r + g * g + b * b;
    }

    // Cumulative sums over the three axes, so any box's totals are eight lookups.
    for r in 1..SIDE {
        let mut area_w = [0.0f64; SIDE];
        let mut area_r = [0.0f64; SIDE];
        let mut area_g = [0.0f64; SIDE];
        let mut area_b = [0.0f64; SIDE];
        let mut area_sq = [0.0f64; SIDE];

        for g in 1..SIDE {
            let (mut line_w, mut line_r, mut line_g, mut line_b, mut line_sq) =
                (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);

            for b in 1..SIDE {
                let i = at(r, g, b);
                line_w += m.weight[i];
                line_r += m.sum_r[i];
                line_g += m.sum_g[i];
                line_b += m.sum_b[i];
                line_sq += m.sum_sq[i];

                area_w[b] += line_w;
                area_r[b] += line_r;
                area_g[b] += line_g;
                area_b[b] += line_b;
                area_sq[b] += line_sq;

                let prev = at(r - 1, g, b);
                m.weight[i] = m.weight[prev] + area_w[b];
                m.sum_r[i] = m.sum_r[prev] + area_r[b];
                m.sum_g[i] = m.sum_g[prev] + area_g[b];
                m.sum_b[i] = m.sum_b[prev] + area_b[b];
                m.sum_sq[i] = m.sum_sq[prev] + area_sq[b];
            }
        }
    }

    m
}

/// Inclusion–exclusion over the eight corners of a box.
fn volume(bx: &Box3, m: &[f64]) -> f64 {
    m[at(bx.r1, bx.g1, bx.b1)] - m[at(bx.r1, bx.g1, bx.b0)] - m[at(bx.r1, bx.g0, bx.b1)]
        + m[at(bx.r1, bx.g0, bx.b0)]
        - m[at(bx.r0, bx.g1, bx.b1)]
        + m[at(bx.r0, bx.g1, bx.b0)]
        + m[at(bx.r0, bx.g0, bx.b1)]
        - m[at(bx.r0, bx.g0, bx.b0)]
}

/// The part of a box's total that lies below the cut on `axis`.
fn bottom(bx: &Box3, axis: usize, m: &[f64]) -> f64 {
    match axis {
        0 => {
            -m[at(bx.r0, bx.g1, bx.b1)] + m[at(bx.r0, bx.g1, bx.b0)] + m[at(bx.r0, bx.g0, bx.b1)]
                - m[at(bx.r0, bx.g0, bx.b0)]
        }
        1 => {
            -m[at(bx.r1, bx.g0, bx.b1)] + m[at(bx.r1, bx.g0, bx.b0)] + m[at(bx.r0, bx.g0, bx.b1)]
                - m[at(bx.r0, bx.g0, bx.b0)]
        }
        _ => {
            -m[at(bx.r1, bx.g1, bx.b0)] + m[at(bx.r1, bx.g0, bx.b0)] + m[at(bx.r0, bx.g1, bx.b0)]
                - m[at(bx.r0, bx.g0, bx.b0)]
        }
    }
}

fn top(bx: &Box3, axis: usize, pos: usize, m: &[f64]) -> f64 {
    match axis {
        0 => {
            m[at(pos, bx.g1, bx.b1)] - m[at(pos, bx.g1, bx.b0)] - m[at(pos, bx.g0, bx.b1)]
                + m[at(pos, bx.g0, bx.b0)]
        }
        1 => {
            m[at(bx.r1, pos, bx.b1)] - m[at(bx.r1, pos, bx.b0)] - m[at(bx.r0, pos, bx.b1)]
                + m[at(bx.r0, pos, bx.b0)]
        }
        _ => {
            m[at(bx.r1, bx.g1, pos)] - m[at(bx.r1, bx.g0, pos)] - m[at(bx.r0, bx.g1, pos)]
                + m[at(bx.r0, bx.g0, pos)]
        }
    }
}

/// Weighted variance of a box — the quantity Wu greedily removes.
fn variance(bx: &Box3, m: &Moments) -> f64 {
    let w = volume(bx, &m.weight);
    if w == 0.0 {
        return 0.0;
    }
    let r = volume(bx, &m.sum_r);
    let g = volume(bx, &m.sum_g);
    let b = volume(bx, &m.sum_b);
    volume(bx, &m.sum_sq) - (r * r + g * g + b * b) / w
}

/// Best cut along one axis, or `None` when the axis cannot be split.
fn best_cut(bx: &Box3, axis: usize, m: &Moments, whole_w: f64) -> Option<(usize, f64)> {
    let (first, last) = match axis {
        0 => (bx.r0 + 1, bx.r1),
        1 => (bx.g0 + 1, bx.g1),
        _ => (bx.b0 + 1, bx.b1),
    };

    let base_w = bottom(bx, axis, &m.weight);
    let base_r = bottom(bx, axis, &m.sum_r);
    let base_g = bottom(bx, axis, &m.sum_g);
    let base_b = bottom(bx, axis, &m.sum_b);

    let whole_r = volume(bx, &m.sum_r);
    let whole_g = volume(bx, &m.sum_g);
    let whole_b = volume(bx, &m.sum_b);

    let mut best: Option<(usize, f64)> = None;
    let mut best_gain = 0.0f64;

    for pos in first..last {
        let half_w = base_w + top(bx, axis, pos, &m.weight);
        if half_w == 0.0 {
            continue;
        }
        let other_w = whole_w - half_w;
        if other_w == 0.0 {
            break;
        }

        let half_r = base_r + top(bx, axis, pos, &m.sum_r);
        let half_g = base_g + top(bx, axis, pos, &m.sum_g);
        let half_b = base_b + top(bx, axis, pos, &m.sum_b);

        let other_r = whole_r - half_r;
        let other_g = whole_g - half_g;
        let other_b = whole_b - half_b;

        let gain = (half_r * half_r + half_g * half_g + half_b * half_b) / half_w
            + (other_r * other_r + other_g * other_g + other_b * other_b) / other_w;

        // Strictly greater: on a tie the *lower* cut position wins, in both
        // languages, so an image with a symmetric histogram cannot split two
        // ways.
        if gain > best_gain {
            best_gain = gain;
            best = Some((pos, gain));
        }
    }

    best
}

/// Wu's greedy split. Returns at most `max_colors` boxes.
fn wu_boxes(m: &Moments, max_colors: usize) -> Vec<Box3> {
    let mut boxes = vec![Box3 {
        r0: 0,
        r1: SIDE - 1,
        g0: 0,
        g1: SIDE - 1,
        b0: 0,
        b1: SIDE - 1,
    }];
    let mut variances = vec![variance(&boxes[0], m)];

    while boxes.len() < max_colors {
        // Split the box with the most variance; ties go to the lowest index.
        let mut target: Option<usize> = None;
        let mut worst = 0.0f64;
        for (i, &v) in variances.iter().enumerate() {
            if v > worst {
                worst = v;
                target = Some(i);
            }
        }
        let Some(target) = target else { break };

        let bx = boxes[target];
        let whole_w = volume(&bx, &m.weight);
        let cuts = [
            best_cut(&bx, 0, m, whole_w),
            best_cut(&bx, 1, m, whole_w),
            best_cut(&bx, 2, m, whole_w),
        ];

        // Axis order r, g, b with strict `>` again fixes ties to the earliest.
        let mut axis: Option<usize> = None;
        let mut gain = 0.0f64;
        for (a, cut) in cuts.iter().enumerate() {
            if let Some((_, g)) = cut {
                if *g > gain {
                    gain = *g;
                    axis = Some(a);
                }
            }
        }

        let Some(axis) = axis else {
            // Unsplittable: retire it so the loop cannot spin on it forever.
            variances[target] = 0.0;
            continue;
        };
        let cut = cuts[axis].expect("axis was chosen from a Some cut").0;

        let mut next = bx;
        match axis {
            0 => {
                next.r0 = cut;
                boxes[target].r1 = cut;
            }
            1 => {
                next.g0 = cut;
                boxes[target].g1 = cut;
            }
            _ => {
                next.b0 = cut;
                boxes[target].b1 = cut;
            }
        }

        variances[target] = variance(&boxes[target], m);
        variances.push(variance(&next, m));
        boxes.push(next);
    }

    boxes
}

fn box_centroid(bx: &Box3, m: &Moments) -> Option<Rgba> {
    let w = volume(bx, &m.weight);
    if w == 0.0 {
        return None;
    }
    Some([
        (volume(bx, &m.sum_r) / w).round() as u8,
        (volume(bx, &m.sum_g) / w).round() as u8,
        (volume(bx, &m.sum_b) / w).round() as u8,
        255,
    ])
}

#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub lab: Oklab,
    pub count: f64,
}

/// One sample per *distinct* colour, weighted by how often it occurs.
///
/// Iterating distinct colours rather than pixels makes k-means cost independent
/// of image size, and — more importantly — independent of pixel *order*, so the
/// two implementations cannot drift on traversal alone. Sorting by colour key
/// gives an order a `HashMap` and a JS `Map` can both reproduce.
fn distinct_samples(image: &PixelBuffer, alpha_threshold: u8) -> Vec<Sample> {
    let mut counts: HashMap<u32, f64> = HashMap::new();
    for px in image.data.chunks_exact(4) {
        if px[3] < alpha_threshold {
            continue;
        }
        let key = ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | px[2] as u32;
        *counts.entry(key).or_insert(0.0) += 1.0;
    }

    let mut keys: Vec<u32> = counts.keys().copied().collect();
    keys.sort_unstable();
    keys.into_iter()
        .map(|key| Sample {
            lab: oklab::srgb8_to_oklab(
                ((key >> 16) & 0xff) as u8,
                ((key >> 8) & 0xff) as u8,
                (key & 0xff) as u8,
            ),
            count: counts[&key],
        })
        .collect()
}

/// Lloyd's algorithm in Oklab, weighted by colour frequency.
///
/// Fixed iteration count and no random restarts — see the determinism note at
/// the top of this file. An empty cluster keeps its previous centroid rather
/// than being re-seeded, which is the behaviour that has no arbitrary choice in
/// it.
pub fn kmeans_oklab(samples: &[Sample], initial: &[Oklab], iterations: usize) -> Vec<Oklab> {
    let mut centroids = initial.to_vec();
    if centroids.is_empty() || samples.is_empty() {
        return centroids;
    }

    for _ in 0..iterations {
        let n = centroids.len();
        let mut sum_l = vec![0.0f64; n];
        let mut sum_a = vec![0.0f64; n];
        let mut sum_b = vec![0.0f64; n];
        let mut weight = vec![0.0f64; n];

        for sample in samples {
            let mut best = 0usize;
            let mut best_d = oklab::distance_sq(sample.lab, centroids[0]);
            for (i, c) in centroids.iter().enumerate().skip(1) {
                let d = oklab::distance_sq(sample.lab, *c);
                // The D12 tie-break again: equidistant samples join the lowest
                // cluster.
                if d < best_d - NEAREST_EPSILON {
                    best_d = d;
                    best = i;
                }
            }
            sum_l[best] += sample.lab.l * sample.count;
            sum_a[best] += sample.lab.a * sample.count;
            sum_b[best] += sample.lab.b * sample.count;
            weight[best] += sample.count;
        }

        let mut moved = false;
        for i in 0..n {
            if weight[i] == 0.0 {
                continue;
            }
            let next = Oklab {
                l: sum_l[i] / weight[i],
                a: sum_a[i] / weight[i],
                b: sum_b[i] / weight[i],
            };
            if next != centroids[i] {
                moved = true;
            }
            centroids[i] = next;
        }
        if !moved {
            break;
        }
    }

    centroids
}

/// Choose up to `max_colors` colours for `image`.
///
/// Always returns at least one colour: a fully transparent image still needs a
/// palette for the pipeline to be defined on, and black is the least surprising
/// answer for an image with no visible pixels.
pub fn auto_palette(
    image: &PixelBuffer,
    max_colors: u32,
    alpha_threshold: u8,
) -> Result<Vec<Rgba>, String> {
    if max_colors < 1 {
        return Err(format!("maxColors must be at least 1, got {max_colors}"));
    }
    let max_colors = max_colors as usize;

    let samples = distinct_samples(image, alpha_threshold);
    if samples.is_empty() {
        return Ok(vec![[0, 0, 0, 255]]);
    }

    // Fewer distinct colours than requested: return them exactly. Inventing
    // extra entries by splitting a flat image is worse than a short palette.
    if samples.len() <= max_colors {
        return Ok(samples
            .iter()
            .map(|s| {
                let (r, g, b) = oklab::oklab_to_srgb8(s.lab);
                [r, g, b, 255]
            })
            .collect());
    }

    let moments = build_moments(image, alpha_threshold);
    let seeds: Vec<Oklab> = wu_boxes(&moments, max_colors)
        .iter()
        .filter_map(|bx| box_centroid(bx, &moments))
        .map(|c| oklab::srgb8_to_oklab(c[0], c[1], c[2]))
        .collect();
    if seeds.is_empty() {
        return Ok(vec![[0, 0, 0, 255]]);
    }

    let refined = kmeans_oklab(&samples, &seeds, KMEANS_ITERATIONS);

    // Deduplicate: k-means can collapse two centroids onto the same 8-bit
    // colour, and a palette with a repeated entry wastes a slot and confuses the
    // index map's meaning.
    let mut seen: HashSet<u32> = HashSet::new();
    let mut out: Vec<Rgba> = Vec::new();
    for centroid in refined {
        let (r, g, b) = oklab::oklab_to_srgb8(centroid);
        let key = ((r as u32) << 16) | ((g as u32) << 8) | b as u32;
        if seen.insert(key) {
            out.push([r, g, b, 255]);
        }
    }

    // Sorted for stability: the palette's *order* is visible in the index map,
    // and an order that depended on Wu's split sequence would make the golden
    // suite sensitive to an implementation detail rather than to the colours.
    out.sort_unstable_by_key(|c| ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | c[2] as u32);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_colors(colors: &[Rgba]) -> PixelBuffer {
        let data: Vec<u8> = colors.iter().flat_map(|c| c.iter().copied()).collect();
        PixelBuffer::from_data(colors.len() as u32, 1, data).unwrap()
    }

    fn solid(width: u32, height: u32, color: Rgba) -> PixelBuffer {
        let mut b = PixelBuffer::new(width, height).unwrap();
        for px in b.data.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        b
    }

    #[test]
    fn returns_the_exact_colours_when_the_image_has_few() {
        let image = from_colors(&[[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
        let palette = auto_palette(&image, 8, 128).unwrap();
        assert_eq!(palette.len(), 3);
    }

    #[test]
    fn never_returns_more_than_max_colors() {
        let mut image = PixelBuffer::new(64, 64).unwrap();
        for (p, px) in image.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[p as u8, (p >> 2) as u8, (p >> 4) as u8, 255]);
        }
        for n in [2u32, 4, 8, 16, 32] {
            assert!(auto_palette(&image, n, 128).unwrap().len() <= n as usize);
        }
    }

    #[test]
    fn is_deterministic() {
        let mut image = PixelBuffer::new(48, 48).unwrap();
        for (p, px) in image.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[(p * 7) as u8, (p * 13) as u8, (p * 29) as u8, 255]);
        }
        assert_eq!(
            auto_palette(&image, 12, 128).unwrap(),
            auto_palette(&image, 12, 128).unwrap()
        );
    }

    #[test]
    fn separates_two_well_spaced_clusters() {
        let mut image = PixelBuffer::new(16, 16).unwrap();
        for (p, px) in image.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(if p % 2 == 0 {
                &[230, 20, 20, 255]
            } else {
                &[20, 20, 230, 255]
            });
        }
        let palette = auto_palette(&image, 2, 128).unwrap();
        assert_eq!(palette.len(), 2);
        assert_eq!(palette.iter().filter(|c| c[0] > c[2]).count(), 1);
        assert_eq!(palette.iter().filter(|c| c[2] > c[0]).count(), 1);
    }

    #[test]
    fn ignores_transparent_pixels() {
        let mut image = PixelBuffer::new(8, 8).unwrap();
        for (p, px) in image.data.chunks_exact_mut(4).enumerate() {
            // A loud transparent green that must not reach the palette.
            px.copy_from_slice(if p < 32 {
                &[0, 255, 0, 0]
            } else {
                &[200, 100, 50, 255]
            });
        }
        let palette = auto_palette(&image, 4, 128).unwrap();
        assert!(!palette
            .iter()
            .any(|c| c[0] == 0 && c[1] == 255 && c[2] == 0));
    }

    #[test]
    fn a_fully_transparent_image_still_gets_a_palette() {
        let palette = auto_palette(&solid(4, 4, [9, 9, 9, 0]), 8, 128).unwrap();
        assert_eq!(palette.len(), 1);
    }

    #[test]
    fn rejects_a_nonsensical_max_colors() {
        assert!(auto_palette(&solid(2, 2, [1, 2, 3, 255]), 0, 128).is_err());
    }

    #[test]
    fn contains_no_duplicate_entries() {
        let mut image = PixelBuffer::new(32, 32).unwrap();
        for (p, px) in image.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[120 + (p % 3) as u8, 120, 120, 255]);
        }
        let palette = auto_palette(&image, 16, 128).unwrap();
        let unique: HashSet<_> = palette.iter().map(|c| (c[0], c[1], c[2])).collect();
        assert_eq!(unique.len(), palette.len());
    }

    #[test]
    fn an_empty_cluster_keeps_its_centroid() {
        let samples = [Sample {
            lab: oklab::srgb8_to_oklab(255, 255, 255),
            count: 10.0,
        }];
        let seed = [
            oklab::srgb8_to_oklab(255, 255, 255),
            oklab::srgb8_to_oklab(0, 0, 0),
        ];
        let out = kmeans_oklab(&samples, &seed, KMEANS_ITERATIONS);
        assert_eq!(out[1], seed[1]);
    }

    #[test]
    fn a_centroid_moves_to_the_mean_of_its_cluster() {
        let samples = [
            Sample {
                lab: oklab::srgb8_to_oklab(0, 0, 0),
                count: 1.0,
            },
            Sample {
                lab: oklab::srgb8_to_oklab(255, 255, 255),
                count: 1.0,
            },
        ];
        let out = kmeans_oklab(
            &samples,
            &[oklab::srgb8_to_oklab(128, 128, 128)],
            KMEANS_ITERATIONS,
        );
        let expected = (samples[0].lab.l + samples[1].lab.l) / 2.0;
        assert!((out[0].l - expected).abs() < 1e-12);
    }
}
