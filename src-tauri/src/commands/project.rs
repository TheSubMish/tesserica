//! `.tess` save / load (`docs/03-data-model.md` §7, locked by D3).
//!
//! ```text
//! project.tess
//! ├── manifest.json         format version, app version, sprite metadata
//! ├── sprite.json           layers, frames, cels, tilesets, palette — no pixels
//! ├── cels/<celId>.png      raster cels, compressed and inspectable
//! ├── cels/<celId>.bin      tilemap cels, raw packed tile ids (§4)
//! ├── tiles/<tilesetId>/
//! │   └── <tileEntryId>.png one tile's RGBA pixels, roadmap Phase 6
//! ├── sources/              original imported images (Phase 2)
//! └── thumbnail.png         256×256 preview for file browsers
//! ```
//!
//! A tilemap layer's cel holds no RGBA pixels — its content is a flat array of
//! packed tile ids (`src/model/tileGridBuffers.ts`) — so it is written raw
//! rather than PNG-encoded, exactly as §7's own sketch already specified
//! ("indexed/tilemap cels as raw"). Rust never resolves a grid against a
//! tileset (it never composites layers at all — see `model::document::Layer`),
//! so both the cel bytes and each tile's own PNG are opaque payloads here:
//! staged, persisted, and handed back unchanged.
//!
//! ZIP-of-files rather than one binary blob because you can unzip it and look,
//! PNG gives compression for free, and a reader can pull the thumbnail without
//! parsing the document.
//!
//! **Forward compatibility is implemented, not just promised.** §7 requires
//! that "unknown files are preserved on round-trip, so an older build opening
//! a newer file does not destroy data it does not understand". `preserve_from`
//! is how: on save, every entry of the previously-opened archive that this
//! build does not itself write is copied across first. Without it, opening a
//! Phase 4 file in a Phase 1 build and pressing save would silently delete the
//! animation.
//!
//! Pixels never appear in a command argument. Cels arrive as staging handles
//! on save and leave as staging handles on load (`crate::staging`).

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::error::AppError;
use crate::model::document::{ColorMode, Layer, Sprite};
use crate::staging::Staging;

/// Bumped when the archive layout changes in a way older readers cannot handle.
pub const FORMAT_VERSION: u32 = 1;

pub const MANIFEST: &str = "manifest.json";
pub const SPRITE: &str = "sprite.json";
pub const THUMBNAIL: &str = "thumbnail.png";
pub const CEL_DIR: &str = "cels/";
/// Roadmap Phase 6 — one tile's RGBA pixels live at `tiles/<tilesetId>/<tileId>.png`.
pub const TILE_DIR: &str = "tiles/";

/// Longest edge of the thumbnail (`docs/03-data-model.md` §7).
const THUMB_SIZE: u32 = 256;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub app_version: String,
    pub width: u32,
    pub height: u32,
    pub layer_count: usize,
    pub frame_count: usize,
}

/// One cel's pixels, referenced by a staging handle rather than inlined.
///
/// `width`/`height` are pixel dimensions for a raster cel, but for a tilemap
/// cel (`docs/03-data-model.md` §4) or an indexed-mode raster cel
/// (`docs/08-roadmap.md` Phase 7) the bytes are an opaque, already-encoded
/// blob (packed tile ids, or palette indices) this side never validates
/// against them — see `cel_is_raw`, which is how `write_archive` decides
/// `.png` vs `.bin` per cel rather than trusting a redundant flag on the
/// upload itself.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CelUpload {
    pub cel_id: String,
    pub stage_id: u64,
    pub width: u32,
    pub height: u32,
}

