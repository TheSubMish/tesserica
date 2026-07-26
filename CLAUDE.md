# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Pre-implementation.** As of 2026-07-26 this repo contains `docs/`, `CLAUDE.md` and
`LICENSE` — no application code. There is no `package.json`, no `src/`, and no
`src-tauri/`. Git is initialized on `main`.

Phase 0 of `docs/08-roadmap.md` is scaffolding the Tauri app. Until that lands, **the
build/test commands below do not exist yet** — do not run them expecting them to work,
and do not tell the user they passed.

## The docs are the source of truth

`docs/` is not background reading; it is the spec. Before implementing anything, read the
relevant document. Start at `docs/README.md`.

**`docs/04-image-pipeline.md` is normative.** It specifies the image pipeline for *both*
implementations (see below). Changing pipeline behaviour means changing that document
first, then both implementations, then the golden tests.

**`docs/10-decisions.md` is the decision log.** Eleven decisions are locked (D1–D11).
Locked means locked — reopening one requires updating that file and every document it
touches. `docs/09-open-questions.md` holds the four that remain deferred; each is
scheduled against a phase and **must be settled by measurement, not intuition**.

## What this app is

**Tesserica** — a Tauri v2 desktop app that is **both** a pixel art editor
(Pixelorama-style: layers, frames, tilemaps, palettes) **and** an image→pixel-art
converter, plus utilities (background removal, smart crop). Name is from *tessera*, the
individual tile in a mosaic.

The product thesis is the **seam between the two halves**: conversion produces a live,
re-editable layer inside a real editor, rather than dumping a PNG. The `[ Edit → ]`
button in Convert mode is the concrete expression of this. When a design decision is
ambiguous, favour the one that keeps convert→edit continuous.

## Locked scope (docs/10-decisions.md)

| | |
|---|---|
| License | **MIT** |
| Project file | **`.tess`** — ZIP archive |
| Build order | **Editor first** (Phase 1), converter second (Phase 2) |
| Platform | **Linux only for now** — no cross-platform CI yet |
| Modes | **`Convert \| Edit`** — two modes. Animation is a *panel inside Edit*, not a third mode |
| Generative AI | **Never.** No text→sprite, no plugin seam for it. Local ONNX background removal is unaffected and stays in scope |
| Color mode | **RGBA only in v1.** `indexed` variants stay in the types so Phase 7 is an extension, not a migration — but nothing implements them |

Two consequences worth internalizing: **do not build indexed-color code paths in v1**, and
**do not add a third mode for animation**.

## Architecture: the hybrid split

**The frontend renders what you *see*; Rust produces what you *ship*.**

- **TS + Canvas2D, in a Web Worker** — live conversion preview, all drawing tools, layer
  compositing for display. Operates on a **downscaled proxy** (~1024px) and is
  deliberately approximate.
- **Rust + `rayon`** — full-resolution export, ONNX inference, file encode/decode.

Two consequences that drive most of the codebase:

### 1. The pipeline is implemented twice

`src/pipeline/` (TS) and `src-tauri/src/pipeline/` (Rust) **mirror each other** — same
module names, same function names, same parameter structs. This is intentional, so the
two can be reviewed side by side.

The risk this creates is **preview/export divergence** — the user approves a preview and
exports something different. The golden-image test suite (`docs/04` §11) exists solely to
prevent this and should be built alongside the first pipeline stage, not after.
Non-dithered modes must match exactly; dithered modes are compared structurally, because
error diffusion is legitimately resolution-dependent.

When you touch one implementation, touch the other in the same change.

### 2. Never send pixel buffers through Tauri IPC

Tauri serializes commands to JSON. A 12 MP RGBA image is 48 MB; passing it through
`invoke()` costs more than the image processing itself and would make the Rust path
*slower* than doing everything in JS.

- Source images are opened by Rust and **stay in Rust**. The frontend holds a `SourceId`
  handle plus a small proxy for preview.
- Export sends a `DocumentSnapshot` (metadata only) and Rust re-runs the pipeline from
  the source it already holds.
- Bulk data flowing back uses Tauri v2 Channels, not command return values.

See `docs/02-architecture.md` §6.2. How hand-drawn *editor* layers cross the boundary on
export is **still open (Q7)** — benchmark custom protocol vs Channel vs temp file in
Phase 2 with ~10 MB of layers. Do not guess.

