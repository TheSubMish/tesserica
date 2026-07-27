//! Stage [2] — crop / fit-to-subject (`docs/04-image-pipeline.md` §2, §8.5).
//!
//! Mirrors `src/pipeline/crop.ts`.

use super::buffer::PixelBuffer;
use super::settings::CropRect;

/// Crop to `rect`, clamped to the source.
///
/// A rect that misses the image entirely is an error rather than a 0×0 buffer —
/// every later stage assumes a non-empty image, and failing here names the
/// actual mistake.
pub fn crop(src: &PixelBuffer, rect: CropRect) -> Result<PixelBuffer, String> {
    let sw = src.width as i64;
    let sh = src.height as i64;

    let x0 = rect.x.clamp(0, sw);
    let y0 = rect.y.clamp(0, sh);
    let x1 = rect.x.saturating_add(rect.w).clamp(0, sw);
    let y1 = rect.y.saturating_add(rect.h).clamp(0, sh);

    let w = x1 - x0;
    let h = y1 - y0;
    if w < 1 || h < 1 {
        return Err(format!(
            "crop rect {},{} {}x{} does not overlap the {}x{} source",
            rect.x, rect.y, rect.w, rect.h, src.width, src.height
        ));
    }

    let (w, h) = (w as u32, h as u32);
    let mut out = vec![0u8; w as usize * h as usize * 4];
    for y in 0..h as usize {
        let from = ((y0 as usize + y) * src.width as usize + x0 as usize) * 4;
        let row = w as usize * 4;
        out[y * row..(y + 1) * row].copy_from_slice(&src.data[from..from + row]);
    }
    PixelBuffer::from_data(w, h, out)
}

/// Bounding box of everything with alpha at or above `threshold`, or `None` when
/// nothing is.
pub fn opaque_bounds(src: &PixelBuffer, threshold: u8) -> Option<CropRect> {
    let mut min_x = src.width as i64;
    let mut min_y = src.height as i64;
    let mut max_x = -1i64;
    let mut max_y = -1i64;

    for y in 0..src.height {
        for x in 0..src.width {
            if src.data[src.offset(x, y) + 3] >= threshold {
                let (x, y) = (x as i64, y as i64);
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }

    if max_x < 0 {
        return None;
    }
    Some(CropRect {
        x: min_x,
        y: min_y,
        w: max_x - min_x + 1,
        h: max_y - min_y + 1,
    })
}

/// Crop to the subject's bounding box (`docs/04` §8.5).
///
/// `padding` is in source pixels and is clamped to the image. Returns the source
/// unchanged when none of it is subject — a fully transparent buffer means
/// "there is nothing to fit to", and silently returning a 1×1 image would be
/// worse than doing nothing.
pub fn fit_to_subject(
    src: &PixelBuffer,
    alpha_threshold: u8,
    padding: i64,
) -> Result<PixelBuffer, String> {
    let Some(bounds) = opaque_bounds(src, alpha_threshold) else {
        return Ok(src.clone());
    };

    crop(
        src,
        CropRect {
            x: bounds.x - padding,
            y: bounds.y - padding,
            w: bounds.w + padding * 2,
            h: bounds.h + padding * 2,
        },
    )
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
    fn crops_the_requested_window() {
        let mut src = solid(4, 4, [10, 20, 30, 255]);
        let o = src.offset(2, 1);
        src.data[o..o + 4].copy_from_slice(&[9, 9, 9, 255]);

        let out = crop(
            &src,
            CropRect {
                x: 1,
                y: 1,
                w: 2,
                h: 2,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(&out.data[4..8], &[9, 9, 9, 255]);
    }

    #[test]
    fn clamps_a_rect_that_hangs_off_the_edge() {
        let src = solid(4, 4, [1, 2, 3, 255]);
        let out = crop(
            &src,
            CropRect {
                x: -2,
                y: -2,
                w: 4,
                h: 4,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (2, 2));
    }

    #[test]
    fn rejects_a_rect_that_misses_entirely() {
        let src = solid(4, 4, [1, 2, 3, 255]);
        assert!(crop(
            &src,
            CropRect {
                x: 10,
                y: 10,
                w: 4,
                h: 4
            }
        )
        .is_err());
    }

    #[test]
    fn fit_to_subject_finds_the_opaque_box() {
        let mut src = solid(8, 8, [0, 0, 0, 0]);
        for y in 2..5 {
            for x in 3..6 {
                let o = src.offset(x, y);
                src.data[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        let out = fit_to_subject(&src, 128, 0).unwrap();
        assert_eq!((out.width, out.height), (3, 3));
        assert_eq!(&out.data[0..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn fit_to_subject_on_a_fully_transparent_image_does_nothing() {
        let src = solid(4, 4, [0, 0, 0, 0]);
        let out = fit_to_subject(&src, 128, 0).unwrap();
        assert_eq!((out.width, out.height), (4, 4));
    }
}
