//! `.ase`/`.aseprite` import (`docs/08-roadmap.md` Phase 6 "`.ase` import";
//! `docs/01-reference-analysis.md` §9; `docs/10-decisions.md` D11 for the
//! import-only scope, D17 for the crate-vs-hand-rolled evaluation).
//!
//! Parses via the third-party `aseprite-io` crate (D17) rather than a
//! hand-rolled binary parser, and converts its own types onto this project's
//! `model::document::Sprite` — the *same* shape `.tess` load already
//! produces, so the frontend needs no new plumbing beyond one new command to
//! call: `commands::project::LoadResult`/`LoadedCel` are reused verbatim.
//!
//! **What's converted**: every `raster`/`group` layer (nested groups via
//! `parentId`, `docs/03-data-model.md` §2.1, preserved from Aseprite's own
//! child-level nesting), every frame's duration, every non-empty cel — raw
//! and zlib-compressed alike, since `aseprite-io` already decompresses —
//! including **linked cels**, mapped onto this project's own `Cel.linkedTo`
//! (docs/03 §2.2), animation tags, and the file's own palette as an
//! importable swatch list. RGBA cels pass through unchanged; grayscale
//! (value+alpha) and indexed (palette index, honouring the transparent
//! index) source pixels are converted to straight-alpha RGBA on the way in
//! (D9 — v1 is RGBA only) rather than rejected or left indexed.
//!
//! **`.ase` tilemap layers import** (gap-closure follow-up to D17 — the
//! bit-layout mismatch below is real, not assumed, checked against the
//! official spec and against `aseprite-io`'s own reader/writer, not
//! guessed). Aseprite's own tilemap-cel bit layout does **not** match this
//! project's `model/tile_ids.rs`/`model/tileIds.ts` packing: Aseprite uses
//! `0x1fff_ffff` (29 bits, index bits 0-28) for the tile index, then
//! flip-horizontal (bit 29, `0x2000_0000`), flip-vertical (bit 30,
//! `0x4000_0000`), and "diagonal flip" (bit 31, `0x8000_0000` — the spec's
//! own words are "swap X/Y axis", i.e. a transpose) — verified against the
//! official `ase-file-specs.md` Tilemap Cel section (chunk 0x2005) and
//! against `aseprite-io` 0.2.0's own `types.rs::set_tilemap_cel`/
//! `reader.rs::read_cel_chunk`, which read/write those exact bitmask values
//! rather than assuming them. This project's own packing (`docs/03-data-
//! model.md` §4) uses one fewer index bit (28, bits 0-27) with the same
//! three flags — same semantics, same order — one bit lower across the
//! board (28/29/30). Same flags, different bit positions and a different
//! index width, so [`ase_tile_to_tesserica_id`] does a real translation
//! (the same situation `commands::tilemap_export::tesserica_id_to_tiled_gid`
//! already found against Tiled's GID bits), not a passthrough. A tilemap
//! layer's embedded `Tileset` chunk (0x2023, one column of `tileCount`
//! `tileWidth`×`tileHeight` tiles, per the spec) converts onto this
//! project's own `model::document::Tileset`/`TileEntry` — the same model
//! `commands::tilemap_export` already reads, not a parallel one. An
//! *external*-file tileset (no embedded pixels) imports its tiles as blank,
//! with a warning: following the external reference into another `.ase`
//! file is out of scope here, the same "reported gap, not silent drop"
//! standard as everything else in this list.
//!
//! **What's a reported gap, not a silent drop** (every one of these adds a
//! human-readable entry to `LoadResult.warnings`, the same channel `.tess`
//! load already uses for a missing cel):
//!
//! - **Aseprite's three non-W3C blend modes** (`addition`/`subtract`/
//!   `divide`) have no equivalent in this project's `BlendMode`
//!   (`docs/03-data-model.md` §2.1's own W3C set) and import as `normal`.
//! - **Tag colours are not preserved.** `aseprite-io` 0.2.0's own tag-chunk
//!   reader discards the tag's embedded RGB colour outright (checked in its
//!   source, `reader.rs::read_tags_chunk` — it `skip`s the deprecated
//!   3-byte field rather than reading it), so an imported tag gets a
//!   deterministic placeholder colour from a small fixed cycle, not the one
//!   the artist picked in Aseprite.
//! - **`pingpongReverse`** (Aseprite's fourth loop direction) has no fourth
//!   variant in this project's `TagDirection` (`docs/03-data-model.md` §2.3)
//!   and imports as `pingpong`.
//! - **Per-cel opacity and slices have no equivalent field in this project's
//!   data model at all** (a cel's opacity lives nowhere in `model::document::
//!   Cel`; there is no `Slice` type) and are dropped without a warning —
//!   there is nothing to warn *about*, since neither concept exists here to
//!   have failed to receive it.

use std::collections::HashMap;

use aseprite::{
    AsepriteFile, CelKind as AseCelKind, Color as AseColor, ColorMode as AseColorMode,
    LayerKind as AseLayerKind, LoopDirection, Pixels as AsePixels, Tileset as AseTileset,
    TilesetData as AseTilesetData,
};
use tauri::State;

use crate::error::AppError;
use crate::model::document::{
    BlendMode, Cel, ColorMode, Frame, GridShape, GridSpec, Layer, LayerBase, Palette, Sprite, Tag,
    TagDirection, TileEntry, Tileset,
};
use crate::model::tile_ids::{pack_tile_id, TileFlags, TILE_INDEX_MASK};
use crate::staging::Staging;

use super::project::{LoadResult, LoadedCel, LoadedTile, FORMAT_VERSION};

/// Deterministic placeholder colours for imported tags, cycled by index —
/// `aseprite-io` 0.2.0 does not expose the file's own tag colour (see the
/// module doc comment above), so this is a stand-in, not a recovery of the
/// original.
const TAG_COLOR_CYCLE: [&str; 6] = [
    "#e15554", "#e1b16a", "#3bb273", "#4d9de0", "#7768ae", "#b16dc4",
];

