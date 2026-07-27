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

/// Direct-mapped memo for nearest-colour lookups (`docs/04` §4.2).
///
/// §4.2 sketches a table keyed on the top 5 bits per channel. Taken literally
/// that is **lossy** — two colours 7 apart in red would share an answer — which
/// is a quality regression bought with speed, and quietly changes output.
///
/// So the key is the same (5 bits per channel, 32,768 slots, same locality) but
/// each slot also stores the **full 24-bit colour it was filled from**. A hit
/// requires the tag to match; a mismatch recomputes and replaces. The cache is
/// then a pure memoization: it cannot change a single output pixel, which is
/// asserted directly in the tests and, more usefully, by the fact that the
/// entire golden corpus produces byte-identical output with and without it.
///
/// `lanes` exists for ordered dithering, where the same source colour resolves
/// differently depending on its position in the Bayer cell. One lane per cell
/// position keeps the memo exact there too.
///
/// > ⚠️ **Error diffusion must not use this**, and structurally cannot: the
/// > lookup takes 8-bit sRGB, while diffused values are arbitrary Oklab floats
/// > with no 24-bit key to tag on. That is §4.2's carve-out enforced by the
/// > types rather than by a comment.
#[derive(Debug, Clone)]
pub struct NearestCache {
    tags: Vec<i32>,
    values: Vec<u16>,
}

impl NearestCache {
    pub const SLOTS_PER_LANE: usize = 32768;

    pub fn new(lanes: usize) -> Self {
        assert!(lanes >= 1, "lanes must be at least 1");
        let size = lanes * Self::SLOTS_PER_LANE;
        Self {
            // -1 is "empty"; a real tag is a 24-bit colour, always >= 0.
            tags: vec![-1; size],
            values: vec![0; size],
        }
    }

    /// Top 5 bits per channel — the key from §4.2, shared with `coarse_key`.
    pub fn slot(r: u8, g: u8, b: u8) -> usize {
        ((r as usize >> 3) << 10) | ((g as usize >> 3) << 5) | (b as usize >> 3)
    }

    pub fn tag(r: u8, g: u8, b: u8) -> i32 {
        ((r as i32) << 16) | ((g as i32) << 8) | b as i32
    }

