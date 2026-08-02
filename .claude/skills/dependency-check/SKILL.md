---
name: dependency-check
description: Version-pinning risk notes and deliberately-avoided libraries for Tesserica. Use before adding or upgrading a dependency, or when scaffolding new setup.
---

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