fn map_blend_mode(
    mode: aseprite::BlendMode,
    warnings: &mut Vec<String>,
    layer_name: &str,
) -> BlendMode {
    use aseprite::BlendMode as A;
    match mode {
        A::Normal => BlendMode::Normal,
        A::Multiply => BlendMode::Multiply,
        A::Screen => BlendMode::Screen,
        A::Overlay => BlendMode::Overlay,
        A::Darken => BlendMode::Darken,
        A::Lighten => BlendMode::Lighten,
        A::ColorDodge => BlendMode::ColorDodge,
        A::ColorBurn => BlendMode::ColorBurn,
        A::HardLight => BlendMode::HardLight,
        A::SoftLight => BlendMode::SoftLight,
        A::Difference => BlendMode::Difference,
        A::Exclusion => BlendMode::Exclusion,
        A::Hue => BlendMode::Hue,
        A::Saturation => BlendMode::Saturation,
        A::Color => BlendMode::Color,
        A::Luminosity => BlendMode::Luminosity,
        // `aseprite::BlendMode` is `#[non_exhaustive]` — this arm also covers
        // any future Aseprite blend mode this project's own `BlendMode`
        // (the fixed W3C set, `docs/03-data-model.md` §2.1) has no room for,
        // not just the three known non-W3C ones (addition/subtract/divide).
        other => {
            warnings.push(format!(
                "layer '{layer_name}' uses Aseprite's {other:?} blend mode, which has no \
                 equivalent in this project's BlendMode; imported as normal"
            ));
            BlendMode::Normal
        }
    }
}

fn map_tag_direction(
    direction: LoopDirection,
    warnings: &mut Vec<String>,
    tag_name: &str,
) -> TagDirection {
    match direction {
        LoopDirection::Forward => TagDirection::Forward,
        LoopDirection::Reverse => TagDirection::Reverse,
        LoopDirection::PingPong => TagDirection::Pingpong,
        // `LoopDirection` is `#[non_exhaustive]`; ping-pong-reverse is the
        // only known case with no fourth `TagDirection` variant to land on,
        // but this arm also covers anything added later in the same way.
        other => {
            warnings.push(format!(
                "tag '{tag_name}' uses Aseprite's {other:?} direction, which this project's \
                 TagDirection has no room for; imported as pingpong"
            ));
            TagDirection::Pingpong
        }
    }
}

/// Grayscale is 2 bytes/pixel (value, alpha); indexed is 1 byte/pixel (a
/// palette index, transparent when it equals the file's `transparent_index`
/// — only meaningful for indexed images, per the Aseprite spec). RGBA passes
/// through untouched: already straight-alpha 4-bytes/pixel, matching this
/// project's own "straight alpha, never premultiplied" invariant.
fn pixels_to_rgba(
    pixels: &aseprite::Pixels,
    color_mode: AseColorMode,
    palette: &[AseColor],
    transparent_index: u8,
) -> Vec<u8> {
    match color_mode {
        AseColorMode::Rgba => pixels.data.clone(),
        AseColorMode::Grayscale => pixels
            .data
            .chunks_exact(2)
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        AseColorMode::Indexed => pixels
            .data
            .iter()
            .flat_map(|&idx| {
                if idx == transparent_index {
                    [0, 0, 0, 0]
                } else if let Some(c) = palette.get(idx as usize) {
                    [c.r, c.g, c.b, c.a]
                } else {
                    // Missing palette entry — treat as transparent rather
                    // than guessing a colour.
                    [0, 0, 0, 0]
                }
            })
            .collect(),
        // `aseprite::ColorMode` is `#[non_exhaustive]`, but `AsepriteFile::
        // from_reader` already rejects any depth other than 32/16/8 at parse
        // time (`ColorMode::from_depth`), so by the time a caller holds a
        // real `AsepriteFile` this arm is unreachable, not merely unlikely.
        _ => Vec::new(),
    }
}

fn ase_palette_to_sprite_palette(colors: &[AseColor]) -> Option<Palette> {
    if colors.is_empty() {
        return None;
    }
    Some(Palette {
        id: "imported-ase-palette".into(),
        name: "Imported palette".into(),
        colors: colors.iter().map(|c| [c.r, c.g, c.b, c.a]).collect(),
    })
}

/// A resolved (never `Linked`) cel's own pixel dimensions — used to size a
/// linked cel's own `Cel.width`/`height`, since it owns no pixels itself.
///
/// `tile_dims`, when the resolved cel is a tilemap cel, is that layer's own
/// `(tileWidth, tileHeight)` (`tile_dims_by_layer_id` in `convert`) — a
/// tilemap cel's own `width`/`height` fields are a tile *count*, per the
/// `.ase` spec's "Width/Height in number of tiles", not pixels, so this
/// project's own `Cel.width`/`height` (always pixel dimensions, matching
/// `model/tileIds.ts::tileGridDims`'s expectation) needs the multiply.
fn cel_dimensions(cel: &aseprite::Cel, tile_dims: Option<(u32, u32)>) -> (u32, u32) {
    match &cel.kind {
        AseCelKind::Raw { pixels, .. } | AseCelKind::Compressed { pixels, .. } => {
            (pixels.width as u32, pixels.height as u32)
        }
        AseCelKind::Tilemap { width, height, .. } => {
            let (tw, th) = tile_dims.unwrap_or((1, 1));
            (*width as u32 * tw, *height as u32 * th)
        }
        // `resolve_cel` never returns `Linked` (docs on that method), and
        // `CelKind` is `#[non_exhaustive]` — both land here defensively.
        _ => (0, 0),
    }
}

/// Aseprite's own tilemap-cel bit layout translated onto this project's own
/// packing (`crate::model::tile_ids`) — see the module doc comment above for
/// the full bit-position comparison and why this is a real translation, not
/// a passthrough. `tile_id_bitmask`/`x_flip_bitmask`/`y_flip_bitmask`/
/// `d_flip_bitmask` are read from the `.ase` file's own cel data
/// (`aseprite::CelKind::Tilemap`) rather than hardcoded, since the spec
/// documents them as per-cel fields, not a global constant — even though in
/// practice every known writer (including `aseprite-io`'s own) emits the
/// same four values for the documented 32-bit-tile case.
fn ase_tile_to_tesserica_id(
    raw: u32,
    tile_id_bitmask: u32,
    x_flip_bitmask: u32,
    y_flip_bitmask: u32,
    d_flip_bitmask: u32,
) -> u32 {
    let index = raw & tile_id_bitmask;
    pack_tile_id(
        index,
        TileFlags {
            flip_h: raw & x_flip_bitmask != 0,
            flip_v: raw & y_flip_bitmask != 0,
            transpose: raw & d_flip_bitmask != 0,
        },
    )
}

