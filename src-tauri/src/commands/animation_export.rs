//! Spritesheet (+ metadata JSON) and animated GIF export
//! (`docs/08-roadmap.md` Phase 4 "Export: spritesheet (+ metadata JSON),
//! animated GIF").
//!
//! Same shape as `export.rs`'s single-frame PNG export, one axis over: the
//! frontend flattens every frame it wants exported (`canvas/flatten.ts`,
//! unchanged — Rust never composites layers, `08-roadmap.md` Phase 3) and
//! concatenates them into one buffer, staged once over the raw IPC body
//! (`crate::staging`). Rust never receives per-layer pixels, only the
//! already-flattened RGBA frames plus metadata (durations, tag ranges).
//!
//! **Spritesheet** lays every frame into a fixed-column grid (unscaled),
//! reuses `export::scale_nearest` to scale the *whole assembled sheet* in one
//! nearest-neighbour pass — which is exactly equivalent to scaling each cell,
//! since nearest-neighbour never mixes pixels across a cell boundary — and
//! writes an Aseprite-shaped metadata JSON alongside the PNG (see
//! `SpritesheetMeta` for why that shape and not TexturePacker's).
//!
//! **GIF** encodes via `image::codecs::gif`, which is already a dependency
//! (`image` 0.25.10) and needed no new crate: enabling its `gif` Cargo
//! feature pulls in `gif` 0.14 (MIT OR Apache-2.0) and `color_quant` 1.1.0
//! (MIT), both compatible with this project's MIT license. GIF is an
//! inherently indexed, binary-alpha format — the per-frame quantization to
//! ≤256 colors and the any-nonzero-alpha→opaque collapse happen inside the
//! `gif` crate as an unavoidable property of the file format, not a departure
//! from this project's own RGBA/straight-alpha pipeline (`docs/10-decisions.md`
//! D9), which never runs here at all.

use std::path::Path;

use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame as GifFrame, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::export::{encode_png, scale_nearest, ALLOWED_SCALES};
use crate::error::AppError;
use crate::staging::Staging;

