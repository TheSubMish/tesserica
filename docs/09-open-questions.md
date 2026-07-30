# Open Questions

> Status: **most questions resolved 2026-07-26** · See `10-decisions.md` for locked decisions.
>
> This file now tracks **only what is still genuinely undecided.** Everything else moved
> to the decision log.

---

## Resolved — see `10-decisions.md`

| Was | Now | Decision |
|---|---|---|
| Q1 Product name | **Tesserica** | D1 |
| Q2 License | **MIT** | D2 |
| Q3 Git repository | ✅ initialized | — |
| — File extension | **`.tess`** | D3 |
| — Build order | **Editor first** | D4 |
| — Target platforms | **Linux only for now** | D5 |
| Q4 Convert: mode or dialog | **Top-level mode** | D6 |
| Q5 Animate: mode or panel | **Panel inside Edit** | D7 |
| Q6 Oklab: hand-roll or crate | **Hand-roll both** | D10 |
| Q11 Generative AI | **Never** | D8 |
| Q12 Aseprite export | **Import only** | D11 |
| Q7 Editor layers over IPC | **Raw invoke body** | D13 |
| — Color mode | **RGBA only in v1** | D9 |
| Q8 Canvas2D or WebGL2 renderer | **Canvas2D holds** | D14 |
| Q9 ONNX Runtime size vs installer budget | **Download on first use** | D16 |

---

## Still open — needs measurement, not preference

These are deliberately deferred. Each is scheduled against a phase where the
information needed to decide will actually exist. **Do not resolve them by intuition.**

### Q10 · Which segmentation model ships by default?

**Decide in Phase 5.**

`u2netp` (4.7 MB) vs `isnet-general-use` (170 MB).

**Method:** benchmark both *on 64×64 pixel-art output*, not on full-resolution mattes.
The insight in `04-image-pipeline.md` §8.4 is that downscaling 60× and snapping alpha to
1-bit hides most mask imperfection — wispy hair edges simply do not survive to the output.
**The small model may be indistinguishable, in which case we skip the download entirely.**

⚠️ **License check is mandatory before bundling any model.** U2-Net is Apache-2.0 (safe);
BRIA RMBG is non-commercial only (never bundle).

---

## Deferred past v2

### Q13 · Plugin / scripting API

Both Pixelorama (custom effects) and Aseprite (Lua) have one.

Not before v2. **Keep the effect system data-driven** (`03-data-model.md` §5) so it stays
a natural extension point rather than a rewrite.

Note that D8 (no generative AI) means no plugin seam is needed in Convert mode — this
question is only about the *editor's* effect system.

### Panel docking behaviour

Floating vs docked panels, and whether panels should be detachable into separate windows
at all. Lower stakes given the Linux-only target (D5). Decide during Phase 3 polish.