/// An Aseprite tileset chunk (spec `ase-file-specs.md`, chunk 0x2023) onto
/// this project's own `Tileset`/`TileEntry` (`docs/03-data-model.md` §4) —
/// the same model `commands::tilemap_export` already reads on the way out,
/// reused rather than duplicated.
///
/// The embedded pixel data is one image, `tileWidth × (tileHeight ×
/// tileCount)`, tiles stacked in a single column top to bottom (the spec's
/// own wording) — `aseprite-io` already zlib-decompresses it
/// (`TilesetData::Embedded`), so tile `i`'s bytes are simply the contiguous
/// slice `[i * tileByteLen, (i + 1) * tileByteLen)` of that one buffer, at
/// the file's own colour depth (`tileByteLen = tileWidth * tileHeight *
/// bytesPerPixel(colorMode)`). Each tile's bytes are converted through
/// `pixels_to_rgba` — the exact grayscale/indexed → straight-alpha-RGBA
/// path an ordinary cel already gets, not a second colour conversion to
/// keep in sync.
fn ase_tileset_to_sprite_tileset(
    ase_tileset: &AseTileset,
    tesserica_id: String,
    color_mode: AseColorMode,
    palette: &[AseColor],
    transparent_index: u8,
    staging: &Staging,
    warnings: &mut Vec<String>,
) -> (Tileset, Vec<LoadedTile>) {
    let tile_width = ase_tileset.tile_width as u32;
    let tile_height = ase_tileset.tile_height as u32;
    let tile_byte_len = tile_width as usize * tile_height as usize * color_mode.bytes_per_pixel();

    let strip: &[u8] = match &ase_tileset.data {
        AseTilesetData::Embedded { pixels, .. } => pixels,
        _ => {
            warnings.push(format!(
                "tileset '{}' has no embedded pixel data (an external-file tileset reference \
                 is not followed); its tiles imported blank",
                ase_tileset.name
            ));
            &[]
        }
    };

    let mut tiles = Vec::with_capacity(ase_tileset.tile_count as usize);
    let mut loaded = Vec::with_capacity(ase_tileset.tile_count as usize);
    for i in 0..ase_tileset.tile_count {
        let tile_id = format!("t{i}");
        let start = i as usize * tile_byte_len;
        let rgba = strip
            .get(start..start + tile_byte_len)
            .map(|raw| {
                let pixels = AsePixels {
                    data: raw.to_vec(),
                    width: tile_width as u16,
                    height: tile_height as u16,
                };
                pixels_to_rgba(&pixels, color_mode, palette, transparent_index)
            })
            .unwrap_or_else(|| vec![0u8; tile_width as usize * tile_height as usize * 4]);

        let stage_id = staging.put(rgba);
        loaded.push(LoadedTile {
            tileset_id: tesserica_id.clone(),
            tile_id: tile_id.clone(),
            stage_id,
            width: tile_width,
            height: tile_height,
        });
        tiles.push(TileEntry { id: tile_id });
    }

    (
        Tileset {
            id: tesserica_id,
            name: ase_tileset.name.clone(),
            tile_width,
            tile_height,
            tiles,
        },
        loaded,
    )
}