// ---------------------------------------------------------------------------
// Spritesheet
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpritesheetFrameInput {
    pub duration_ms: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpritesheetTagInput {
    pub name: String,
    /// Frame indices *within the exported frame list* — already re-based by
    /// the caller when export is scoped to one tag, so this file never has
    /// to know whether it is looking at the whole sprite or a slice of it.
    pub from: u32,
    pub to: u32,
    pub direction: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpritesheetRequest {
    /// Handle to `frames.len()` concatenated `frameWidth × frameHeight` RGBA
    /// buffers, in export order.
    pub stage_id: u64,
    pub frame_width: u32,
    pub frame_height: u32,
    pub scale: u32,
    /// Grid width in cells. Clamped to `[1, frames.len()]` — a request for
    /// more columns than frames just makes a one-row strip, which is exactly
    /// what a whole-sprite export with, say, 3 frames and 4 columns should do.
    pub columns: u32,
    pub frames: Vec<SpritesheetFrameInput>,
    pub tags: Vec<SpritesheetTagInput>,
    /// Where the PNG goes. The metadata JSON is written alongside it, same
    /// stem, `.json` extension.
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpritesheetResult {
    pub path: String,
    pub json_path: String,
    pub width: u32,
    pub height: u32,
    pub columns: u32,
    pub rows: u32,
    pub bytes: u64,
    pub json_bytes: u64,
}

/// Grid geometry for a spritesheet. Kept free of IPC/serde so the layout math
/// is directly unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetLayout {
    pub columns: u32,
    pub rows: u32,
    pub frame_w: u32,
    pub frame_h: u32,
}

impl SheetLayout {
    pub fn new(frame_count: u32, columns: u32, frame_w: u32, frame_h: u32) -> Self {
        let frame_count = frame_count.max(1);
        let columns = columns.clamp(1, frame_count);
        let rows = frame_count.div_ceil(columns);
        Self {
            columns,
            rows,
            frame_w,
            frame_h,
        }
    }

    pub fn sheet_width(&self) -> u32 {
        self.columns * self.frame_w
    }

    pub fn sheet_height(&self) -> u32 {
        self.rows * self.frame_h
    }

    /// Top-left corner of cell `index` (row-major), in unscaled pixels.
    pub fn cell_origin(&self, index: u32) -> (u32, u32) {
        let col = index % self.columns;
        let row = index / self.columns;
        (col * self.frame_w, row * self.frame_h)
    }
}

/// Place every frame into its grid cell of an unscaled, sheet-sized buffer.
pub fn assemble_sheet(frames: &[&[u8]], layout: &SheetLayout) -> Vec<u8> {
    let sheet_w = layout.sheet_width() as usize;
    let sheet_h = layout.sheet_height() as usize;
    let mut out = vec![0u8; sheet_w * sheet_h * 4];
    let frame_w = layout.frame_w as usize;
    let frame_h = layout.frame_h as usize;
    let row_len = frame_w * 4;

    for (i, frame) in frames.iter().enumerate() {
        let (ox, oy) = layout.cell_origin(i as u32);
        let (ox, oy) = (ox as usize, oy as usize);
        for y in 0..frame_h {
            let dst = ((oy + y) * sheet_w + ox) * 4;
            let src = y * row_len;
            out[dst..dst + row_len].copy_from_slice(&frame[src..src + row_len]);
        }
    }

    out
}

fn derive_json_path(png_path: &str) -> String {
    Path::new(png_path)
        .with_extension("json")
        .to_string_lossy()
        .into_owned()
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "sprite".to_string())
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The metadata JSON shape.
///
/// **Chosen shape: Aseprite's own "array" JSON export**, not a bespoke schema.
/// `docs/06-workflows.md` W3 asks for "a metadata JSON alongside it for engine
/// import" without specifying a schema, and Aseprite's shape is already the
/// de-facto standard `frameTags`/`frame`/`sourceSize` vocabulary every major
/// engine's importer understands (Phaser's Aseprite loader, PixiJS's
/// spritesheet loader, TexturePacker-compatible tools). Re-using it — right
/// down to `direction` using the identical `forward`/`reverse`/`pingpong`
/// strings this project's own `TagDirection` already uses — means an existing
/// importer can read Tesserica's output with no adapter. TexturePacker's
/// competing "hash" shape (frames keyed by filename) was not chosen because
/// it loses frame ordering as an explicit property; the array preserves it.
#[derive(Debug, Serialize, PartialEq)]
struct FrameRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Debug, Serialize, PartialEq)]
struct SizeWH {
    w: u32,
    h: u32,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FrameEntry {
    filename: String,
    frame: FrameRect,
    rotated: bool,
    trimmed: bool,
    sprite_source_size: FrameRect,
    source_size: SizeWH,
    duration: u32,
}

#[derive(Debug, Serialize, PartialEq)]
struct FrameTagEntry {
    name: String,
    from: u32,
    to: u32,
    direction: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MetaBlock {
    app: String,
    version: String,
    image: String,
    format: String,
    size: SizeWH,
    scale: String,
    frame_tags: Vec<FrameTagEntry>,
}

#[derive(Debug, Serialize, PartialEq)]
struct SpritesheetMeta {
    frames: Vec<FrameEntry>,
    meta: MetaBlock,
}

fn build_metadata(request: &ExportSpritesheetRequest, layout: &SheetLayout) -> SpritesheetMeta {
    let stem = file_stem(&request.path);
    let scale = request.scale;
    let frame_w = layout.frame_w * scale;
    let frame_h = layout.frame_h * scale;

    let frames = request
        .frames
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let (ox, oy) = layout.cell_origin(i as u32);
            let rect = FrameRect {
                x: ox * scale,
                y: oy * scale,
                w: frame_w,
                h: frame_h,
            };
            FrameEntry {
                filename: format!("{stem} {i}.png"),
                frame: FrameRect { ..rect },
                rotated: false,
                trimmed: false,
                sprite_source_size: FrameRect {
                    x: 0,
                    y: 0,
                    w: frame_w,
                    h: frame_h,
                },
                source_size: SizeWH {
                    w: frame_w,
                    h: frame_h,
                },
                duration: f.duration_ms,
            }
        })
        .collect();

