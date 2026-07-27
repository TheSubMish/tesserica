//! Oklab — the perceptual colour space every colour decision in the pipeline is
//! made in (`docs/04-image-pipeline.md` §4.1).
//!
//! Mirrors `src/pipeline/oklab.ts` function for function. When you touch one,
//! touch the other in the same change.
//!
//! The transform constants below are Bjorn Ottosson's published matrices,
//! duplicated on purpose from `shared/oklab.constants.json` rather than parsed
//! at runtime. The tests at the bottom of this file assert every literal here
//! against that file, and `oklab.test.ts` does the same on its side, so the
//! duplication cannot drift (D10).
//!
//! Precision is `f64` on both sides (D12): `f32` drifts up to 3.6e-7 from
//! `f64`, which is enough to flip a nearest-colour `argmin` near a tie and
//! change an output pixel. The 6.7e-16 residual between Rust `f64` and JS `f64`
//! cannot.

use std::sync::LazyLock;

pub const SRGB_TO_LINEAR_THRESHOLD: f64 = 0.04045;
pub const SRGB_TO_LINEAR_DIVISOR: f64 = 12.92;
pub const SRGB_TO_LINEAR_OFFSET: f64 = 0.055;
pub const SRGB_TO_LINEAR_SCALE: f64 = 1.055;
pub const SRGB_TO_LINEAR_EXPONENT: f64 = 2.4;

pub const LINEAR_TO_SRGB_THRESHOLD: f64 = 0.0031308;
pub const LINEAR_TO_SRGB_SCALE: f64 = 12.92;
pub const LINEAR_TO_SRGB_MUL: f64 = 1.055;
pub const LINEAR_TO_SRGB_OFFSET: f64 = 0.055;
pub const LINEAR_TO_SRGB_EXPONENT: f64 = 2.4;

pub const LINEAR_TO_LMS: [[f64; 3]; 3] = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];

pub const LMS_TO_OKLAB: [[f64; 3]; 3] = [
    [0.2104542553, 0.793617785, -0.0040720468],
    [1.9779984951, -2.428592205, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.808675766],
];

pub const OKLAB_TO_LMS: [[f64; 3]; 3] = [
    [1.0, 0.3963377774, 0.2158037573],
    [1.0, -0.1055613458, -0.0638541728],
    [1.0, -0.0894841775, -1.291485548],
];

pub const LMS_TO_LINEAR: [[f64; 3]; 3] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
];

/// The tie-break epsilon from D12, in squared-Oklab units.
///
/// ~3.2e-5 in Oklab distance against a JND of ~0.002, so it can never change a
/// visible choice; ~10^6 times the 6.7e-16 cross-language float residual it
/// exists to absorb.
pub const NEAREST_EPSILON: f64 = 1e-9;

/// A colour in Oklab. `l` is perceptual lightness in roughly 0..1; `a` and `b`
/// are the opponent axes, roughly -0.4..0.4 for in-gamut sRGB.
///
/// Alpha is deliberately absent. Alpha is never quantized against the palette
/// and never travels through the colour-distance code (`docs/04` §4.4).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

impl Oklab {
    pub const fn new(l: f64, a: f64, b: f64) -> Self {
        Self { l, a, b }
    }
}

/// sRGB electro-optical transfer function. `c` in 0..1.
pub fn srgb_to_linear(c: f64) -> f64 {
    if c <= SRGB_TO_LINEAR_THRESHOLD {
        c / SRGB_TO_LINEAR_DIVISOR
    } else {
        ((c + SRGB_TO_LINEAR_OFFSET) / SRGB_TO_LINEAR_SCALE).powf(SRGB_TO_LINEAR_EXPONENT)
    }
}

/// Inverse of [`srgb_to_linear`]. `c` in 0..1.
pub fn linear_to_srgb(c: f64) -> f64 {
    if c <= LINEAR_TO_SRGB_THRESHOLD {
        c * LINEAR_TO_SRGB_SCALE
    } else {
        LINEAR_TO_SRGB_MUL * c.powf(1.0 / LINEAR_TO_SRGB_EXPONENT) - LINEAR_TO_SRGB_OFFSET
    }
}

