# Golden parity corpus

The highest-value test in the project (`docs/04-image-pipeline.md` §11,
`docs/02-architecture.md` §3.3).

The pipeline is implemented twice — `src/pipeline/` in TypeScript for live
preview, `src-tauri/src/pipeline/` in Rust for full-resolution export. The
failure mode that matters is **preview/export divergence**: the user approves a
preview and exports something different. This corpus is the only thing standing
between the codebase and that happening silently.

## Layout

| Directory   | Contents                                  | Committed?    |
| ----------- | ----------------------------------------- | ------------- |
| `sources/`  | input images — small, varied, alpha-heavy | ✅ yes        |
| `expected/` | reference output per source × settings    | ✅ yes        |
| `actual/`   | output from the current run               | ❌ gitignored |

## Comparison rules

- **Non-dithered modes must match exactly.** Any difference is a bug.
- **Dithered modes are compared structurally.** Error diffusion is legitimately
  resolution-dependent, so Floyd–Steinberg and Atkinson output from a 1024px
  proxy will not be byte-identical to full-resolution output. Compare
  distributions and palette usage, not bytes.

## Status

Harness lands in **Phase 2**, alongside the first pipeline stage rather than
after it (`docs/08-roadmap.md` Phase 2). `npm run test:golden` is wired from
Phase 0 and currently reports todos.

Run with:

```bash
npm run test:golden
```