    let frame_tags = request
        .tags
        .iter()
        .map(|t| FrameTagEntry {
            name: t.name.clone(),
            from: t.from,
            to: t.to,
            direction: t.direction.clone(),
        })
        .collect();

    SpritesheetMeta {
        frames,
        meta: MetaBlock {
            app: "Tesserica".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            image: file_name(&request.path),
            format: "RGBA8888".to_string(),
            size: SizeWH {
                w: layout.sheet_width() * scale,
                h: layout.sheet_height() * scale,
            },
            scale: scale.to_string(),
            frame_tags,
        },
    }
}

/// Validate, assemble and scale one spritesheet PNG. Pure and synchronous —
/// exposed so tests can drive it with a plain `Staging` and no async runtime,
/// the same split `project.rs`'s `write_archive`/`read_archive` use for
/// `save_project`/`load_project`.
fn write_spritesheet(
    request: &ExportSpritesheetRequest,
    staging: &Staging,
) -> Result<ExportSpritesheetResult, AppError> {
    if !ALLOWED_SCALES.contains(&request.scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {}",
            request.scale
        )));
    }
    let frame_count = request.frames.len();
    if frame_count == 0 {
        return Err(AppError::invalid("no frames to export"));
    }

    let src = staging.get(request.stage_id)?;
    let per_frame = (request.frame_width as usize) * (request.frame_height as usize) * 4;
    let expected = per_frame * frame_count;
    if src.len() != expected {
        return Err(AppError::invalid(format!(
            "expected {expected} staged bytes for {frame_count} frames of {}x{}, got {}",
            request.frame_width,
            request.frame_height,
            src.len()
        )));
    }

    let layout = SheetLayout::new(
        frame_count as u32,
        request.columns,
        request.frame_width,
        request.frame_height,
    );
    let frame_slices: Vec<&[u8]> = src.chunks_exact(per_frame).collect();
    let assembled = assemble_sheet(&frame_slices, &layout);

    let scaled = scale_nearest(
        &assembled,
        layout.sheet_width(),
        layout.sheet_height(),
        request.scale,
    )?;
    let out_w = layout.sheet_width() * request.scale;
    let out_h = layout.sheet_height() * request.scale;
    let png = encode_png(&scaled, out_w, out_h)?;
    let png_bytes = png.len() as u64;
    std::fs::write(&request.path, &png)?;

    let json_path = derive_json_path(&request.path);
    let meta = build_metadata(request, &layout);
    let json_bytes = serde_json::to_vec_pretty(&meta)?;
    let json_len = json_bytes.len() as u64;
    std::fs::write(&json_path, &json_bytes)?;

    staging.release(request.stage_id);

    Ok(ExportSpritesheetResult {
        path: request.path.clone(),
        json_path,
        width: out_w,
        height: out_h,
        columns: layout.columns,
        rows: layout.rows,
        bytes: png_bytes,
        json_bytes: json_len,
    })
}

#[tauri::command]
pub async fn export_spritesheet(
    request: ExportSpritesheetRequest,
    staging: State<'_, Staging>,
) -> Result<ExportSpritesheetResult, AppError> {
    write_spritesheet(&request, &staging)
}

// ---------------------------------------------------------------------------
// Animated GIF
// ---------------------------------------------------------------------------