/// sRGB (0..1 per channel) → Oklab.
pub fn srgb_to_oklab(r: f64, g: f64, b: f64) -> Oklab {
    linear_srgb_to_oklab(srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))
}

/// Linear sRGB (0..1 per channel) → Oklab.
pub fn linear_srgb_to_oklab(r: f64, g: f64, b: f64) -> Oklab {
    let l = LINEAR_TO_LMS[0][0] * r + LINEAR_TO_LMS[0][1] * g + LINEAR_TO_LMS[0][2] * b;
    let m = LINEAR_TO_LMS[1][0] * r + LINEAR_TO_LMS[1][1] * g + LINEAR_TO_LMS[1][2] * b;
    let s = LINEAR_TO_LMS[2][0] * r + LINEAR_TO_LMS[2][1] * g + LINEAR_TO_LMS[2][2] * b;

    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());

    Oklab {
        l: LMS_TO_OKLAB[0][0] * l_ + LMS_TO_OKLAB[0][1] * m_ + LMS_TO_OKLAB[0][2] * s_,
        a: LMS_TO_OKLAB[1][0] * l_ + LMS_TO_OKLAB[1][1] * m_ + LMS_TO_OKLAB[1][2] * s_,
        b: LMS_TO_OKLAB[2][0] * l_ + LMS_TO_OKLAB[2][1] * m_ + LMS_TO_OKLAB[2][2] * s_,
    }
}

/// Oklab → linear sRGB. May return out-of-gamut values; see [`oklab_to_srgb`].
pub fn oklab_to_linear_srgb(c: Oklab) -> (f64, f64, f64) {
    let l_ = OKLAB_TO_LMS[0][0] * c.l + OKLAB_TO_LMS[0][1] * c.a + OKLAB_TO_LMS[0][2] * c.b;
    let m_ = OKLAB_TO_LMS[1][0] * c.l + OKLAB_TO_LMS[1][1] * c.a + OKLAB_TO_LMS[1][2] * c.b;
    let s_ = OKLAB_TO_LMS[2][0] * c.l + OKLAB_TO_LMS[2][1] * c.a + OKLAB_TO_LMS[2][2] * c.b;

    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);

    (
        LMS_TO_LINEAR[0][0] * l + LMS_TO_LINEAR[0][1] * m + LMS_TO_LINEAR[0][2] * s,
        LMS_TO_LINEAR[1][0] * l + LMS_TO_LINEAR[1][1] * m + LMS_TO_LINEAR[1][2] * s,
        LMS_TO_LINEAR[2][0] * l + LMS_TO_LINEAR[2][1] * m + LMS_TO_LINEAR[2][2] * s,
    )
}

