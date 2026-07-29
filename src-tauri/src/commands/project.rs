//! `.tess` save / load (`docs/03-data-model.md` §7, locked by D3).
//!
//! ```text
//! project.tess
//! ├── manifest.json      format version, app version, sprite metadata
//! ├── sprite.json        layers, frames, cels, palette — no pixels
//! ├── cels/<celId>.png   raster cels, compressed and inspectable
//! ├── sources/           original imported images (Phase 2)
//! └── thumbnail.png      256×256 preview for file browsers
//! ```
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
use crate::model::document::{ColorMode, Sprite};
use crate::staging::Staging;

/// Bumped when the archive layout changes in a way older readers cannot handle.
pub const FORMAT_VERSION: u32 = 1;

pub const MANIFEST: &str = "manifest.json";
pub const SPRITE: &str = "sprite.json";
pub const THUMBNAIL: &str = "thumbnail.png";
pub const CEL_DIR: &str = "cels/";

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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CelUpload {
    pub cel_id: String,
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
pub struct LoadResult {
    pub path: String,
    pub format_version: u32,
    pub sprite: Sprite,
    pub cels: Vec<LoadedCel>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------

fn cel_path(cel_id: &str) -> String {
    format!("{CEL_DIR}{cel_id}.png")
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
    if request.sprite.color_mode != ColorMode::Rgba {
        return Err(AppError::invalid(
            "v1 writes RGBA documents only (docs/10-decisions.md D9)",
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

    let mut owned: HashSet<String> = HashSet::new();
    owned.insert(MANIFEST.to_string());
    owned.insert(SPRITE.to_string());
    owned.insert(THUMBNAIL.to_string());
    for cel in &request.cels {
        owned.insert(cel_path(&cel.cel_id));
    }

    // Anything a newer build wrote that this one does not understand.
    let mut preserved = Vec::new();
    if let Some(from) = &request.preserve_from {
        if let Ok(file) = File::open(from) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i)?;
                    let name = entry.name().to_string();
                    if entry.is_dir() || owned.contains(&name) || name.starts_with(CEL_DIR) {
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
        let rgba = staging.get(cel.stage_id)?;
        let png = encode_rgba_png(&rgba, cel.width, cel.height)?;
        // PNG is already deflated; a second pass costs time and saves nothing.
        zip.start_file(cel_path(&cel.cel_id), stored)?;
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

    if sprite.color_mode != ColorMode::Rgba {
        return Err(AppError::invalid(
            "v1 opens RGBA documents only (docs/10-decisions.md D9)",
        ));
    }

    let mut cels = Vec::new();
    let mut warnings = Vec::new();

    for cel in &sprite.cels {
        // A linked cel (`docs/03-data-model.md` §2.2) shares another cel's
        // pixels and never had its own `cels/<id>.png` written — nothing to
        // load, and no warning either, since that is the expected shape.
        if cel.linked_to.is_some() {
            continue;
        }
        let name = cel_path(&cel.id);
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

    Ok(LoadResult {
        path: path.to_string(),
        format_version: manifest.format_version,
        sprite,
        cels,
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
}
