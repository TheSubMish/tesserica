//! Tileset + tilemap JSON export (`docs/08-roadmap.md` Phase 6 "Tileset +
//! tilemap JSON export").
//!
//! Same shape as `animation_export.rs`: the frontend already holds every
//! pixel this needs (a tile's own RGBA buffer, `model/tileBuffers.ts`, and a
//! cel's packed tile-id grid, `model/tileGridBuffers.ts`) at full resolution
//! — there is no proxy/downscale step to worry about, unlike the conversion
//! pipeline. It concatenates every *real* tile's pixels (skipping index 0,
//! the mandatory empty tile) into one buffer and stages it once over the raw
//! IPC body; the grid itself is a flat `Vec<u32>` of packed ids, small enough
//! to travel as a plain JSON field exactly like `animation_export.rs`'s
//! `frames`/`tags` metadata does. Rust never receives a document snapshot's
//! full pixel content, only what this one tileset/layer needs.
//!
//! **Schema choice: Tiled's own `.tmj`/JSON map format**, not a bespoke one.
//! `docs/03-data-model.md` §4 already models a tilemap cel's packed ids with
//! "the same convention Godot and Tiled both use" for flip flags, and Tiled's
//! JSON export is the closest thing tile-based engines have to a lingua
//! franca (Tiled itself, Phaser's Tiled loader, Godot's `TileMap` importer,
//! LDtk's compatibility layer). Re-using it — embedded tileset, `tilelayer`
//! `data` array of GIDs — means an existing importer can read Tesserica's
//! tilemap output with no adapter, the same reasoning `animation_export.rs`
//! gives for choosing Aseprite's shape over a bespoke one.
//!
//! **The bit-layout match is real, not assumed.** Verified against Tiled's
//! own documented GID flag bits rather than guessed: Tiled reserves the *top*
//! three bits of a 32-bit GID for flip/rotate flags —
//! `FLIPPED_HORIZONTALLY_FLAG = 0x80000000` (bit 31), `FLIPPED_VERTICALLY_FLAG
//! = 0x40000000` (bit 30), `FLIPPED_DIAGONALLY_FLAG = 0x20000000` (bit 29,
//! Tiled's name for a transpose) — leaving 28 low bits (0–27) for the tile
//! index. `docs/03-data-model.md` §4's own packing puts the *same* three
//! flags, in the *same* H/V/diagonal order, immediately above a 28-bit index
//! (bits 28/29/30) rather than at the very top (31/30/29) — one bit lower
//! across the board, which is what keeps a packed id a positive `int32`
//! (`model/tileIds.ts`'s own comment on why: JS bitwise ops and a
//! `Uint32Array`/Rust `u32` wire value both stay sign-ambiguity-free). So the
//! two schemes agree on "which three flags, which order, how many index
//! bits" but disagree on exactly which bits — not an accident probably, but
//! not identical either, so [`tesserica_id_to_tiled_gid`] below does a real
//! translation, not a bit-for-bit passthrough. It also folds in the
//! index-space shift: Tesserica's tile index 0 is a real, drawable empty tile
//! (`docs/03-data-model.md` §4's own "index 0 is always the empty tile"),
//! while Tiled's GID 0 means "no tile here" — the two are close enough in
//! meaning (an empty tile paints nothing) that mapping index 0 to GID 0 is
//! the honest choice, and it falls out for free: with `firstgid = 1` and the
//! empty tile never itself entered into the exported atlas, Tesserica index
//! `i` (`i >= 1`) becomes Tiled local id `i - 1` and therefore GID
//! `firstgid + (i - 1) = i` — the two numbering schemes coincide exactly for
//! every real tile.
//!
//! **Orientation is shape-aware (gap-closure follow-up to Phase 7 "Isometric
//! and hexagonal tile grids").** Earlier, this module always wrote
//! `"orientation": "orthogonal"` regardless of the exporting layer's actual
//! `GridSpec.shape` — a real, documented gap (`docs/08-roadmap.md`'s Phase 7
//! entry), since Tiled's own isometric/hexagonal orientations are read by a
//! genuinely different renderer on Tiled's side. [`ExportTilemapRequest`] now
//! carries `grid_shape`, and [`tiled_orientation_fields`] derives the correct
//! `orientation` plus (for `hexagonal`) `hexsidelength`/`staggeraxis`/
//! `staggerindex` — see that function's own doc comment for the real research
//! (Tiled's documented JSON schema plus its `hexagonalrenderer.cpp` source)
//! behind the `hexsidelength` derivation specifically.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::animation_export::{assemble_sheet, SheetLayout};
use crate::commands::export::{encode_png, scale_nearest, ALLOWED_SCALES};
use crate::error::AppError;
use crate::model::document::GridShape;
use crate::model::tile_ids::unpack_tile_id;
#[cfg(test)]
use crate::model::tile_ids::{FLIP_H_BIT, FLIP_V_BIT, TRANSPOSE_BIT};
use crate::staging::Staging;

