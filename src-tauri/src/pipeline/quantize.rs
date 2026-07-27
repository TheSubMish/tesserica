//! Stage [5] — quantize to the palette (`docs/04-image-pipeline.md` §4).
//!
//! Mirrors `src/pipeline/quantize.ts`.
//!
//! Dithering is a separate module that plugs in here; this file owns the palette
//! preparation, the nearest-colour search, and the alpha policy that every
//! dither mode shares.

use super::buffer::PixelBuffer;
use super::oklab::{self, Oklab, NEAREST_EPSILON};
use super::settings::{ColorSpace, ConvertSettings, Rgba};

/// The index map's stand-in for "this pixel is transparent and was never
/// quantized" (`docs/04` §4.4).
///
/// `u16::MAX`, which also caps a palette at 65,535 entries — four orders of
/// magnitude beyond anything a pixel-art palette contains.
pub const TRANSPARENT_INDEX: u16 = u16::MAX;

#[derive(Debug, Clone)]
pub struct QuantizeResult {
    pub image: PixelBuffer,
    /// One entry per pixel, row-major; `TRANSPARENT_INDEX` where transparent.
    pub indices: Vec<u16>,
}

/// A palette with its Oklab conversion done once, up front (§4.2).
#[derive(Debug, Clone)]
pub struct PreparedPalette {
    pub colors: Vec<Rgba>,
    pub lab: Vec<Oklab>,
}

pub fn prepare_palette(colors: Vec<Rgba>) -> Result<PreparedPalette, String> {
    if colors.is_empty() {
        return Err("palette is empty".to_string());
    }
    if colors.len() > TRANSPARENT_INDEX as usize {
        return Err(format!(
            "palette has {} entries, maximum is {TRANSPARENT_INDEX}",
            colors.len()
        ));
    }
    let lab = colors
        .iter()
        .map(|c| oklab::srgb8_to_oklab(c[0], c[1], c[2]))
        .collect();
    Ok(PreparedPalette { colors, lab })
}

