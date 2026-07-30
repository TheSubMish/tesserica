# Tesserica

A Linux desktop app that is **both** a pixel art editor (layers, frames, tilemaps,
palettes) **and** an image→pixel-art converter — plus background removal and smart
cropping. Built with Tauri v2, React and Rust.

The name is from _tessera_, the individual tile in a mosaic.

> **Status: Phases 0–2 complete, Phase 3 (v1 release) underway.** Draw with seven tools
> across layers with the full W3C blend-mode set, pick from bundled or imported
> palettes, drop a photo in and convert it live, and keep editing the result as a
> layer whose settings stay live. See `docs/08-roadmap.md` for what is and is not
> built yet.

## What makes it different

Conversion produces a **live, re-editable layer inside a real editor** rather than
dumping a PNG. The `[ Edit → ]` button in Convert mode is the concrete expression of
that.

## Documentation

`docs/` is the specification, not background reading. Start at
[`docs/README.md`](docs/README.md).

- [`docs/04-image-pipeline.md`](docs/04-image-pipeline.md) is **normative** — it
  specifies the pipeline for both the TypeScript and the Rust implementation.
- [`docs/10-decisions.md`](docs/10-decisions.md) is the decision log. D1–D11 are locked.

## Building

Requires Rust 1.89+, Node 22+ and `webkit2gtk-4.1`. Linux only for now
(`docs/10-decisions.md` D5).

```bash
npm install
npm run tauri dev      # hot-reload frontend, rebuild Rust on change
npm run tauri build    # .deb + .AppImage
```

### Optional: background removal's bundled model

`npm run models:fetch` downloads the small `u2netp.onnx` segmentation model
(~4.7 MB, Apache-2.0) into the gitignored `assets/models/` — a one-time,
network-requiring, developer-side step (see `assets/models/README.md`). AI
background removal degrades cleanly to the flood-fill fallback without it.

## Checks

```bash
npm run verify         # format, lint, typecheck, tests, build, clippy, cargo test
npm run test           # vitest — frontend + TS pipeline
npm run test:golden    # cross-implementation parity suite (Phase 2 onward)
```

`npm install` points `core.hooksPath` at `.githooks/`, so format, lint and unit tests
run before every commit. Bypass with `git commit --no-verify`, or `SKIP_RUST=1` to skip
only the slow cargo half.

## License

MIT — see [LICENSE](LICENSE). Bundled assets carry their own constraints; see
`docs/07-tech-stack.md` §8 before adding any.