// ---------------------------------------------------------------------------
// Tesserica → Tiled GID (`docs/03-data-model.md` §4's own packing, mirrored
// in `crate::model::tile_ids` and `model/tileIds.ts`, vs. Tiled's own GID
// flag bits)
// ---------------------------------------------------------------------------

/// Tiled's own GID flag bits (top of a 32-bit value) — see this module's own
/// doc comment for why these are *not* the same bit positions as
/// `model/tileIds.ts`, even though they are the same three flags in the same
/// order.
const TILED_FLIP_H: u32 = 0x8000_0000;
const TILED_FLIP_V: u32 = 0x4000_0000;
const TILED_FLIP_DIAGONAL: u32 = 0x2000_0000;

/// A packed Tesserica tile id → a Tiled GID, folding in the flip-flag
/// re-mapping and the index-0-means-empty convention both formats happen to
/// share (see the module doc comment).
fn tesserica_id_to_tiled_gid(id: u32) -> u32 {
    let unpacked = unpack_tile_id(id);
    if unpacked.index == 0 {
        return 0;
    }
    let mut gid = unpacked.index; // firstgid (1) + (index - 1) == index
    if unpacked.flip_h {
        gid |= TILED_FLIP_H;
    }
    if unpacked.flip_v {
        gid |= TILED_FLIP_V;
    }
    if unpacked.transpose {
        gid |= TILED_FLIP_DIAGONAL;
    }
    gid
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTilemapRequest {
    /// Handle to `tileCount` concatenated `tileWidth × tileHeight` RGBA tile
    /// images, one per *real* tile (Tesserica index 1.. — the mandatory empty
    /// tile at index 0 is never staged; it maps to Tiled's own "no tile" GID
    /// 0), in ascending tile-index order.
    pub stage_id: u64,
    pub tile_width: u32,
    pub tile_height: u32,
    pub tile_count: u32,
    /// Columns for the assembled tileset sheet — same "grid of equal-size
    /// images" layout `animation_export.rs`'s `SheetLayout` already does for
    /// spritesheet frames, reused here unchanged.
    pub columns: u32,
    pub scale: u32,
    pub tileset_name: String,
    pub layer_name: String,
    /// The tilemap layer's own `GridSpec.shape` (`model/gridGeometry.ts`) —
    /// drives which Tiled `orientation` (and, for `hexagonal`, which
    /// `hexsidelength`/`staggeraxis`/`staggerindex`) the exported map JSON
    /// declares (`tiled_orientation_fields`). Placement itself never crosses
    /// IPC — Rust does not composite tiles (`docs/02-architecture.md` §6.2) —
    /// only this one enum needs to travel.
    pub grid_shape: GridShape,
    pub grid_cols: u32,
    pub grid_rows: u32,
    /// Packed Tesserica tile ids (`model/tileIds.ts`), row-major, one per
    /// grid cell — `gridCols * gridRows` entries.
    pub tile_ids: Vec<u32>,
    /// Where the tileset PNG goes. The map JSON is written alongside it, same
    /// stem, `.json` extension — the same derivation
    /// `animation_export.rs::derive_json_path` uses for the spritesheet's own
    /// metadata file.
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTilemapResult {
    pub path: String,
    pub json_path: String,
    pub width: u32,
    pub height: u32,
    pub columns: u32,
    pub rows: u32,
    pub tile_count: u32,
    pub bytes: u64,
    pub json_bytes: u64,
}

fn derive_json_path(png_path: &str) -> String {
    std::path::Path::new(png_path)
        .with_extension("json")
        .to_string_lossy()
        .into_owned()
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

// ---------------------------------------------------------------------------
// Tiled JSON map shape (a subset sufficient for import — embedded tileset,
// one `tilelayer`).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TiledProperty {
    name: String,
    r#type: String,
    value: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TiledTileset {
    firstgid: u32,
    name: String,
    image: String,
    #[serde(rename = "imagewidth")]
    image_width: u32,
    #[serde(rename = "imageheight")]
    image_height: u32,
    #[serde(rename = "tilewidth")]
    tile_width: u32,
    #[serde(rename = "tileheight")]
    tile_height: u32,
    #[serde(rename = "tilecount")]
    tile_count: u32,
    columns: u32,
    margin: u32,
    spacing: u32,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TiledLayer {
    id: u32,
    name: String,
    r#type: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    visible: bool,
    opacity: f32,
    data: Vec<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TiledMap {
    r#type: String,
    version: String,
    orientation: String,
    renderorder: String,
    width: u32,
    height: u32,
    #[serde(rename = "tilewidth")]
    tile_width: u32,
    #[serde(rename = "tileheight")]
    tile_height: u32,
    /// Hexagonal orientation only (`docs/tiled` schema, verified against both
    /// the upstream JSON reference and `hexagonalrenderer.cpp` — see
    /// `tiled_orientation_fields`'s own doc comment). Omitted entirely for
    /// `orthogonal`/`isometric` maps rather than emitted as `null`, matching
    /// what Tiled itself writes.
    #[serde(skip_serializing_if = "Option::is_none")]
    hexsidelength: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staggeraxis: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staggerindex: Option<&'static str>,
    infinite: bool,
    #[serde(rename = "nextlayerid")]
    next_layer_id: u32,
    #[serde(rename = "nextobjectid")]
    next_object_id: u32,
    layers: Vec<TiledLayer>,
    tilesets: Vec<TiledTileset>,
    properties: Vec<TiledProperty>,
}

/// Tiled `orientation` plus, for `hexagonal` only, `hexsidelength`/
/// `staggeraxis`/`staggerindex` — researched against Tiled's own documented
/// schema and renderer source, not guessed (the same bar
/// `tesserica_id_to_tiled_gid` above holds itself to, which found a *real*
/// bit-position mismatch despite the two schemes looking alike at a glance).
///
/// **Isometric** needs nothing beyond `"orientation": "isometric"`. Tiled's
/// isometric renderer consumes the exact same row-major `data` array as
/// orthogonal, only projecting `(col, row)` through its own 2:1 diamond shear
/// at render time — there is no extra field in Tiled's schema for it, and
/// this project's own isometric placement (`gridGeometry.ts::cellOrigin`,
/// `docs/03-data-model.md` §4) is already that same standard 2:1 shear, so no
/// convention translation is needed.
///
/// **Hexagonal** is the one that actually needed research. Tiled's JSON/TMX
/// reference (`doc.mapeditor.org/en/stable/reference/json-map-format/`)
/// documents `staggeraxis: "x" | "y"` and `staggerindex: "odd" | "even"` with
/// no formula, so the real geometry was pulled from Tiled's own renderer
/// source (`src/libtiled/hexagonalrenderer.cpp`,
/// `HexagonalRenderer::RenderParams`), which — for a pointy-top map
/// (`staggeraxis: "y"`, `staggerX = false`) — computes:
///
/// ```text
/// sideOffsetY = (tileHeight - hexSideLength) / 2
/// rowHeight   = sideOffsetY + hexSideLength = (tileHeight + hexSideLength) / 2
/// columnWidth = tileWidth / 2   // horizontal shift Tiled applies to staggered rows
/// ```
///
/// This project's own hex placement is pointy-top, odd-row horizontal offset
/// ("odd-r", `gridGeometry.ts`'s module doc): rows step by a fixed
/// `tileHeight * 0.75`, and odd-numbered rows (`isOddRow`) shift right by
/// exactly `tileWidth / 2`. The horizontal shift already matches Tiled's
/// `columnWidth` with no translation needed. Solving Tiled's `rowHeight`
/// formula for the `hexSideLength` that reproduces this project's fixed
/// `0.75` row step —
///
/// ```text
/// (tileHeight + hexSideLength) / 2 = tileHeight * 0.75
/// hexSideLength                    = tileHeight / 2
/// ```
///
/// — is an *exact* match, not an approximation: plugging `hexSideLength =
/// tileHeight / 2` back into Tiled's own `rowHeight` formula reproduces
/// `tileHeight * 0.75` precisely. Unlike the GID flip bits (which looked
/// alike but were not a bit-for-bit passthrough), no convention mismatch was
/// found for the stagger axis/index themselves — `staggeraxis: "y"` is
/// exactly "pointy-top, rows staggered" (this project's own choice) and
/// `staggerindex: "odd"` is exactly "odd-numbered rows shift" (this
/// project's own `isOddRow`). `hexSideLength` needed a real derivation only
/// because this project's tiles are plain rectangular sprite buffers with a
/// hex silhouette painted into their own alpha channel — nothing in
/// `docs/03-data-model.md` or `gridGeometry.ts` names a "hex side length" at
/// all, so there was no existing constant to read off directly. Odd
/// `tileHeight` truncates by one pixel (`hexsidelength` is Tiled's own `int`
/// field); harmless in practice since tile sizes are user-chosen even
/// integers in every shipped default.
fn tiled_orientation_fields(
    shape: GridShape,
    scaled_tile_height: u32,
) -> (
    &'static str,
    Option<u32>,
    Option<&'static str>,
    Option<&'static str>,
) {
    match shape {
        GridShape::Rect => ("orthogonal", None, None, None),
        GridShape::Isometric => ("isometric", None, None, None),
        GridShape::Hexagonal => {
            let hex_side_length = scaled_tile_height / 2;
            ("hexagonal", Some(hex_side_length), Some("y"), Some("odd"))
        }
    }
}

fn build_map_json(request: &ExportTilemapRequest, layout: &SheetLayout) -> TiledMap {
    let scale = request.scale;
    let data: Vec<u32> = request
        .tile_ids
        .iter()
        .map(|&id| tesserica_id_to_tiled_gid(id))
        .collect();
    let scaled_tile_height = request.tile_height * scale;
    let (orientation, hexsidelength, staggeraxis, staggerindex) =
        tiled_orientation_fields(request.grid_shape, scaled_tile_height);

    TiledMap {
        r#type: "map".to_string(),
        version: "1.10".to_string(),
        orientation: orientation.to_string(),
        renderorder: "right-down".to_string(),
        width: request.grid_cols,
        height: request.grid_rows,
        tile_width: request.tile_width * scale,
        tile_height: scaled_tile_height,
        hexsidelength,
        staggeraxis,
        staggerindex,
        infinite: false,
        next_layer_id: 2,
        next_object_id: 1,
        layers: vec![TiledLayer {
            id: 1,
            name: request.layer_name.clone(),
            r#type: "tilelayer".to_string(),
            x: 0,
            y: 0,
            width: request.grid_cols,
            height: request.grid_rows,
            visible: true,
            opacity: 1.0,
            data,
        }],
        tilesets: vec![TiledTileset {
            firstgid: 1,
            name: request.tileset_name.clone(),
            image: file_name(&request.path),
            image_width: layout.sheet_width() * scale,
            image_height: layout.sheet_height() * scale,
            tile_width: request.tile_width * scale,
            tile_height: scaled_tile_height,
            tile_count: request.tile_count,
            columns: layout.columns,
            margin: 0,
            spacing: 0,
        }],
        properties: vec![TiledProperty {
            name: "exportedBy".to_string(),
            r#type: "string".to_string(),
            value: format!("Tesserica {}", env!("CARGO_PKG_VERSION")),
        }],
    }
}

/// Validate, assemble the tileset sheet, scale it and write both files. Pure
/// and synchronous — the async command is a thin wrapper, the same split
/// `animation_export.rs`'s `write_spritesheet` uses.
fn write_tilemap(
    request: &ExportTilemapRequest,
    staging: &Staging,
) -> Result<ExportTilemapResult, AppError> {
    if !ALLOWED_SCALES.contains(&request.scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {}",
            request.scale
        )));
    }
    if request.tile_count == 0 {
        return Err(AppError::invalid("tileset has no real tiles to export"));
    }
    let expected_cells = (request.grid_cols as usize) * (request.grid_rows as usize);
    if request.tile_ids.len() != expected_cells {
        return Err(AppError::invalid(format!(
            "expected {expected_cells} grid cells ({}x{}), got {}",
            request.grid_cols,
            request.grid_rows,
            request.tile_ids.len()
        )));
    }
    if expected_cells == 0 {
        return Err(AppError::invalid("tilemap grid is empty"));
    }

    let src = staging.get(request.stage_id)?;
    let per_tile = (request.tile_width as usize) * (request.tile_height as usize) * 4;
    let expected_bytes = per_tile * request.tile_count as usize;
    if src.len() != expected_bytes {
        return Err(AppError::invalid(format!(
            "expected {expected_bytes} staged bytes for {} tiles of {}x{}, got {}",
            request.tile_count,
            request.tile_width,
            request.tile_height,
            src.len()
        )));
    }

    let layout = SheetLayout::new(
        request.tile_count,
        request.columns,
        request.tile_width,
        request.tile_height,
    );
    let tile_slices: Vec<&[u8]> = src.chunks_exact(per_tile).collect();
    let assembled = assemble_sheet(&tile_slices, &layout);

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
    let map = build_map_json(request, &layout);
    let json_bytes = serde_json::to_vec_pretty(&map)?;
    let json_len = json_bytes.len() as u64;
    std::fs::write(&json_path, &json_bytes)?;

    staging.release(request.stage_id);

    Ok(ExportTilemapResult {
        path: request.path.clone(),
        json_path,
        width: out_w,
        height: out_h,
        columns: layout.columns,
        rows: layout.rows,
        tile_count: request.tile_count,
        bytes: png_bytes,
        json_bytes: json_len,
    })
}

#[tauri::command]
pub async fn export_tilemap(
    request: ExportTilemapRequest,
    staging: State<'_, Staging>,
) -> Result<ExportTilemapResult, AppError> {
    write_tilemap(&request, &staging)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- tile-id bit packing / GID mapping -------------------------------------

    #[test]
    fn unpacks_a_plain_index_with_no_flags() {
        let u = unpack_tile_id(5);
        assert_eq!(u.index, 5);
        assert!(!u.flip_h && !u.flip_v && !u.transpose);
    }

    #[test]
    fn unpacks_every_flag_bit_independently() {
        assert!(unpack_tile_id(FLIP_H_BIT | 3).flip_h);
        assert!(unpack_tile_id(FLIP_V_BIT | 3).flip_v);
        assert!(unpack_tile_id(TRANSPOSE_BIT | 3).transpose);
    }

    #[test]
    fn empty_tile_index_maps_to_gid_zero_regardless_of_flags() {
        // Index 0 is Tesserica's mandatory empty tile; a flipped empty tile is
        // still empty, so it must still map to Tiled's "no tile" GID 0.
        assert_eq!(tesserica_id_to_tiled_gid(0), 0);
        assert_eq!(tesserica_id_to_tiled_gid(FLIP_H_BIT | FLIP_V_BIT), 0);
    }

    #[test]
    fn a_plain_tile_gid_equals_its_tesserica_index() {
        // firstgid = 1, the empty tile is never entered into the atlas, so
        // Tesserica index i (i >= 1) becomes Tiled GID i exactly.
        assert_eq!(tesserica_id_to_tiled_gid(1), 1);
        assert_eq!(tesserica_id_to_tiled_gid(7), 7);
    }

    #[test]
    fn flip_flags_land_on_tiled_own_bit_positions_not_a_passthrough() {
        // A raw bit-for-bit copy would leave Tesserica's flags at bits
        // 28-30, which is *not* what Tiled expects (bits 29-31) — this test
        // fails if the mapping ever regresses to a naive passthrough.
        let id = FLIP_H_BIT | 3; // Tesserica: index 3, flip-h
        let gid = tesserica_id_to_tiled_gid(id);
        assert_eq!(gid, 3 | TILED_FLIP_H);
        assert_ne!(gid, id, "must not be a bit-for-bit passthrough");
    }

    #[test]
    fn all_three_flags_combine_correctly() {
        let id = FLIP_H_BIT | FLIP_V_BIT | TRANSPOSE_BIT | 12;
        let gid = tesserica_id_to_tiled_gid(id);
        assert_eq!(gid, 12 | TILED_FLIP_H | TILED_FLIP_V | TILED_FLIP_DIAGONAL);
    }

    // -- wire format ------------------------------------------------------------

    #[test]
    fn request_deserializes_the_frontends_camelcase_wire_shape() {
        let json = r#"{
            "stageId": 1,
            "tileWidth": 8,
            "tileHeight": 8,
            "tileCount": 2,
            "columns": 2,
            "scale": 1,
            "tilesetName": "Ground",
            "layerName": "Terrain",
            "gridShape": "hexagonal",
            "gridCols": 2,
            "gridRows": 1,
            "tileIds": [1, 2],
            "path": "/tmp/x.png"
        }"#;
        let request: ExportTilemapRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.stage_id, 1);
        assert_eq!(request.tile_count, 2);
        assert_eq!(request.tile_ids, vec![1, 2]);
        assert_eq!(request.tileset_name, "Ground");
        assert_eq!(request.grid_shape, GridShape::Hexagonal);
    }

    // -- JSON shape ---------------------------------------------------------

    fn sample_request(path: &str) -> ExportTilemapRequest {
        ExportTilemapRequest {
            stage_id: 1,
            tile_width: 8,
            tile_height: 8,
            tile_count: 2,
            columns: 2,
            scale: 1,
            tileset_name: "Ground".to_string(),
            layer_name: "Terrain".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 2,
            grid_rows: 1,
            tile_ids: vec![1, FLIP_H_BIT | 2],
            path: path.to_string(),
        }
    }

    #[test]
    fn map_json_reflects_grid_gids_and_tileset_shape() {
        let request = sample_request("/tmp/whatever/level.png");
        let layout = SheetLayout::new(
            request.tile_count,
            request.columns,
            request.tile_width,
            request.tile_height,
        );
        let map = build_map_json(&request, &layout);

        assert_eq!(map.r#type, "map");
        assert_eq!(map.width, 2);
        assert_eq!(map.height, 1);
        assert_eq!(map.layers.len(), 1);
        assert_eq!(map.layers[0].data, vec![1, 2 | TILED_FLIP_H]);
        assert_eq!(map.tilesets.len(), 1);
        assert_eq!(map.tilesets[0].firstgid, 1);
        assert_eq!(map.tilesets[0].tile_count, 2);
        assert_eq!(map.tilesets[0].image, "level.png");
    }

    #[test]
    fn json_round_trips_through_serde_json() {
        let request = sample_request("/tmp/whatever/level.png");
        let layout = SheetLayout::new(
            request.tile_count,
            request.columns,
            request.tile_width,
            request.tile_height,
        );
        let map = build_map_json(&request, &layout);
        let bytes = serde_json::to_vec(&map).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["type"], "map");
        assert_eq!(value["layers"][0]["type"], "tilelayer");
        assert_eq!(value["layers"][0]["data"][0], 1);
        assert_eq!(value["tilesets"][0]["tilecount"], 2);
    }

    // -- orientation / stagger fields (gap-closure: shape-aware Tiled export) --

    #[test]
    fn rect_grid_writes_orthogonal_orientation_and_no_hex_fields() {
        let (orientation, hexsidelength, staggeraxis, staggerindex) =
            tiled_orientation_fields(GridShape::Rect, 16);
        assert_eq!(orientation, "orthogonal");
        assert_eq!(hexsidelength, None);
        assert_eq!(staggeraxis, None);
        assert_eq!(staggerindex, None);
    }

    #[test]
    fn isometric_grid_writes_isometric_orientation_and_no_hex_fields() {
        let (orientation, hexsidelength, staggeraxis, staggerindex) =
            tiled_orientation_fields(GridShape::Isometric, 16);
        assert_eq!(orientation, "isometric");
        assert_eq!(hexsidelength, None);
        assert_eq!(staggeraxis, None);
        assert_eq!(staggerindex, None);
    }

    #[test]
    fn hexagonal_grid_writes_hexagonal_orientation_and_odd_r_stagger_fields() {
        // tileHeight=16 -> hexSideLength=8, and plugging that back into
        // Tiled's own rowHeight formula, (tileHeight + hexSideLength) / 2,
        // reproduces this project's fixed 0.75 * tileHeight row step exactly:
        // (16 + 8) / 2 = 12 = 16 * 0.75.
        let (orientation, hexsidelength, staggeraxis, staggerindex) =
            tiled_orientation_fields(GridShape::Hexagonal, 16);
        assert_eq!(orientation, "hexagonal");
        assert_eq!(hexsidelength, Some(8));
        assert_eq!(staggeraxis, Some("y"));
        assert_eq!(staggerindex, Some("odd"));

        let tiled_row_height = (16 + hexsidelength.unwrap()) / 2;
        let this_project_row_step = (16f64 * 0.75) as u32;
        assert_eq!(tiled_row_height, this_project_row_step);
    }

    #[test]
    fn hexsidelength_scales_with_the_export_scale_factor() {
        // hexsidelength is a pixel length like tilewidth/tileheight — it must
        // scale the same way they do (`request.tile_height * scale`), or an
        // exported map at 2x/4x would have geometrically inconsistent hex
        // tiles vs. row spacing.
        let (_, hexsidelength, _, _) = tiled_orientation_fields(GridShape::Hexagonal, 16 * 4);
        assert_eq!(hexsidelength, Some(32));
    }

    fn hex_request(path: &str) -> ExportTilemapRequest {
        ExportTilemapRequest {
            grid_shape: GridShape::Hexagonal,
            ..sample_request(path)
        }
    }

    fn iso_request(path: &str) -> ExportTilemapRequest {
        ExportTilemapRequest {
            grid_shape: GridShape::Isometric,
            ..sample_request(path)
        }
    }

    #[test]
    fn build_map_json_for_a_hexagonal_layer_has_the_real_tiled_stagger_fields() {
        let request = hex_request("/tmp/whatever/hex.png");
        let layout = SheetLayout::new(
            request.tile_count,
            request.columns,
            request.tile_width,
            request.tile_height,
        );
        let map = build_map_json(&request, &layout);
        assert_eq!(map.orientation, "hexagonal");
        // tile_height is 8 (sample_request), scale 1 -> hexsidelength 4.
        assert_eq!(map.hexsidelength, Some(4));
        assert_eq!(map.staggeraxis, Some("y"));
        assert_eq!(map.staggerindex, Some("odd"));

        // Decode through serde_json::Value like the other JSON-shape tests
        // do, proving the fields land on the exact documented Tiled key
        // names (`hexsidelength`, `staggeraxis`, `staggerindex`) via the
        // real serializer, not just the intermediate struct.
        let value: serde_json::Value = serde_json::to_value(&map).unwrap();
        assert_eq!(value["orientation"], "hexagonal");
        assert_eq!(value["hexsidelength"], 4);
        assert_eq!(value["staggeraxis"], "y");
        assert_eq!(value["staggerindex"], "odd");
    }

    #[test]
    fn build_map_json_for_an_isometric_layer_has_no_stray_hex_fields() {
        let request = iso_request("/tmp/whatever/iso.png");
        let layout = SheetLayout::new(
            request.tile_count,
            request.columns,
            request.tile_width,
            request.tile_height,
        );
        let map = build_map_json(&request, &layout);
        assert_eq!(map.orientation, "isometric");
        assert_eq!(map.hexsidelength, None);
        assert_eq!(map.staggeraxis, None);
        assert_eq!(map.staggerindex, None);

        // Tiled omits these fields entirely for non-hex maps (rather than
        // writing them as `null`) — confirm the real serializer output
        // agrees, not just the struct-level `Option`.
        let value: serde_json::Value = serde_json::to_value(&map).unwrap();
        assert_eq!(value["orientation"], "isometric");
        assert!(value.get("hexsidelength").is_none());
        assert!(value.get("staggeraxis").is_none());
        assert!(value.get("staggerindex").is_none());
    }

    // -- write_tilemap end to end ---------------------------------------------

    fn solid(color: [u8; 4], w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            out.extend_from_slice(&color);
        }
        out
    }

    #[test]
    fn exports_a_real_atlas_png_and_matching_map_json() {
        let staging = Staging::default();
        // Two 2x2 tiles: red (Tesserica index 1) and green (index 2).
        let red = solid([255, 0, 0, 255], 2, 2);
        let green = solid([0, 255, 0, 255], 2, 2);
        let mut concatenated = red.clone();
        concatenated.extend_from_slice(&green);
        let stage_id = staging.put(concatenated);

        let dir = std::env::temp_dir().join(format!(
            "tess-tilemap-test-{}-{stage_id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("ground.png");

        // A 2x1 grid: cell 0 is tile index 1 (red), cell 1 is tile index 2
        // flipped horizontally (still green — flipping a solid color tile is
        // a no-op on pixels, this test is about the GID/flag bit, not visual
        // content).
        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 2,
            tile_count: 2,
            columns: 2,
            scale: 1,
            tileset_name: "Ground".to_string(),
            layer_name: "Terrain".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 2,
            grid_rows: 1,
            tile_ids: vec![1, FLIP_H_BIT | 2],
            path: png_path.to_string_lossy().into_owned(),
        };

        let result = write_tilemap(&request, &staging).unwrap();
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
        assert_eq!(value["layers"][0]["data"][0], 1);
        assert_eq!(value["layers"][0]["data"][1], 2 | TILED_FLIP_H);
        assert_eq!(value["tilesets"][0]["tilecount"], 2);
        assert_eq!(value["tilesets"][0]["columns"], 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Real, end-to-end `write_tilemap` for a hexagonal layer: writes an
    /// actual map JSON to disk and decodes it, the same bar
    /// `exports_a_real_atlas_png_and_matching_map_json` holds itself to —
    /// schema-conformance against Tiled's *documented* JSON reference
    /// (`orientation`/`hexsidelength`/`staggeraxis`/`staggerindex`, all
    /// verified in `tiled_orientation_fields`'s own doc comment), since
    /// running real Tiled software is not available in this environment.
    #[test]
    fn exports_a_real_hexagonal_map_json_with_the_documented_stagger_fields() {
        let staging = Staging::default();
        let red = solid([255, 0, 0, 255], 2, 8); // matches tile_width=2, tile_height=8 below
        let stage_id = staging.put(red);

        let dir = std::env::temp_dir().join(format!(
            "tess-tilemap-hex-test-{}-{stage_id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("hex.png");

        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 8,
            tile_count: 1,
            columns: 1,
            scale: 2,
            tileset_name: "Hex".to_string(),
            layer_name: "Terrain".to_string(),
            grid_shape: GridShape::Hexagonal,
            grid_cols: 1,
            grid_rows: 1,
            tile_ids: vec![1],
            path: png_path.to_string_lossy().into_owned(),
        };

        let result = write_tilemap(&request, &staging).unwrap();

        let json_bytes = std::fs::read(&result.json_path).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(value["orientation"], "hexagonal");
        assert_eq!(value["staggeraxis"], "y");
        assert_eq!(value["staggerindex"], "odd");
        // tileHeight 8 * scale 2 = 16 -> hexsidelength 8.
        assert_eq!(value["tileheight"], 16);
        assert_eq!(value["hexsidelength"], 8);
        // orthogonal-only fields must not leak in from the earlier default.
        assert_eq!(value["width"], 1);
        assert_eq!(value["height"], 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Same bar as the hexagonal case above, for an isometric layer —
    /// confirms the map JSON's `orientation` is correct and that no
    /// hex-only field leaks in for a shape that does not use them.
    #[test]
    fn exports_a_real_isometric_map_json_with_no_stray_hex_fields() {
        let staging = Staging::default();
        let blue = solid([0, 0, 255, 255], 4, 2); // matches tile_width=4, tile_height=2 below
        let stage_id = staging.put(blue);

        let dir = std::env::temp_dir().join(format!(
            "tess-tilemap-iso-test-{}-{stage_id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("iso.png");

        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 4,
            tile_height: 2,
            tile_count: 1,
            columns: 1,
            scale: 1,
            tileset_name: "Iso".to_string(),
            layer_name: "Terrain".to_string(),
            grid_shape: GridShape::Isometric,
            grid_cols: 1,
            grid_rows: 1,
            tile_ids: vec![1],
            path: png_path.to_string_lossy().into_owned(),
        };

        let result = write_tilemap(&request, &staging).unwrap();

        let json_bytes = std::fs::read(&result.json_path).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(value["orientation"], "isometric");
        assert!(value.get("hexsidelength").is_none());
        assert!(value.get("staggeraxis").is_none());
        assert!(value.get("staggerindex").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_non_integer_scale() {
        let staging = Staging::default();
        let stage_id = staging.put(vec![0u8; 2 * 2 * 4]);
        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 2,
            tile_count: 1,
            columns: 1,
            scale: 3,
            tileset_name: "T".to_string(),
            layer_name: "L".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 1,
            grid_rows: 1,
            tile_ids: vec![1],
            path: "/tmp/should-not-be-written.png".to_string(),
        };
        assert!(write_tilemap(&request, &staging).is_err());
    }

    #[test]
    fn rejects_a_tile_count_of_zero() {
        let staging = Staging::default();
        let stage_id = staging.put(vec![]);
        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 2,
            tile_count: 0,
            columns: 1,
            scale: 1,
            tileset_name: "T".to_string(),
            layer_name: "L".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 1,
            grid_rows: 1,
            tile_ids: vec![0],
            path: "/tmp/should-not-be-written.png".to_string(),
        };
        assert!(write_tilemap(&request, &staging).is_err());
    }

    #[test]
    fn rejects_a_grid_cell_count_mismatch() {
        let staging = Staging::default();
        let stage_id = staging.put(solid([255, 0, 0, 255], 2, 2));
        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 2,
            tile_count: 1,
            columns: 1,
            scale: 1,
            tileset_name: "T".to_string(),
            layer_name: "L".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 2,
            grid_rows: 2,         // claims 4 cells
            tile_ids: vec![1, 1], // only 2 provided
            path: "/tmp/should-not-be-written.png".to_string(),
        };
        assert!(write_tilemap(&request, &staging).is_err());
    }

    #[test]
    fn rejects_a_staged_byte_count_mismatch() {
        let staging = Staging::default();
        // Claims 2 tiles of 2x2 but only stages one.
        let stage_id = staging.put(solid([255, 0, 0, 255], 2, 2));
        let request = ExportTilemapRequest {
            stage_id,
            tile_width: 2,
            tile_height: 2,
            tile_count: 2,
            columns: 2,
            scale: 1,
            tileset_name: "T".to_string(),
            layer_name: "L".to_string(),
            grid_shape: GridShape::Rect,
            grid_cols: 1,
            grid_rows: 1,
            tile_ids: vec![1],
            path: "/tmp/should-not-be-written.png".to_string(),
        };
        assert!(write_tilemap(&request, &staging).is_err());
    }
}