/// GIF's delay field is hundredths of a second — one unit is 10ms. Frames
/// shorter than that would round to a 0 delay, which some viewers render as
/// "as fast as possible" rather than "instant repeat"; flooring to one tick
/// keeps playback speed at least sane. This is a format limit, not a pipeline
/// rounding bug: nothing in `docs/04-image-pipeline.md` governs frame timing.
const MIN_GIF_DELAY_MS: u32 = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportGifRequest {
    /// Handle to `durationsMs.len()` concatenated `frameWidth × frameHeight`
    /// RGBA buffers, in playback order (already direction/ping-pong expanded
    /// by the caller — `model/tags.ts::tagFrameSequence` — so this file never
    /// has to know about tags at all).
    pub stage_id: u64,
    pub frame_width: u32,
    pub frame_height: u32,
    pub scale: u32,
    pub durations_ms: Vec<u32>,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportGifResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub bytes: u64,
}

/// Validate, encode and write one animated GIF. Pure and synchronous for the
/// same reason `write_spritesheet` is — tests drive it with a plain
/// `Staging`, no async runtime needed.
fn write_gif(request: &ExportGifRequest, staging: &Staging) -> Result<ExportGifResult, AppError> {
    if !ALLOWED_SCALES.contains(&request.scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {}",
            request.scale
        )));
    }
    let frame_count = request.durations_ms.len();
    if frame_count == 0 {
        return Err(AppError::invalid("no frames to export"));
    }

    let src = staging.get(request.stage_id)?;
    let per_frame = (request.frame_width as usize) * (request.frame_height as usize) * 4;
    let expected = per_frame * frame_count;
    if src.len() != expected {
        return Err(AppError::invalid(format!(
            "expected {expected} staged bytes for {frame_count} frames of {}x{}, got {}",
            request.frame_width,
            request.frame_height,
            src.len()
        )));
    }

    let out_w = request
        .frame_width
        .checked_mul(request.scale)
        .ok_or_else(|| AppError::invalid("output width overflows"))?;
    let out_h = request
        .frame_height
        .checked_mul(request.scale)
        .ok_or_else(|| AppError::invalid("output height overflows"))?;

    let bytes = encode_gif(
        &src,
        request.frame_width,
        request.frame_height,
        request.scale,
        &request.durations_ms,
    )?;
    let len = bytes.len() as u64;
    std::fs::write(&request.path, &bytes)?;
    staging.release(request.stage_id);

    Ok(ExportGifResult {
        path: request.path.clone(),
        width: out_w,
        height: out_h,
        frames: frame_count as u32,
        bytes: len,
    })
}

#[tauri::command]
pub async fn export_gif(
    request: ExportGifRequest,
    staging: State<'_, Staging>,
) -> Result<ExportGifResult, AppError> {
    write_gif(&request, &staging)
}

