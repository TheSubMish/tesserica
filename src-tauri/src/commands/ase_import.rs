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
//! **What's a reported gap, not a silent drop** (every one of these adds a
//! human-readable entry to `LoadResult.warnings`, the same channel `.tess`
//! load already uses for a missing cel):
//!
//! - **`.ase` tilemap layers are skipped.** Aseprite's own tile flip/rotate
//!   bit layout does not match this project's `model/tileIds.ts` packing
//!   (the *export* side of this already found the analogous mismatch against
//!   Tiled's bit layout, `commands::tilemap_export`) and repacking it
//!   correctly is real work distinct from the rest of this item.
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

use aseprite::{
    AsepriteFile, CelKind as AseCelKind, Color as AseColor, ColorMode as AseColorMode,
    LayerKind as AseLayerKind, LoopDirection,
};
use tauri::State;

use crate::error::AppError;
use crate::model::document::{
    BlendMode, Cel, ColorMode, Frame, Layer, LayerBase, Palette, Sprite, Tag, TagDirection,
};
use crate::staging::Staging;

use super::project::{LoadResult, LoadedCel, FORMAT_VERSION};

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
fn cel_dimensions(cel: &aseprite::Cel) -> (u32, u32) {
    match &cel.kind {
        AseCelKind::Raw { pixels, .. } | AseCelKind::Compressed { pixels, .. } => {
            (pixels.width as u32, pixels.height as u32)
        }
        AseCelKind::Tilemap { width, height, .. } => (*width as u32, *height as u32),
        // `resolve_cel` never returns `Linked` (docs on that method), and
        // `CelKind` is `#[non_exhaustive]` — both land here defensively.
        _ => (0, 0),
    }
}

/// The actual `.ase` -> `Sprite` conversion, separated from the Tauri command
/// so it can be unit-tested against an in-memory `AsepriteFile` with no file
/// I/O.
fn convert(file: &AsepriteFile, staging: &Staging) -> (Sprite, Vec<LoadedCel>, Vec<String>) {
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

    // One generated id per Aseprite layer index, `None` for a skipped
    // tilemap layer — lets both the parent-pointer and cel loops below
    // resolve "this ase layer index" -> "this project's own LayerId" without
    // a second pass.
    let ase_layers = file.layers();
    let mut layer_ids: Vec<Option<String>> = Vec::with_capacity(ase_layers.len());
    let mut layers: Vec<Layer> = Vec::new();

    for (i, ase_layer) in ase_layers.iter().enumerate() {
        if matches!(ase_layer.kind, AseLayerKind::Tilemap { .. }) {
            warnings.push(format!(
                "layer '{}' is an Aseprite tilemap layer; .ase tilemap import is not yet \
                 supported, skipped",
                ase_layer.name
            ));
            layer_ids.push(None);
            continue;
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
        };

        let layer = if ase_layer.kind == AseLayerKind::Group {
            Layer::Group {
                base,
                collapsed: ase_layer.collapsed,
            }
        } else {
            Layer::Raster { base }
        };
        layers.push(layer);
        layer_ids.push(Some(id));
    }

    let mut cels: Vec<Cel> = Vec::new();
    let mut loaded_cels: Vec<LoadedCel> = Vec::new();

    for (i, ase_layer) in ase_layers.iter().enumerate() {
        let Some(layer_id) = layer_ids[i].clone() else {
            continue; // skipped tilemap layer
        };
        if ase_layer.kind == AseLayerKind::Group {
            continue; // groups hold no cels of their own
        }
        let Some(layer_ref) = file.layer_ref(i) else {
            continue;
        };

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
                    let (w, h) = cel_dimensions(resolved);
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
                // `AseCelKind::Tilemap` is unreachable in practice (a
                // tilemap-kind layer never reaches this loop — skipped
                // above, so `file.cel` is never called against one), and
                // `CelKind` is itself `#[non_exhaustive]`. Both are handled
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
        tilesets: Vec::new(),
    };

    (sprite, loaded_cels, warnings)
}

#[tauri::command]
pub async fn import_ase(path: String, staging: State<'_, Staging>) -> Result<LoadResult, AppError> {
    let bytes = std::fs::read(&path)?;
    let file = AsepriteFile::from_reader(&bytes[..]).map_err(|e| {
        AppError::invalid(format!("{path} is not a readable .ase/.aseprite file: {e}"))
    })?;
    let (sprite, cels, warnings) = convert(&file, &staging);
    Ok(LoadResult {
        path,
        format_version: FORMAT_VERSION,
        sprite,
        cels,
        tile_entries: Vec::new(),
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
        let (sprite, cels, warnings) = convert(&reopened, &staging);

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
        let (sprite, _cels, warnings) = convert(&reopened, &staging);
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
        let (sprite, cels, warnings) = convert(&reopened, &staging);
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
        let (sprite, cels, warnings) = convert(&reopened, &staging);
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
        let (sprite, cels, warnings) = convert(&reopened, &staging);
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
        let (sprite, _cels, warnings) = convert(&reopened, &staging);

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
        let (sprite, _cels, _warnings) = convert(&reopened, &staging);

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
        let (sprite, cels, warnings) = convert(&reopened, &staging);

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
        let (sprite, cels, warnings) = convert(&reopened, &staging);

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

    #[test]
    fn skips_a_tilemap_layer_with_an_explicit_warning() {
        let mut file = AsepriteFile::new(4, 4, AseColorMode::Rgba);
        let tileset = aseprite::Tileset {
            id: 0,
            flags: aseprite::TilesetFlags(2),
            name: "Tiles".into(),
            tile_count: 1,
            tile_width: 2,
            tile_height: 2,
            base_index: 0,
            data: aseprite::TilesetData::Embedded {
                pixels: vec![0u8; 2 * 2 * 4],
                original_compressed: None,
            },
            user_data: None,
            tile_user_data: vec![None],
        };
        file.add_tileset(tileset);
        let _tilemap_layer = file.add_tilemap_layer("Ground", 0);
        let _frame = file.add_frame(100);

        let mut bytes = Vec::new();
        file.write_to(&mut bytes).unwrap();
        let reopened = AsepriteFile::from_reader(&bytes[..]).unwrap();

        let staging = Staging::default();
        let (sprite, cels, warnings) = convert(&reopened, &staging);

        assert!(sprite.layers.is_empty());
        assert!(cels.is_empty());
        assert!(warnings.iter().any(|w| w.contains("tilemap")));
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
        let (sprite, _cels, _warnings) = convert(&reopened, &staging);

        let base = sprite.layers[0].base();
        assert!(!base.visible);
        assert!(base.locked);
        assert!((base.opacity - 128.0 / 255.0).abs() < 1e-6);
    }
}