/// Oklab → sRGB (0..1 per channel).
///
/// Out-of-gamut results are clamped in **linear** light, before the transfer
/// function, and both implementations must clamp at the same point — clamping
/// after encoding gives different values for the same input.
pub fn oklab_to_srgb(c: Oklab) -> (f64, f64, f64) {
    let (lr, lg, lb) = oklab_to_linear_srgb(c);
    (
        linear_to_srgb(clamp01(lr)),
        linear_to_srgb(clamp01(lg)),
        linear_to_srgb(clamp01(lb)),
    )
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// 8-bit sRGB → linear, via a 256-entry table.
///
/// Every source pixel goes through this, so the table matters; it holds exactly
/// the values [`srgb_to_linear`] would return, so it changes nothing about the
/// result. The TS side builds the identical table.
static SRGB8_TO_LINEAR: LazyLock<[f64; 256]> = LazyLock::new(|| {
    let mut t = [0.0f64; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        *slot = srgb_to_linear(i as f64 / 255.0);
    }
    t
});

/// 8-bit sRGB → linear sRGB (0..1).
pub fn srgb8_to_linear(c: u8) -> f64 {
    SRGB8_TO_LINEAR[c as usize]
}

/// 8-bit sRGB → Oklab. The pipeline's normal entry point.
pub fn srgb8_to_oklab(r: u8, g: u8, b: u8) -> Oklab {
    let t = &*SRGB8_TO_LINEAR;
    linear_srgb_to_oklab(t[r as usize], t[g as usize], t[b as usize])
}

/// Oklab → 8-bit sRGB, rounded half-up and clamped.
pub fn oklab_to_srgb8(c: Oklab) -> (u8, u8, u8) {
    let (r, g, b) = oklab_to_srgb(c);
    (to8(r), to8(g), to8(b))
}

fn to8(v: f64) -> u8 {
    // `f64::round` is round-half-away-from-zero; JS `Math.round` is
    // round-half-up. They differ only for negative halves, which cannot occur
    // here because `v` is already clamped to 0..1.
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Squared Euclidean distance in Oklab.
///
/// Squared, not rooted: nearest-colour only ever compares distances, and the
/// square root is both wasted work and an extra place for the two
/// implementations' libms to disagree.
///
/// Callers comparing against a running best must use the D12 tie-break
/// (`d < best - NEAREST_EPSILON`) so near-ties resolve to the lowest palette
/// index identically in both languages — see `docs/04` §4.2.
pub fn distance_sq(x: Oklab, y: Oklab) -> f64 {
    let (dl, da, db) = (x.l - y.l, x.a - y.a, x.b - y.b);
    dl * dl + da * da + db * db
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The D10 guard, Rust side: assert this file's literals against
    /// `shared/oklab.constants.json`. `src/pipeline/oklab.test.ts` asserts the
    /// TS literals against the same file, so changing one implementation's
    /// constants without the other fails a test in the language that was not
    /// edited.
    fn shared() -> Value {
        serde_json::from_str(include_str!("../../../shared/oklab.constants.json"))
            .expect("shared/oklab.constants.json is valid JSON")
    }

    fn matrix(v: &Value) -> [[f64; 3]; 3] {
        let rows = v.as_array().expect("matrix is an array");
        let mut m = [[0.0f64; 3]; 3];
        for (i, row) in rows.iter().enumerate() {
            for (j, cell) in row.as_array().expect("row is an array").iter().enumerate() {
                m[i][j] = cell.as_f64().expect("cell is a number");
            }
        }
        m
    }

    fn scalar(v: &Value, key: &str) -> f64 {
        v[key].as_f64().unwrap_or_else(|| panic!("missing {key}"))
    }

    #[test]
    fn transfer_function_constants_match_shared() {
        let c = shared();
        let f = &c["srgbToLinear"];
        assert_eq!(scalar(f, "threshold"), SRGB_TO_LINEAR_THRESHOLD);
        assert_eq!(scalar(f, "divisor"), SRGB_TO_LINEAR_DIVISOR);
        assert_eq!(scalar(f, "offset"), SRGB_TO_LINEAR_OFFSET);
        assert_eq!(scalar(f, "scale"), SRGB_TO_LINEAR_SCALE);
        assert_eq!(scalar(f, "exponent"), SRGB_TO_LINEAR_EXPONENT);

        let g = &c["linearToSrgb"];
        assert_eq!(scalar(g, "threshold"), LINEAR_TO_SRGB_THRESHOLD);
        assert_eq!(scalar(g, "scale"), LINEAR_TO_SRGB_SCALE);
        assert_eq!(scalar(g, "mul"), LINEAR_TO_SRGB_MUL);
        assert_eq!(scalar(g, "offset"), LINEAR_TO_SRGB_OFFSET);
        assert_eq!(scalar(g, "exponent"), LINEAR_TO_SRGB_EXPONENT);
    }

    #[test]
    fn matrices_match_shared() {
        let c = shared();
        assert_eq!(matrix(&c["linearToLms"]), LINEAR_TO_LMS);
        assert_eq!(matrix(&c["lmsToOklab"]), LMS_TO_OKLAB);
        assert_eq!(matrix(&c["oklabToLms"]), OKLAB_TO_LMS);
        assert_eq!(matrix(&c["lmsToLinear"]), LMS_TO_LINEAR);
    }

    #[test]
    fn transfer_function_anchors_and_round_trip() {
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert!((srgb_to_linear(1.0) - 1.0).abs() < 1e-15);
        assert_eq!(linear_to_srgb(0.0), 0.0);
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-15);

        for i in 0..256u32 {
            let c = i as f64 / 255.0;
            let back = (linear_to_srgb(srgb_to_linear(c)) * 255.0).round() as u32;
            assert_eq!(back, i, "round trip failed at {i}");
        }
    }

    #[test]
    fn transfer_function_is_near_continuous_at_the_threshold() {
        // The sRGB standard's published constants are rounded, so the two
        // branches do not meet exactly — the step is ~2.5e-9. A property of the
        // standard, not of this code; assert its size so a typo cannot hide.
        let t = SRGB_TO_LINEAR_THRESHOLD;
        let step = (srgb_to_linear(t + 1e-9) - srgb_to_linear(t - 1e-9)).abs();
        assert!(step < 1e-8, "step at threshold was {step}");
    }

    #[test]
    fn white_black_and_greys() {
        let w = srgb_to_oklab(1.0, 1.0, 1.0);
        assert!((w.l - 1.0).abs() < 1e-6);
        assert!(w.a.abs() < 1e-6 && w.b.abs() < 1e-6);

        let k = srgb_to_oklab(0.0, 0.0, 0.0);
        assert!(k.l.abs() < 1e-12 && k.a.abs() < 1e-12 && k.b.abs() < 1e-12);

        // Ottosson's matrices are published rounded to 10 decimals, so a
        // perfect grey lands ~7e-9 off the neutral axis rather than exactly on
        // it. Far below a JND (~2e-3) and below the D12 tie-break's reach.
        for i in (0..256).step_by(17) {
            let c = srgb8_to_oklab(i as u8, i as u8, i as u8);
            assert!(c.a.abs() < 1e-7 && c.b.abs() < 1e-7, "grey {i} not neutral");
        }
    }

    #[test]
    fn lightness_is_monotonic_along_the_grey_ramp() {
        let mut prev = f64::NEG_INFINITY;
        for i in 0..=255u8 {
            let l = srgb8_to_oklab(i, i, i).l;
            assert!(l > prev, "L not monotonic at {i}");
            prev = l;
        }
    }

    #[test]
    fn hue_signs() {
        let r = srgb_to_oklab(1.0, 0.0, 0.0);
        assert!(r.a > 0.0 && r.b > 0.0);
        assert!(srgb_to_oklab(0.0, 0.0, 1.0).b < 0.0);
    }

    #[test]
    fn table_path_agrees_with_the_float_path() {
        for (r, g, b) in [
            (0, 0, 0),
            (255, 255, 255),
            (12, 200, 77),
            (1, 2, 3),
            (254, 0, 128),
        ] {
            let via_table = srgb8_to_oklab(r, g, b);
            let via_float = srgb_to_oklab(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
            assert_eq!(via_table, via_float);
        }
    }

    #[test]
    fn round_trip_recovers_every_colour_on_a_coarse_grid() {
        for r in (0..256).step_by(17) {
            for g in (0..256).step_by(17) {
                for b in (0..256).step_by(17) {
                    let (r2, g2, b2) = oklab_to_srgb8(srgb8_to_oklab(r as u8, g as u8, b as u8));
                    assert_eq!(
                        (r2, g2, b2),
                        (r as u8, g as u8, b as u8),
                        "round trip failed at ({r},{g},{b})"
                    );
                }
            }
        }
    }

    #[test]
    fn out_of_gamut_is_clamped_not_wrapped() {
        let (r, g, b) = oklab_to_srgb(Oklab::new(0.9, -0.5, 0.4));
        for c in [r, g, b] {
            assert!(
                (0.0..=1.0).contains(&c),
                "channel {c} escaped the gamut clamp"
            );
        }
    }

    #[test]
    fn distance_is_zero_symmetric_and_ordered() {
        let x = srgb8_to_oklab(10, 20, 30);
        let y = srgb8_to_oklab(200, 100, 50);
        assert_eq!(distance_sq(x, x), 0.0);
        assert_eq!(distance_sq(x, y), distance_sq(y, x));

        let base = srgb8_to_oklab(128, 128, 128);
        let near = srgb8_to_oklab(130, 128, 128);
        let far = srgb8_to_oklab(255, 0, 0);
        assert!(distance_sq(base, near) < distance_sq(base, far));
    }

    #[test]
    fn tie_break_epsilon_is_far_below_a_jnd() {
        // Applied to *squared* distance, so compare in that space (D12).
        assert!(NEAREST_EPSILON.sqrt() < 0.002 / 50.0);
    }
}