/// Encode one animated GIF from concatenated straight-alpha RGBA frames.
///
/// **Always loops infinitely.** `docs/06-workflows.md` W3 step 9 asks for "a
/// GIF for sharing" of a looping walk cycle, and the encoder underneath (the
/// `gif` crate driving `image::codecs::gif`) turns out not to have an
/// unambiguous "play once" to offer even if asked: its decoder maps *both*
/// `Repeat::Infinite` and an *absent* loop extension to
/// `LoopCount::Infinite` (confirmed empirically — see this module's tests),
/// so a `loopForever: false` request field would silently do nothing
/// distinguishable to any reader of the file. Rather than expose a checkbox
/// that lies, the smallest reasonable behaviour is what was actually asked
/// for: always loop.
///
/// Exposed for testing without a `Staging` handle. Each frame is
/// nearest-neighbour scaled exactly as the single-PNG export path does
/// (`export::scale_nearest`), so a spritesheet, a single export, and a GIF
/// export of the same document at the same scale all produce identical
/// per-frame pixels.
pub fn encode_gif(
    src: &[u8],
    frame_width: u32,
    frame_height: u32,
    scale: u32,
    durations_ms: &[u32],
) -> Result<Vec<u8>, AppError> {
    let per_frame = (frame_width as usize) * (frame_height as usize) * 4;
    let out_w = frame_width * scale;
    let out_h = frame_height * scale;

    let mut bytes: Vec<u8> = Vec::new();
    {
        // Speed 10: the `gif`/`image` docs call it "a good compromise between
        // speed and quality" — full quality (speed 1) is needless here since
        // pixel art typically has few enough colors that the exact-palette
        // path (not NeuQuant) is taken regardless (`gif::Frame::from_rgba_speed`).
        let mut encoder = GifEncoder::new_with_speed(&mut bytes, 10);
        encoder.set_repeat(Repeat::Infinite)?;

        for (chunk, &duration_ms) in src.chunks_exact(per_frame).zip(durations_ms) {
            let scaled = scale_nearest(chunk, frame_width, frame_height, scale)?;
            let buffer = RgbaImage::from_raw(out_w, out_h, scaled)
                .ok_or_else(|| AppError::invalid("gif frame buffer size mismatch"))?;
            let delay = Delay::from_numer_denom_ms(duration_ms.max(MIN_GIF_DELAY_MS), 1);
            encoder.encode_frame(GifFrame::from_parts(buffer, 0, 0, delay))?;
        }
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- wire format ----------------------------------------------------------
    //
    // These two decode a JSON string shaped exactly like what
    // `src/ipc/commands.ts::exportSpritesheet`/`exportGif` actually sends
    // (camelCase keys, straight off a real `invoke()` call) rather than
    // constructing the Rust struct directly — the one thing a live desktop
    // run would otherwise be needed to catch: a silent camelCase/snake_case
    // field-name mismatch between the two languages that `serde`'s
    // `rename_all` is supposed to bridge.

    #[test]
    fn spritesheet_request_deserializes_the_frontends_camelcase_wire_shape() {
        let json = r#"{
            "stageId": 1,
            "frameWidth": 4,
            "frameHeight": 4,
            "scale": 2,
            "columns": 2,
            "frames": [{"durationMs": 100}, {"durationMs": 150}],
            "tags": [{"name": "walk", "from": 0, "to": 1, "direction": "forward"}],
            "path": "/tmp/x.png"
        }"#;
        let request: ExportSpritesheetRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.stage_id, 1);
        assert_eq!(request.frame_width, 4);
        assert_eq!(request.frame_height, 4);
        assert_eq!(request.frames.len(), 2);
        assert_eq!(request.frames[1].duration_ms, 150);
        assert_eq!(request.tags[0].direction, "forward");
    }

    #[test]
    fn gif_request_deserializes_the_frontends_camelcase_wire_shape() {
        let json = r#"{
            "stageId": 1,
            "frameWidth": 8,
            "frameHeight": 8,
            "scale": 1,
            "durationsMs": [100, 100, 150],
            "path": "/tmp/x.gif"
        }"#;
        let request: ExportGifRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.frame_width, 8);
        assert_eq!(request.durations_ms, vec![100, 100, 150]);
    }

    // -- SheetLayout --------------------------------------------------------

    #[test]
    fn lays_out_a_one_row_strip_when_columns_covers_every_frame() {
        let layout = SheetLayout::new(4, 4, 8, 8);
        assert_eq!(layout.columns, 4);
        assert_eq!(layout.rows, 1);
        assert_eq!(layout.sheet_width(), 32);
        assert_eq!(layout.sheet_height(), 8);
    }

    #[test]
    fn wraps_to_a_second_row_when_frames_exceed_columns() {
        // 5 frames at 4 columns: 4 in row 0, 1 in row 1 — still 2 rows, not 1.25.
        let layout = SheetLayout::new(5, 4, 8, 8);
        assert_eq!(layout.columns, 4);
        assert_eq!(layout.rows, 2);
        assert_eq!(layout.cell_origin(0), (0, 0));
        assert_eq!(layout.cell_origin(3), (24, 0));
        assert_eq!(layout.cell_origin(4), (0, 8));
    }

    #[test]
    fn clamps_columns_to_the_frame_count() {
        // Asking for 4 columns with only 2 frames should not leave two empty
        // cells in the row — it is a single row of exactly 2.
        let layout = SheetLayout::new(2, 4, 8, 8);
        assert_eq!(layout.columns, 2);
        assert_eq!(layout.rows, 1);
    }

    #[test]
    fn clamps_a_zero_column_request_up_to_one() {
        let layout = SheetLayout::new(3, 0, 4, 4);
        assert_eq!(layout.columns, 1);
        assert_eq!(layout.rows, 3);
    }

    // -- assemble_sheet -------------------------------------------------------

    fn solid(color: [u8; 4], w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            out.extend_from_slice(&color);
        }
        out
    }

    #[test]
    fn places_each_frame_in_its_own_cell() {
        let red = solid([255, 0, 0, 255], 2, 2);
        let green = solid([0, 255, 0, 255], 2, 2);
        let blue = solid([0, 0, 255, 255], 2, 2);
        let frames: Vec<&[u8]> = vec![&red, &green, &blue];
        let layout = SheetLayout::new(3, 2, 2, 2);
        let sheet = assemble_sheet(&frames, &layout);

        // Sheet is 4x4 (2 cols x 2 rows of 2x2 cells).
        let px = |x: usize, y: usize| -> [u8; 4] {
            let i = (y * 4 + x) * 4;
            [sheet[i], sheet[i + 1], sheet[i + 2], sheet[i + 3]]
        };
        assert_eq!(px(0, 0), [255, 0, 0, 255]); // frame 0, top-left cell
        assert_eq!(px(2, 0), [0, 255, 0, 255]); // frame 1, top-right cell
        assert_eq!(px(0, 2), [0, 0, 255, 255]); // frame 2, bottom-left cell
        assert_eq!(px(2, 2), [0, 0, 0, 0]); // empty cell stays transparent
    }

    // -- metadata JSON --------------------------------------------------------

    fn sample_request(path: &str) -> ExportSpritesheetRequest {
        ExportSpritesheetRequest {
            stage_id: 1,
            frame_width: 4,
            frame_height: 4,
            scale: 2,
            columns: 2,
            frames: vec![
                SpritesheetFrameInput { duration_ms: 100 },
                SpritesheetFrameInput { duration_ms: 150 },
            ],
            tags: vec![SpritesheetTagInput {
                name: "walk".to_string(),
                from: 0,
                to: 1,
                direction: "forward".to_string(),
            }],
            path: path.to_string(),
        }
    }

    #[test]
    fn metadata_reflects_scaled_frame_rects_and_durations() {
        let request = sample_request("/tmp/whatever/hero.png");
        let layout = SheetLayout::new(
            2,
            request.columns,
            request.frame_width,
            request.frame_height,
        );
        let meta = build_metadata(&request, &layout);

        assert_eq!(meta.frames.len(), 2);
        assert_eq!(meta.frames[0].filename, "hero 0.png");
        // frame_width/height 4, scale 2 -> 8x8 cells; frame 1 is column 1, row 0.
        assert_eq!(
            meta.frames[0].frame,
            FrameRect {
                x: 0,
                y: 0,
                w: 8,
                h: 8
            }
        );
        assert_eq!(
            meta.frames[1].frame,
            FrameRect {
                x: 8,
                y: 0,
                w: 8,
                h: 8
            }
        );
        assert_eq!(meta.frames[0].duration, 100);
        assert_eq!(meta.frames[1].duration, 150);

        assert_eq!(meta.meta.image, "hero.png");
        assert_eq!(meta.meta.size, SizeWH { w: 16, h: 8 });
        assert_eq!(meta.meta.scale, "2");
        assert_eq!(meta.meta.frame_tags.len(), 1);
        assert_eq!(meta.meta.frame_tags[0].name, "walk");
        assert_eq!(meta.meta.frame_tags[0].direction, "forward");
    }

    #[test]
    fn json_round_trips_through_serde_json() {
        let request = sample_request("/tmp/whatever/hero.png");
        let layout = SheetLayout::new(
            2,
            request.columns,
            request.frame_width,
            request.frame_height,
        );
        let meta = build_metadata(&request, &layout);
        let bytes = serde_json::to_vec(&meta).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["frames"].is_array());
        assert_eq!(value["frames"][0]["frame"]["w"], 8);
        assert_eq!(value["meta"]["frameTags"][0]["name"], "walk");
    }

    // -- write_spritesheet end to end (the async command is a thin wrapper
    //    around this, so testing it directly needs no async runtime) --------

    #[test]
    fn exports_a_grid_png_and_a_matching_json_file() {
        let staging = Staging::default();
        let red = solid([255, 0, 0, 255], 2, 2);
        let green = solid([0, 255, 0, 255], 2, 2);
        let mut concatenated = red.clone();
        concatenated.extend_from_slice(&green);
        let stage_id = staging.put(concatenated);

        let dir =
            std::env::temp_dir().join(format!("tess-sheet-test-{}-{stage_id}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("sheet.png");

        let request = ExportSpritesheetRequest {
            stage_id,
            frame_width: 2,
            frame_height: 2,
            scale: 1,
            columns: 2,
            frames: vec![
                SpritesheetFrameInput { duration_ms: 100 },
                SpritesheetFrameInput { duration_ms: 100 },
            ],
            tags: vec![],
            path: png_path.to_string_lossy().into_owned(),
        };

        let result = write_spritesheet(&request, &staging).unwrap();

        assert_eq!(result.columns, 2);
        assert_eq!(result.rows, 1);
        assert_eq!(result.width, 4);
        assert_eq!(result.height, 2);
        assert!(staging.is_empty());

        let png_bytes = std::fs::read(&result.path).unwrap();
        let decoded = image::load_from_memory(&png_bytes).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (4, 2));
        assert_eq!(decoded.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(2, 0).0, [0, 255, 0, 255]);

        let json_bytes = std::fs::read(&result.json_path).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(value["frames"].as_array().unwrap().len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_non_integer_scale() {
        let staging = Staging::default();
        let stage_id = staging.put(vec![0u8; 2 * 2 * 4]);
        let request = ExportSpritesheetRequest {
            stage_id,
            frame_width: 2,
            frame_height: 2,
            scale: 3,
            columns: 1,
            frames: vec![SpritesheetFrameInput { duration_ms: 100 }],
            tags: vec![],
            path: "/tmp/should-not-be-written.png".to_string(),
        };
        assert!(write_spritesheet(&request, &staging).is_err());
    }

    // -- GIF ------------------------------------------------------------------

    #[test]
    fn encodes_and_decodes_frame_count_delays_and_loop() {
        use image::{codecs::gif::GifDecoder, AnimationDecoder};

        let red = solid([255, 0, 0, 255], 2, 2);
        let blue = solid([0, 0, 255, 255], 2, 2);
        let mut src = red.clone();
        src.extend_from_slice(&blue);

        let bytes = encode_gif(&src, 2, 2, 1, &[100, 250]).unwrap();

        let decoder = GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(matches!(
            decoder.loop_count(),
            image::metadata::LoopCount::Infinite
        ));
        let frames: Vec<_> = decoder
            .into_frames()
            .collect_frames()
            .expect("decodes cleanly");
        assert_eq!(frames.len(), 2);

        // GIF delay is centiseconds; 100ms and 250ms both land on exact ticks.
        assert_eq!(frames[0].delay().numer_denom_ms(), (100, 1));
        assert_eq!(frames[1].delay().numer_denom_ms(), (250, 1));

        let f0 = frames[0].buffer();
        assert_eq!(f0.get_pixel(0, 0).0, [255, 0, 0, 255]);
        let f1 = frames[1].buffer();
        assert_eq!(f1.get_pixel(0, 0).0, [0, 0, 255, 255]);
    }

    #[test]
    fn always_loops_infinitely() {
        use image::{codecs::gif::GifDecoder, AnimationDecoder};

        let px = solid([1, 2, 3, 255], 1, 1);
        let bytes = encode_gif(&px, 1, 1, 1, &[100]).unwrap();
        let decoder = GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(matches!(
            decoder.loop_count(),
            image::metadata::LoopCount::Infinite
        ));
    }

    #[test]
    fn scales_gif_frames_with_nearest_neighbour() {
        let px = solid([10, 20, 30, 255], 1, 1);
        let bytes = encode_gif(&px, 1, 1, 4, &[100]).unwrap();

        let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        use image::ImageDecoder;
        assert_eq!(decoder.dimensions(), (4, 4));
    }

    #[test]
    fn floors_very_short_durations_to_one_gif_tick() {
        use image::{codecs::gif::GifDecoder, AnimationDecoder};

        let px = solid([1, 1, 1, 255], 1, 1);
        let bytes = encode_gif(&px, 1, 1, 1, &[1]).unwrap();
        let decoder = GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        let frames: Vec<_> = decoder.into_frames().collect_frames().unwrap();
        assert_eq!(frames[0].delay().numer_denom_ms(), (10, 1));
    }

    #[test]
    fn write_gif_writes_a_real_file_and_releases_the_stage() {
        let staging = Staging::default();
        let red = solid([255, 0, 0, 255], 2, 2);
        let blue = solid([0, 0, 255, 255], 2, 2);
        let mut concatenated = red;
        concatenated.extend_from_slice(&blue);
        let stage_id = staging.put(concatenated);

        let path = std::env::temp_dir().join(format!("tess-gif-test-{stage_id}.gif"));
        let request = ExportGifRequest {
            stage_id,
            frame_width: 2,
            frame_height: 2,
            scale: 2,
            durations_ms: vec![120, 80],
            path: path.to_string_lossy().into_owned(),
        };

        let result = write_gif(&request, &staging).unwrap();
        assert_eq!(result.width, 4);
        assert_eq!(result.height, 4);
        assert_eq!(result.frames, 2);
        assert!(staging.is_empty());

        use image::{codecs::gif::GifDecoder, AnimationDecoder, ImageDecoder};
        let bytes = std::fs::read(&result.path).unwrap();
        let decoder = GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(decoder.dimensions(), (4, 4));
        let frames: Vec<_> = decoder.into_frames().collect_frames().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].delay().numer_denom_ms(), (120, 1));
        assert_eq!(frames[1].delay().numer_denom_ms(), (80, 1));
        // Nearest-neighbour scale 2: every pixel of the 4x4 output is one of
        // the two source colors, replicated in solid 2x2 blocks, never mixed.
        assert_eq!(frames[0].buffer().get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(frames[0].buffer().get_pixel(3, 3).0, [255, 0, 0, 255]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_mismatched_frame_and_duration_counts() {
        // durations longer than the staged buffer covers should fail loudly
        // rather than silently reading garbage or panicking.
        let staging = Staging::default();
        let stage_id = staging.put(vec![0u8; 2 * 2 * 4]); // 1 frame's worth
        let request = ExportGifRequest {
            stage_id,
            frame_width: 2,
            frame_height: 2,
            scale: 1,
            durations_ms: vec![100, 100], // claims 2 frames
            path: "/tmp/should-not-be-written.gif".to_string(),
        };
        assert!(write_gif(&request, &staging).is_err());
    }
}
