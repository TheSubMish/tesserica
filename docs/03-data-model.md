# Data Model

> Status: **draft for review** · Last updated: 2026-07-26

## 1. Overview

The model is adopted from Aseprite's proven structure (see `01-reference-analysis.md` §9):

```
Project
└── Sprite (w, h, color mode)
    ├── Palette
    ├── Layer[]      (ordered bottom → top)
    ├── Frame[]      (ordered in time)
    ├── Cel[]        ← the layer × frame intersection; holds actual pixels
    ├── Tag[]        (named frame ranges: "walk" 4–7)
    └── Slice[]      (named regions: 9-patch, hitboxes)
```

**The key idea: a Cel is the content of one Layer at one Frame.** Layers and frames are
independent axes; cels are the sparse grid where they meet. Sparse matters — a background
layer that never changes has one cel referenced by every frame, not N copies.

---

## 2. Core types

```ts
type SpriteId = string;   type LayerId = string;
type FrameId = string;    type CelId   = string;

interface Sprite {
  id: SpriteId;
  width: number;            // document pixels, not screen pixels
  height: number;
  colorMode: 'rgba' | 'indexed' | 'grayscale';   // v1 uses 'rgba' only — D9
  layers: LayerId[];        // bottom → top
  frames: FrameId[];        // time order
  palette: Palette;
  tags: Tag[];
  slices: Slice[];
}
```

### 2.1 Layers

A layer is a **discriminated union on `kind`** — this is what lets tilemap and conversion
layers be first-class rather than bolted on.

```ts
interface LayerBase {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;              // 0..1
  blendMode: BlendMode;
  parentId: LayerId | null;     // for groups
  clippingMask: boolean;        // clip to layer below
  effects: Effect[];            // non-destructive, see §5
  userData?: Record<string, unknown>;   // Pixelorama-style custom data
}

type Layer =
  | LayerBase & { kind: 'raster' }
  | LayerBase & { kind: 'group'; collapsed: boolean }
  | LayerBase & { kind: 'tilemap'; tilesetId: TilesetId; grid: GridSpec }
  | LayerBase & { kind: 'conversion'; source: ConversionSource };
```

**The `conversion` layer is our distinguishing feature.** It holds a reference to the
original imported image plus the live conversion settings, and renders its output as
pixels. It stays re-editable — change the palette weeks later and it re-renders.
"Flatten to raster" converts it to a normal layer when the user wants to hand-edit.

```ts
interface ConversionSource {
  sourceId: SourceId;           // handle to full-res image held in Rust
  settings: ConvertSettings;    // see 04-image-pipeline.md §2
  maskId?: MaskId;              // background-removal mask, if applied
}
```

```ts
type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';
```

### 2.2 Frames & Cels

```ts
interface Frame {
  id: FrameId;
  durationMs: number;           // per-frame, as Aseprite does it
}

interface Cel {
  id: CelId;
  layerId: LayerId;
  frameId: FrameId;
  x: number; y: number;         // cels can be smaller than the sprite
  width: number; height: number;
  opacity: number;
  data: CelData;
}

type CelData =
  | { kind: 'raster'; pixels: Uint8ClampedArray }   // RGBA, w*h*4
  | { kind: 'indexed'; indices: Uint8Array }        // palette indices
  | { kind: 'tilemap'; tiles: Uint32Array }         // tile IDs + flip flags
  | { kind: 'linked'; targetCelId: CelId };         // shared across frames
```

**Bounded cels** (x/y/w/h smaller than the sprite) are a real memory win for animation:
a 16×16 blinking eye on a 256×256 sprite stores 1KB, not 256KB.

**Linked cels** implement "this layer doesn't change on these frames."

### 2.3 Tags & Slices

```ts
interface Tag {
  name: string;                 // "idle" | "walk" | "attack"
  from: number; to: number;     // frame indices, inclusive
  direction: 'forward' | 'reverse' | 'pingpong';
  repeat?: number;
  color: string;
}

interface Slice {
  name: string;
  keys: { frame: number; x: number; y: number; w: number; h: number;
          pivot?: { x: number; y: number };
          center?: { x: number; y: number; w: number; h: number } }[];  // 9-patch
}
```

