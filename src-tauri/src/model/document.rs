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

use crate::pipeline::settings::ConvertSettings;

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

/// `docs/03-data-model.md` §2.1 — the full W3C Compositing/Blending set.
///
/// Rust never composites layers itself (export flattens in TS, `docs/02` §6.2 —
/// pixel buffers never cross IPC, and the flattened bytes are what Rust
/// receives), so this enum exists purely so a `.tess` with a non-`normal`
/// blend mode round-trips instead of failing to deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
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
    /// `docs/03-data-model.md` §2.1 — groups nest via this pointer into the
    /// same flat `layers` array rather than a separate tree structure.
    /// `#[serde(default)]` so a `.tess` saved before Phase 3 (no groups)
    /// still loads: an absent field means "top level", same as an explicit
    /// `null`.
    #[serde(default)]
    pub parent_id: Option<LayerId>,
    /// "Clip to layer below". Rust never composites layers (see `Layer`'s own
    /// doc comment), so this — like `BlendMode` — only has to round-trip.
    #[serde(default)]
    pub clipping_mask: bool,
}

/// What makes convert→edit continuous (`docs/03-data-model.md` §2.1).
///
/// The layer keeps a handle to the full-resolution image Rust still holds, plus
/// the settings that produced its pixels — so changing the palette weeks later
/// re-renders it, rather than requiring the user to start again from the photo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionSource {
    /// Handle to the full-res image held in Rust (`docs/02` §6.2).
    ///
    /// A handle is process-local, so a reopened `.tess` will not have a live
    /// one. The settings survive regardless, which is what makes the layer
    /// re-editable once its source is re-attached.
    pub source_id: u64,
    pub settings: ConvertSettings,
}

/// The discriminated union from `docs/03-data-model.md` §2.1.
///
/// Tilemap arrives with its phase (6); `conversion` is here because it is the
/// product thesis. `Group` lands in Phase 3 alongside clipping masks —
/// compositing a group (rendering its children onto an intermediate buffer,
/// then treating that as one layer) happens entirely in TS
/// (`canvas/renderer.ts`, `canvas/flatten.ts`); Rust never composites layers
/// at all (`docs/02-architecture.md` §6.2 — pixel buffers never cross IPC, so
/// there is nothing here for Rust to composite *with*), so this variant only
/// has to round-trip through a `.tess` faithfully.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layer {
    Raster {
        #[serde(flatten)]
        base: LayerBase,
    },
    Group {
        #[serde(flatten)]
        base: LayerBase,
        collapsed: bool,
    },
    Conversion {
        #[serde(flatten)]
        base: LayerBase,
        source: ConversionSource,
    },
}

