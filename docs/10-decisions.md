# Decision Log

> Locked decisions and their rationale. **Locked means locked** — reopening one is a
> deliberate act that requires updating this file and every document it touches.
>
> Format: one entry per decision, with the alternatives that were rejected and why.

---

## D1 · Product name: **Tesserica**

**Locked 2026-07-26.** Resolves `09-open-questions.md` Q1.

From *tessera* — the individual tile in a mosaic. A pixel is exactly that, and the name
covers **both halves of the app** rather than only the converter, which
`pixel-art-generator` did not.

**Derived identifiers:**
- Bundle identifier: `com.tesserica.app` *(provisional — adjust if you own a domain)*
- Window title / product name: `Tesserica`
- Repo name: `tesserica`

---

## D2 · License: **MIT**

**Locked 2026-07-26.** Resolves Q2.

Rejected: Apache-2.0 (patent grant not worth the extra paperwork here), GPL-3.0
(copyleft would block commercial game studios from adopting it, which is our primary
audience).

**Bundled-asset constraints carry over unchanged and are not affected by this choice:**
- ✅ Hardware palettes (Game Boy, NES, CGA, C64) — factual color lists, safe to ship
- ❌ Artist-made Lospec palettes — individual licenses; users import their own
- ❌ BRIA RMBG model — non-commercial only, never bundle
- ✅ U2-Net / `u2netp` — Apache-2.0, safe to bundle

---

## D3 · Project file extension: **`.tess`**

**Locked 2026-07-26.** Resolves Q1's dependent placeholder; replaces `.pxlab` throughout.

Rejected: `.tsr` (cryptic, collides visually with `.tsv`/`.tar`), `.tessera` (too long,
unusual on Windows).

Format is unchanged from `03-data-model.md` §7 — a ZIP archive:

```
character.tess
├── manifest.json     formatVersion, app version, sprite metadata
├── sprite.json       layers, frames, tags, slices, palette (no pixels)
├── cels/             raster cels as PNG
├── sources/          original images for conversion layers
└── thumbnail.png     256×256
```

---

## D4 · Build order: **editor first, then converter**

**Locked 2026-07-26.** Resolves Q-priority. `08-roadmap.md` sequencing stands as written.

Phase 1 = editor core → Phase 2 = conversion.

**Rationale:** the converter's output has to land on a layer. Building conversion first
means building its UI twice — once standalone against a PNG export, once rebuilt onto the
layer model. The layer model must exist first.

**Accepted cost:** no visually impressive demo until Phase 2. Phase 1 ends with a working
but plain pixel editor (workflow W2).

Rejected: converter-first (faster demo, guaranteed rework), thin-slice-of-both (proves
the seam earliest but leaves neither half usable for real work for longer).

---

## D5 · Target platform: **Linux only for now**

**Locked 2026-07-26.** Resolves Q-platforms.

Only the dev machine is verified. `webkit2gtk-4.1` confirmed present.

**Consequences:**
- CI runs Linux only; no cross-platform matrix yet.
- The Phase 3 cross-platform verification item in `08-roadmap.md` is **deferred**, not
  deleted — Windows and macOS remain the eventual goal.
- ⚠️ **Standing risk:** Tauri uses the OS WebView, so Canvas and `OffscreenCanvas`
  behaviour differs across platforms. Building Linux-only means those differences surface
  *later and in bulk* rather than incrementally.
- **Mitigation:** avoid WebView-specific APIs; prefer plain Canvas2D; note anything that
  smells platform-dependent in code comments so the eventual port has a trail to follow.

---

## D6 · Convert is a **top-level mode**

**Locked 2026-07-26.** Resolves Q4.

Mode switcher is **`Convert | Edit`** — two modes, not three (see D7).

```
≡  [ Convert │ Edit ]                          ⚙  ◑  ─ □ ✕
```

**Rationale:** workflow W6 (casual user, photo → export in 10 seconds) is a real
requirement. A dialog reached from inside a full editor cannot serve it — the user would
have to pass through the editor UI to get to the thing they came for. As a mode, the app
opens directly into Convert when an image is dropped and the casual user never sees a
layer panel.

Rejected: dialog inside Edit (simpler mental model, but fails W6).

**The `[ Edit → ]` button remains the product thesis in one control** — it creates a
conversion layer and switches modes, losslessly.