Per `01-reference-analysis.md` §6, we ship **preset tag names** (idle/walk/run/attack/
hurt/death) because those are the units game devs think in.

---

## 3. Palettes

```ts
interface Palette {
  id: string;
  name: string;
  colors: RGBA[];
  source?: { kind: 'builtin' | 'lospec' | 'file' | 'custom'; ref?: string };
}
```

**Built-ins for v1 — hardware palettes only:** Game Boy (4), NES (55), CGA (16),
Commodore 64 (16), ZX Spectrum (15), plus grayscale ramps (4/8/16).

> Earlier drafts of this section also listed PICO-8, Sweetie-16 and Dawnbringer-16/-32.
> Those are **authored** palettes, and bundling them contradicts `07-tech-stack.md` §8,
> which permits only factual hardware colour lists. They are removed from the built-in
> set; users import them with the parsers below. Counts are after de-duplication — the
> NES PPU has 64 register values but only 55 distinct colours (nine of them are black),
> and the ZX Spectrum's two blacks are identical.

**Import formats** (all four unlock the ~4,400-palette Lospec catalog):

| Format | Ext | Notes |
|---|---|---|
| Plain hex | `.hex` | One `RRGGBB` per line. Trivial. |
| GIMP | `.gpl` | `GIMP Palette` header, then `R G B  Name` rows |
| JASC | `.pal` | `JASC-PAL\n0100\n<count>` then `R G B` rows |
| RIFF | `.pal` | binary `RIFF…PAL data`; sniffed by magic, since `.pal` is two unrelated formats |
| Paint.net | `.txt` | `AARRGGBB` per line, `;` comments |

**Byte order is the trap.** `.hex` puts alpha *last* (`RRGGBBAA`) when it carries alpha at
all; Paint.NET puts it *first* (`AARRGGBB`). Getting that backwards produces a palette of
nearly-transparent colours and no error at all, so both orderings are pinned by tests.

**Indexed color mode** stores palette indices instead of RGBA. Palette swapping becomes
free — recolor a whole character by swapping the palette, which is exactly how retro
games did team colors.

> ⚠️ **Deferred to Phase 7** (`10-decisions.md` D9). **v1 is RGBA only.** Indexed mode
> touches every tool, every blend mode and every effect, and needs a policy for "user
> picked a color not in the palette". The `indexed` variants stay in the type definitions
> so adding it later is an extension, not a migration — but nothing implements them in
> v1. Instant palette swapping is postponed with it.

---

## 4. Tilemaps

```ts
interface Tileset {
  id: TilesetId;
  name: string;
  tileWidth: number; tileHeight: number;
  tiles: TileEntry[];           // index 0 is always the empty tile
}

interface GridSpec {
  shape: 'rect' | 'isometric' | 'hexagonal';
  tileWidth: number; tileHeight: number;
  offsetX: number; offsetY: number;
}
```

Tile IDs in a tilemap cel pack flip flags into the high bits (the standard approach —
Godot/Tiled both do this):

```
bits  0–27 : tile index
bit     28 : flip horizontal
bit     29 : flip vertical
bit     30 : transpose (diagonal flip)
```

**v1 ships rect only.** Isometric and hex are in the model from the start so adding them
later is not a migration, but they are not implemented initially.

---

## 5. Non-destructive effects

```ts
type Effect =
  | { kind: 'outline'; color: RGBA; thickness: number; corners: boolean }
  | { kind: 'drop-shadow'; dx: number; dy: number; color: RGBA }
  | { kind: 'gradient-map'; palette: RGBA[] }
  | { kind: 'hsv-shift'; h: number; s: number; v: number }
  | { kind: 'outline-inner'; color: RGBA; thickness: number };
```

Stored on the layer, applied at composite time, reorderable, toggleable. Following
Pixelorama's model (`01-reference-analysis.md` §2).

---