impl Layer {
    pub fn base(&self) -> &LayerBase {
        match self {
            Layer::Raster { base } => base,
            Layer::Group { base, .. } => base,
            Layer::Conversion { base, .. } => base,
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
///
/// `linked_to` (`docs/03-data-model.md` §2.2) marks this cel as sharing
/// another cel's pixels rather than owning its own — always another cel on
/// the same `layer_id`, at a different `frame_id`. Rust only has to round-trip
/// the pointer: pixel buffers never cross IPC (`docs/02-architecture.md`
/// §6.2), so nothing here resolves the link, and `commands::project` skips
/// writing or reading a `cels/<id>.png` for a cel that has one.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_to: Option<CelId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub id: String,
    pub name: String,
    pub colors: Vec<Rgba>,
}

/// `docs/03-data-model.md` §2.3 — a named, inclusive range of frame indices.
/// Mirrors `src/model/types.ts::Tag` field for field, including the `id` that
/// the doc's own sketch omits (see that file's comment: every other
/// collection here is addressed by id, and this keeps rename/undo
/// unambiguous even between two same-named tags).
///
/// Rust never schedules playback — it only has to round-trip a tag through
/// `.tess` faithfully, the same division of labour as `BlendMode` and the
/// `Group`/`Conversion` layer variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagDirection {
    Forward,
    Reverse,
    Pingpong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub from: u32,
    pub to: u32,
    pub direction: TagDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u32>,
    pub color: String,
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
    /// `#[serde(default)]` — a `.tess` saved before tags existed has no such
    /// field on the wire; it round-trips as an empty list rather than
    /// refusing to load.
    #[serde(default)]
    pub tags: Vec<Tag>,
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
            linked_to: None,
        };
        let json = serde_json::to_value(&cel).unwrap();
        assert!(json.get("layerId").is_some());
        assert!(json.get("layer_id").is_none());
    }

    /// A cel without `linkedTo` at all (every `.tess` saved before Phase 4)
    /// must still deserialize — `linked_to` defaults to `None`, i.e. "owns its
    /// own pixels", exactly like the field being explicitly absent today.
    #[test]
    fn linked_to_defaults_to_none_when_absent() {
        let json = serde_json::json!({
            "id": "c1", "layerId": "l1", "frameId": "f1",
            "x": 0, "y": 0, "width": 4, "height": 4
        });
        let cel: Cel = serde_json::from_value(json).unwrap();
        assert_eq!(cel.linked_to, None);
    }

    /// A linked cel round-trips its target and is omitted from the wire form
    /// when absent, matching `parent_id`'s "only present when it means
    /// something" convention closely enough that a hand-written `.tess`
    /// reader does not have to special-case an explicit `null`.
    #[test]
    fn linked_to_round_trips_when_present() {
        let cel = Cel {
            id: "c2".into(),
            layer_id: "l1".into(),
            frame_id: "f2".into(),
            x: 0,
            y: 0,
            width: 4,
            height: 4,
            linked_to: Some("c1".into()),
        };
        let json = serde_json::to_value(&cel).unwrap();
        assert_eq!(json["linkedTo"], "c1");
        let back: Cel = serde_json::from_value(json).unwrap();
        assert_eq!(back.linked_to.as_deref(), Some("c1"));
    }

    /// The conversion layer has to survive a `.tess` round trip with its
    /// settings intact — that is what "re-editable weeks later" means in
    /// practice (`docs/03-data-model.md` §2.1).
    #[test]
    fn a_conversion_layer_round_trips_with_its_settings() {
        use crate::pipeline::settings::{ConvertSettings, DitherMode, PaletteSpec};

        let mut settings = ConvertSettings::new(
            64,
            48,
            PaletteSpec::Fixed {
                colors: vec![[0, 0, 0, 255], [255, 255, 255, 255]],
            },
        );
        settings.dither = DitherMode::Atkinson;
        settings.brightness = 0.25;

        let layer = Layer::Conversion {
            base: LayerBase {
                id: "l1".into(),
                name: "photo.jpg".into(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
                parent_id: None,
                clipping_mask: false,
            },
            source: ConversionSource {
                source_id: 42,
                settings,
            },
        };

        let json = serde_json::to_value(&layer).expect("serializes");
        assert_eq!(json["kind"], "conversion");
        // `base` is flattened, so the layer is one object with a `kind`
        // discriminant — the same shape the TypeScript union has.
        assert_eq!(json["name"], "photo.jpg");
        assert_eq!(json["source"]["sourceId"], 42);
        assert_eq!(json["source"]["settings"]["dither"], "atkinson");

        let back: Layer = serde_json::from_value(json).expect("deserializes");
        match back {
            Layer::Conversion { base, source } => {
                assert_eq!(base.id, "l1");
                assert_eq!(source.source_id, 42);
                assert_eq!(source.settings.dither, DitherMode::Atkinson);
                assert_eq!(source.settings.brightness, 0.25);
                assert_eq!(source.settings.target_width, 64);
            }
            other => panic!("expected a conversion layer, got {other:?}"),
        }
    }

    /// Phase 3 added fifteen blend modes beyond `normal`; a `.tess` saved with
    /// one selected must still load, not just fail loudly.
    #[test]
    fn every_blend_mode_round_trips_kebab_case() {
        let cases = [
            (BlendMode::Normal, "normal"),
            (BlendMode::Multiply, "multiply"),
            (BlendMode::Screen, "screen"),
            (BlendMode::Overlay, "overlay"),
            (BlendMode::Darken, "darken"),
            (BlendMode::Lighten, "lighten"),
            (BlendMode::ColorDodge, "color-dodge"),
            (BlendMode::ColorBurn, "color-burn"),
            (BlendMode::HardLight, "hard-light"),
            (BlendMode::SoftLight, "soft-light"),
            (BlendMode::Difference, "difference"),
            (BlendMode::Exclusion, "exclusion"),
            (BlendMode::Hue, "hue"),
            (BlendMode::Saturation, "saturation"),
            (BlendMode::Color, "color"),
            (BlendMode::Luminosity, "luminosity"),
        ];
        for (mode, wire) in cases {
            let json = serde_json::to_value(mode).unwrap();
            assert_eq!(json, wire);
            let back: BlendMode = serde_json::from_value(json).unwrap();
            assert_eq!(back, mode);
        }
    }

    #[test]
    fn a_raster_layer_is_unaffected_by_the_new_variant() {
        let json = serde_json::json!({
            "kind": "raster",
            "id": "l1",
            "name": "bg",
            "visible": true,
            "locked": false,
            "opacity": 1.0,
            "blendMode": "normal"
        });
        let layer: Layer = serde_json::from_value(json).expect("deserializes");
        assert!(matches!(layer, Layer::Raster { .. }));
    }

    /// Phase 3's "Layer groups, clipping masks" roadmap item — a group has to
    /// round-trip its `collapsed` flag, and children have to keep their
    /// `parentId` pointer into it, exactly like the TS side's flat-array +
    /// `parentId` scheme (`docs/03-data-model.md` §2.1).
    #[test]
    fn a_group_layer_round_trips_with_its_children() {
        let group = Layer::Group {
            base: LayerBase {
                id: "g1".into(),
                name: "Character".into(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
                parent_id: None,
                clipping_mask: false,
            },
            collapsed: true,
        };
        let child = Layer::Raster {
            base: LayerBase {
                id: "l1".into(),
                name: "outline".into(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
                parent_id: Some("g1".into()),
                clipping_mask: true,
            },
        };

        let group_json = serde_json::to_value(&group).expect("serializes");
        assert_eq!(group_json["kind"], "group");
        assert_eq!(group_json["collapsed"], true);
        assert_eq!(group_json["parentId"], serde_json::Value::Null);

        let child_json = serde_json::to_value(&child).expect("serializes");
        assert_eq!(child_json["parentId"], "g1");
        assert_eq!(child_json["clippingMask"], true);

        let group_back: Layer = serde_json::from_value(group_json).expect("deserializes");
        match group_back {
            Layer::Group { base, collapsed } => {
                assert_eq!(base.id, "g1");
                assert!(collapsed);
                assert_eq!(base.parent_id, None);
            }
            other => panic!("expected a group layer, got {other:?}"),
        }

        let child_back: Layer = serde_json::from_value(child_json).expect("deserializes");
        assert_eq!(child_back.base().parent_id.as_deref(), Some("g1"));
        assert!(child_back.base().clipping_mask);
    }

    /// A `.tess` saved before Phase 3 has neither field at all — the reader
    /// must default to "top level, not clipped" rather than refuse to load.
    #[test]
    fn parent_id_and_clipping_mask_default_when_absent() {
        let json = serde_json::json!({
            "kind": "raster",
            "id": "l1",
            "name": "bg",
            "visible": true,
            "locked": false,
            "opacity": 1.0,
            "blendMode": "normal"
        });
        let layer: Layer = serde_json::from_value(json).expect("deserializes");
        assert_eq!(layer.base().parent_id, None);
        assert!(!layer.base().clipping_mask);
    }

    /// Phase 4's "Tags with preset names" — a tag has to round-trip through
    /// `.tess` with every field intact, camelCase on the wire like everything
    /// else here.
    #[test]
    fn a_tag_round_trips_with_all_its_fields() {
        let tag = Tag {
            id: "t1".into(),
            name: "walk".into(),
            from: 1,
            to: 4,
            direction: TagDirection::Pingpong,
            repeat: Some(3),
            color: "#4d9de0".into(),
        };
        let json = serde_json::to_value(&tag).expect("serializes");
        assert_eq!(json["name"], "walk");
        assert_eq!(json["from"], 1);
        assert_eq!(json["to"], 4);
        assert_eq!(json["direction"], "pingpong");
        assert_eq!(json["repeat"], 3);
        assert_eq!(json["color"], "#4d9de0");

        let back: Tag = serde_json::from_value(json).expect("deserializes");
        assert_eq!(back.id, "t1");
        assert_eq!(back.direction, TagDirection::Pingpong);
        assert_eq!(back.repeat, Some(3));
    }

    /// `repeat` is optional on the wire — a tag that never set one round-trips
    /// without the key at all, matching `linked_to`'s "absent means unset"
    /// convention.
    #[test]
    fn a_tag_without_repeat_omits_it_on_the_wire() {
        let tag = Tag {
            id: "t1".into(),
            name: "idle".into(),
            from: 0,
            to: 0,
            direction: TagDirection::Forward,
            repeat: None,
            color: "#e15554".into(),
        };
        let json = serde_json::to_value(&tag).expect("serializes");
        assert!(json.get("repeat").is_none());

        let back: Tag = serde_json::from_value(json).expect("deserializes");
        assert_eq!(back.repeat, None);
    }

    /// A `.tess` saved before tags existed has no `tags` field at all — the
    /// sprite must still load, with an empty tag list, not fail.
    #[test]
    fn sprite_defaults_tags_to_empty_when_the_field_is_absent() {
        let sprite: Sprite =
            serde_json::from_str(r#"{"width":8,"height":8,"layers":[],"frames":[],"cels":[]}"#)
                .unwrap();
        assert!(sprite.tags.is_empty());
    }

    /// A sprite with tags round-trips them alongside everything else it holds.
    #[test]
    fn sprite_round_trips_its_tags() {
        let sprite = Sprite {
            width: 8,
            height: 8,
            color_mode: ColorMode::Rgba,
            layers: vec![],
            frames: vec![],
            cels: vec![],
            palette: None,
            tags: vec![Tag {
                id: "t1".into(),
                name: "run".into(),
                from: 0,
                to: 2,
                direction: TagDirection::Reverse,
                repeat: None,
                color: "#3bb273".into(),
            }],
        };
        let json = serde_json::to_value(&sprite).expect("serializes");
        assert_eq!(json["tags"][0]["name"], "run");
        assert_eq!(json["tags"][0]["direction"], "reverse");

        let back: Sprite = serde_json::from_value(json).expect("deserializes");
        assert_eq!(back.tags.len(), 1);
        assert_eq!(back.tags[0].name, "run");
    }
}