/// The actual `.ase` -> `Sprite` conversion, separated from the Tauri command
/// so it can be unit-tested against an in-memory `AsepriteFile` with no file
/// I/O.
fn convert(
    file: &AsepriteFile,
    staging: &Staging,
) -> (Sprite, Vec<LoadedCel>, Vec<LoadedTile>, Vec<String>) {
    let mut warnings = Vec::new();
    let width = file.width() as u32;
    let height = file.height() as u32;
    let color_mode = file.color_mode();
    let palette = file.palette();
    let transparent_index = file.transparent_index();

    let frames: Vec<Frame> = file
        .frames()
        .iter()
        .enumerate()
        .map(|(i, f)| Frame {
            id: format!("f{i}"),
            duration_ms: f.duration_ms as u32,
        })
        .collect();

    // Every tileset referenced by at least one tilemap layer, converted once
    // up front so both the layer loop (needs each tilemap layer's own
    // `tileWidth`/`tileHeight` for its `GridSpec`) and the cel loop (needs
    // them to turn a tile-count cel size into a pixel size) can look it up
    // by Aseprite layer id. `tileset_index` in `LayerKind::Tilemap` names an
    // `aseprite::Tileset.id`, not a position in `file.tilesets()` — the spec
    // just calls it "Tileset index", but `aseprite-io`'s own reader/writer
    // round-trip the raw DWORD against `Tileset.id` with no positional
    // assumption, so matching on `.id` is the correct (and only
    // crate-verified) lookup.
    let mut tileset_id_by_ase_id: HashMap<u32, String> = HashMap::new();
    let mut tile_dims_by_ase_id: HashMap<u32, (u32, u32)> = HashMap::new();
    let mut tilesets: Vec<Tileset> = Vec::new();
    let mut loaded_tiles: Vec<LoadedTile> = Vec::new();
    for ase_layer in file.layers() {
        let AseLayerKind::Tilemap { tileset_index } = ase_layer.kind else {
            continue;
        };
        if tileset_id_by_ase_id.contains_key(&tileset_index) {
            continue; // already converted for an earlier layer referencing it
        }
        match file.tilesets().iter().find(|t| t.id == tileset_index) {
            Some(ase_tileset) => {
                let tesserica_id = format!("ts{tileset_index}");
                tile_dims_by_ase_id.insert(
                    tileset_index,
                    (
                        ase_tileset.tile_width as u32,
                        ase_tileset.tile_height as u32,
                    ),
                );
                let (tileset, mut loaded) = ase_tileset_to_sprite_tileset(
                    ase_tileset,
                    tesserica_id.clone(),
                    color_mode,
                    palette,
                    transparent_index,
                    staging,
                    &mut warnings,
                );
                tileset_id_by_ase_id.insert(tileset_index, tesserica_id);
                tilesets.push(tileset);
                loaded_tiles.append(&mut loaded);
            }
            None => {
                warnings.push(format!(
                    "layer '{}' references Aseprite tileset {tileset_index}, which is missing \
                     from the file; layer skipped",
                    ase_layer.name
                ));
            }
        }
    }

    // One generated id per Aseprite layer index, `None` for a layer skipped
    // outright (a tilemap layer whose tileset is missing) — lets both the
    // parent-pointer and cel loops below resolve "this ase layer index" ->
    // "this project's own LayerId" without a second pass.
    let ase_layers = file.layers();
    let mut layer_ids: Vec<Option<String>> = Vec::with_capacity(ase_layers.len());
    let mut layers: Vec<Layer> = Vec::new();
    // A tilemap layer's own tile size, by *this project's* `LayerId` — the
    // cel loop below needs it to convert a tile-count cel size to pixels.
    let mut tile_dims_by_layer_id: HashMap<String, (u32, u32)> = HashMap::new();

    for (i, ase_layer) in ase_layers.iter().enumerate() {
        if let AseLayerKind::Tilemap { tileset_index } = ase_layer.kind {
            if !tileset_id_by_ase_id.contains_key(&tileset_index) {
                // Already warned above (missing tileset) — this layer has
                // nothing to reference, so it does not import.
                layer_ids.push(None);
                continue;
            }
        }

        let id = format!("l{i}");
        // A parent index always refers to an already-visited Group layer
        // (Aseprite always writes a group's own chunk before its children's),
        // so `layer_ids[p]` is already populated by the time we get here.
        let parent_id = ase_layer
            .parent
            .and_then(|p| layer_ids.get(p).cloned().flatten());

        let base = LayerBase {
            id: id.clone(),
            name: ase_layer.name.clone(),
            visible: ase_layer.visible,
            locked: !ase_layer.editable,
            opacity: ase_layer.opacity as f32 / 255.0,
            blend_mode: map_blend_mode(ase_layer.blend_mode, &mut warnings, &ase_layer.name),
            parent_id,
            clipping_mask: false,
            // `.ase` has no equivalent of `docs/03-data-model.md` §5's
            // non-destructive effects (Phase 7) to import from.
            effects: vec![],
        };

        let layer = match ase_layer.kind {
            AseLayerKind::Group => Layer::Group {
                base,
                collapsed: ase_layer.collapsed,
            },
            AseLayerKind::Tilemap { tileset_index } => {
                let tileset_id = tileset_id_by_ase_id[&tileset_index].clone();
                let (tile_width, tile_height) = tile_dims_by_ase_id[&tileset_index];
                tile_dims_by_layer_id.insert(id.clone(), (tile_width, tile_height));
                Layer::Tilemap {
                    base,
                    tileset_id,
                    grid: GridSpec {
                        shape: GridShape::Rect,
                        tile_width,
                        tile_height,
                        offset_x: 0,
                        offset_y: 0,
                    },
                }
            }
            _ => Layer::Raster { base },
        };
        layers.push(layer);
        layer_ids.push(Some(id));
    }

    let mut cels: Vec<Cel> = Vec::new();
    let mut loaded_cels: Vec<LoadedCel> = Vec::new();

    for (i, ase_layer) in ase_layers.iter().enumerate() {
        let Some(layer_id) = layer_ids[i].clone() else {
            continue; // skipped layer (missing tileset reference)
        };
        if ase_layer.kind == AseLayerKind::Group {
            continue; // groups hold no cels of their own
        }
        let Some(layer_ref) = file.layer_ref(i) else {
            continue;
        };
        let tile_dims = tile_dims_by_layer_id.get(&layer_id).copied();

        for (fi, frame) in frames.iter().enumerate() {
            let Some(raw_cel) = file.cel(layer_ref, fi) else {
                continue; // sparse: not every layer has a cel on every frame
            };
            let cel_id = format!("c{i}_{fi}");

            match &raw_cel.kind {
                AseCelKind::Linked { source_frame, x, y } => {
                    let Some(resolved) = file.resolve_cel(layer_ref, fi) else {
                        warnings.push(format!(
                            "cel at layer '{}' frame {fi} links to a missing source; skipped",
                            ase_layer.name
                        ));
                        continue;
                    };
                    let (w, h) = cel_dimensions(resolved, tile_dims);
                    cels.push(Cel {
                        id: cel_id,
                        layer_id: layer_id.clone(),
                        frame_id: frame.id.clone(),
                        x: *x as i32,
                        y: *y as i32,
                        width: w,
                        height: h,
                        linked_to: Some(format!("c{i}_{source_frame}")),
                    });
                }
                AseCelKind::Raw { pixels, x, y } | AseCelKind::Compressed { pixels, x, y, .. } => {
                    let rgba = pixels_to_rgba(pixels, color_mode, palette, transparent_index);
                    let (w, h) = (pixels.width as u32, pixels.height as u32);
                    let stage_id = staging.put(rgba);
                    loaded_cels.push(LoadedCel {
                        cel_id: cel_id.clone(),
                        stage_id,
                        width: w,
                        height: h,
                    });
                    cels.push(Cel {
                        id: cel_id,
                        layer_id: layer_id.clone(),
                        frame_id: frame.id.clone(),
                        x: *x as i32,
                        y: *y as i32,
                        width: w,
                        height: h,
                        linked_to: None,
                    });
                }
                AseCelKind::Tilemap {
                    width: cols,
                    height: rows,
                    tile_id_bitmask,
                    x_flip_bitmask,
                    y_flip_bitmask,
                    d_flip_bitmask,
                    tiles,
                    x,
                    y,
                    ..
                } => {
                    let Some((tile_width, tile_height)) = tile_dims else {
                        // Can't happen in practice: a `Tilemap`-kind cel only
                        // ever belongs to a `Tilemap`-kind layer, which
                        // always populates `tile_dims_by_layer_id` above when
                        // it makes it into `layer_ids` at all. Handled
                        // defensively rather than assumed impossible, same
                        // standard as every other `#[non_exhaustive]` arm in
                        // this file.
                        warnings.push(format!(
                            "tilemap cel at layer '{}' frame {fi} has no resolved tile size; \
                             skipped",
                            ase_layer.name
                        ));
                        continue;
                    };

                    let mut index_overflowed = false;
                    let packed: Vec<u32> = tiles
                        .iter()
                        .map(|&raw| {
                            if (raw & tile_id_bitmask) > TILE_INDEX_MASK {
                                index_overflowed = true;
                            }
                            ase_tile_to_tesserica_id(
                                raw,
                                *tile_id_bitmask,
                                *x_flip_bitmask,
                                *y_flip_bitmask,
                                *d_flip_bitmask,
                            )
                        })
                        .collect();
                    if index_overflowed {
                        warnings.push(format!(
                            "layer '{}' frame {fi} has a tile index beyond this project's \
                             28-bit range; truncated",
                            ase_layer.name
                        ));
                    }

                    // Row-major, top to bottom (the spec's own cel-data
                    // wording) — the same order `model/tileGridBuffers.ts`'s
                    // dense `Uint32Array` expects, so no reordering needed,
                    // only the byte encoding (`Uint32Array` reads
                    // platform-native, little-endian on every real target
                    // here, so bytes are written explicitly rather than
                    // relying on an implicit `u32` layout).
                    let bytes: Vec<u8> = packed.iter().flat_map(|v| v.to_le_bytes()).collect();
                    let w = *cols as u32 * tile_width;
                    let h = *rows as u32 * tile_height;
                    let stage_id = staging.put(bytes);
                    loaded_cels.push(LoadedCel {
                        cel_id: cel_id.clone(),
                        stage_id,
                        width: w,
                        height: h,
                    });
                    cels.push(Cel {
                        id: cel_id,
                        layer_id: layer_id.clone(),
                        frame_id: frame.id.clone(),
                        x: *x as i32,
                        y: *y as i32,
                        width: w,
                        height: h,
                        linked_to: None,
                    });
                }
                // `CelKind` is `#[non_exhaustive]` — handled defensively
                // rather than assumed impossible.
                _ => {
                    warnings.push(format!(
                        "unexpected/unsupported cel data on layer '{}' frame {fi}; skipped",
                        ase_layer.name
                    ));
                }
            }
        }
    }

    let tags: Vec<Tag> = file
        .tags()
        .iter()
        .enumerate()
        .map(|(i, t)| Tag {
            id: format!("t{i}"),
            name: t.name.clone(),
            from: t.from_frame as u32,
            to: t.to_frame as u32,
            direction: map_tag_direction(t.direction, &mut warnings, &t.name),
            repeat: if t.repeat == 0 {
                None
            } else {
                Some(t.repeat as u32)
            },
            color: TAG_COLOR_CYCLE[i % TAG_COLOR_CYCLE.len()].to_string(),
        })
        .collect();

    if !tags.is_empty() {
        warnings.push(
            "Aseprite tag colours are not preserved on import (the aseprite-io 0.2.0 reader \
             discards the file's own tag colour field); placeholder colours were assigned \
             instead."
                .to_string(),
        );
    }

    let sprite = Sprite {
        width,
        height,
        color_mode: ColorMode::Rgba,
        layers,
        frames,
        cels,
        palette: ase_palette_to_sprite_palette(palette),
        tags,
        tilesets,
    };

    (sprite, loaded_cels, loaded_tiles, warnings)
}