## 6. History (undo/redo)

**Command pattern with inverse patches**, not full-document snapshots.

Research surfaced two approaches: immutable snapshot stacks (simple, memory-hungry) and
delta storage (more bookkeeping, far cheaper). For a 512×512 sprite with 10 layers and
30 frames, snapshots are ~300 MB for a 20-step history. Deltas are unusable-to-usable,
so this is not a close call.

```ts
interface Command {
  label: string;                       // shown in UI: "Pencil", "Add Layer"
  apply(doc: Document): void;
  invert(doc: Document): void;
  coalesceWith?(next: Command): Command | null;   // merge continuous strokes
  memoryCost: number;
}
```

**Dirty-rect strokes.** A pencil stroke records only the bounding box of touched pixels
plus before/after buffers for that box. A 3-pixel dot on a 512×512 canvas costs ~100
bytes, not 1 MB.

**Coalescing.** One drag = one undo step, not 200. Slider drags on a conversion layer
likewise collapse into a single "Change palette" step.

**Budget:** cap history at ~256 MB or 200 steps, whichever comes first, evicting oldest.

---

## 7. Project file format

**`.tess` — a ZIP archive.** (Locked — `10-decisions.md` D3.)

```
project.tess
├── manifest.json          # format version, app version, sprite metadata
├── sprite.json            # layers, frames, tags, slices, palette (no pixels)
├── cels/
│   ├── <celId>.png        # raster cels as PNG (compressed, inspectable)
│   └── <celId>.bin        # indexed/tilemap cels as raw
├── sources/
│   └── <sourceId>.png     # original imported images for conversion layers
└── thumbnail.png          # 256×256 preview for file browsers
```

Rationale for ZIP-of-files over a single binary blob:

- **Debuggable.** Unzip it and look. Enormously valuable during development.
- **Free compression.** PNG for raster cels, deflate for the rest.
- **Forward-compatible.** Unknown files are preserved on round-trip, so an older build
  opening a newer file does not destroy data it does not understand.
- **Cheap partial reads.** Thumbnail without parsing the document.

**Versioning:** `manifest.json` carries `formatVersion` (integer). Readers refuse
versions above what they know and migrate versions below.

**Important:** conversion layers store the **original source image**, which means project
files can be large (a 12 MP photo source is several MB). Offer "flatten conversion
layers on save" for users who want small files, but default to preserving the source —
the ability to re-tune later is the point of the feature.

---

## 8. Rust mirror

Rust types mirror the TS types with `serde` derives:

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sprite {
    pub id: SpriteId,
    pub width: u32,
    pub height: u32,
    pub color_mode: ColorMode,
    pub layers: Vec<LayerId>,
    pub frames: Vec<FrameId>,
    pub palette: Palette,
    pub tags: Vec<Tag>,
    pub slices: Vec<Slice>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layer {
    Raster  { #[serde(flatten)] base: LayerBase },
    Group   { #[serde(flatten)] base: LayerBase, collapsed: bool },
    Tilemap { #[serde(flatten)] base: LayerBase, tileset_id: TilesetId, grid: GridSpec },
    Conversion { #[serde(flatten)] base: LayerBase, source: ConversionSource },
}
```

`#[serde(tag = "kind")]` matches the TS discriminated union exactly, so the wire format
needs no translation layer.

**`DocumentSnapshot`** — what crosses IPC on export — is metadata only, never pixels
(`02-architecture.md` §6.2).

---

## 9. Memory budget

For a 256×256 sprite, 8 layers, 24 frames, dense cels:
`256 × 256 × 4 bytes × 8 × 24 = 50 MB` raw RGBA.

Reduction levers, in order of impact:

1. **Sparse cels** — most layer/frame pairs are empty or linked. Typically 5–10× saving.
2. **Bounded cels** — store only the dirty rect.
3. **Indexed mode** — 1 byte/pixel instead of 4.
4. **Lazy composite cache** — cache composited frames, evict under pressure.

Watch this during v1; a naive dense implementation will hit memory problems on
realistic animation work.