## Invariants

These are not style preferences; violating them produces visibly wrong pixel art.

1. **Nearest-neighbour on every pixel-art path.** No bilinear/bicubic upscale, ever.
   Rotation and non-integer scaling need pixel-art-aware algorithms (rotxel, cleanEdge) —
   never naive resampling.
2. **Integer scale factors on export** (1×/2×/4×/8×). Non-integer scaling produces uneven
   block sizes and is instantly visible.
3. **Straight alpha throughout, never premultiplied.** Premultiplication plus palette
   quantization causes color fringing on transparent edges.
4. **Alpha-weight box downscaling.** Averaging a transparent pixel's RGB bleeds dark
   fringes into every edge. This is the most common bug in naive converters.
5. **All color distance and error diffusion happen in Oklab**, not sRGB. sRGB nearest-
   color is perceptually wrong.
6. **The pipeline order in `docs/04` §2 is fixed** and identical in both implementations.
   Adjustments come *before* quantization deliberately.
7. **No network calls in the core.** Model download and Lospec fetch are the only network
   features, both explicitly user-initiated. Local-first is a stated product promise.

### Subtle trap

The nearest-color lookup cache (`docs/04` §4.2) keyed on quantized RGB is **invalid for
error-diffusion dithering** — the cache rounds away the very error being propagated. Use
it for `none` and ordered dithering only; compute directly for Floyd–Steinberg and
Atkinson.

## Data model

Adopted from Aseprite: **layers and frames are independent axes; a Cel is their
intersection** and holds the actual pixels. Cels are sparse, bounded (can be smaller than
the sprite), and linkable (shared across frames). This is what makes animation memory
tractable — see `docs/03-data-model.md` §9.

`Layer` is a discriminated union on `kind` (`raster` | `group` | `tilemap` |
`conversion`). The `conversion` variant holds a source handle plus live settings and is
what makes convert→edit non-destructive. Rust mirrors this with
`#[serde(tag = "kind")]` so the wire format needs no translation layer.

**Keep pixel data out of React state.** Layer buffers are plain `Uint8ClampedArray`s
referenced by the zustand store; only metadata (name, opacity, visibility) is reactive.

**Undo is command-pattern with dirty-rect deltas**, not document snapshots — snapshots
would be ~300 MB for a 20-step history on a modest animated sprite. One drag coalesces
into one undo step.

## Commands (once Phase 0 lands)

```bash
npm install
npm run tauri dev      # hot-reload frontend, rebuild Rust on change
npm run tauri build    # production bundle

npm run test                  # vitest (frontend + TS pipeline)
npm run test -- <pattern>     # single test file
npm run test:golden           # cross-implementation parity suite

cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml <name>   # single test
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

`npm run test:golden` is the highest-value test in the project — it is the only thing
standing between the codebase and silent preview/export divergence.

## Dependency notes

Versions in `docs/07-tech-stack.md` were verified against npm and crates.io on
2026-07-26. **Re-verify before scaffolding.** Two carry real risk:

- **`ort` (ONNX runtime) has no stable release** — latest is `2.0.0-rc.12`. Pin the exact
  version and keep it isolated behind `src-tauri/src/segment/`. Background removal is
  Phase 5 and has a non-ML flood-fill fallback, so it degrades rather than blocks.
- **TypeScript 7.0 is the native Go compiler port.** Fast but new; falling back to latest
  5.x is legitimate if tooling friction appears.

Deliberately avoided: component libraries (the UI is almost entirely custom canvas/rails/
timelines), canvas frameworks like Konva/Fabric/PixiJS (built for scene graphs; we have a
pixel buffer), Redux, and **the `palette` crate** — Oklab is hand-rolled in both
languages from identical constants (D10) so golden-test parity is structural.

## Bundled-asset licensing

The project is MIT, but bundled assets have their own constraints:

- ✅ Hardware palettes (Game Boy, NES, CGA, C64) — factual color lists, safe to bundle
- ❌ **Artist-made Lospec palettes** — individual licenses; users import their own
- ✅ U2-Net / `u2netp` — Apache-2.0
- ❌ **BRIA RMBG** — non-commercial only, never bundle

Verify any additional model's license before shipping it.
