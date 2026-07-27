# Golden parity corpus

The highest-value test in the project (`docs/04-image-pipeline.md` §11,
`docs/02-architecture.md` §3.3).

The pipeline is implemented twice — `src/pipeline/` in TypeScript for live
preview, `src-tauri/src/pipeline/` in Rust for full-resolution export. The
failure mode that matters is **preview/export divergence**: the user approves a
preview and exports something different. This corpus is the only thing standing
between the codebase and that happening silently.

```bash
npm run test:golden      # run the suite
npm run golden:corpus    # regenerate sources/ from corpus.ts
```

## How it fits together

| File                                      | Role                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `corpus.ts`                               | Pure, deterministic renderers for the seven sources                      |
| `../../scripts/generate-golden-corpus.ts` | Writes `sources/` from those renderers                                   |
| `runner.ts`                               | Plumbing: reads sources, shells out to Rust, reads payloads back         |
| `../../src-tauri/examples/golden.rs`      | The Rust half — a `cargo` **example**, so it is linted but never shipped |
| `*.test.ts`                               | The comparisons themselves                                               |

**Adding a pipeline stage means adding a job `kind` to `golden.rs` _and_
`runner.ts` in the same change.** One without the other is a stage with no
parity coverage, which is exactly the situation this corpus exists to prevent.

## Layout

| Directory   | Contents                                  | Committed?    |
| ----------- | ----------------------------------------- | ------------- |
| `sources/`  | input images — small, varied, alpha-heavy | ✅ yes        |
| `expected/` | reference output per source × settings    | ✅ yes        |
| `actual/`   | output from the current run               | ❌ gitignored |

### Why the sources are `.rgba`, not `.png`

Each source is committed twice: `<name>.rgba` (raw straight-alpha RGBA) and
`<name>.png` (the same pixels, so a human can look at the corpus).

**Both implementations read the `.rgba`.** That puts _identical bytes_ into the
two pipelines, so a parity failure can only ever be a pipeline bug — never a
disagreement between two PNG decoders, which is a real risk worth designing out
of a test whose entire job is attributing differences.

The `.png` is not decoration that can rot: the Rust runner's `sourceIntegrity`
job decodes it and asserts it matches the `.rgba` byte for byte.

### Why the sources are synthetic

`docs/04` §11 asks for photo (portrait), photo (landscape), flat illustration,
existing pixel art, image with alpha, high-contrast graphic, and gradient. All
seven are **synthesized deterministically** by `corpus.ts` rather than being
real photographs — real ones bring licensing questions and repository weight,
and a corpus nobody can regenerate rots. Each synthetic source is built to
stress the property its real-world category would: smooth tonal ramps with fine
grain, hard flat edges, an already-upscaled sprite grid, a soft alpha edge over
transparent _green_ (so an unweighted box average is glaring rather than
subtle).

They are small — 128×128 at the largest. The properties under test are
per-pixel, so a 128px source proves what a 4000px one would at a thousandth of
the cost.

## Comparison rules

- **Non-dithered modes must match exactly** — meaning **identical palette
  indices**, not identical floats (D12). Bit-identical floats across the two
  languages are unachievable; see below.
- **Dithered modes are compared structurally.** Error diffusion is legitimately
  resolution-dependent, so Floyd–Steinberg and Atkinson output from a 1024px
  proxy will not match full-resolution output. Compare palette-usage
  distributions, not bytes.

## Measurements

### Oklab, TS `f64` vs Rust `f64` — 2026-07-27

Over all 76,800 pixels of the corpus (`oklab.parity.test.ts`, which rewrites
`actual/oklab-parity.json` on every run):

|                                      |                           |
| ------------------------------------ | ------------------------- |
| Max absolute divergence, any channel | **6.661338147750939e-16** |
| Bit-identical pixels                 | **77.92%**                |

This reproduces D12's independent 4,096-sample experiment to the digit, and it
is why D12 defines parity on palette indices: identical constants buy identical
_values_ to 6.7e-16, but they do not buy identical _bits_, because `cbrt` and
`powf` come from different libms in Rust and V8.

The suite asserts a 1e-12 bound — six orders of magnitude above what is
observed, and three below the 1e-9 nearest-colour tie-break that has to absorb
it. Reintroducing `f32` on the Rust side (3.6e-7) would breach it by five orders
of magnitude.

The suite has been checked against a deliberately injected 1e-9 offset in
`golden.rs`: it fails, and names the source and pixel index.