    /// Memoize `compute` against the source colour and lane.
    ///
    /// The caller supplies the computation rather than the cache deriving it,
    /// because the two callers do different things: undithered quantization asks
    /// for the nearest entry to the colour, ordered dithering asks for the
    /// nearest entry to the colour *perturbed by its Bayer cell*. Both are pure
    /// functions of `(r, g, b, lane)`, which is exactly what makes memoizing
    /// them exact.
    pub fn lookup<F: FnOnce() -> u16>(
        &mut self,
        r: u8,
        g: u8,
        b: u8,
        lane: usize,
        compute: F,
    ) -> u16 {
        let at = lane * Self::SLOTS_PER_LANE + Self::slot(r, g, b);
        let tag = Self::tag(r, g, b);
        if self.tags[at] == tag {
            return self.values[at];
        }
        let idx = compute();
        self.tags[at] = tag;
        self.values[at] = idx;
        idx
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
    cache: Option<&mut NearestCache>,
) -> Result<QuantizeResult, String> {
    let mut out = vec![0u8; src.data.len()];
    let mut indices = vec![TRANSPARENT_INDEX; src.pixel_count()];
    let mut cache = cache;

    for (p, (dst, px)) in out
        .chunks_exact_mut(4)
        .zip(src.data.chunks_exact(4))
        .enumerate()
    {
        let a = policy.resolve(px[3]);
        if a == 0 {
            continue;
        }
        let (r, g, b) = (px[0], px[1], px[2]);
        let idx = match cache.as_deref_mut() {
            Some(c) => c.lookup(r, g, b, 0, || nearest_index(palette, r, g, b, space)),
            None => nearest_index(palette, r, g, b, space),
        };
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
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy, None).unwrap();

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
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy, None).unwrap();
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
        let out = quantize_none(&src, &p, ColorSpace::Oklab, policy, None).unwrap();
        assert_eq!(out.image.data[3], 255);
    }

    /// The property the whole design rests on: the cache is a *memo*, so it can
    /// never change an output pixel. A lossy 5-bit table — which is what §4.2
    /// literally describes — would fail this.
    #[test]
    fn the_cache_cannot_change_a_single_pixel() {
        let palette = grey_ramp(8);
        let mut src = PixelBuffer::new(64, 64).unwrap();
        // Deliberately fill a single 5-bit bucket with many distinct colours:
        // 0..8 in each channel all share one slot, so this is the exact case a
        // lossy table would get wrong and a tag-checked one gets right.
        for (i, px) in src.data.chunks_exact_mut(4).enumerate() {
            let r = (i % 8) as u8;
            let g = ((i / 8) % 8) as u8;
            let b = ((i / 64) % 8) as u8;
            px.copy_from_slice(&[r, g, b, 255]);
        }

        let without = quantize_none(&src, &palette, ColorSpace::Oklab, opaque(), None).unwrap();
        let mut cache = NearestCache::new(1);
        let with = quantize_none(
            &src,
            &palette,
            ColorSpace::Oklab,
            opaque(),
            Some(&mut cache),
        )
        .unwrap();

        assert_eq!(with.indices, without.indices);
        assert_eq!(with.image.data, without.image.data);
    }

    #[test]
    fn a_tag_mismatch_recomputes_rather_than_returning_a_neighbours_answer() {
        let mut cache = NearestCache::new(1);
        // (0,0,0) and (7,7,7) share a slot but not a tag.
        assert_eq!(NearestCache::slot(0, 0, 0), NearestCache::slot(7, 7, 7));
        assert_ne!(NearestCache::tag(0, 0, 0), NearestCache::tag(7, 7, 7));

        assert_eq!(cache.lookup(0, 0, 0, 0, || 11), 11);
        assert_eq!(cache.lookup(7, 7, 7, 0, || 22), 22);
        // And the first colour is now a miss again, which is correct behaviour
        // for a direct-mapped cache and still exact.
        assert_eq!(cache.lookup(0, 0, 0, 0, || 33), 33);
    }

    #[test]
    fn a_repeat_of_the_same_colour_is_a_hit() {
        let mut cache = NearestCache::new(1);
        assert_eq!(cache.lookup(9, 40, 200, 0, || 5), 5);
        // The compute closure must not run; if it did, this would be 6.
        assert_eq!(cache.lookup(9, 40, 200, 0, || 6), 5);
    }

    #[test]
    fn lanes_do_not_collide() {
        let mut cache = NearestCache::new(4);
        assert_eq!(cache.lookup(1, 2, 3, 0, || 10), 10);
        assert_eq!(cache.lookup(1, 2, 3, 3, || 20), 20);
        assert_eq!(cache.lookup(1, 2, 3, 0, || 99), 10);
    }

    fn opaque() -> AlphaPolicy {
        AlphaPolicy {
            alpha_threshold: 128,
            preserve_alpha: false,
        }
    }

    /// Reproducible measurement behind the note in `docs/04` §4.2.
    ///
    /// Ignored by default because it is a timing, not an assertion:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml --release \
    ///     nearest_cache_benchmark -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "timing measurement, not a correctness assertion"]
    fn nearest_cache_benchmark() {
        use std::time::Instant;

        // A 54-colour palette, the NES-sized case §4.2 argues from.
        let palette = prepare_palette(
            (0..54)
                .map(|i| {
                    let i = i as u8;
                    [
                        i.wrapping_mul(37),
                        i.wrapping_mul(59),
                        i.wrapping_mul(83),
                        255,
                    ]
                })
                .collect(),
        )
        .unwrap();

        // 512x512 is a generous *output* size; the pipeline quantizes after
        // downscaling, so this is far larger than a normal conversion.
        let mut src = PixelBuffer::new(512, 512).unwrap();
        for (i, px) in src.data.chunks_exact_mut(4).enumerate() {
            let x = (i % 512) as u32;
            let y = (i / 512) as u32;
            px.copy_from_slice(&[
                (x * 255 / 511) as u8,
                (y * 255 / 511) as u8,
                ((x + y) * 255 / 1022) as u8,
                255,
            ]);
        }

        let t0 = Instant::now();
        let plain = quantize_none(&src, &palette, ColorSpace::Oklab, opaque(), None).unwrap();
        let without = t0.elapsed();

        let mut cache = NearestCache::new(1);
        let t1 = Instant::now();
        let cached = quantize_none(
            &src,
            &palette,
            ColorSpace::Oklab,
            opaque(),
            Some(&mut cache),
        )
        .unwrap();
        let with = t1.elapsed();

        assert_eq!(plain.indices, cached.indices, "cache changed the output");
        println!(
            "nearest cache, 512x512 x 54 colours: without {without:?}, with {with:?} \
             ({:.2}x)",
            without.as_secs_f64() / with.as_secs_f64()
        );
    }
}