---

## D7 · Animate is a **panel inside Edit**, not a mode

**Locked 2026-07-26.** Resolves Q5. **This changes `05-ui-design.md` §2 and §5 as drafted.**

The timeline is a toggleable bottom panel within Edit mode.

**Rationale:** the drafted Animate mode shared Edit's canvas, tools, layers and palette
entirely — the only difference was the timeline. A mode that is 90% identical to another
mode is not a mode. As a panel it is honest about what it is, and it keeps the switcher
at two entries.

**Consequence:** the layer×frame cel grid still needs the full timeline UI in Phase 4;
only its *container* changed. The data model (`03-data-model.md` §2.2) is unaffected.

---

## D8 · Generative AI: **never**

**Locked 2026-07-26.** Resolves Q11. Strengthens `00-vision-and-scope.md` §6 from
"not in v1/v2" to a permanent scope boundary.

No text→sprite, no image-to-image generation, no plugin seam reserved for it.

**Rationale:** it would require hosted models, GPUs, accounts and billing — a different
product with a different cost structure. Tesserica is a local-first craft tool.

**Explicitly unaffected:** local ONNX **background removal** stays in scope (Phase 5).
That is a small discriminative model running on the user's machine, not generative AI,
and it never sends an image anywhere.

**Consequence:** Convert mode needs no plugin architecture. Simpler.

---

## D9 · v1 ships **RGBA only**; indexed color deferred

**Locked 2026-07-26.** Resolves the color-mode question.

`Cel.data` is `{ kind: 'raster', pixels: Uint8ClampedArray }` for all v1 work.

**Rationale:** indexed mode touches every tool, every blend mode, every effect, and needs
a policy for "user picked a color not in the palette". RGBA keeps Phase 1 tractable.

**Preserved for later:** `colorMode` stays in the `Sprite` type and `CelData` keeps its
`indexed` variant, so adding it in Phase 7 is an extension, **not a migration**.

**Deferred with it:** instant palette swapping (the retro team-color trick). Worth being
clear that this is a real feature we are choosing to postpone, not one we forgot.

---

## D10 · Hand-roll Oklab in both languages

**Locked 2026-07-26** (my call — Q6, low-stakes technical decision).

`src/pipeline/oklab.ts` and `src-tauri/src/pipeline/oklab.rs`, written from **identical
constants**, rather than using the `palette` crate on the Rust side.

**Rationale:** the TS side must hand-roll regardless, and the two implementations have to
agree closely enough to pass golden-image parity tests. Deriving both from the same
constants makes parity *structural* rather than hoped-for. It is ~30 lines each.

---

## D11 · Aseprite: **import only**, no export

**Locked 2026-07-26** (my call — Q12).

Phase 6 implements `.ase` reading. Writing is not planned.

**Rationale:** the format is rich, and round-tripping it badly is worse than not
supporting it. Users who own Aseprite overwhelmingly want to bring work *in*.

---

## Still open — deferred, not decided

These genuinely need measurement rather than a preference, and each is scheduled:

| # | Question | Decide at |
|---|---|---|
| Q7 | How hand-drawn editor layers cross IPC on export (custom protocol vs Channel vs temp file) | **Phase 2** — benchmark all three with 10 layers × 512×512 |
| Q8 | Canvas2D vs WebGL2 renderer | **Phase 4** — measure animation playback first |
| Q9 | ONNX Runtime size vs installer budget | **Phase 5** — leaning "download on first use" |
| Q10 | Which segmentation model ships (`u2netp` 4.7 MB vs `isnet-general-use` 170 MB) | **Phase 5** — benchmark at 64×64 output first; the small one may be indistinguishable |
| Q13 | Plugin / scripting API | Post-v2. Keep the effect system data-driven so it stays a natural extension point |

---

## Summary

| # | Decision |
|---|---|
| D1 | Name: **Tesserica** |
| D2 | License: **MIT** |
| D3 | Extension: **`.tess`** |
| D4 | **Editor first**, converter second |
| D5 | **Linux only** for now |
| D6 | Convert is a **top-level mode** |
| D7 | Animate is a **panel inside Edit** |
| D8 | Generative AI: **never** |
| D9 | **RGBA only** in v1 |
| D10 | **Hand-roll Oklab** in both languages |
| D11 | Aseprite **import only** |
