//! PNG export.
//!
//! Rust owns encoding because Rust owns everything the user *ships*
//! (`docs/02-architecture.md` §3.2). The frontend composites the sprite at
//! document scale, stages the straight-alpha RGBA bytes over the raw IPC body
//! (`staging.rs`), and sends only metadata here.
//!
//! Two invariants live in this file:
//!
//! - **Integer scale factors only** (1× / 2× / 4× / 8×). A non-integer scale
//!   makes some output pixels 3 source pixels wide and others 4; at pixel-art
//!   sizes that is not subtle, it is the first thing anyone notices.
//! - **Nearest-neighbour, always.** At an integer scale this degenerates to
//!   plain pixel replication, which is exactly right and needs no filtering
//!   decision at all. Pixel-art-aware *non*-integer scaling (rotxel, cleanEdge)
//!   is Phase 7 and does not belong on the export path.
//!
//! Alpha stays straight throughout. PNG stores unassociated alpha, and
//! `image` does not premultiply, so the bytes the user drew are the bytes on
//! disk.

use std::io::BufWriter;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::staging::Staging;

/// The scale factors offered on export. Locked to powers of two.
pub const ALLOWED_SCALES: [u32; 4] = [1, 2, 4, 8];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPngRequest {
    /// Handle to the composited RGBA bytes staged over the raw IPC body.
    pub stage_id: u64,
    pub width: u32,
    pub height: u32,
    pub scale: u32,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Replicate each source pixel into a `scale`×`scale` block.
///
/// This *is* nearest-neighbour for integer factors — every destination pixel
/// maps to exactly one source pixel with no rounding — and it copies four
/// bytes at a time, so no channel is ever averaged and no fringe can appear.
pub fn scale_nearest(src: &[u8], width: u32, height: u32, scale: u32) -> Result<Vec<u8>, AppError> {
    if !ALLOWED_SCALES.contains(&scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {scale}"
        )));
    }
    let expected = (width as usize) * (height as usize) * 4;
    if src.len() != expected {
        return Err(AppError::invalid(format!(
            "expected {expected} bytes for {width}x{height} RGBA, got {}",
            src.len()
        )));
    }

    if scale == 1 {
        return Ok(src.to_vec());
    }

    let out_w = width as usize * scale as usize;
    let mut out = vec![0u8; out_w * height as usize * scale as usize * 4];

    for y in 0..height as usize {
        // Build one destination row, then copy it `scale` times: the vertical
        // repeat is a memcpy rather than a per-pixel loop.
        let row_start = y * scale as usize * out_w * 4;
        for x in 0..width as usize {
            let s = (y * width as usize + x) * 4;
            let px = &src[s..s + 4];
            for k in 0..scale as usize {
                let d = row_start + (x * scale as usize + k) * 4;
                out[d..d + 4].copy_from_slice(px);
            }
        }
        for r in 1..scale as usize {
            let (head, tail) = out.split_at_mut(row_start + r * out_w * 4);
            let source = &head[row_start..row_start + out_w * 4];
            tail[..out_w * 4].copy_from_slice(source);
        }
    }

    Ok(out)
}

pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    {
        let writer = BufWriter::new(&mut bytes);
        let encoder = image::codecs::png::PngEncoder::new(writer);
        image::ImageEncoder::write_image(
            encoder,
            rgba,
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )?;
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn export_png(
    request: ExportPngRequest,
    staging: State<'_, Staging>,
) -> Result<ExportResult, AppError> {
    let src = staging.get(request.stage_id)?;

    let out_w = request
        .width
        .checked_mul(request.scale)
        .ok_or_else(|| AppError::invalid("output width overflows"))?;
    let out_h = request
        .height
        .checked_mul(request.scale)
        .ok_or_else(|| AppError::invalid("output height overflows"))?;

    let scaled = scale_nearest(&src, request.width, request.height, request.scale)?;
    let png = encode_png(&scaled, out_w, out_h)?;
    let len = png.len() as u64;

    std::fs::write(&request.path, png)?;
    staging.release(request.stage_id);

    Ok(ExportResult {
        path: request.path,
        width: out_w,
        height: out_h,
        bytes: len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×1: one opaque red pixel, one fully transparent pixel carrying red RGB.
    fn two_pixels() -> Vec<u8> {
        vec![255, 0, 0, 255, 255, 0, 0, 0]
    }

    #[test]
    fn scale_one_is_a_passthrough() {
        assert_eq!(scale_nearest(&two_pixels(), 2, 1, 1).unwrap(), two_pixels());
    }

    #[test]
    fn replicates_each_pixel_into_a_square_block() {
        let out = scale_nearest(&[1, 2, 3, 4], 1, 1, 4).unwrap();
        assert_eq!(out.len(), 4 * 4 * 4);
        for chunk in out.chunks(4) {
            assert_eq!(chunk, [1, 2, 3, 4]);
        }
    }

    #[test]
    fn never_averages_neighbours() {
        // A bilinear or box filter would produce intermediate colours between
        // the red and the black. Nearest-neighbour must produce exactly two
        // distinct values, whatever the scale.
        let src = vec![255, 0, 0, 255, 0, 0, 0, 255];
        let out = scale_nearest(&src, 2, 1, 8).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        for px in out.chunks(4) {
            seen.insert(px.to_vec());
        }
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn preserves_straight_alpha_on_transparent_pixels() {
        // The transparent pixel keeps its RGB. Premultiplying would zero it and
        // a later palette step would then see black instead of red — the
        // classic fringing bug (docs/02-architecture.md §9).
        let out = scale_nearest(&two_pixels(), 2, 1, 2).unwrap();
        assert!(out.chunks(4).any(|px| px == [255, 0, 0, 0]));
    }

    #[test]
    fn lays_out_rows_correctly() {
        // 2×2 source, each pixel a distinct red value, scaled 2×.
        let src = vec![
            1, 0, 0, 255, 2, 0, 0, 255, // row 0
            3, 0, 0, 255, 4, 0, 0, 255, // row 1
        ];
        let out = scale_nearest(&src, 2, 2, 2).unwrap();
        let at = |x: usize, y: usize| out[(y * 4 + x) * 4];
        assert_eq!(
            [
                at(0, 0),
                at(1, 0),
                at(2, 0),
                at(3, 0),
                at(0, 1),
                at(1, 1),
                at(2, 1),
                at(3, 1),
                at(0, 2),
                at(1, 2),
                at(2, 2),
                at(3, 2),
                at(0, 3),
                at(1, 3),
                at(2, 3),
                at(3, 3),
            ],
            [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]
        );
    }

    #[test]
    fn rejects_non_integer_and_unsupported_scales() {
        for scale in [0, 3, 5, 6, 7, 9, 16] {
            assert!(
                scale_nearest(&[0, 0, 0, 0], 1, 1, scale).is_err(),
                "scale {scale} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_a_buffer_that_does_not_match_the_dimensions() {
        assert!(scale_nearest(&[0, 0, 0, 0], 2, 2, 1).is_err());
    }

    #[test]
    fn encodes_a_png_with_the_png_signature() {
        let png = encode_png(&two_pixels(), 2, 1).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn round_trips_pixels_through_the_encoder() {
        let png = encode_png(&two_pixels(), 2, 1).unwrap();
        let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 1));
        assert_eq!(decoded.as_raw(), &two_pixels());
    }
}