/// One tile's RGBA pixels (roadmap Phase 6), referenced by a staging handle —
/// the tileset-level counterpart to `CelUpload`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileUpload {
    pub tileset_id: String,
    pub tile_id: String,
    pub stage_id: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectRequest {
    pub path: String,
    pub sprite: Sprite,
    pub cels: Vec<CelUpload>,
    /// Composited RGBA for the thumbnail, at document size.
    pub thumbnail: Option<CelUpload>,
    /// Every tile entry's own pixels, across every tileset in `sprite`.
    /// `#[serde(default)]` — a document with no tilesets sends none.
    #[serde(default)]
    pub tile_entries: Vec<TileUpload>,
    /// Path of the archive this document was opened from, if any. Unknown
    /// entries in it are carried over.
    #[serde(default)]
    pub preserve_from: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub bytes: u64,
    /// Entries carried over from a newer writer.
    pub preserved: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedCel {
    pub cel_id: String,
    pub stage_id: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTile {
    pub tileset_id: String,
    pub tile_id: String,
    pub stage_id: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub path: String,
    pub format_version: u32,
    pub sprite: Sprite,
    pub cels: Vec<LoadedCel>,
    pub tile_entries: Vec<LoadedTile>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------

/// A raster cel's PNG lives at `cels/<id>.png`; a raw cel (see `cel_is_raw`
/// below) lives at `cels/<id>.bin` instead (`docs/03-data-model.md` §7).
fn cel_path(cel_id: &str, raw: bool) -> String {
    if raw {
        format!("{CEL_DIR}{cel_id}.bin")
    } else {
        format!("{CEL_DIR}{cel_id}.png")
    }
}

fn tile_path(tileset_id: &str, tile_id: &str) -> String {
    format!("{TILE_DIR}{tileset_id}/{tile_id}.png")
}

/// Whether the cel belonging to `layer_id` is written raw (`.bin`) rather
/// than PNG-encoded — true for every tilemap cel (opaque packed tile ids
/// Rust never decodes) and, as of `docs/08-roadmap.md` Phase 7, every
/// `raster` cel in an `indexed`-mode sprite (opaque palette indices Rust
/// never resolves against a palette either — it never composites layers at
/// all, `docs/02-architecture.md` §6.2). A `conversion` layer's cel is the
/// one raster case that stays RGBA regardless of `sprite.color_mode`: its
/// pixels come from the RGBA conversion pipeline, and re-quantizing them
/// into the sprite's separate indexed palette is out of this dispatch's
/// scope (`docs/08-roadmap.md` Phase 7's own scope note, mirroring
/// `src/model/celStorage.ts` on the TS side).
fn cel_is_raw(sprite: &Sprite, layer_id: &str) -> bool {
    match sprite.layers.iter().find(|l| l.base().id == layer_id) {
        Some(Layer::Tilemap { .. }) => true,
        Some(Layer::Raster { .. }) => sprite.color_mode == ColorMode::Indexed,
        _ => false,
    }
}

fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(AppError::invalid(format!(
            "expected {expected} bytes for {width}x{height} RGBA, got {}",
            rgba.len()
        )));
    }
    super::export::encode_png(rgba, width, height)
}

/// Nearest-neighbour box fit into `THUMB_SIZE`, aspect preserved.
///
/// Point sampling rather than averaging: a thumbnail of pixel art that has
/// been smoothed misrepresents the file it is previewing.
pub fn make_thumbnail(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    if width == 0 || height == 0 {
        return Err(AppError::invalid("cannot thumbnail a zero-sized sprite"));
    }
    let mut out = vec![0u8; (THUMB_SIZE * THUMB_SIZE * 4) as usize];

    // Largest scale that fits, never enlarging beyond whole pixels.
    let scale = (THUMB_SIZE as f64 / width.max(height) as f64).max(f64::MIN_POSITIVE);
    let draw_w = ((width as f64 * scale).round() as u32).clamp(1, THUMB_SIZE);
    let draw_h = ((height as f64 * scale).round() as u32).clamp(1, THUMB_SIZE);
    let off_x = (THUMB_SIZE - draw_w) / 2;
    let off_y = (THUMB_SIZE - draw_h) / 2;

    for y in 0..draw_h {
        let sy = (y as u64 * height as u64 / draw_h as u64).min(height as u64 - 1) as u32;
        for x in 0..draw_w {
            let sx = (x as u64 * width as u64 / draw_w as u64).min(width as u64 - 1) as u32;
            let s = ((sy * width + sx) * 4) as usize;
            let d = (((y + off_y) * THUMB_SIZE + x + off_x) * 4) as usize;
            out[d..d + 4].copy_from_slice(&rgba[s..s + 4]);
        }
    }

    super::export::encode_png(&out, THUMB_SIZE, THUMB_SIZE)
}

fn write_archive(request: &SaveProjectRequest, staging: &Staging) -> Result<SaveResult, AppError> {
    if !matches!(
        request.sprite.color_mode,
        ColorMode::Rgba | ColorMode::Indexed
    ) {
        return Err(AppError::invalid(
            "unsupported color mode (docs/10-decisions.md D9)",
        ));
    }

    // Build the whole archive in memory, then write once. A half-written
    // `.tess` over the user's existing file is the worst possible outcome, and
    // this also lets `preserve_from` point at the file being overwritten.
    let mut buffer = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buffer);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Which cels are written raw (`.bin`) vs PNG-encoded — `cel_is_raw`
    // covers both tilemap cels and, as of Phase 7, indexed-mode raster cels
    // — purely from `sprite.layers`/`sprite.cels`, not a redundant flag on
    // the upload itself.
    let cel_layer_id: std::collections::HashMap<&str, &str> = request
        .sprite
        .cels
        .iter()
        .map(|c| (c.id.as_str(), c.layer_id.as_str()))
        .collect();
    let is_raw_cel = |cel_id: &str| -> bool {
        cel_layer_id
            .get(cel_id)
            .is_some_and(|layer_id| cel_is_raw(&request.sprite, layer_id))
    };

    let mut owned: HashSet<String> = HashSet::new();
    owned.insert(MANIFEST.to_string());
    owned.insert(SPRITE.to_string());
    owned.insert(THUMBNAIL.to_string());
    for cel in &request.cels {
        owned.insert(cel_path(&cel.cel_id, is_raw_cel(&cel.cel_id)));
    }
    for tile in &request.tile_entries {
        owned.insert(tile_path(&tile.tileset_id, &tile.tile_id));
    }

    // Anything a newer build wrote that this one does not understand. `cels/`
    // and `tiles/` are both owned prefixes this build always rewrites in full
    // from the current document, so a stale entry from a deleted cel/tile
    // must not survive here either.
    let mut preserved = Vec::new();
    if let Some(from) = &request.preserve_from {
        if let Ok(file) = File::open(from) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i)?;
                    let name = entry.name().to_string();
                    if entry.is_dir()
                        || owned.contains(&name)
                        || name.starts_with(CEL_DIR)
                        || name.starts_with(TILE_DIR)
                    {
                        continue;
                    }
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes)?;
                    zip.start_file(&name, deflated)?;
                    zip.write_all(&bytes)?;
                    preserved.push(name);
                }
            }
        }
    }

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        width: request.sprite.width,
        height: request.sprite.height,
        layer_count: request.sprite.layers.len(),
        frame_count: request.sprite.frames.len(),
    };
    zip.start_file(MANIFEST, deflated)?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;

    zip.start_file(SPRITE, deflated)?;
    zip.write_all(serde_json::to_string_pretty(&request.sprite)?.as_bytes())?;

    for cel in &request.cels {
        let bytes = staging.get(cel.stage_id)?;
        if is_raw_cel(&cel.cel_id) {
            // Raw bytes — packed tile ids or, for an indexed-mode raster
            // cel, palette indices. An opaque payload this side never
            // decodes either way, so no PNG encode and no RGBA length check.
            zip.start_file(cel_path(&cel.cel_id, true), deflated)?;
            zip.write_all(&bytes)?;
        } else {
            let png = encode_rgba_png(&bytes, cel.width, cel.height)?;
            // PNG is already deflated; a second pass costs time and saves nothing.
            zip.start_file(cel_path(&cel.cel_id, false), stored)?;
            zip.write_all(&png)?;
        }
    }

    for tile in &request.tile_entries {
        let rgba = staging.get(tile.stage_id)?;
        let png = encode_rgba_png(&rgba, tile.width, tile.height)?;
        zip.start_file(tile_path(&tile.tileset_id, &tile.tile_id), stored)?;
        zip.write_all(&png)?;
    }

    if let Some(thumb) = &request.thumbnail {
        let rgba = staging.get(thumb.stage_id)?;
        let png = make_thumbnail(&rgba, thumb.width, thumb.height)?;
        zip.start_file(THUMBNAIL, stored)?;
        zip.write_all(&png)?;
    }

    zip.finish()?;
    let bytes = buffer.into_inner();
    let len = bytes.len() as u64;
    std::fs::write(&request.path, bytes)?;

    Ok(SaveResult {
        path: request.path.clone(),
        bytes: len,
        preserved,
    })
}

