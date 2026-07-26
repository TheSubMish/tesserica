//! Document metadata, mirroring `src/model/types.ts`.
//!
//! Deliberately typed rather than passed through as opaque JSON: parsing the
//! document on load is what turns a corrupt or future `.tess` into a clear
//! error message instead of a broken canvas.
//!
//! D9 — v1 is RGBA only. `ColorMode` keeps the other variants so Phase 7 is an
//! extension rather than a migration, but nothing reads or writes them, and
//! `save`/`load` reject anything but `rgba` rather than pretending.

use serde::{Deserialize, Serialize};

pub type LayerId = String;
pub type FrameId = String;
pub type CelId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode {
    Rgba,
    /// Phase 7 (D9). Present in the type, implemented nowhere.
    Indexed,
    Grayscale,
}

impl Default for ColorMode {
    fn default() -> Self {
        Self::Rgba
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    Normal,
}

pub type Rgba = [u8; 4];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerBase {
    pub id: LayerId,
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    /// 0..1
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

/// The discriminated union from `docs/03-data-model.md` §2.1. Only `raster`
/// exists in v1; group / tilemap / conversion arrive with their phases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layer {
    Raster {
        #[serde(flatten)]
        base: LayerBase,
    },
}

impl Layer {
    pub fn base(&self) -> &LayerBase {
        match self {
            Layer::Raster { base } => base,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: FrameId,
    pub duration_ms: u32,
}

/// A cel is the content of one layer at one frame. Bounded — `x`/`y`/`width`/
/// `height` may be smaller than the sprite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cel {
    pub id: CelId,
    pub layer_id: LayerId,
    pub frame_id: FrameId,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub id: String,
    pub name: String,
    pub colors: Vec<Rgba>,
}

/// What `sprite.json` holds: everything except pixels.
///
/// The TS `Sprite` inlines its layers, frames and cels rather than holding id
/// lists with side tables, so this mirrors that shape — the point of the
/// mirror is that no translation layer exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprite {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub color_mode: ColorMode,
    pub layers: Vec<Layer>,
    pub frames: Vec<Frame>,
    pub cels: Vec<Cel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<Palette>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_round_trips_through_the_tagged_union() {
        // The JSON here is exactly what the TS side holds — a flat object with
        // a `kind` discriminant, no nesting.
        let json = r#"{
            "kind": "raster",
            "id": "l1",
            "name": "Layer 1",
            "visible": true,
            "locked": false,
            "opacity": 1.0,
            "blendMode": "normal"
        }"#;
        let layer: Layer = serde_json::from_str(json).unwrap();
        assert_eq!(layer.base().name, "Layer 1");

        let back: serde_json::Value = serde_json::to_value(&layer).unwrap();
        assert_eq!(back["kind"], "raster");
        assert_eq!(back["blendMode"], "normal");
        // Flattened, not nested under `base`.
        assert!(back.get("base").is_none());
    }

    #[test]
    fn sprite_defaults_to_rgba_when_the_field_is_absent() {
        let sprite: Sprite =
            serde_json::from_str(r#"{"width":8,"height":8,"layers":[],"frames":[],"cels":[]}"#)
                .unwrap();
        assert_eq!(sprite.color_mode, ColorMode::Rgba);
    }

    #[test]
    fn cel_fields_are_camel_case_on_the_wire() {
        let cel = Cel {
            id: "c1".into(),
            layer_id: "l1".into(),
            frame_id: "f1".into(),
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        };
        let json = serde_json::to_value(&cel).unwrap();
        assert!(json.get("layerId").is_some());
        assert!(json.get("layer_id").is_none());
    }
}
