# Editor Guide

> Status: **user-facing guide, not a spec.** Everything in `docs/00`–`10` is Tesserica's
> design specification (`docs/README.md`: "the specification, not background reading").
> This document is different on purpose: it walks a *user* through Edit mode as shipped,
> task by task, rather than explaining why it was built that way. If something here
> disagrees with what you see on screen, the app is right and this page is stale — please
> file that as a bug against the doc, not the app.
>
> Scoped to Edit mode only, and to what `docs/08-roadmap.md` actually marks `[x]` at the
> time of writing (through Phase 8's first three items). It does not cover Convert mode
> task-by-task — see the note on conversion layers near the end for the one place the two
> modes meet. A standalone Convert guide may follow later; if it does, `docs/12-convert-
> guide.md` is the natural next number, not a new subdirectory (see `docs/README.md`'s
> existing flat, numbered layout).

## 1. Two modes, one document

Tesserica has exactly two modes, switched with the tabs at the top left: **Convert** and
**Edit**. This guide is about Edit — a layered pixel-art canvas with the tools, palettes,
timeline and tilemaps you'd expect from a dedicated pixel editor. (There is no third
"Animate" mode: animation lives inside Edit as the Timeline panel, described in §6.)

The app opens straight into Edit mode on a blank 64×64 canvas. Press **`Ctrl+N`** any
time to open the New Sprite dialog: pick a preset (16/32/64/128 px, square) or a custom
width and height up to **4096×4096**, a starting palette, and a colour mode (RGBA, the
default, or Indexed — see §5.5). Confirming replaces the current document, so save first
if you want to keep it (`Ctrl+S`).

## 2. The canvas

- **Scroll** to pan, **`Ctrl`+scroll** (or the Zoom tool, §3) to zoom. Zoom is always an
  integer percentage — nearest-neighbour, never a blurred in-between size.
- **`Home`** re-centers the view on the sprite from wherever you've panned to.
- The **`'`** key toggles the grid overlay; it also appears automatically at high zoom.
- The checkerboard behind your artwork is transparency, not a colour — it never gets
  exported.
- Hold **Space** to pan with the tool of your choice still selected, instead of
  switching to a pan tool and back.

## 3. Tools

The tool rail on the left has twelve tools. Each one's shortcut is a single letter, no
modifier — press it any time you're not typing into a text field.