fn read_archive(path: &str, staging: &Staging) -> Result<LoadResult, AppError> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::invalid(format!("{path} is not a .tess archive: {e}")))?;

    let manifest: Manifest = {
        let entry = archive
            .by_name(MANIFEST)
            .map_err(|_| AppError::invalid("archive has no manifest.json"))?;
        serde_json::from_reader(entry)?
    };

    // Refuse versions above what we know; migrate versions below (there are
    // none yet, but the branch is where they will go).
    if manifest.format_version > FORMAT_VERSION {
        return Err(AppError::invalid(format!(
            "this file was written by a newer version of Tesserica (format {} > {})",
            manifest.format_version, FORMAT_VERSION
        )));
    }

    let sprite: Sprite = {
        let entry = archive
            .by_name(SPRITE)
            .map_err(|_| AppError::invalid("archive has no sprite.json"))?;
        serde_json::from_reader(entry)?
    };

    if !matches!(sprite.color_mode, ColorMode::Rgba | ColorMode::Indexed) {
        return Err(AppError::invalid(
            "unsupported color mode (docs/10-decisions.md D9)",
        ));
    }

    let mut cels = Vec::new();
    let mut warnings = Vec::new();

    for cel in &sprite.cels {
        // A linked cel (`docs/03-data-model.md` §2.2) shares another cel's
        // pixels and never had its own `cels/<id>.png`/`.bin` written —
        // nothing to load, and no warning either, since that is the expected
        // shape.
        if cel.linked_to.is_some() {
            continue;
        }
        let is_raw = cel_is_raw(&sprite, cel.layer_id.as_str());
        let name = cel_path(&cel.id, is_raw);

        if is_raw {
            // Raw bytes — packed tile ids, or (Phase 7) an indexed-mode
            // raster cel's palette indices. Read and staged verbatim, no
            // image decode (`docs/03-data-model.md` §7's own "indexed/
            // tilemap cels as raw").
            let mut raw = Vec::new();
            match archive.by_name(&name) {
                Ok(mut entry) => entry.read_to_end(&mut raw)?,
                Err(_) => {
                    warnings.push(format!("missing {name}; layer opens empty"));
                    continue;
                }
            };
            cels.push(LoadedCel {
                cel_id: cel.id.clone(),
                stage_id: staging.put(raw),
                width: cel.width,
                height: cel.height,
            });
            continue;
        }

        let mut png = Vec::new();
        match archive.by_name(&name) {
            Ok(mut entry) => entry.read_to_end(&mut png)?,
            Err(_) => {
                // A missing cel is recoverable: the layer opens empty rather
                // than the whole document failing.
                warnings.push(format!("missing {name}; layer opens empty"));
                continue;
            }
        };

        let decoded =
            image::load_from_memory_with_format(&png, image::ImageFormat::Png)?.to_rgba8();
        let (w, h) = decoded.dimensions();
        if w != cel.width || h != cel.height {
            warnings.push(format!(
                "{name} is {w}x{h} but the document says {}x{}",
                cel.width, cel.height
            ));
        }
        cels.push(LoadedCel {
            cel_id: cel.id.clone(),
            stage_id: staging.put(decoded.into_raw()),
            width: w,
            height: h,
        });
    }

    let mut tile_entries = Vec::new();
    for tileset in &sprite.tilesets {
        for tile in &tileset.tiles {
            let name = tile_path(&tileset.id, &tile.id);
            let mut png = Vec::new();
            match archive.by_name(&name) {
                Ok(mut entry) => entry.read_to_end(&mut png)?,
                Err(_) => {
                    // A missing tile is recoverable the same way a missing
                    // cel is: the tileset entry survives with no pixels
                    // behind it rather than failing the whole document.
                    warnings.push(format!("missing {name}; tile is blank"));
                    continue;
                }
            };
            let decoded =
                image::load_from_memory_with_format(&png, image::ImageFormat::Png)?.to_rgba8();
            let (w, h) = decoded.dimensions();
            if w != tileset.tile_width || h != tileset.tile_height {
                warnings.push(format!(
                    "{name} is {w}x{h} but tileset {} says {}x{}",
                    tileset.id, tileset.tile_width, tileset.tile_height
                ));
            }
            tile_entries.push(LoadedTile {
                tileset_id: tileset.id.clone(),
                tile_id: tile.id.clone(),
                stage_id: staging.put(decoded.into_raw()),
                width: w,
                height: h,
            });
        }
    }

    Ok(LoadResult {
        path: path.to_string(),
        format_version: manifest.format_version,
        sprite,
        cels,
        tile_entries,
        warnings,
    })
}

