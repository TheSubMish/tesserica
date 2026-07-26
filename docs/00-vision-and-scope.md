# Vision & Scope

> Status: **reviewed; core decisions locked** · Last updated: 2026-07-26
> See `10-decisions.md` for what is locked.

## 1. One-line description

**Tesserica** — a desktop application for making pixel art: a full drawing/animation
editor for original work (game maps, character sprites, tilesets) combined with a
high-quality image→pixel-art converter and a small set of practical image utilities.

The name is from *tessera*, the individual tile in a mosaic — which is exactly what a
pixel is, and covers both halves of the app rather than only the converter.

**Linux first** (`10-decisions.md` D5); Windows and macOS are the eventual goal.

## 2. The problem

Today this workflow is split across several tools:

- **Pixelorama / Aseprite** — excellent editors, but no serious image→pixel conversion.
  You draw from scratch or you import already-pixel art.
- **Pixel It / PixelMe / Pixel Art Village** — good converters, but they are one-shot web
  toys. No layers, no animation, no project you can come back to, output goes straight
  to your Downloads folder.
- **Background removal / cropping / resizing** — a separate trip to a web tool, usually
  one that uploads your image to someone else's server.

So a typical "make a character sprite from a reference photo" job looks like: web tool
to remove background → another web tool to crop → a converter to pixelate → download →
import into an editor → clean up by hand. Five tools, four file round-trips, and the
intermediate steps are lossy and non-reversible.

## 3. What we are building

**One desktop app where conversion is the *first step of an editing session*, not a
dead end.** You drop in a photo, remove the background, crop to the character, tune the
pixelation live, and the result lands on a layer in a real editor where you can fix the
eyes by hand, add a walk cycle, and export a spritesheet.

The two halves reinforce each other, and that pairing is the actual product thesis:

- The converter gets you 80% of the way in 10 seconds.
- The editor lets you fix the 20% that automated conversion always gets wrong.

Neither half alone is novel. The seam between them is where the value is, and it is the
part every existing tool is missing.

## 4. Target users

| User | Needs | Priority |
|---|---|---|
| **Hobbyist game devs** (the primary user — this is us) | Character sprites, tilesets, map tiles, UI elements. Fast iteration over polish. | P0 |
| **Pixel artists** | A real editor: pixel-perfect tools, palettes, layers, onion skinning. | P1 |
| **Casual users** | Drop a photo in, get an avatar out. Never open the editor. | P2 |

Design implication: the app must be **usable in 10 seconds by a casual user** and
**deep enough to live in for hours** by a game dev. That argues for a mode-based UI
(see `05-ui-design.md`) rather than one giant editor that greets you with 40 tools.

## 5. Scope

### 5.1 In scope — v1 (the walking skeleton)

- Canvas-based pixel editor: pencil, eraser, fill, line, rect, ellipse, picker, select.
- Layers: add/delete/reorder/opacity/visibility/blend modes.
- Palettes: built-in retro palettes, Lospec import, per-project custom palettes.
- Image→pixel conversion: downscale, color quantization, dithering, live preview.
- Basic adjustments: brightness, contrast, saturation, hue.
- Export: PNG at integer scale factors (1×/2×/4×/8×, nearest-neighbour).
- Project save/load in a native format.

### 5.2 In scope — v2+

- Animation: frames, timeline, onion skinning, GIF + spritesheet export.
- Tilemap layers with a tile palette (rect grid first; iso/hex later).
- Background removal (ONNX segmentation model, running locally).
- Smart crop / "fit to character" using the segmentation mask.
- Aseprite `.ase` import (read-only at first).
- Non-destructive effects: outline, drop shadow, gradient map.

### 5.3 Explicitly out of scope

| Not doing | Why |
|---|---|
| **AI image generation** (text→sprite, like Pixellab/pixie.haus) | Requires hosted models, GPUs, accounts, and a billing relationship. Fundamentally a different product with a different cost structure. See §6. |
| **Cloud sync / accounts / sharing** | Local-first. No server to run, no privacy questions to answer. |
| **Vector drawing** | Different tool, different data model. |
| **Photo editing beyond the listed utilities** | We are not competing with GIMP. Utilities exist to serve the pixel-art pipeline, not as an end in themselves. |
| **Mobile / tablet builds** | Desktop-first. Revisit only after v2 ships. |

## 6. On the AI features in our references

Three of the reference tools (Pixellab, pixie.haus, PixelMe, Adobe Firefly) are
fundamentally **AI generation** products. They are worth studying for UX, but copying
their core feature would change what this project is:

- They need large diffusion models — impractical to bundle, slow on CPU, and requiring a
  capable GPU to be tolerable locally.
- Their business model is credits and subscriptions, which implies a backend, accounts,
  and payments.

**Decision: no generative AI, ever.** Locked — `10-decisions.md` D8. This is a permanent
scope boundary, not a "not yet". No plugin seam is reserved for it, which keeps Convert
mode simpler.

**Explicitly unaffected:** we do use one small, local, discriminative model for
**background removal** (a few MB, runs fine on CPU), described in `04-image-pipeline.md`
§8. That is a segmentation model running on the user's machine that never sends an image
anywhere — a different proposition entirely from generative AI, and it stays in scope.

## 7. Product principles

1. **Local-first.** No image ever leaves the machine. This is a real differentiator
   against every web reference and should be stated plainly in the UI.
2. **Non-destructive where it is cheap to be.** Conversion settings stay live and
   re-editable as long as the source layer is intact.
3. **Integer-honest.** Pixel art has a grid. Never introduce half-pixels, never resample
   with a smoothing filter on export, always snap.
4. **Fast preview, correct export.** The preview may approximate; the export must not.
   (This is the direct justification for the hybrid architecture — see `02-architecture.md`.)
5. **Escape hatches everywhere.** Any automated result must be droppable onto a layer
   and editable by hand.

## 8. Success criteria for v1

- Load a 4000×3000 photo, adjust pixelation, and see the preview update at **≥30 fps**.
- Convert → edit → export a game-ready 64×64 sprite **without leaving the app**.
- Cold start to drawable canvas in **under 2 seconds**.
- Installer under **20 MB** (excluding the optional background-removal model, which is
  downloaded on first use — see `07-tech-stack.md`).

## 9. Related documents

- `01-reference-analysis.md` — what each reference tool does and what we take from it
- `02-architecture.md` — process model and the hybrid preview/export split
- `03-data-model.md` — document, layers, frames, project file format
- `04-image-pipeline.md` — the algorithms
- `05-ui-design.md` — layout and design system
- `06-workflows.md` — end-to-end user journeys
- `07-tech-stack.md` — dependencies and packaging
- `08-roadmap.md` — phased delivery plan
- `09-open-questions.md` — decisions still to be made
