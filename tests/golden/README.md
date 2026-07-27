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

There are two comparisons, and they answer different questions.

**`convert.parity.test.ts` — same bytes, same size, every mode matches exactly.**
"Exactly" means **identical palette indices** (D12), not identical floats, which
are unachievable across libms. Error diffusion is included: at equal resolution
it is fully deterministic, so there is no reason to accept less.

**`dither.structural.test.ts` — different resolutions, compared structurally.**
This is the shipping situation: preview runs TS on a proxy, export runs Rust on
the original. Error diffusion is genuinely resolution-dependent there, so the
assertion is on the _distribution_ of palette indices rather than on pixels.

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

### Full-pipeline parity — 2026-07-27

`convert.parity.test.ts`, writing `actual/convert-parity.json`:

|                      |             |
| -------------------- | ----------- |
| Cases                | **3,051**   |
| Pixels compared      | **911,520** |
| Differing indices    | **0**       |
| Differing RGBA bytes | **0**       |

The matrix is 7 sources × 8 bundled palettes × 3 pixel sizes × 3 downscale modes
× 6 dither modes, plus 61 edge cases covering adjustments, crop, fit-to-subject,
despeckle, outline, sRGB distance, `preserveAlpha`, fractional dither strength,
and the **auto palette** at four colour counts on every source.

The auto-palette cases are the highest-risk in the suite: Wu's greedy split and
eight k-means iterations have to agree exactly across two languages, and a
divergence there would change the palette itself rather than one pixel's
assignment within it. They pass with zero differing indices.

Checked against a deliberately changed rounding mode in the TS box downscale
(`round` → `floor`): 70 cases fail, each naming the differing pixel and both
implementations' index.

### Preview/export divergence under dithering — 2026-07-27

`dither.structural.test.ts`, writing `actual/dither-structural.json`. TS converts
a half-resolution proxy, Rust converts the full source, both to the same output
size; the metric is total variation distance between palette-usage histograms.

|                                                        |           |
| ------------------------------------------------------ | --------- |
| Worst case (`gradient`, NES 54-color, Floyd–Steinberg) | **0.109** |
| Bound asserted                                         | 0.2       |
| Cases                                                  | 84        |

Ordered dithering diverges an order of magnitude less than error diffusion,
which is `docs/04` §5.3's resolution-independence claim measured rather than
assumed. **This number is the honest size of the preview/export risk** for
dithered conversions, and it is the one to re-check if the proxy resolution ever
changes.