#[tauri::command]
pub async fn save_project(
    request: SaveProjectRequest,
    staging: State<'_, Staging>,
) -> Result<SaveResult, AppError> {
    let result = write_archive(&request, &staging)?;
    for cel in &request.cels {
        staging.release(cel.stage_id);
    }
    for tile in &request.tile_entries {
        staging.release(tile.stage_id);
    }
    if let Some(thumb) = &request.thumbnail {
        staging.release(thumb.stage_id);
    }
    Ok(result)
}

#[tauri::command]
pub async fn load_project(
    path: String,
    staging: State<'_, Staging>,
) -> Result<LoadResult, AppError> {
    read_archive(&path, &staging)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::document::{BlendMode, Cel, Frame, Layer, LayerBase};

    fn sprite() -> Sprite {
        Sprite {
            width: 2,
            height: 2,
            color_mode: ColorMode::Rgba,
            layers: vec![Layer::Raster {
                base: LayerBase {
                    id: "l1".into(),
                    name: "Layer 1".into(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                    parent_id: None,
                    clipping_mask: false,
                    effects: vec![],
                },
            }],
            frames: vec![Frame {
                id: "f1".into(),
                duration_ms: 100,
            }],
            cels: vec![Cel {
                id: "c1".into(),
                layer_id: "l1".into(),
                frame_id: "f1".into(),
                x: 0,
                y: 0,
                width: 2,
                height: 2,
                linked_to: None,
            }],
            palette: None,
            tags: vec![],
            tilesets: vec![],
        }
    }

    /// 2×2: red, transparent-carrying-green, blue, half-transparent white.
    fn pixels() -> Vec<u8> {
        vec![
            255, 0, 0, 255, //
            0, 255, 0, 0, //
            0, 0, 255, 255, //
            255, 255, 255, 128,
        ]
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("tesserica-test-{}-{name}", std::process::id()));
        p
    }

    fn save_to(path: &std::path::Path, staging: &Staging, preserve_from: Option<String>) {
        let stage_id = staging.put(pixels());
        let thumb_id = staging.put(pixels());
        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: sprite(),
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: Some(CelUpload {
                cel_id: "thumb".into(),
                stage_id: thumb_id,
                width: 2,
                height: 2,
            }),
            tile_entries: vec![],
            preserve_from,
        };
        write_archive(&request, staging).unwrap();
    }

    fn entry_names(path: &std::path::Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn writes_the_documented_archive_layout() {
        let path = temp_path("layout.tess");
        let staging = Staging::default();
        save_to(&path, &staging, None);

        let names = entry_names(&path);
        assert!(names.contains(&MANIFEST.to_string()));
        assert!(names.contains(&SPRITE.to_string()));
        assert!(names.contains(&THUMBNAIL.to_string()));
        assert!(names.contains(&"cels/c1.png".to_string()));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trips_pixels_exactly_including_straight_alpha() {
        let path = temp_path("roundtrip.tess");
        let staging = Staging::default();
        save_to(&path, &staging, None);

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert_eq!(loaded.format_version, FORMAT_VERSION);
        assert_eq!(loaded.sprite.width, 2);
        assert_eq!(loaded.cels.len(), 1);
        assert!(loaded.warnings.is_empty());

        // PNG stores unassociated alpha, so the transparent pixel keeps its
        // green and the half-transparent one keeps full-strength white.
        // Premultiplying anywhere on this path would zero the first and dim
        // the second.
        let bytes = staging.take(loaded.cels[0].stage_id).unwrap();
        assert_eq!(bytes, pixels());

        std::fs::remove_file(&path).ok();
    }

    /// Phase 4's "Tags with preset names" — a tag round-trips through
    /// `sprite.json` alongside layers/frames/cels, exactly like any other
    /// piece of `Sprite` metadata.
    #[test]
    fn round_trips_tags_through_sprite_json() {
        use crate::model::document::{Tag, TagDirection};

        let path = temp_path("tags-roundtrip.tess");
        let staging = Staging::default();
        let stage_id = staging.put(pixels());
        let thumb_id = staging.put(pixels());
        let mut with_tag = sprite();
        with_tag.tags = vec![Tag {
            id: "t1".into(),
            name: "walk".into(),
            from: 0,
            to: 1,
            direction: TagDirection::Pingpong,
            repeat: Some(2),
            color: "#4d9de0".into(),
        }];

        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: with_tag,
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: Some(CelUpload {
                cel_id: "thumb".into(),
                stage_id: thumb_id,
                width: 2,
                height: 2,
            }),
            tile_entries: vec![],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert_eq!(loaded.sprite.tags.len(), 1);
        assert_eq!(loaded.sprite.tags[0].name, "walk");
        assert_eq!(loaded.sprite.tags[0].from, 0);
        assert_eq!(loaded.sprite.tags[0].to, 1);
        assert_eq!(loaded.sprite.tags[0].direction, TagDirection::Pingpong);
        assert_eq!(loaded.sprite.tags[0].repeat, Some(2));

        std::fs::remove_file(&path).ok();
    }

    /// A sprite saved with no tags at all opens with an empty tag list rather
    /// than erroring — the archive-level counterpart to
    /// `document::tests::sprite_defaults_tags_to_empty_when_the_field_is_absent`,
    /// which checks the same default at the raw-JSON level.
    #[test]
    fn loads_a_pre_tags_tess_with_an_empty_tag_list() {
        let path = temp_path("no-tags.tess");
        let staging = Staging::default();
        save_to(&path, &staging, None);

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert!(loaded.sprite.tags.is_empty());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn preserves_entries_a_newer_writer_left_behind() {
        // docs/03-data-model.md §7: an older build opening a newer file must
        // not destroy what it does not understand.
        let original = temp_path("preserve-src.tess");
        let staging = Staging::default();
        save_to(&original, &staging, None);

        // Splice in a file this build knows nothing about.
        {
            let existing = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
            let mut out = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(&mut out);
            zip.merge_archive(existing).unwrap();
            zip.start_file("timeline.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(br#"{"tags":[]}"#).unwrap();
            zip.finish().unwrap();
            std::fs::write(&original, out.into_inner()).unwrap();
        }

        let resaved = temp_path("preserve-dst.tess");
        save_to(
            &resaved,
            &staging,
            Some(original.to_string_lossy().into_owned()),
        );

        assert!(entry_names(&resaved).contains(&"timeline.json".to_string()));

        std::fs::remove_file(&original).ok();
        std::fs::remove_file(&resaved).ok();
    }

    #[test]
    fn refuses_a_file_from_a_newer_format() {
        let path = temp_path("future.tess");
        {
            let mut out = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(&mut out);
            zip.start_file(MANIFEST, SimpleFileOptions::default())
                .unwrap();
            let manifest = Manifest {
                format_version: FORMAT_VERSION + 1,
                app_version: "9.9.9".into(),
                width: 1,
                height: 1,
                layer_count: 0,
                frame_count: 0,
            };
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
            std::fs::write(&path, out.into_inner()).unwrap();
        }

        let staging = Staging::default();
        let err = read_archive(&path.to_string_lossy(), &staging).unwrap_err();
        assert!(err.to_string().contains("newer version"));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_something_that_is_not_an_archive() {
        let path = temp_path("garbage.tess");
        std::fs::write(&path, b"not a zip").unwrap();
        let staging = Staging::default();
        assert!(read_archive(&path.to_string_lossy(), &staging).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_missing_cel_warns_rather_than_failing_the_whole_document() {
        let path = temp_path("missing-cel.tess");
        {
            let mut out = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(&mut out);
            let manifest = Manifest {
                format_version: FORMAT_VERSION,
                app_version: "0.1.0".into(),
                width: 2,
                height: 2,
                layer_count: 1,
                frame_count: 1,
            };
            zip.start_file(MANIFEST, SimpleFileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
                .unwrap();
            zip.start_file(SPRITE, SimpleFileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&sprite()).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
            std::fs::write(&path, out.into_inner()).unwrap();
        }

        let staging = Staging::default();
        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert!(loaded.cels.is_empty());
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.sprite.layers.len() == 1);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn thumbnail_is_256_square_and_letterboxed() {
        let png = make_thumbnail(&pixels(), 2, 2).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (256, 256));
        // Square source fills the frame, so the top-left is the red pixel.
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    /// A linked cel (`docs/03-data-model.md` §2.2) shares another cel's
    /// pixels: it must not get its own `cels/<id>.png` on save, and loading it
    /// back must neither warn about a missing file nor try to stage one.
    #[test]
    fn a_linked_cel_needs_no_png_of_its_own_and_loads_without_warning() {
        let path = temp_path("linked-cel.tess");
        let staging = Staging::default();

        let mut doc = sprite();
        doc.frames.push(Frame {
            id: "f2".into(),
            duration_ms: 100,
        });
        doc.cels.push(Cel {
            id: "c2".into(),
            layer_id: "l1".into(),
            frame_id: "f2".into(),
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            linked_to: Some("c1".into()),
        });

        let stage_id = staging.put(pixels());
        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: doc,
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let names = entry_names(&path);
        assert!(names.contains(&"cels/c1.png".to_string()));
        assert!(!names.contains(&"cels/c2.png".to_string()));

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert!(loaded.warnings.is_empty());
        assert_eq!(loaded.cels.len(), 1);
        assert_eq!(loaded.cels[0].cel_id, "c1");
        assert_eq!(
            loaded
                .sprite
                .cels
                .iter()
                .find(|c| c.id == "c2")
                .unwrap()
                .linked_to
                .as_deref(),
            Some("c1")
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn thumbnail_never_averages_pixels() {
        // Two distinct colours in, exactly two distinct colours out.
        let png = make_thumbnail(&[255, 0, 0, 255, 0, 0, 255, 255], 2, 1).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        let mut seen = std::collections::BTreeSet::new();
        for p in img.pixels() {
            if p.0[3] != 0 {
                seen.insert(p.0);
            }
        }
        assert_eq!(seen.len(), 2);
    }

    // -- Roadmap Phase 6 "Tileset model, tilemap layers, rect grid" ----------
    // A tileset's tile pixels are PNGs under `tiles/<tilesetId>/`; a tilemap
    // layer's cel is raw packed tile ids under `cels/<id>.bin`, never a PNG.

    use crate::model::document::{GridShape, GridSpec, Tileset};

    fn tileset_and_tilemap_sprite() -> Sprite {
        Sprite {
            width: 4,
            height: 4,
            color_mode: ColorMode::Rgba,
            layers: vec![Layer::Tilemap {
                base: LayerBase {
                    id: "tm1".into(),
                    name: "Ground".into(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                    parent_id: None,
                    clipping_mask: false,
                    effects: vec![],
                },
                tileset_id: "ts1".into(),
                grid: GridSpec {
                    shape: GridShape::Rect,
                    tile_width: 2,
                    tile_height: 2,
                    offset_x: 0,
                    offset_y: 0,
                },
            }],
            frames: vec![Frame {
                id: "f1".into(),
                duration_ms: 100,
            }],
            cels: vec![Cel {
                id: "cel-tm".into(),
                layer_id: "tm1".into(),
                frame_id: "f1".into(),
                x: 0,
                y: 0,
                width: 4,
                height: 4,
                linked_to: None,
            }],
            palette: None,
            tags: vec![],
            tilesets: vec![Tileset {
                id: "ts1".into(),
                name: "Ground".into(),
                tile_width: 2,
                tile_height: 2,
                tiles: vec![
                    crate::model::document::TileEntry { id: "empty".into() },
                    crate::model::document::TileEntry { id: "grass".into() },
                ],
            }],
        }
    }

    /// A 2×2 grid (4 cells) of packed `u32` tile ids, little-endian bytes —
    /// the same wire shape `Uint32Array.buffer` on the TS side produces.
    fn packed_grid_bytes(ids: &[u32]) -> Vec<u8> {
        ids.iter().flat_map(|id| id.to_le_bytes()).collect()
    }

    #[test]
    fn writes_a_tilemap_cel_as_raw_bin_not_png_and_tile_entries_as_png() {
        let path = temp_path("tilemap-layout.tess");
        let staging = Staging::default();

        let grid_id = staging.put(packed_grid_bytes(&[0, 1, 1, 0]));
        let tile_id = staging.put(pixels()); // reuse the 2x2 RGBA fixture

        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: tileset_and_tilemap_sprite(),
            cels: vec![CelUpload {
                cel_id: "cel-tm".into(),
                stage_id: grid_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![TileUpload {
                tileset_id: "ts1".into(),
                tile_id: "grass".into(),
                stage_id: tile_id,
                width: 2,
                height: 2,
            }],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let names = entry_names(&path);
        assert!(names.contains(&"cels/cel-tm.bin".to_string()));
        assert!(!names.contains(&"cels/cel-tm.png".to_string()));
        assert!(names.contains(&"tiles/ts1/grass.png".to_string()));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trips_a_tileset_and_a_populated_tilemap_layer() {
        let path = temp_path("tilemap-roundtrip.tess");
        let staging = Staging::default();

        let grid_bytes = packed_grid_bytes(&[0, 1, 1, 0]);
        let grid_id = staging.put(grid_bytes.clone());
        let tile_pixels = pixels();
        let tile_id = staging.put(tile_pixels.clone());
        // Index 0, the mandatory empty tile, also has a real (transparent)
        // buffer in the live app (`model/tilesets.ts::createTileset`) — upload
        // it too so this round trip has no missing-tile warning.
        let empty_id = staging.put(vec![0u8; 2 * 2 * 4]);

        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: tileset_and_tilemap_sprite(),
            cels: vec![CelUpload {
                cel_id: "cel-tm".into(),
                stage_id: grid_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![
                TileUpload {
                    tileset_id: "ts1".into(),
                    tile_id: "empty".into(),
                    stage_id: empty_id,
                    width: 2,
                    height: 2,
                },
                TileUpload {
                    tileset_id: "ts1".into(),
                    tile_id: "grass".into(),
                    stage_id: tile_id,
                    width: 2,
                    height: 2,
                },
            ],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert!(loaded.warnings.is_empty());

        // The sprite's own tileset metadata round-trips.
        assert_eq!(loaded.sprite.tilesets.len(), 1);
        assert_eq!(loaded.sprite.tilesets[0].tiles.len(), 2);

        // The tilemap cel's grid bytes round-trip byte-for-byte — raw, not
        // reinterpreted as RGBA anywhere on this side.
        assert_eq!(loaded.cels.len(), 1);
        assert_eq!(loaded.cels[0].cel_id, "cel-tm");
        let loaded_grid = staging.take(loaded.cels[0].stage_id).unwrap();
        assert_eq!(loaded_grid, grid_bytes);

        // Both tiles' own pixels round-trip too (through PNG, so exact for
        // this fully-opaque-or-transparent-preserving fixture).
        assert_eq!(loaded.tile_entries.len(), 2);
        let grass = loaded
            .tile_entries
            .iter()
            .find(|t| t.tile_id == "grass")
            .expect("grass tile present");
        assert_eq!(grass.tileset_id, "ts1");
        let loaded_tile = staging.take(grass.stage_id).unwrap();
        assert_eq!(loaded_tile, tile_pixels);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_missing_tile_png_warns_rather_than_failing_the_whole_document() {
        let path = temp_path("missing-tile.tess");
        let staging = Staging::default();

        let grid_id = staging.put(packed_grid_bytes(&[0, 0, 0, 0]));
        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: tileset_and_tilemap_sprite(),
            cels: vec![CelUpload {
                cel_id: "cel-tm".into(),
                stage_id: grid_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            // Deliberately omit the "grass" tile's own upload — only "empty"
            // would be missing anyway, but neither tile is uploaded here.
            tile_entries: vec![],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert!(loaded.tile_entries.is_empty());
        assert_eq!(loaded.warnings.len(), 2); // both "empty" and "grass" missing
        assert!(loaded
            .warnings
            .iter()
            .any(|w| w.contains("tiles/ts1/empty.png")));
        assert!(loaded
            .warnings
            .iter()
            .any(|w| w.contains("tiles/ts1/grass.png")));
        // The tileset metadata itself still loads intact.
        assert_eq!(loaded.sprite.tilesets[0].tiles.len(), 2);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn stale_tile_and_cel_entries_are_not_preserved_across_a_resave() {
        // `cels/`/`tiles/` are owned prefixes this build always rewrites in
        // full — a tile or cel dropped from the document must not survive a
        // resave just because it was in the archive being opened from.
        let original = temp_path("tile-preserve-src.tess");
        let staging = Staging::default();

        let grid_id = staging.put(packed_grid_bytes(&[0, 1, 1, 0]));
        let tile_id = staging.put(pixels());
        let request = SaveProjectRequest {
            path: original.to_string_lossy().into_owned(),
            sprite: tileset_and_tilemap_sprite(),
            cels: vec![CelUpload {
                cel_id: "cel-tm".into(),
                stage_id: grid_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![TileUpload {
                tileset_id: "ts1".into(),
                tile_id: "grass".into(),
                stage_id: tile_id,
                width: 2,
                height: 2,
            }],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();
        assert!(entry_names(&original).contains(&"tiles/ts1/grass.png".to_string()));

        // Resave with the tileset (and its tile) removed entirely.
        let resaved = temp_path("tile-preserve-dst.tess");
        let mut without_tileset = sprite();
        without_tileset.tilesets = vec![];
        let stage_id = staging.put(pixels());
        let request2 = SaveProjectRequest {
            path: resaved.to_string_lossy().into_owned(),
            sprite: without_tileset,
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![],
            preserve_from: Some(original.to_string_lossy().into_owned()),
        };
        write_archive(&request2, &staging).unwrap();

        let names = entry_names(&resaved);
        assert!(!names.contains(&"tiles/ts1/grass.png".to_string()));
        assert!(!names.contains(&"cels/cel-tm.bin".to_string()));

        std::fs::remove_file(&original).ok();
        std::fs::remove_file(&resaved).ok();
    }

    // -----------------------------------------------------------------
    // Indexed color mode (`docs/08-roadmap.md` Phase 7, `docs/10-decisions.md`
    // D9). Rust never resolves an index against a palette (it never
    // composites layers at all), so these tests are only about the wire
    // shape: raw bytes in, the identical raw bytes out, `.bin` not `.png`.
    // -----------------------------------------------------------------

    use crate::model::document::Palette;

    fn indexed_sprite() -> Sprite {
        let mut s = sprite();
        s.color_mode = ColorMode::Indexed;
        s.palette = Some(Palette {
            id: "p1".into(),
            name: "Test".into(),
            colors: vec![[255, 0, 0, 255], [0, 255, 0, 255]],
        });
        s
    }

    #[test]
    fn writes_an_indexed_raster_cel_as_raw_bin_not_png() {
        let path = temp_path("indexed-layout.tess");
        let staging = Staging::default();
        // One byte per pixel — a 2x2 cel is 4 raw index bytes, not 16 RGBA ones.
        let stage_id = staging.put(vec![1u8, 2, 0, 1]);

        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: indexed_sprite(),
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let names = entry_names(&path);
        assert!(names.contains(&"cels/c1.bin".to_string()));
        assert!(!names.contains(&"cels/c1.png".to_string()));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trips_indexed_cel_bytes_and_the_sprite_palette_exactly() {
        let path = temp_path("indexed-roundtrip.tess");
        let staging = Staging::default();
        let raw_indices = vec![1u8, 2, 0, 1];
        let stage_id = staging.put(raw_indices.clone());

        let request = SaveProjectRequest {
            path: path.to_string_lossy().into_owned(),
            sprite: indexed_sprite(),
            cels: vec![CelUpload {
                cel_id: "c1".into(),
                stage_id,
                width: 2,
                height: 2,
            }],
            thumbnail: None,
            tile_entries: vec![],
            preserve_from: None,
        };
        write_archive(&request, &staging).unwrap();

        let loaded = read_archive(&path.to_string_lossy(), &staging).unwrap();
        assert_eq!(loaded.sprite.color_mode, ColorMode::Indexed);
        assert_eq!(
            loaded.sprite.palette.as_ref().unwrap().colors,
            vec![[255, 0, 0, 255], [0, 255, 0, 255]]
        );
        assert!(loaded.warnings.is_empty());

        // Bytes come back byte-for-byte — no PNG encode/decode ever touched
        // them, unlike the RGBA path (`round_trips_pixels_exactly_including_
        // straight_alpha` above).
        let bytes = staging.take(loaded.cels[0].stage_id).unwrap();
        assert_eq!(bytes, raw_indices);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_conversion_layer_cel_stays_png_even_in_an_indexed_sprite() {
        // Scope decision (`model/celStorage.ts` on the TS side, mirrored
        // here): a conversion layer's pixels come from the RGBA conversion
        // pipeline regardless of the sprite's own colorMode.
        let mut s = indexed_sprite();
        s.layers = vec![Layer::Conversion {
            base: LayerBase {
                id: "l1".into(),
                name: "Layer 1".into(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
                parent_id: None,
                clipping_mask: false,
                effects: vec![],
            },
            source: crate::model::document::ConversionSource {
                source_id: 1,
                settings: crate::pipeline::settings::ConvertSettings::new(
                    2,
                    2,
                    crate::pipeline::settings::PaletteSpec::Fixed {
                        colors: vec![[0, 0, 0, 255]],
                    },
                ),
            },
        }];

        assert!(!cel_is_raw(&s, "l1"));
    }
}
