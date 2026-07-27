//! Dithering (`docs/04-image-pipeline.md` §5) — part of stage [5].
//!
//! Mirrors `src/pipeline/dither.ts`.
//!
//! Three families, all shipped, because they are aesthetic choices rather than
//! quality tiers: error diffusion (Floyd–Steinberg, Atkinson), ordered/Bayer,
//! and none.
//!
//! **Everything here works in Oklab**, on an `f64` working buffer (§5.1, D12).
//! `ColorSpace::Srgb` therefore affects only the *undithered* nearest-colour
//! lookup; §5.1 is unconditional about the dither buffer, and running error
//! diffusion in a space where equal distances do not look equally different is
//! the thing Oklab was adopted to stop.
//!
//! **No nearest-colour cache is used on the error-diffusion paths**, by design —
//! see §4.2 and the note on [`quantize_error_diffusion`].

use super::buffer::PixelBuffer;
use super::oklab::{self, Oklab};
use super::quantize::{
    nearest_index_oklab, AlphaPolicy, NearestCache, PreparedPalette, QuantizeResult,
    TRANSPARENT_INDEX,
};

/// One term of an error-diffusion kernel: an offset and its share of the error.
#[derive(Debug, Clone, Copy)]
pub struct DiffusionTerm {
    pub dx: i64,
    pub dy: i64,
    pub weight: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct DiffusionKernel {
    pub terms: &'static [DiffusionTerm],
    /// Alternate scan direction every row.
    ///
    /// On for Floyd–Steinberg, where it noticeably reduces the diagonal
    /// streaking that plain left-to-right scanning produces (§5.1). Off for
    /// Atkinson, which §5.2 describes as the classic Mac algorithm — that one is
    /// raster order, and its look is part of why anyone picks it.
    pub serpentine: bool,
}

/// ```text
///         X    7/16
///  3/16  5/16  1/16
/// ```
pub const FLOYD_STEINBERG: DiffusionKernel = DiffusionKernel {
    terms: &[
        DiffusionTerm {
            dx: 1,
            dy: 0,
            weight: 7.0 / 16.0,
        },
        DiffusionTerm {
            dx: -1,
            dy: 1,
            weight: 3.0 / 16.0,
        },
        DiffusionTerm {
            dx: 0,
            dy: 1,
            weight: 5.0 / 16.0,
        },
        DiffusionTerm {
            dx: 1,
            dy: 1,
            weight: 1.0 / 16.0,
        },
    ],
    serpentine: true,
};

/// ```text
///         X    1/8  1/8
///  1/8   1/8   1/8
///        1/8
/// ```
///
/// Distributes only 6/8 of the error, discarding the rest — that is what makes
/// it higher contrast and "crunchier" than Floyd–Steinberg, and it is
/// deliberate, not a missing term.
pub const ATKINSON: DiffusionKernel = DiffusionKernel {
    terms: &[
        DiffusionTerm {
            dx: 1,
            dy: 0,
            weight: 0.125,
        },
        DiffusionTerm {
            dx: 2,
            dy: 0,
            weight: 0.125,
        },
        DiffusionTerm {
            dx: -1,
            dy: 1,
            weight: 0.125,
        },
        DiffusionTerm {
            dx: 0,
            dy: 1,
            weight: 0.125,
        },
        DiffusionTerm {
            dx: 1,
            dy: 1,
            weight: 0.125,
        },
        DiffusionTerm {
            dx: 0,
            dy: 2,
            weight: 0.125,
        },
    ],
    serpentine: false,
};

/// The `n`×`n` Bayer threshold matrix, built by the standard recurrence:
///
/// ```text
///   M(1)  = [0]
///   M(2n) = [ 4M(n)      4M(n)+2 ]
///           [ 4M(n)+3    4M(n)+1 ]
/// ```
///
/// Generated rather than table-driven so 2, 4 and 8 cannot disagree with each
/// other, and so both languages produce it from the same rule.
pub fn bayer_matrix(n: usize) -> Result<Vec<i32>, String> {
    if n != 2 && n != 4 && n != 8 {
        return Err(format!("Bayer matrix size must be 2, 4 or 8, got {n}"));
    }
    let mut size = 1usize;
    let mut m = vec![0i32];
    while size < n {
        let next_size = size * 2;
        let mut next = vec![0i32; next_size * next_size];
        for y in 0..size {
            for x in 0..size {
                let v = m[y * size + x] * 4;
                next[y * next_size + x] = v;
                next[y * next_size + (x + size)] = v + 2;
                next[(y + size) * next_size + x] = v + 3;
                next[(y + size) * next_size + (x + size)] = v + 1;
            }
        }
        m = next;
        size = next_size;
    }
    Ok(m)
}

/// How far apart the palette's colours are, in Oklab — the `spread` of §5.3.
///
/// The mean distance from each entry to its nearest other entry. A fixed value
/// looks wrong on both a 4-colour and a 64-colour palette: too little spread and
/// ordered dithering does nothing, too much and it shreds the image. Zero for a
/// one-colour palette, where dithering has nothing to choose between.
///
/// `sqrt` is IEEE-754 correctly rounded, unlike `cbrt` and `powf`, so this
/// particular number is bit-identical in both languages.
pub fn palette_spread(palette: &PreparedPalette) -> f64 {
    if palette.lab.len() < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    for (i, a) in palette.lab.iter().enumerate() {
        let mut nearest = f64::INFINITY;
        for (j, b) in palette.lab.iter().enumerate() {
            if i == j {
                continue;
            }
            let d = oklab::distance_sq(*a, *b);
            if d < nearest {
                nearest = d;
            }
        }
        total += nearest.sqrt();
    }
    total / palette.lab.len() as f64
}

/// Ordered (Bayer) dithering.
///
/// The threshold offset is applied to **`l` only**, not to all three Oklab
/// channels. §5.3 writes `adjusted = pixel + threshold * strength * spread`; in
/// the RGB implementations that formula comes from, adding the same amount to
/// R, G and B is a move along the grey axis — that is, a *lightness* shift. `l`
/// alone is the faithful translation of that into Oklab. Adding the same scalar
/// to `a` and `b` as well would drag every pixel in one fixed hue direction,
/// which is a different effect and not the one anyone means by ordered dither.
///
/// Fully parallelizable and resolution-independent in character, which makes
/// this the safest mode for preview/export parity.
pub fn quantize_ordered(
    src: &PixelBuffer,
    palette: &PreparedPalette,
    policy: AlphaPolicy,
    n: usize,
    strength: f64,
    cache: Option<&mut NearestCache>,
) -> Result<QuantizeResult, String> {
    let matrix = bayer_matrix(n)?;
    let spread = palette_spread(palette);
    let scale = 1.0 / (n * n) as f64;

    let mut out = vec![0u8; src.data.len()];
    let mut indices = vec![TRANSPARENT_INDEX; src.pixel_count()];
    let mut cache = cache;

    for y in 0..src.height as usize {
        for x in 0..src.width as usize {
            let p = y * src.width as usize + x;
            let i = p * 4;

            let a = policy.resolve(src.data[i + 3]);
            if a == 0 {
                continue;
            }

            let lane = (y % n) * n + (x % n);
            let (r, g, b) = (src.data[i], src.data[i + 1], src.data[i + 2]);

            // Exact even with the cache: the perturbation is a deterministic
            // function of the source colour and the Bayer cell, so one lane per
            // cell keeps the memo faithful (§4.2).
            let compute = || {
                let threshold = (matrix[lane] as f64 + 0.5) * scale - 0.5;
                let c = oklab::srgb8_to_oklab(r, g, b);
                let shifted = Oklab {
                    l: c.l + threshold * strength * spread,
                    a: c.a,
                    b: c.b,
                };
                nearest_index_oklab(palette, shifted)
            };
            let idx = match cache.as_deref_mut() {
                Some(c) => c.lookup(r, g, b, lane, compute),
                None => compute(),
            };
            let entry = palette.colors[idx as usize];
            indices[p] = idx;
            out[i] = entry[0];
            out[i + 1] = entry[1];
            out[i + 2] = entry[2];
            out[i + 3] = a;
        }
    }

    Ok(QuantizeResult {
        image: PixelBuffer::from_data(src.width, src.height, out)?,
        indices,
    })
}

/// Error-diffusion dithering.
///
/// > ⚠️ **The nearest-colour cache is invalid here** (§4.2). It is keyed on
/// > quantized RGB, and diffused error pushes colours to arbitrary values — the
/// > cache would round away the very error being propagated. This path computes
/// > every lookup directly, and must keep doing so.
///
/// Inherently sequential: each pixel depends on its predecessors. This is the
/// one stage `rayon` cannot trivially parallelize, and the reason preview and
/// export cannot match exactly at *different* resolutions (`docs/02` §3.3). At
/// equal resolution it is fully deterministic, which is why the golden suite can
/// still demand an exact match.
///
/// Transparent pixels neither produce error nor stop it: they are skipped, and
/// error diffused onto them simply goes nowhere, because they are never
/// quantized. Diffusing *their* colour would smear a dropped pixel's RGB into
/// the visible image, which is the alpha-fringe bug in a different disguise.
pub fn quantize_error_diffusion(
    src: &PixelBuffer,
    palette: &PreparedPalette,
    policy: AlphaPolicy,
    kernel: DiffusionKernel,
    strength: f64,
) -> Result<QuantizeResult, String> {
    let (w, h) = (src.width as i64, src.height as i64);
    let mut buf = vec![0.0f64; src.pixel_count() * 3];
    for (p, px) in src.data.chunks_exact(4).enumerate() {
        let c = oklab::srgb8_to_oklab(px[0], px[1], px[2]);
        buf[p * 3] = c.l;
        buf[p * 3 + 1] = c.a;
        buf[p * 3 + 2] = c.b;
    }

    let mut out = vec![0u8; src.data.len()];
    let mut indices = vec![TRANSPARENT_INDEX; src.pixel_count()];

    for y in 0..h {
        let rightward = !kernel.serpentine || y % 2 == 0;
        for step in 0..w {
            let x = if rightward { step } else { w - 1 - step };
            let p = (y * w + x) as usize;
            let i = p * 4;

            let a = policy.resolve(src.data[i + 3]);
            if a == 0 {
                continue;
            }

            let old = Oklab {
                l: buf[p * 3],
                a: buf[p * 3 + 1],
                b: buf[p * 3 + 2],
            };
            let idx = nearest_index_oklab(palette, old);
            let chosen = palette.lab[idx as usize];
            let entry = palette.colors[idx as usize];

            indices[p] = idx;
            out[i] = entry[0];
            out[i + 1] = entry[1];
            out[i + 2] = entry[2];
            out[i + 3] = a;

            let el = (old.l - chosen.l) * strength;
            let ea = (old.a - chosen.a) * strength;
            let eb = (old.b - chosen.b) * strength;

            for term in kernel.terms {
                // Mirror the horizontal offsets when scanning right to left, or
                // the kernel would push error into pixels that are already done.
                let nx = x + if rightward { term.dx } else { -term.dx };
                let ny = y + term.dy;
                if nx < 0 || nx >= w || ny >= h {
                    continue;
                }
                let q = ((ny * w + nx) as usize) * 3;
                buf[q] += el * term.weight;
                buf[q + 1] += ea * term.weight;
                buf[q + 2] += eb * term.weight;
            }
        }
    }

    Ok(QuantizeResult {
        image: PixelBuffer::from_data(src.width, src.height, out)?,
        indices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::quantize::prepare_palette;

    fn black_and_white() -> PreparedPalette {
        prepare_palette(vec![[0, 0, 0, 255], [255, 255, 255, 255]]).unwrap()
    }

    fn opaque() -> AlphaPolicy {
        AlphaPolicy {
            alpha_threshold: 128,
            preserve_alpha: false,
        }
    }

    fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelBuffer {
        let mut b = PixelBuffer::new(width, height).unwrap();
        for px in b.data.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        b
    }

    #[test]
    fn bayer_2_is_the_canonical_matrix() {
        assert_eq!(bayer_matrix(2).unwrap(), vec![0, 2, 3, 1]);
    }

    #[test]
    fn bayer_4_is_the_matrix_from_the_spec() {
        // docs/04 §5.3 prints exactly this.
        assert_eq!(
            bayer_matrix(4).unwrap(),
            vec![0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
        );
    }

    #[test]
    fn bayer_matrices_are_permutations_of_zero_to_n_squared() {
        for n in [2usize, 4, 8] {
            let mut m = bayer_matrix(n).unwrap();
            assert_eq!(m.len(), n * n);
            m.sort_unstable();
            assert_eq!(m, (0..(n * n) as i32).collect::<Vec<_>>());
        }
    }

    #[test]
    fn bayer_rejects_an_unsupported_size() {
        assert!(bayer_matrix(3).is_err());
        assert!(bayer_matrix(16).is_err());
    }

    #[test]
    fn spread_is_zero_for_a_single_colour_and_positive_otherwise() {
        assert_eq!(
            palette_spread(&prepare_palette(vec![[1, 2, 3, 255]]).unwrap()),
            0.0
        );
        assert!(palette_spread(&black_and_white()) > 0.5);
    }

    #[test]
    fn a_flat_mid_grey_dithers_into_a_mix_under_bayer() {
        // The whole point: a colour with no palette entry near it must break up
        // into a pattern rather than collapsing to one entry.
        let src = solid(8, 8, [128, 128, 128, 255]);
        let out = quantize_ordered(&src, &black_and_white(), opaque(), 4, 1.0, None).unwrap();
        assert!(out.indices.contains(&0), "no black");
        assert!(out.indices.contains(&1), "no white");
    }

    #[test]
    fn a_flat_mid_grey_dithers_into_a_mix_under_floyd_steinberg() {
        let src = solid(8, 8, [128, 128, 128, 255]);
        let out =
            quantize_error_diffusion(&src, &black_and_white(), opaque(), FLOYD_STEINBERG, 1.0)
                .unwrap();
        assert!(out.indices.contains(&0), "no black");
        assert!(out.indices.contains(&1), "no white");
    }

    #[test]
    fn a_colour_already_in_the_palette_is_never_dithered() {
        let src = solid(8, 8, [255, 255, 255, 255]);
        for out in [
            quantize_ordered(&src, &black_and_white(), opaque(), 8, 1.0, None).unwrap(),
            quantize_error_diffusion(&src, &black_and_white(), opaque(), FLOYD_STEINBERG, 1.0)
                .unwrap(),
            quantize_error_diffusion(&src, &black_and_white(), opaque(), ATKINSON, 1.0).unwrap(),
        ] {
            assert!(
                out.indices.iter().all(|&i| i == 1),
                "an exact palette colour picked up dither noise"
            );
        }
    }

    #[test]
    fn zero_strength_matches_undithered_output() {
        use crate::pipeline::quantize::quantize_none;
        use crate::pipeline::settings::ColorSpace;

        let mut src = PixelBuffer::new(16, 16).unwrap();
        for (i, px) in src.data.chunks_exact_mut(4).enumerate() {
            let v = (i * 255 / 255).min(255) as u8;
            px.copy_from_slice(&[v, v, v, 255]);
        }
        let palette = black_and_white();
        let plain = quantize_none(&src, &palette, ColorSpace::Oklab, opaque(), None).unwrap();

        for out in [
            quantize_ordered(&src, &palette, opaque(), 4, 0.0, None).unwrap(),
            quantize_error_diffusion(&src, &palette, opaque(), FLOYD_STEINBERG, 0.0).unwrap(),
            quantize_error_diffusion(&src, &palette, opaque(), ATKINSON, 0.0).unwrap(),
        ] {
            assert_eq!(out.indices, plain.indices);
        }
    }

    #[test]
    fn transparent_pixels_stay_transparent_under_every_mode() {
        let src = solid(4, 4, [128, 128, 128, 0]);
        for out in [
            quantize_ordered(&src, &black_and_white(), opaque(), 2, 1.0, None).unwrap(),
            quantize_error_diffusion(&src, &black_and_white(), opaque(), FLOYD_STEINBERG, 1.0)
                .unwrap(),
            quantize_error_diffusion(&src, &black_and_white(), opaque(), ATKINSON, 1.0).unwrap(),
        ] {
            assert!(out.indices.iter().all(|&i| i == TRANSPARENT_INDEX));
        }
    }

    #[test]
    fn atkinson_discards_a_quarter_of_the_error_and_floyd_steinberg_none() {
        let fs: f64 = FLOYD_STEINBERG.terms.iter().map(|t| t.weight).sum();
        let atkinson: f64 = ATKINSON.terms.iter().map(|t| t.weight).sum();
        assert!((fs - 1.0).abs() < 1e-15);
        assert!((atkinson - 0.75).abs() < 1e-15);
    }

    #[test]
    fn serpentine_is_on_for_floyd_steinberg_and_off_for_atkinson() {
        // Serpentine is a property of the *kernel*, not a global setting: it is
        // a Floyd-Steinberg correction for diagonal streaking, and turning it on
        // for Atkinson would change the classic-Mac look people choose Atkinson
        // for. Iterated rather than asserted directly so clippy does not see a
        // constant it can fold away.
        for (name, kernel) in [("floyd-steinberg", FLOYD_STEINBERG), ("atkinson", ATKINSON)] {
            assert_eq!(kernel.serpentine, name == "floyd-steinberg", "{name}");
        }
    }
}