#[tauri::command]
pub async fn import_ase(path: String, staging: State<'_, Staging>) -> Result<LoadResult, AppError> {
    let bytes = std::fs::read(&path)?;
    let file = AsepriteFile::from_reader(&bytes[..]).map_err(|e| {
        AppError::invalid(format!("{path} is not a readable .ase/.aseprite file: {e}"))
    })?;
    let (sprite, cels, tile_entries, warnings) = convert(&file, &staging);
    Ok(LoadResult {
        path,
        format_version: FORMAT_VERSION,
        sprite,
        cels,
        tile_entries,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aseprite::{ColorMode as AseColorMode, LoopDirection, Pixels};

    fn stage_and_fetch(staging: &Staging, cels: &[LoadedCel], cel_id: &str) -> Vec<u8> {
        let entry = cels
            .iter()
            .find(|c| c.cel_id == cel_id)
            .expect("cel present");
        staging.get(entry.stage_id).unwrap()
    }

    /// The smallest real case: one RGBA layer, one frame, one cel — proves
    /// the header/frame/layer/cel plumbing end to end against a genuine
    /// binary `.aseprite` byte stream (built by the crate's own writer, an
    /// independent code path from its reader, and then round-tripped through
    /// `AsepriteFile::from_reader` exactly as a file opened from disk would
    /// be).
    #[test]
    fn imports_a_minimal_single_layer_single_frame_rgba_file() {
        let mut file = AsepriteFile::new(2, 2, AseColorMode::Rgba);
        let layer = file.add_layer("Background");
        let frame = file.add_frame(100);
        let pixels = Pixels::new(
            vec![
                255, 0, 0, 255, //
                0, 255, 0, 255, //
                0, 0, 255, 255, //
                255, 255, 255, 128,
            ],
            2,
            2,
            AseColorMode::Rgba,
        )
        .unwrap();
        file.set_cel(layer, frame, pixels, 0, 0).unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);

        assert!(warnings.is_empty());
        assert_eq!(sprite.width, 2);
        assert_eq!(sprite.height, 2);
        assert_eq!(sprite.layers.len(), 1);
        assert_eq!(sprite.frames.len(), 1);
        assert_eq!(sprite.frames[0].duration_ms, 100);
        assert_eq!(sprite.cels.len(), 1);
        assert_eq!(cels.len(), 1);

        let rgba = stage_and_fetch(&staging, &cels, &sprite.cels[0].id);
        assert_eq!(
            rgba,
            vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]
        );
    }

    #[test]
    fn imports_nested_groups_with_parent_pointers() {
        let mut file = AsepriteFile::new(4, 4, AseColorMode::Rgba);
        let group = file.add_group("Character");
        let child = file.add_layer_in("outline", group);
        let frame = file.add_frame(100);
        file.set_cel(
            child,
            frame,
            Pixels::new(vec![0u8; 4 * 4 * 4], 4, 4, AseColorMode::Rgba).unwrap(),
            0,
            0,
        )
        .unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, _cels, _tiles, warnings) = convert(&reopened, &staging);
        assert!(warnings.is_empty());

        assert_eq!(sprite.layers.len(), 2);
        let group_layer = sprite
            .layers
            .iter()
            .find(|l| matches!(l, Layer::Group { .. }))
            .expect("group present");
        let child_layer = sprite
            .layers
            .iter()
            .find(|l| matches!(l, Layer::Raster { .. }))
            .expect("child present");
        assert_eq!(
            child_layer.base().parent_id.as_deref(),
            Some(group_layer.base().id.as_str())
        );
    }

    #[test]
    fn imports_a_linked_cel_sharing_the_canonical_cels_buffer() {
        let mut file = AsepriteFile::new(2, 2, AseColorMode::Rgba);
        let layer = file.add_layer("Layer");
        let f0 = file.add_frame(100);
        let f1 = file.add_frame(100);
        let pixels = Pixels::new(
            vec![10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            2,
            2,
            AseColorMode::Rgba,
        )
        .unwrap();
        file.set_cel(layer, f0, pixels, 0, 0).unwrap();
        file.set_linked_cel(layer, f1, f0).unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);
        assert!(warnings.is_empty());

        assert_eq!(sprite.cels.len(), 2);
        // Only the canonical cel was staged — the linked one shares its
        // pixels rather than getting a duplicate upload, exactly like a
        // linked cel in a `.tess` archive (`commands::project`).
        assert_eq!(cels.len(), 1);

        let canonical = sprite
            .cels
            .iter()
            .find(|c| c.linked_to.is_none())
            .expect("canonical cel present");
        let linked = sprite
            .cels
            .iter()
            .find(|c| c.linked_to.is_some())
            .expect("linked cel present");
        assert_eq!(linked.linked_to.as_deref(), Some(canonical.id.as_str()));
        assert_eq!(linked.width, canonical.width);
        assert_eq!(linked.height, canonical.height);
    }

    #[test]
    fn converts_indexed_pixels_to_straight_alpha_rgba_honouring_the_transparent_index() {
        let mut file = AsepriteFile::new(2, 1, AseColorMode::Indexed);
        file.set_transparent_index(0);
        file.set_palette(&[
            AseColor {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
                name: None,
            },
            AseColor {
                r: 200,
                g: 100,
                b: 50,
                a: 255,
                name: None,
            },
        ])
        .unwrap();
        let layer = file.add_layer("Layer");
        let frame = file.add_frame(100);
        // Index 0 (transparent_index) then index 1 (a real palette colour).
        let pixels = Pixels::new(vec![0, 1], 2, 1, AseColorMode::Indexed).unwrap();
        file.set_cel(layer, frame, pixels, 0, 0).unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);
        assert!(warnings.is_empty());

        let rgba = stage_and_fetch(&staging, &cels, &sprite.cels[0].id);
        // Transparent index -> alpha 0 regardless of the palette entry it
        // would otherwise map to; a real index -> its palette colour.
        assert_eq!(rgba, vec![0, 0, 0, 0, 200, 100, 50, 255]);
    }

    #[test]
    fn converts_grayscale_pixels_to_rgba() {
        let mut file = AsepriteFile::new(1, 1, AseColorMode::Grayscale);
        let layer = file.add_layer("Layer");
        let frame = file.add_frame(100);
        let pixels = Pixels::new(vec![128, 200], 1, 1, AseColorMode::Grayscale).unwrap();
        file.set_cel(layer, frame, pixels, 0, 0).unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);
        assert!(warnings.is_empty());

        let rgba = stage_and_fetch(&staging, &cels, &sprite.cels[0].id);
        assert_eq!(rgba, vec![128, 128, 128, 200]);
    }

    #[test]
    fn imports_tags_with_ranges_and_direction_and_flags_a_missing_colour() {
        let mut file = AsepriteFile::new(4, 4, AseColorMode::Rgba);
        let _f0 = file.add_frame(100);
        let _f1 = file.add_frame(100);
        let _f2 = file.add_frame(100);
        file.add_tag("walk", 0..=2, LoopDirection::PingPong)
            .unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, _cels, _tiles, warnings) = convert(&reopened, &staging);

        assert_eq!(sprite.tags.len(), 1);
        assert_eq!(sprite.tags[0].name, "walk");
        assert_eq!(sprite.tags[0].from, 0);
        assert_eq!(sprite.tags[0].to, 2);
        assert_eq!(sprite.tags[0].direction, TagDirection::Pingpong);
        assert_eq!(sprite.tags[0].repeat, None);
        assert!(!sprite.tags[0].color.is_empty());
        assert!(warnings.iter().any(|w| w.contains("colour")));
    }

    #[test]
    fn imports_the_files_own_palette_as_a_swatch_list() {
        let mut file = AsepriteFile::new(1, 1, AseColorMode::Rgba);
        file.set_palette(&[
            AseColor {
                r: 10,
                g: 20,
                b: 30,
                a: 255,
                name: None,
            },
            AseColor {
                r: 40,
                g: 50,
                b: 60,
                a: 255,
                name: None,
            },
        ])
        .unwrap();
        // Layer/palette chunks are written against frame 0 (checked in the
        // crate's own `writer.rs`) — a file with no frame at all writes
        // neither, so a frame is needed here purely to give the palette
        // chunk somewhere to attach, not because this test cares about it.
        let _frame = file.add_frame(100);

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, _cels, _tiles, _warnings) = convert(&reopened, &staging);

        let palette = sprite.palette.expect("palette present");
        assert_eq!(palette.colors.len(), 2);
        assert_eq!(palette.colors[0], [10, 20, 30, 255]);
        assert_eq!(palette.colors[1], [40, 50, 60, 255]);
    }

    #[test]
    fn a_file_with_no_content_imports_as_an_empty_but_valid_sprite() {
        let file = AsepriteFile::new(8, 8, AseColorMode::Rgba);
        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);

        assert!(warnings.is_empty());
        assert_eq!(sprite.width, 8);
        assert_eq!(sprite.height, 8);
        assert!(sprite.layers.is_empty());
        assert!(sprite.cels.is_empty());
        assert!(cels.is_empty());
    }

    #[test]
    fn something_that_is_not_an_aseprite_file_is_rejected_rather_than_panicking() {
        let err = AsepriteFile::from_reader(&b"not an ase file"[..]);
        assert!(err.is_err());
    }

    /// End to end against a **real file on disk**, not just in-memory bytes —
    /// the one thing the unit tests above do not exercise, since `import_ase`
    /// itself (the actual Tauri command) is `std::fs::read` followed by
    /// exactly the same `convert()` call. A multi-layer, multi-frame,
    /// grouped, tagged, linked-cel file, written by the crate's own encoder
    /// and read back through the same file-path code path the real command
    /// uses.
    #[test]
    fn imports_a_real_multi_feature_aseprite_file_from_disk() {
        let mut file = AsepriteFile::new(3, 3, AseColorMode::Rgba);
        let group = file.add_group("Character");
        let body = file.add_layer_in("body", group);
        let bg = file.add_layer("background");
        let f0 = file.add_frame(80);
        let f1 = file.add_frame(80);
        let f2 = file.add_frame(80);

        let solid = |v: u8| Pixels::new(vec![v; 3 * 3 * 4], 3, 3, AseColorMode::Rgba).unwrap();
        file.set_cel(body, f0, solid(10), 0, 0).unwrap();
        file.set_linked_cel(body, f1, f0).unwrap();
        file.set_cel(body, f2, solid(20), 0, 0).unwrap();
        file.set_cel(bg, f0, solid(200), 0, 0).unwrap();
        file.add_tag("walk", 0..=1, LoopDirection::PingPong)
            .unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();

        let mut path = std::env::temp_dir();
        path.push(format!(
            "tesserica-ase-import-test-{}.aseprite",
            std::process::id()
        ));
        std::fs::write(&path, &bytes).unwrap();

        // Exactly what `import_ase` itself does, minus the `State<Staging>`
        // wrapper a real Tauri command needs to be constructed from.
        let read_back = std::fs::read(&path).unwrap();
        let reopened = AsepriteFile::from_reader(&read_back[..]).unwrap();
        let staging = Staging::default();
        let (sprite, cels, _tiles, warnings) = convert(&reopened, &staging);

        std::fs::remove_file(&path).ok();

        assert_eq!(sprite.width, 3);
        assert_eq!(sprite.height, 3);
        assert_eq!(sprite.layers.len(), 3); // group + body + background
        assert_eq!(sprite.frames.len(), 3);
        // 3 body cels (one linked) + 1 background cel = 4, but only 3 are
        // staged (the linked one shares its target's buffer).
        assert_eq!(sprite.cels.len(), 4);
        assert_eq!(cels.len(), 3);
        assert_eq!(sprite.tags.len(), 1);
        assert_eq!(sprite.tags[0].name, "walk");
        assert!(warnings.iter().any(|w| w.contains("colour"))); // the one expected gap

        let linked = sprite
            .cels
            .iter()
            .find(|c| c.linked_to.is_some())
            .expect("linked cel present");
        let canonical_rgba = stage_and_fetch(
            &staging,
            &cels,
            linked.linked_to.as_deref().expect("linked_to set"),
        );
        assert_eq!(canonical_rgba[0], 10); // the body layer's frame-0 fill value
    }

    /// White-box test for the bit translation itself (`ase_tile_to_tesserica_id`)
    /// — Aseprite's own x-flip bit (29, `0x2000_0000`) happens to numerically
    /// equal Tesserica's own `FLIP_V_BIT` (also bit 29), so a naive bit-for-bit
    /// copy would misread Aseprite's flip-horizontal as this project's
    /// flip-vertical without ever panicking or crashing — this test would
    /// pass under that bug unless it checks the *specific* flag, which it
    /// does. `assert_ne!` at the end additionally rules out a literal
    /// passthrough (which happens to still "round-trip" the index correctly
    /// here, since 5 fits in both bit widths, but at the wrong flag bits).
    #[test]
    fn ase_bit_translation_is_not_a_passthrough() {
        let raw = 5 | 0x2000_0000; // Aseprite: index 5, x-flip (bit 29)
        let id = ase_tile_to_tesserica_id(raw, 0x1fff_ffff, 0x2000_0000, 0x4000_0000, 0x8000_0000);
        let unpacked = crate::model::tile_ids::unpack_tile_id(id);
        assert_eq!(unpacked.index, 5);
        assert!(
            unpacked.flip_h,
            "Aseprite's x-flip must land on Tesserica's flip-h"
        );
        assert!(
            !unpacked.flip_v,
            "must not bleed into Tesserica's own bit-29 flag (flip-v)"
        );
        assert_ne!(id, raw, "must not be a bit-for-bit passthrough");
    }

    #[test]
    fn ase_diagonal_flip_maps_to_tesserica_transpose() {
        // Aseprite's own spec wording for its bit-31 flag is "swap X/Y axis"
        // — semantically the same operation as Tesserica's own transpose
        // flag, just at a different bit (30 vs 31).
        let raw = 9 | 0x8000_0000; // Aseprite: index 9, diagonal/d-flip (bit 31)
        let id = ase_tile_to_tesserica_id(raw, 0x1fff_ffff, 0x2000_0000, 0x4000_0000, 0x8000_0000);
        let unpacked = crate::model::tile_ids::unpack_tile_id(id);
        assert_eq!(unpacked.index, 9);
        assert!(unpacked.transpose);
        assert!(!unpacked.flip_h && !unpacked.flip_v);
        assert_ne!(id, raw, "must not be a bit-for-bit passthrough");
    }

    /// End-to-end: a real tilemap layer with a real embedded tileset,
    /// imported through `convert()` exactly as `import_ase` calls it,
    /// decoding the staged cel bytes back into tile ids and asserting on
    /// the actual bit-translated result — not just "did not crash".
    #[test]
    fn imports_a_tilemap_layer_translating_flip_and_transpose_bits() {
        let mut file = AsepriteFile::new(8, 8, AseColorMode::Rgba);

        // A 3-tile, 2x2-pixel tileset: tile 0 blank (Aseprite's own empty
        // convention), tile 1 solid red, tile 2 solid blue — stacked in one
        // column, per the spec's own "(Tile Width) x (Tile Height x Number
        // of Tiles)" embedded-image layout.
        let mut pixels = vec![0u8; 2 * 2 * 4]; // tile 0: blank
        pixels.extend(std::iter::repeat_n([255u8, 0, 0, 255], 4).flatten()); // tile 1: red
        pixels.extend(std::iter::repeat_n([0u8, 0, 255, 255], 4).flatten()); // tile 2: blue
        let tileset = aseprite::Tileset {
            id: 0,
            // Flag 4 (`empty_tile_is_zero`) is the modern/default convention
            // this project's own "index 0 is always empty" already assumes.
            flags: aseprite::TilesetFlags(2 | 4),
            name: "Tiles".into(),
            tile_count: 3,
            tile_width: 2,
            tile_height: 2,
            base_index: 1,
            data: aseprite::TilesetData::Embedded {
                pixels,
                original_compressed: None,
            },
            user_data: None,
            tile_user_data: vec![None; 3],
        };
        file.add_tileset(tileset);
        let tilemap_layer = file.add_tilemap_layer("Ground", 0);
        let frame = file.add_frame(100);

        // A 2-col x 1-row cel: tile 1 flipped horizontally, tile 2
        // transposed (diagonal flip) — the same bitmask values the spec (and
        // `aseprite-io`'s own writer) use for 32-bit tiles.
        let tiles: Vec<u32> = vec![1 | 0x2000_0000, 2 | 0x8000_0000];
        file.set_tilemap_cel(tilemap_layer, frame, tiles, 2, 1, 0, 0)
            .unwrap();

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, tile_entries, warnings) = convert(&reopened, &staging);
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");

        // -- Tileset --------------------------------------------------------
        assert_eq!(sprite.tilesets.len(), 1);
        let tileset = &sprite.tilesets[0];
        assert_eq!(tileset.tile_width, 2);
        assert_eq!(tileset.tile_height, 2);
        assert_eq!(tileset.tiles.len(), 3);
        assert_eq!(tile_entries.len(), 3);

        let tile_rgba = |tile_id: &str| -> Vec<u8> {
            let entry = tile_entries
                .iter()
                .find(|t| t.tile_id == tile_id)
                .expect("tile entry present");
            staging.get(entry.stage_id).unwrap()
        };
        assert_eq!(tile_rgba("t0"), vec![0u8; 16]); // blank
        assert_eq!(tile_rgba("t1"), [255, 0, 0, 255].repeat(4)); // red
        assert_eq!(tile_rgba("t2"), [0, 0, 255, 255].repeat(4)); // blue

        // -- Layer / grid -----------------------------------------------------
        assert_eq!(sprite.layers.len(), 1);
        let Layer::Tilemap {
            tileset_id, grid, ..
        } = &sprite.layers[0]
        else {
            panic!("expected a Layer::Tilemap");
        };
        assert_eq!(tileset_id, &tileset.id);
        assert_eq!(grid.shape, GridShape::Rect);
        assert_eq!(grid.tile_width, 2);
        assert_eq!(grid.tile_height, 2);

        // -- Cel: the actual bit-translated packed ids -----------------------
        assert_eq!(sprite.cels.len(), 1);
        let cel = &sprite.cels[0];
        // 2 cols x 1 row of 2x2 tiles == 4x2 pixels, not the tile-count
        // dimensions `aseprite::CelKind::Tilemap` itself reports.
        assert_eq!(cel.width, 4);
        assert_eq!(cel.height, 2);

        let grid_bytes = stage_and_fetch(&staging, &cels, &cel.id);
        assert_eq!(grid_bytes.len(), 8); // 2 tiles x 4 bytes (one u32 each)
        let raw_ids: Vec<u32> = grid_bytes
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(raw_ids.len(), 2);

        let first = crate::model::tile_ids::unpack_tile_id(raw_ids[0]);
        assert_eq!(first.index, 1);
        assert!(first.flip_h && !first.flip_v && !first.transpose);

        let second = crate::model::tile_ids::unpack_tile_id(raw_ids[1]);
        assert_eq!(second.index, 2);
        assert!(second.transpose && !second.flip_h && !second.flip_v);

        // Not a bit-for-bit passthrough of Aseprite's own raw values —
        // Aseprite's x-flip bit (0x2000_0000) numerically equals Tesserica's
        // own flip-vertical bit, so this is the regression a naive copy
        // would slip through.
        assert_ne!(raw_ids[0], 1 | 0x2000_0000);
        assert_ne!(raw_ids[1], 2 | 0x8000_0000);
    }

    #[test]
    fn a_tilemap_layer_referencing_a_missing_tileset_is_skipped_with_a_warning() {
        let mut file = AsepriteFile::new(4, 4, AseColorMode::Rgba);
        // No tileset added at all — index 0 refers to nothing.
        let _tilemap_layer = file.add_tilemap_layer("Ground", 0);
        let _frame = file.add_frame(100);

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, tile_entries, warnings) = convert(&reopened, &staging);

        assert!(sprite.layers.is_empty());
        assert!(sprite.tilesets.is_empty());
        assert!(cels.is_empty());
        assert!(tile_entries.is_empty());
        assert!(warnings.iter().any(|w| w.contains("tileset")));
    }

    #[test]
    fn maps_a_locked_hidden_layer_and_opacity_correctly() {
        use aseprite::LayerOptions;

        let mut file = AsepriteFile::new(4, 4, AseColorMode::Rgba);
        let _layer = file.add_layer_with(
            "Hidden",
            LayerOptions {
                opacity: 128,
                visible: false,
                editable: false,
                ..Default::default()
            },
        );
        // Layer chunks are written against frame 0 (see the comment in
        // `imports_the_files_own_palette_as_a_swatch_list` above).
        let _frame = file.add_frame(100);

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, _cels, _tiles, _warnings) = convert(&reopened, &staging);

        let base = sprite.layers[0].base();
        assert!(!base.visible);
        assert!(base.locked);
        assert!((base.opacity - 128.0 / 255.0).abs() < 1e-6);
    }
}
