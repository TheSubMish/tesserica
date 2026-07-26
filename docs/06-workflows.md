# User Workflows

> Status: **draft for review** · Last updated: 2026-07-26
>
> These are the journeys the app must support end to end. Each names the mode, the steps,
> and — where relevant — the failure mode we are designing against.

---

## W1 · Photo → character sprite (the flagship)

**The workflow that justifies the whole product.** Currently requires five tools and four
file round-trips (`00-vision-and-scope.md` §2).

**User:** hobbyist game dev. **Target time:** under 3 minutes.

1. Drag `reference-photo.jpg` onto the window → opens in **Convert** mode.
2. Expand **Background** → *Remove background*. Local ONNX inference, ~2 s, progress
   shown. Mask applied as alpha.
3. Enable **Fit to subject** → auto-crops to the character's bounding box with padding.
   (Free once we have the mask — `04-image-pipeline.md` §8.5.)
4. Drag **Pixel size** → live preview updates at ≥30 fps. Settle on a 48×64 output.
5. Pick **Palette** → DB-32. Toggle **Dither** between none / Floyd–Steinberg / Atkinson,
   comparing in the split view.
6. Click **`[ Edit → ]`** — creates a conversion layer, switches to **Edit** mode.
7. Hand-fix what automation got wrong: eyes, silhouette cleanup, a highlight. Add a new
   raster layer above for the outline.
8. `Ctrl+E` → export PNG at 4×.

**Design requirements this imposes:**
- Steps 2–5 must all be non-destructive and re-orderable in the user's head.
- Step 6 must be lossless and instant.
- Step 7 must not prevent going back and re-tuning step 5 (conversion layer stays live).

**Failure mode designed against:** the user reaches step 7, notices the palette was
wrong, and has to start over. Our answer is that step 5's settings are still editable
via the layer's ⚙ badge.

---

## W2 · Draw a sprite from scratch

**User:** pixel artist. **Mode:** Edit only.

1. `Ctrl+N` → New sprite dialog: size (presets: 16², 32², 64², 128², custom), color mode,
   starting palette.
2. Canvas opens at a zoom that fits the viewport (~800% for 32×32).
3. Draw with pencil; pixel-perfect mode on by default.
4. Add layers for outline / base / shading. Set the shading layer to `multiply`.
5. Pick colors from the palette panel; `Alt` to eyedrop from canvas.
6. `Ctrl+S` → `.tess`.

**Requirements:** cold start to drawable in <2 s. Palette panel must be reachable without
a menu. Pixel-perfect must be a visible toggle, not a hidden preference.

---

## W3 · Walk cycle animation

**User:** game dev. **Modes:** Edit → Animate.

1. Open an existing character sprite.
2. Switch to **Animate**. Timeline appears with one frame.
3. Add frames (`Alt+N` ×3) → 4 frames.
4. Create a tag over frames 1–4 → preset dropdown offers "walk".
5. Enable **onion skin**, 1 before / 1 after.
6. Draw each frame, referencing the ghosted neighbours.
7. Set frame durations (or a uniform 12 fps).
8. `Space` to preview the loop in place.
9. Export → **spritesheet** (horizontal strip, 4 columns) *and* a GIF for sharing.

**Requirements:** onion skin must be tinted and clearly non-editable. Playback must hit
the target fps without dropping (`02-architecture.md` §7 — the most likely trigger for
needing WebGL). Spritesheet export needs a metadata JSON alongside it for engine import.

---

## W4 · Tileset for a game map

**User:** game dev. **v2 feature.**

1. New sprite, 128×128, grid set to 16×16.
2. Add a **tilemap layer** → prompts for tileset (new or existing).
3. Draw tiles into the tileset palette; each unique 16×16 cell becomes a tile entry.
4. Paint the map with the tile stamp tool; flip/rotate variants via the packed flags
   (`03-data-model.md` §4).
5. Export the **tileset image** plus the **tilemap data** (JSON) for engine import.

**Requirements:** grid overlay must snap and be visually distinct from the pixel grid.
Auto-deduplication of identical tiles. v1 ships rect grids only; the model already
carries `shape` so iso/hex is not a migration.

---

## W5 · Batch conversion

**User:** game dev with 40 reference images. **v2/v3 feature.**

1. **File → Batch Convert…**
2. Select a folder of source images.
3. Configure once: pixel size, palette, dither, export scale.
4. Optionally load settings from an existing conversion layer ("use these settings").
5. Run → progress list, per-file success/failure.
6. Output folder gets consistently converted PNGs.

**Requirements:** runs entirely in Rust, `rayon` across files. Must be cancellable.
Pixelorama's CLI (`01-reference-analysis.md` §2) is the model — a headless mode is the
natural companion feature and is cheap once the pipeline exists.

---

## W6 · Casual avatar

**User:** someone who will never open Edit mode. **Target time: 10 seconds.**

1. Drag photo onto window.
2. Drag one slider.
3. Click **Export**.

This is the whole journey. It is the reason Convert mode shows only four controls
(`05-ui-design.md` §3). If this takes more than 10 seconds, the mode design has failed.

---

## W7 · Import existing pixel art

**User:** anyone with a PNG that is the wrong size, or an Aseprite file.

**Case A — upscaled PNG:** the source is already pixel art saved at 8×.
1. Open it. Convert mode detects the underlying grid via autocorrelation
   (`04-image-pipeline.md` §3.3) and offers "detected 8× — snap to original?"
2. Accept → recovers the true 1× pixels exactly, no quality loss.

Without grid detection this common case produces mush, which is precisely the quality
signal both AI references lead with.

**Case B — `.ase` file (v2):** parse header/frames/chunks, map cels onto our layer×frame
model (`03-data-model.md` §2.2), preserve palette and tags.

---

## W8 · Palette work

1. **Palette panel → ⬇ Import** → choose a `.hex` / `.gpl` / `.pal` / `.txt` file
   downloaded from Lospec.
2. Palette loads; canvas re-maps if the document is in indexed mode.
3. Edit swatches, reorder, name it, save to the user library.
4. Optional (v2): paste a Lospec URL to fetch directly — **network, so opt-in with a
   clear prompt**, consistent with local-first.

**Requirements:** all four formats in v1 (`01-reference-analysis.md` §7). Indexed mode
makes palette swapping instant, which is the retro team-color trick and worth
demonstrating in the UI.

---

## W9 · Bead / cross-stitch chart

**v3, borrowed from PixelMe** (`01-reference-analysis.md` §5).

1. Finished pixel art in the editor.
2. **Export → Pattern chart.**
3. Produces a printable grid with coordinates, a color-key legend with counts per color,
   and configurable cell size.

Nearly free given an indexed grid plus a palette, and reaches a non-gaming audience.

---

## Cross-cutting requirements

| Requirement | Applies to | Source |
|---|---|---|
| Nothing leaves the machine without an explicit prompt | all | `00` §7.1 |
| Every automated result lands on an editable layer | W1, W7 | `00` §7.5 |
| Undo works across mode switches | all | `03` §6 |
| Preview labelled when approximate | W1, W6 | `02` §3.3 |
| Cancellable long operations | W1, W5 | `02` §8 |
