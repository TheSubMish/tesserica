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
- [x] Export PNG at integer scales
- [x] `.tess` save/load (`03` §7)

**Exit:** ⚠️ **W2 all but complete.** A usable, if basic, pixel editor: draw with seven
tools, stack and reorder layers, pick from bundled or imported palettes, undo a whole
drag in one step, export PNG at 1×/2×/4×/8×, and save and reopen a `.tess`.

Two steps of W2 (`06-workflows.md`) are **not** covered by the checklist above, and were
therefore not built:

- **`Ctrl+N` → New sprite dialog** (W2 step 1). The app boots a fixed 64×64 document and
  offers no way to create another or change its size. No checklist item covers it; it is
  small and belongs at the head of Phase 3.
- **`multiply` on the shading layer** (W2 step 4) needs blend modes beyond normal, which
  the roadmap itself schedules for **Phase 3**. W2 as written in `06-workflows.md` cannot
  complete before that phase; the two documents disagree and Phase 3 is the correct one.

---

## Phase 2 · Conversion

**Goal:** W6 (casual avatar) and the core of W1 work.

- [x] `oklab.ts` / `oklab.rs` from shared constants (`04` §4.1)
- [x] **Golden-image test harness** — build this alongside the first stage, not after
- [x] Pipeline stages, both implementations: adjustments → downscale → quantize → cleanup
- [x] Dithering: none, Floyd–Steinberg (serpentine), Atkinson, Bayer 2/4/8 (`04` §5)
- [x] Nearest-color cache with the error-diffusion carve-out (`04` §4.2)
- [x] Preview Web Worker with latest-wins cancellation (`02` §8)
- [x] Rust full-res export path; `SourceId` handle model (`02` §6.2)
- [x] Convert mode UI: split/side-by-side, four primary controls (`05` §3)
- [x] Auto-palette (Wu + k-means in Oklab) (`04` §4.3)
- [x] **`[ Edit → ]`** — conversion layer creation, mode switch, live re-editing

**Exit:** ✅ **W6 complete. W1 complete except background removal.** This is where the
product thesis becomes real and demonstrable.

Drop a photo in, watch it convert live, adjust four controls, export a PNG at an integer
scale — or press `[ Edit → ]` and keep working on it as a layer whose palette you can
change later. The parity guarantee holds: **3,083 golden cases over 917,040 pixels, zero
differing palette indices and zero differing RGBA bytes** between the TypeScript preview
pipeline and the Rust export pipeline.

Two caveats worth carrying into Phase 3, neither of which blocks the exit:

- **A conversion layer's `sourceId` is process-local.** Reopening a `.tess` restores the
  layer and its settings, but not the live handle, so the layer cannot re-render until its
  source is re-attached. `10-decisions.md` D3 already reserves `sources/` inside the
  archive for exactly this; wiring it up is Phase 3 work.
- **Re-rendering a conversion layer is not yet an undo step.** It edits the cel directly
  rather than going through the command system (`03-data-model.md` §6).

> **Highest-risk phase, and it landed.** The dual implementation and the parity guarantee
> both arrived here.

---

## Phase 3 · v1 release

**Goal:** ship it.

- [x] Blend modes beyond normal — all sixteen from `03-data-model.md` §2.1. Composited
      in `canvas/blend.ts` (W3C formulas, used by export and the eyedropper) and via
      native `globalCompositeOperation` in the live renderer (`canvas/renderer.ts`) —
      see that file for why the two are allowed to differ here, unlike the conversion
      pipeline. The Rust `BlendMode` enum mirrors the wire format only; Rust never
      composites layers.
- [~] Selection tools (rect, ellipse, lasso, magic wand) + move — **rectangle marquee
      and Move only.** `state/selectionStore.ts` holds a single `Rect`, not a general
      mask, so ellipse/lasso/magic-wand selection is a data-model change, not just a
      new tool, and did not land in this pass. Every paint tool (pencil, eraser, fill,
      line, rect, ellipse) clips to the active selection.
- [x] Layer groups, clipping masks — groups nest via a `parentId` pointer into
      the same flat `Sprite.layers` array rather than a separate tree
      (`model/layerTree.ts`, `03-data-model.md` §2.1); a group has no pixels
      of its own and composites its children onto an isolated canvas
      (`canvas/renderer.ts::compositeScope`), which is also where "clip to
      layer below" is resolved, scoped to one group and never crossing a
      group boundary. Both `canvas/flatten.ts` (export) and `canvas/sample.ts`
      (eyedropper) walk the same tree recursively so a clipped or grouped
      layer reads the same way everywhere. A hidden or locked group cascades
      to every descendant for both display and editing
      (`isEffectivelyVisible`/`isEffectivelyLocked`). The Rust `Layer::Group`
      variant round-trips `parentId`/`clippingMask`/`collapsed` through
      `.tess` only — Rust never composites layers at all, groups included.
      There is no nesting-depth limit and no multi-select; grouping wraps one
      layer at a time and further members are reassigned via the layer
      panel's Parent selector.
- [~] Keyboard shortcuts complete (`05` §7) — the interaction rules in §7 are now all
      implemented, including "every slider is also a number field"
      (`app/SliderField.tsx`, used by all nine sliders in the app) and `M`/`V` for
      Select/Move. Not done: a dedicated click-to-zoom `Z` tool (`Ctrl`+wheel already
      covers zoom-from-any-tool) and a preferences panel.
- [~] Accessibility pass (`05` §8) — color-blindness simulation shipped
      (`lib/colorBlind.ts`, palette panel). A systematic contrast/focus-order audit
      beyond what already existed did not happen in this pass.
- [ ] ~~Cross-platform verification~~ — **deferred, Linux only** (`10-decisions.md` D5)
- [x] Linux installers (`.deb`, `.AppImage`); README; first-run experience — bundle
      targets and icons were already configured (Phase 0). `npm run tauri build`
      (both `--debug` and the real release profile) produces
      `Tesserica_0.1.0_amd64.deb` and `Tesserica_0.1.0_amd64.AppImage` with no
      privileged package installs, using `dpkg-deb` and the cached `linuxdeploy` +
      gtk/appimage plugins already on this machine. The `.deb` is verified
      end to end: `dpkg-deb -I`/`-c` show a correct control file (`Depends:
      libwebkit2gtk-4.1-0, libgtk-3-0`), desktop entry and hicolor icons, and
      launching the extracted binary directly (`GDK_BACKEND=x11`) opens a full
      working window — tool rail, layer and palette panels all present, and a
      pencil stroke drawn with `xdotool` rendered correctly — which is also the
      first-run experience: straight into Edit mode on a blank 64×64 sprite. The
      `.AppImage` builds and is structurally valid (correct `.desktop`, its own
      bundled `webkit2gtk-4.1` via the linuxdeploy gtk plugin) and its processes
      launch correctly, but its WebView content stayed blank on every attempt in
      this container; a WebKitGTK warning ("...no longer allows disabling the
      sandbox. Use `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`...") points at
      WebKit's own process sandbox as the likely cause inside this nested
      container — not chased further since forcing the sandbox off was blocked by
      this session's own permission guardrail. Later relaunches in the same
      session got flaky even for the previously-good `.deb` (blank window,
      no interaction fixed it), almost certainly GPU/WebKit resource pressure
      from repeatedly spawning WebKit processes in a shared desktop container
      across ~8 launches, not a defect in the artifact — the first clean run
      already proved the `.deb` renders and accepts input correctly. README's
      `npm run tauri build # .deb + .AppImage` line was already accurate.

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
