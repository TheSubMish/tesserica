# Roadmap

> Status: **draft for review** · Last updated: 2026-07-26

## Guiding constraint

Scope is the top risk in this project (`02-architecture.md` §10). Pixelorama is years of
work; the converters are focused single-purpose tools; we are proposing both plus
utilities.

**The discipline: every phase ends with something usable end to end.** No phase leaves
the app in a state where nothing works until the next phase lands.

---

## Phase 0 · Foundation

**Goal:** a Tauri window that draws pixels.

- [x] Scaffold Tauri v2 + React + TS + Vite; verify `tauri dev` and `tauri build` on Linux
- [x] Repo layout per `07-tech-stack.md` §4; formatters, linters, pre-commit
- [x] Design tokens (`05-ui-design.md` §6.2), app shell, mode switcher (tabs inert)
- [x] Canvas viewport: pan, zoom, nearest-neighbour, checkerboard, grid overlay
- [x] `documentStore` with a single raster layer
- [x] Pencil tool → visible pixels

**Exit:** you can draw on a canvas and zoom in. Nothing else.

---

## Phase 1 · Editor core

**Goal:** W2 (draw from scratch) works fully.

- [x] Command/history system with dirty-rect deltas + coalescing (`03-data-model.md` §6)
- [x] Tools: pencil (pixel-perfect), eraser, fill, line, rect, ellipse, eyedropper
- [x] Layers: add/delete/reorder/rename/opacity/visibility/lock; normal blend
- [x] Layer panel; compositing renderer with dirty-layer caching
- [x] Palette panel; built-in hardware palettes
- [x] Palette import: `.hex`, `.gpl`, `.pal`, Paint.net `.txt` (`03` §3)
- [ ] Export PNG at integer scales
- [ ] `.tess` save/load (`03` §7)

**Exit:** ✅ **W2 complete.** A usable, if basic, pixel editor.

---

## Phase 2 · Conversion

**Goal:** W6 (casual avatar) and the core of W1 work.

- [ ] `oklab.ts` / `oklab.rs` from shared constants (`04` §4.1)
- [ ] **Golden-image test harness** — build this alongside the first stage, not after
- [ ] Pipeline stages, both implementations: adjustments → downscale → quantize → cleanup
- [ ] Dithering: none, Floyd–Steinberg (serpentine), Atkinson, Bayer 2/4/8 (`04` §5)
- [ ] Nearest-color cache with the error-diffusion carve-out (`04` §4.2)
- [ ] Preview Web Worker with latest-wins cancellation (`02` §8)
- [ ] Rust full-res export path; `SourceId` handle model (`02` §6.2)
- [ ] Convert mode UI: split/side-by-side, four primary controls (`05` §3)
- [ ] Auto-palette (Wu + k-means in Oklab) (`04` §4.3)
- [ ] **`[ Edit → ]`** — conversion layer creation, mode switch, live re-editing

**Exit:** ✅ **W6 complete. W1 complete except background removal.** This is where the
product thesis becomes real and demonstrable.

> **Highest-risk phase.** The dual implementation and the parity guarantee both land
> here. Budget accordingly.

---

## Phase 3 · v1 release

**Goal:** ship it.

- [ ] Blend modes beyond normal
- [ ] Selection tools (rect, ellipse, lasso, magic wand) + move
- [ ] Layer groups, clipping masks
- [ ] Keyboard shortcuts complete (`05` §7); preferences
- [ ] Accessibility pass (`05` §8), including color-blindness simulation
- [ ] ~~Cross-platform verification~~ — **deferred, Linux only** (`10-decisions.md` D5)
- [ ] Linux installers (`.deb`, `.AppImage`); README; first-run experience

**Exit:** 🚀 **v1.** Editor + converter, meeting the §8 success criteria in
`00-vision-and-scope.md`.

---

## Phase 4 · Animation

**Goal:** W3 works.

- [ ] Frames, cels, linked cels (`03` §2.2)
- [ ] Timeline **panel inside Edit** (D7 — not a third mode): layer×frame grid,
      durations, playback; hidden by default, toggleable
- [ ] Onion skinning with tint and configurable range
- [ ] Tags with preset names (idle/walk/run/attack/hurt/death)
- [ ] Export: spritesheet (+ metadata JSON), animated GIF
- [ ] Performance: sustain target fps; **decide on WebGL2** here if Canvas2D falls short

**Exit:** ✅ **W3 complete.**

---

## Phase 5 · Background removal & smart utilities

**Goal:** W1 complete end to end.

- [ ] Non-ML flood-fill background removal first (instant, no dependency, ships value early)
- [ ] `segment` module; evaluate `rembg-rs` vs direct `ort` (`07` §3.1)
- [ ] Bundle `u2netp`; on-demand download for larger models with explicit consent
- [ ] Mask post-processing: threshold, morphological close, feather (`04` §8.3)
- [ ] Fit-to-subject cropping (`04` §8.5)
- [ ] Resolve the ONNX Runtime size question (`07` §6)

**Exit:** ✅ **W1 complete.** The flagship workflow works without leaving the app.

---

## Phase 6 · Tilemaps & import

**Goal:** W4 and W7 work.

- [ ] Tileset model, tilemap layers, rect grid (`03` §4)
- [ ] Tile stamp tool, auto-deduplication, flip/rotate flags
- [ ] Tileset + tilemap JSON export
- [ ] Grid detection via autocorrelation (`04` §3.3) — unlocks W7 Case A
- [ ] `.ase` import; evaluate `aseprite-io` (`01` §9)

**Exit:** ✅ **W4, W7 complete.**

---

## Phase 7 · Polish & reach

Ordered by value, not commitment:

- [ ] Non-destructive layer effects: outline, drop shadow, gradient map (`03` §5)
- [ ] Batch conversion + CLI headless mode (W5)
- [ ] Pixel-art-aware rotate/scale — rotxel, cleanEdge (`04` §7)
- [ ] **Indexed color mode + live palette swapping** (deferred from v1 by D9 — touches
      every tool, blend mode and effect, so it is a real chunk of work, not a flag)
- [ ] Bead / cross-stitch chart export (W9)
- [ ] Lospec URL import (opt-in network)
- [ ] Isometric and hexagonal tile grids

---

## Sequencing rationale

**Why the editor before the converter (Phase 1 before 2):** the converter's output has to
land *somewhere*. Building conversion first would mean building it twice — once
standalone, once integrated. The layer model has to exist first.

**Why animation after v1 (Phase 4, not 3):** it is the largest single feature and W1/W2/W6
are all complete without it. Shipping v1 earlier gets real feedback before committing to
the timeline UI.

**Why background removal so late (Phase 5):** it is the only dependency with genuine
technical risk (`ort` pre-release, runtime size). Everything else must be shippable
without it, and the flood-fill fallback means the feature has a floor.

**Why grid detection is in Phase 6:** it is not needed for the flagship photo workflow,
but it is what makes W7 Case A not-mush. Cheap once the pipeline exists.

---

## What would make us re-plan

- Preview/export parity proves unachievable within tolerance → reconsider the hybrid
  split; possibly move all processing to Rust and accept slower previews.
- Canvas2D cannot sustain animation playback → WebGL2 renderer, a significant addition.
- IPC benchmarks show handle-passing is still too slow for editor-layer export → rethink
  where pixel data lives.
- `ort` never stabilizes → ship flood-fill only, or bind ONNX Runtime C API directly.