/// Nearest palette entry to an Oklab colour.
///
/// The `- NEAREST_EPSILON` is D12's tie-break, not a micro-optimization: it makes
/// near-ties resolve to the **lowest palette index** in both languages. Exact
/// ties are real — a mid-grey exactly between two entries of a grayscale ramp
/// produces one — and without this the two implementations could legitimately
/// disagree on such a pixel while both being correct.
pub fn nearest_index_oklab(palette: &PreparedPalette, c: Oklab) -> u16 {
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

/// Nearest palette entry in sRGB.
///
/// Perceptually wrong — equal RGB distances do not look equally different and
/// dark colours collapse together — and exposed only as an escape hatch for
/// matching another tool's output (§4.1). Same tie-break, for the same reason.
pub fn nearest_index_srgb(palette: &PreparedPalette, r: u8, g: u8, b: u8) -> u16 {
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for (i, p) in palette.colors.iter().enumerate() {
        let dr = r as f64 - p[0] as f64;
        let dg = g as f64 - p[1] as f64;
        let db = b as f64 - p[2] as f64;
        let d = dr * dr + dg * dg + db * db;
        if d < best_d - NEAREST_EPSILON {
            best_d = d;
            best = i;
        }
    }
    best as u16
}

pub fn nearest_index(palette: &PreparedPalette, r: u8, g: u8, b: u8, space: ColorSpace) -> u16 {
    match space {
        ColorSpace::Oklab => nearest_index_oklab(palette, oklab::srgb8_to_oklab(r, g, b)),
        ColorSpace::Srgb => nearest_index_srgb(palette, r, g, b),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlphaPolicy {
    /// 0..255. Below this a pixel is fully transparent and is not quantized.
    pub alpha_threshold: u8,
    /// Keep the source alpha above the threshold instead of snapping to opaque.
    pub preserve_alpha: bool,
}

impl AlphaPolicy {
    pub fn from_settings(settings: &ConvertSettings) -> Self {
        Self {
            alpha_threshold: settings.alpha_threshold,
            preserve_alpha: settings.preserve_alpha,
        }
    }

    /// Resolve a pixel's output alpha, or `0` when it is to be dropped entirely.
    ///
    /// Alpha is never quantized against the palette, and a palette entry's own
    /// alpha is ignored — the palette is a list of *colours* (§4.4, D9).
    pub fn resolve(&self, a: u8) -> u8 {
        if a < self.alpha_threshold {
            0
        } else if self.preserve_alpha {
            a
        } else {
            255
        }
    }
}

/// Quantize with no dithering.
///
/// Split out from the dispatcher so the dither modes can share the alpha policy
/// and the index-map contract without re-deriving them.
pub fn quantize_none(
    src: &PixelBuffer,
    palette: &PreparedPalette,
    space: ColorSpace,
    policy: AlphaPolicy,
) -> Result<QuantizeResult, String> {
    let mut out = vec![0u8; src.data.len()];
    let mut indices = vec![TRANSPARENT_INDEX; src.pixel_count()];

    for (p, (dst, px)) in out
        .chunks_exact_mut(4)
        .zip(src.data.chunks_exact(4))
        .enumerate()
    {
        let a = policy.resolve(px[3]);
        if a == 0 {
            continue;
        }
        let idx = nearest_index(palette, px[0], px[1], px[2], space);
        let c = palette.colors[idx as usize];
        indices[p] = idx;
        dst[0] = c[0];
        dst[1] = c[1];
        dst[2] = c[2];
        dst[3] = a;
    }

    Ok(QuantizeResult {
        image: PixelBuffer::from_data(src.width, src.height, out)?,
        indices,
    })
}

/// Paint an index map back into RGBA using the palette and a per-pixel alpha.
pub fn render_indices(
    width: u32,
    height: u32,
    indices: &[u16],
    palette: &PreparedPalette,
    alpha: &[u8],
) -> Result<PixelBuffer, String> {
    let mut out = vec![0u8; width as usize * height as usize * 4];
    for (p, dst) in out.chunks_exact_mut(4).enumerate() {
        let idx = indices[p];
        if idx == TRANSPARENT_INDEX {
            continue;
        }
        let c = palette.colors[idx as usize];
        dst[0] = c[0];
        dst[1] = c[1];
        dst[2] = c[2];
        dst[3] = alpha[p];
    }
    PixelBuffer::from_data(width, height, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey_ramp(n: usize) -> PreparedPalette {
        let colors = (0..n)
            .map(|i| {
                let v = (i * 255 / (n - 1)) as u8;
                [v, v, v, 255]
            })
            .collect();
        prepare_palette(colors).unwrap()
    }

    #[test]
    fn rejects_an_empty_palette() {
        assert!(prepare_palette(vec![]).is_err());
    }

    #[test]
    fn picks_the_obvious_nearest_colour() {
        let p =
            prepare_palette(vec![[0, 0, 0, 255], [255, 255, 255, 255], [255, 0, 0, 255]]).unwrap();
        assert_eq!(nearest_index(&p, 250, 5, 5, ColorSpace::Oklab), 2);
        assert_eq!(nearest_index(&p, 8, 8, 8, ColorSpace::Oklab), 0);
        assert_eq!(nearest_index(&p, 250, 250, 250, ColorSpace::Oklab), 1);
    }

    /// D12's tie-break, exercised on the case the decision log names: a colour
    /// exactly between two entries must resolve to the lower index, in both
    /// languages, every time.
    #[test]
    fn an_exact_tie_resolves_to_the_lower_index() {
        let black_and_white = prepare_palette(vec![[0, 0, 0, 255], [255, 255, 255, 255]]).unwrap();
        // Construct a colour exactly equidistant in Oklab by taking the midpoint
        // of the two palette entries' Oklab values.
        let a = black_and_white.lab[0];
        let b = black_and_white.lab[1];
        let mid = Oklab::new((a.l + b.l) / 2.0, (a.a + b.a) / 2.0, (a.b + b.b) / 2.0);
        assert_eq!(nearest_index_oklab(&black_and_white, mid), 0);
    }

    #[test]
    fn a_tie_in_srgb_also_resolves_to_the_lower_index() {
        let p = prepare_palette(vec![[100, 100, 100, 255], [140, 140, 140, 255]]).unwrap();
        assert_eq!(nearest_index_srgb(&p, 120, 120, 120), 0);
    }

    #[test]
    fn a_greyscale_ramp_maps_monotonically() {
        let p = grey_ramp(5);
        let mut previous = 0u16;
        for v in 0..=255u8 {
            let i = nearest_index(&p, v, v, v, ColorSpace::Oklab);
            assert!(i >= previous, "index went backwards at {v}");
            previous = i;
        }
        assert_eq!(previous, 4);
    }

    #[test]
    fn transparent_pixels_are_not_quantized() {
        let p = prepare_palette(vec![[255, 0, 0, 255]]).unwrap();
        let src = PixelBuffer::from_data(2, 1, vec![10, 200, 30, 10, 10, 200, 30, 250]).unwrap();
        let policy = AlphaPolicy {
            alpha_threshold: 128,
            preserve_alpha: false,
        };
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy).unwrap();

        assert_eq!(out.indices[0], TRANSPARENT_INDEX);
        assert_eq!(&out.image.data[0..4], &[0, 0, 0, 0]);
        assert_eq!(out.indices[1], 0);
        assert_eq!(&out.image.data[4..8], &[255, 0, 0, 255]);
    }

    #[test]
    fn preserve_alpha_keeps_the_source_value() {
        let p = prepare_palette(vec![[255, 0, 0, 255]]).unwrap();
        let src = PixelBuffer::from_data(1, 1, vec![250, 10, 10, 200]).unwrap();
        let policy = AlphaPolicy {
            alpha_threshold: 128,
            preserve_alpha: true,
        };
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy).unwrap();
        assert_eq!(out.image.data[3], 200);
    }

    #[test]
    fn a_palette_entrys_own_alpha_is_ignored() {
        let p = prepare_palette(vec![[255, 0, 0, 7]]).unwrap();
        let src = PixelBuffer::from_data(1, 1, vec![250, 10, 10, 255]).unwrap();
        let policy = AlphaPolicy {
            alpha_threshold: 128,
            preserve_alpha: false,
        };
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy).unwrap();
        assert_eq!(out.image.data[3], 255);
    }
}
