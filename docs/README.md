# Tesserica — Documentation

Design knowledge base for **Tesserica**, a pixel art editor and image→pixel-art converter.

**Status: reviewed, core decisions locked (2026-07-26).** See `10-decisions.md` for what
is settled and `09-open-questions.md` for the four questions still awaiting measurement.

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 00 | [Vision & Scope](00-vision-and-scope.md) | What we're building, for whom, and what we're deliberately not building |
| 01 | [Reference Analysis](01-reference-analysis.md) | What Pixelorama, Pixel It, Pixel Art Village, PixelMe, Pixellab, pixie.haus, Aseprite and Lospec each do, and what we take from each |
| 02 | [Architecture](02-architecture.md) | Tauri v2 process model, the hybrid canvas-preview / Rust-export split, IPC design, risks |
| 03 | [Data Model](03-data-model.md) | Sprite / layer / frame / cel model, palettes, tilemaps, undo, `.tess` file format |
| 04 | [Image Pipeline](04-image-pipeline.md) | **Normative algorithm spec** — pipeline order, Oklab, quantization, dithering, background removal |
| 05 | [UI & Design](05-ui-design.md) | Mode structure, layouts, design tokens, interaction rules, accessibility |
| 06 | [Workflows](06-workflows.md) | Nine end-to-end user journeys the app must support |
| 07 | [Tech Stack](07-tech-stack.md) | Verified dependency versions, repo layout, testing, packaging, licensing |
| 08 | [Roadmap](08-roadmap.md) | Eight phases, each ending in something usable |
| 09 | [Open Questions](09-open-questions.md) | The four questions still deferred, and when each gets decided |
| 10 | [Decision Log](10-decisions.md) | **Locked decisions and why** — read before changing anything structural |

## User guides

Everything above is the design specification — read it to understand *why* Tesserica is
built the way it is. The document below is different: it's task-oriented, written for
someone using the app, not building it.

| # | Document | What it answers |
|---|---|---|
| 11 | [Editor Guide](11-editor-guide.md) | How to use Edit mode: tools, layers, palettes, the timeline, tilemaps, undo, export |

## The short version

Tesserica is **both** a Pixelorama-style pixel art editor **and** a high-quality
image→pixel-art converter, plus practical utilities (background removal, smart crop).

The thesis is the **seam between the two halves**: every existing converter is a dead end
that dumps a PNG in your Downloads folder, and every existing editor assumes you already
have pixel art. Here, conversion is the first step of an editing session — convert a
photo, then fix by hand what automation got wrong, then animate it, then export a
spritesheet, without leaving the app.

**Architecture in one line:** the frontend renders what you *see* (fast, approximate,
Canvas2D in a Web Worker); Rust produces what you *ship* (full resolution, exact,
`rayon`-parallel).

**Local-first.** No image leaves the machine. Every reference converter with good UX is a
web app; that is a real differentiator, not just an implementation detail.

## Locked decisions at a glance

| | |
|---|---|
| Name | **Tesserica** (from *tessera*, a mosaic tile) |
| License | **MIT** |
| Project file | **`.tess`** (ZIP archive) |
| Build order | **Editor first**, converter second |
| Platform | **Linux only for now** |
| Modes | **Convert \| Edit** — animation is a panel inside Edit |
| Generative AI | **Never** (local background removal is unaffected) |
| Color mode | **RGBA only in v1**; indexed deferred to Phase 7 |

Full rationale in [10-decisions.md](10-decisions.md).

## Conventions

- ⚠️ marks a risk or a caveat that should not be skimmed past.
- Cross-references use `NN-filename.md §N`; decisions use `D<n>`.
- `04-image-pipeline.md` is **normative** — the TS and Rust pipelines must both conform to
  it, and the golden-image test suite exists to enforce that.
- Version numbers in `07-tech-stack.md` were verified 2026-07-26. Re-verify before
  scaffolding.