| Tool | Key | What it does |
|---|---|---|
| Pencil | `B` | Freehand drawing. "Pixel-perfect" mode (its own checkbox in the tool options) removes the doubled corner pixel a fast diagonal drag normally leaves. |
| Eraser | `E` | Same brush mechanics as Pencil, but clears to transparent instead of painting. |
| Fill | `G` | Bucket fill. Toggle between *contiguous* (stops at a colour boundary, the default) and *global* (recolours every matching pixel in the cel) in the tool options. |
| Line | `L` | Click-drag a straight line at the current brush size. |
| Rectangle | `U` | Click-drag a rectangle, outline or filled (tool options). |
| Ellipse | `O` | Click-drag an ellipse, outline or filled. |
| Eyedropper | `I` | Pick a colour from the canvas into the active swatch. Also reachable by holding `Alt` while any other tool is active. |
| Select | `M` | One tool, four shapes (tool options): rectangle, ellipse, lasso (freehand), and magic wand (click a region to select everything connected to it that matches its colour). Every paint tool clips to the current selection. |
| Move | `V` | Drag the selected pixels (or, with nothing selected, the whole layer's content). |
| Zoom | `Z` | Click to zoom in on that point, `Alt`+click to zoom out — a dedicated magnifier if you'd rather not use `Ctrl`+scroll. |
| Stamp | `S` | Paint tiles from the active tileset onto a tilemap layer. See §7. |
| Transform | `R` | Rotate and scale a selection or layer using pixel-art-aware algorithms (rotxel for rotation, cleanEdge for scaling) instead of a blurry resample. Set angle/scale in the tool options, then apply. |

Brush size (Pencil/Eraser/Line) is a number field *and* a slider together — drag it, type
into it, or use **`[`**/**`]`** to nudge it up and down. That "every slider is also a
number field" convention holds everywhere in the app, not just here.

**`X`** swaps the foreground/background swatches; **`D`** resets them to black/white.

## 4. Undo and redo

**`Ctrl+Z`** / **`Ctrl+Shift+Z`** (or `Ctrl+Y`). One click-drag is one undo step, however
many pixels it touched — dragging a long pencil stroke across the canvas undoes in one
step, not one step per pixel. Undo is unlimited within a budget (200 steps or roughly
256 MB of retained changes, whichever comes first); the oldest steps drop first if you
hit that ceiling, and the most recent step is never dropped even if it alone is large.

One thing worth knowing if you work at very large canvas sizes: finishing a freehand
stroke on a full-size raster layer costs more the bigger that layer is, because Tesserica
finds the changed region by comparing the whole layer before and after. At the default
sizes this is instant; at the 4096×4096 ceiling a single-pixel edit on a full-canvas
raster layer can take on the order of a few hundred milliseconds to register in the undo
stack. Tile stamping (§7) is unaffected by this regardless of canvas size — it only ever
compares the tile grid, not raw pixels.

## 5. Layers, palettes and colour

### 5.1 Layers

The Layers panel (right side) lists every layer in the sprite, top to bottom, matching
paint order. Per layer:

- **Visibility** and **lock** toggles (the eye and padlock icons).
- **Blend mode** — all sixteen from the standard compositing set (Normal, Multiply,
  Screen, Overlay, Darken, Lighten, Color Dodge, Color Burn, Hard Light, Soft Light,
  Difference, Exclusion, Hue, Saturation, Color, Luminosity).
- **Opacity** slider, 0–100%.
- **Parent** — assigns the layer into a group (see below) or back to the top level.
- Rename by double-clicking the layer's name.

Buttons above the list: add a raster layer, add a group, group/ungroup the selected
layer, reorder up/down, delete.

**Groups** have no pixels of their own — they composite their children and can carry a
**clipping mask** flag (clip the group's content to whatever's directly below it),
scoped to that one group. A hidden or locked group hides/locks every layer inside it.

### 5.2 Effects

Below blend mode, each layer can carry non-destructive effects — outline, drop shadow,
gradient map, HSV shift, inner outline — reorderable and toggleable per layer, applied at
composite time without touching the underlying pixels.

### 5.3 Palettes

The Palette panel lists the active palette's swatches; click one to make it the current
foreground colour. The palette picker above it includes:

- **Bundled hardware/fixed-spec palettes**: Game Boy, NES, CGA, Commodore 64, ZX
  Spectrum, PICO-8, plus grayscale ramps at 4/8/16 steps. These are shipped because
  they're facts about real hardware (or, for PICO-8, a single fixed platform spec) —
  never an individual artist's Lospec palette, which carries its own licence.
- **Import your own**: `.hex`, `.gpl`, `.pal`, and Paint.NET `.txt` files, or paste a
  Lospec palette page URL directly (**Import from Lospec URL…**) — an explicit,
  user-initiated network fetch, the only kind this app makes outside model downloads.

**Simulate** (below the palette) previews the canvas under protanopia, deuteranopia or
tritanopia without changing any actual pixel — a check, not an edit.

### 5.4 Recolouring an indexed sprite

If your sprite is in Indexed colour mode (§5.5), the Palette panel also lets you edit a
swatch directly: every pixel using that palette entry updates at once across the whole
sprite, instantly. This is what makes a palette swap a one-click operation once you've
committed to indexed mode.

### 5.5 RGBA vs. Indexed

New sprites default to **RGBA** — any colour, any pixel, independently. **Indexed** mode
locks every pixel to one shared palette; colours not already in it snap to their nearest
match. You can convert an existing RGBA sprite to indexed later from the Palette panel's
**Convert to Indexed…** button, which snaps every pixel on every layer to the palette
currently selected above it. It's a whole-document operation, but it is undoable like
any other edit (**`Ctrl+Z`** puts every layer back to RGBA).

## 6. Frames, the Timeline, and animation

Animation is a **panel**, not a separate mode — press the **`T`** key or the title bar's
timeline button to show or hide it. It's hidden by default on a new sprite.

- **Frames** are columns; **layers** are rows; a filled dot marks an independent cel, a
  chain icon marks a **linked cel** (two frames sharing one buffer — edit either, both
  change, until you unlink them).
- Buttons add/duplicate/reorder/delete frames, and set each frame's duration.
- **Transport**: play, pause, stop, step. Playback loops by default.
- **Onion skinning**: a toggle plus before/after range fields (up to 8 frames each
  direction). Past frames tint red, future frames tint blue — ghosts only, never
  paintable, and they never appear in an export.
- **Tags**: name a frame range (the six common presets — idle/walk/run/attack/hurt/death
  — or a custom name), set its playback direction (forward/reverse/ping-pong), and play
  back just that range without touching the rest of the timeline. Tags shift their range
  automatically when you insert or delete frames elsewhere.

## 7. Tilemaps

The Tileset panel (right side, below Layers) is where a tilemap starts:

1. **Create a tileset** — give it a name and a tile size (e.g. 16×16).
2. **Add tiles** to it by making a rectangular selection on a raster layer that's
   *exactly* the tileset's tile size, then adding it — a size mismatch is a plain error
   rather than a silent resize.
3. **Add a tilemap layer** using that tileset. Its grid can be rectangular, isometric, or
   hexagonal (set when adding the layer).
4. Switch to the **Stamp** tool (`S`), pick a tile from the panel (with flip/rotate
   toggles), and paint it onto the tilemap layer's grid. One drag is one undo step, just
   like every other tool.

Duplicate tiles are recognised automatically, including ones that are only a flip or a
diagonal transpose of a tile you already have — you won't end up with near-identical
tiles cluttering the set.

A tilemap layer's cel can't be larger than its sprite, so the practical ceiling on a
tilemap's size is the sprite size ceiling (**4096×4096** as of Phase 8) divided by your
tile size — 256×256 tiles at 16 px, 128×128 at 32 px.

With a tilemap layer active, the Tileset panel's **Export tileset + tilemap…** button
writes a PNG tile atlas plus a Tiled-shaped `.json` map for that layer's grid — this is
separate from the main Export dialog (§9), which flattens the whole sprite instead of
exporting engine-importable tilemap data.

## 8. Import

From the `≡` menu: **Open image…** (into Convert mode — see §10) and **Import Aseprite
file…** (`.ase`/`.aseprite`, straight into Edit mode as a real, editable sprite —
layers, frames, tags, linked cels and tilemap layers all come across; a small number of
Aseprite-only features that this project's data model has no equivalent for, like the
three non-W3C blend modes or per-cel opacity, are dropped with a warning rather than
silently).

## 9. Export

**`≡` → Export…** opens a dialog with four formats:

- **PNG** — a single image at an integer scale (1×/2×/4×/8×). Never a fractional scale;
  non-integer scaling produces uneven pixel block sizes, which is exactly the artifact
  pixel art can't afford.
- **Spritesheet** — every frame (or one tag's frames) laid into a grid, plus a metadata
  JSON alongside it (frame rectangles and tag ranges, in the same shape Phaser/PixiJS
  importers already expect).
- **GIF** — an animated file covering every frame or one tag, looping.
- **Pattern chart** — the bead/cross-stitch chart export (Phase 7): a printable colour
  key against your active palette, for craft use rather than a game engine.

## 10. Saving, and where Convert mode fits in

**`Ctrl+S`** / **`Ctrl+Shift+S`** save to a `.tess` file (a ZIP archive) and reopen with
**`Ctrl+O`** — this preserves everything: every layer, frame, tag, palette and tileset.

The one thing to know about **Convert mode**, even though this guide doesn't cover it
task-by-task: converting a photo there and pressing **`[ Edit → ]`** creates a
**conversion layer** here in Edit mode — a layer that remembers its source image and
conversion settings, not just a flattened PNG. You can keep drawing on top of it, or (a
current limitation) change its palette later and have it re-render from the original
photo, though re-rendering a conversion layer isn't yet an undo step the way every other
edit is, and if you close and reopen a `.tess` that contains one, it keeps its settings
but needs its source image re-attached before it can re-render again.
