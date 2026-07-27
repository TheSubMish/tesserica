//! Stage [3] — colour adjustments (`docs/04-image-pipeline.md` §9).
//!
//! Mirrors `src/pipeline/adjust.ts`.
//!
//! All four happen **in Oklab**, which is the whole point: sRGB saturation
//! boosts blow out hues and sRGB brightness crushes shadows. And they happen
//! **before** quantization (§2.1) so the palette match is made against the
//! colours the user actually intends, once, rather than being re-mapped and
//! compounding error.
//!
//! Order within the stage is brightness → contrast → saturation → hue, matching
//! §2.2 and §9. Order matters here too — contrast after brightness is not the
//! same as before it — so it is fixed and identical in both implementations.

use super::buffer::PixelBuffer;
use super::oklab::{self, Oklab};
use super::settings::ConvertSettings;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AdjustParams {
    /// -1..1
    pub brightness: f64,
    /// -1..1
    pub contrast: f64,
    /// -1..1
    pub saturation: f64,
    /// -180..180 degrees
    pub hue_shift: f64,
}

impl AdjustParams {
    pub fn from_settings(settings: &ConvertSettings) -> Self {
        Self {
            brightness: settings.brightness,
            contrast: settings.contrast,
            saturation: settings.saturation,
            hue_shift: settings.hue_shift,
        }
    }

    /// True when every adjustment is at its neutral value.
    pub fn is_neutral(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.hue_shift == 0.0
    }
}

/// Apply the adjustments to one colour. Exposed for tests and for dither paths.
pub fn adjust_oklab(c: Oklab, p: AdjustParams) -> Oklab {
    // Brightness: scale L.
    let mut l = c.l * (1.0 + p.brightness);
    // Contrast: expand around mid-lightness.
    l = (l - 0.5) * (1.0 + p.contrast) + 0.5;

    // Saturation: scale chroma.
    let sat = 1.0 + p.saturation;
    let mut a = c.a * sat;
    let mut b = c.b * sat;

    // Hue: rotate the a/b plane.
    if p.hue_shift != 0.0 {
        let rad = p.hue_shift * std::f64::consts::PI / 180.0;
        let (sin, cos) = (rad.sin(), rad.cos());
        let (ra, rb) = (a * cos - b * sin, a * sin + b * cos);
        a = ra;
        b = rb;
    }

    Oklab { l, a, b }
}

/// Apply the adjustments to a whole buffer.
///
/// Alpha is untouched, and fully transparent pixels are adjusted along with
/// everything else — their RGB is meaningless, but branching on alpha here would
/// make the result depend on the threshold, which belongs to a later stage.
///
/// Neutral settings return the source unchanged rather than round-tripping every
/// pixel through Oklab. That is both faster and safer: an 8-bit → Oklab → 8-bit
/// round trip is exact, but "exact" is a property worth not relying on when the
/// correct answer is to do nothing.
pub fn apply_adjustments(src: &PixelBuffer, p: AdjustParams) -> Result<PixelBuffer, String> {
    if p.is_neutral() {
        return Ok(src.clone());
    }

    let mut out = vec![0u8; src.data.len()];
    for (dst, px) in out.chunks_exact_mut(4).zip(src.data.chunks_exact(4)) {
        let c = adjust_oklab(oklab::srgb8_to_oklab(px[0], px[1], px[2]), p);
        let (r, g, b) = oklab::oklab_to_srgb8(c);
        dst[0] = r;
        dst[1] = g;
        dst[2] = b;
        dst[3] = px[3];
    }
    PixelBuffer::from_data(src.width, src.height, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(r: u8, g: u8, b: u8, a: u8) -> PixelBuffer {
        PixelBuffer::from_data(1, 1, vec![r, g, b, a]).unwrap()
    }

    #[test]
    fn neutral_settings_are_a_no_op() {
        let src = pixel(37, 111, 200, 128);
        let out = apply_adjustments(&src, AdjustParams::default()).unwrap();
        assert_eq!(out.data, src.data);
    }

    #[test]
    fn brightness_moves_lightness_and_leaves_alpha_alone() {
        let src = pixel(100, 100, 100, 77);
        let up = apply_adjustments(
            &src,
            AdjustParams {
                brightness: 0.5,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(up.data[0] > 100, "expected brighter, got {}", up.data[0]);
        assert_eq!(up.data[3], 77);

        let down = apply_adjustments(
            &src,
            AdjustParams {
                brightness: -0.5,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(down.data[0] < 100);
    }

    #[test]
    fn saturation_of_minus_one_makes_a_colour_grey() {
        let src = pixel(200, 40, 40, 255);
        let out = apply_adjustments(
            &src,
            AdjustParams {
                saturation: -1.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.data[0], out.data[1]);
        assert_eq!(out.data[1], out.data[2]);
    }

    #[test]
    fn saturation_does_not_disturb_a_grey() {
        let src = pixel(128, 128, 128, 255);
        let out = apply_adjustments(
            &src,
            AdjustParams {
                saturation: 0.8,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(&out.data[0..3], &[128, 128, 128]);
    }

    #[test]
    fn a_full_turn_of_hue_returns_the_original_colour() {
        let c = oklab::srgb8_to_oklab(210, 90, 30);
        let turned = adjust_oklab(
            c,
            AdjustParams {
                hue_shift: 360.0,
                ..Default::default()
            },
        );
        assert!((turned.a - c.a).abs() < 1e-12);
        assert!((turned.b - c.b).abs() < 1e-12);
    }

    #[test]
    fn contrast_pushes_away_from_mid_lightness() {
        let dark = adjust_oklab(
            Oklab::new(0.3, 0.0, 0.0),
            AdjustParams {
                contrast: 0.5,
                ..Default::default()
            },
        );
        let light = adjust_oklab(
            Oklab::new(0.7, 0.0, 0.0),
            AdjustParams {
                contrast: 0.5,
                ..Default::default()
            },
        );
        assert!(dark.l < 0.3);
        assert!(light.l > 0.7);
    }
}
