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

**Update, Phase 7 (2026-08-01): implemented.** `docs/03-data-model.md` §3's own callout
has the full account — storage (`model/indexBuffers.ts`, `model/celStorage.ts`), the
out-of-palette policy (nearest colour in Oklab, `model/indexedColor.ts`), which tools were
converted, the blend-mode/effects scope boundary (both resolve indices to RGBA first,
unchanged otherwise), and the `.tess` wire format. Live palette swapping — the feature
this decision named as postponed — is real: `history/paletteCommands.ts` +
`panels/PalettePanel.tsx`.

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

## D12 · Oklab is **`f64` on both sides**; parity is measured in **palette indices**

**Locked 2026-07-27** (my call — a measurement, not a preference). Follows from D10.

D10 says both implementations are hand-rolled from identical constants so that parity is
structural. Before writing any pipeline code we measured what "structural" can actually
buy us. Over 4,096 RGB samples (a 16³ grid, step 17) plus all 256 greys, using Ottosson's
published matrices:

| Comparison | Max absolute divergence in any Oklab channel |
|---|---|
| Rust `f32` vs Rust `f64` | **3.625e-7** |
| Rust `f64` vs JS `f64` | **6.661e-16** |

Bit-identical rate for Rust `f64` vs JS `f64` was 70–81% depending on the channel —
**never 100%**. `cbrt` and `powf` are not IEEE-754-specified to be correctly rounded, and
Rust's libm and V8's are different implementations, so exact float equality across the two
languages is unachievable no matter how identical the constants are.

Three consequences, all now normative in `04-image-pipeline.md`:

1. **The Rust pipeline uses `f64`, not `f32`** (`04` §4.1, §5.1). A 3.6e-7 divergence is
   small perceptually but is large enough to flip a nearest-colour `argmin` when two
   palette entries are within 3.6e-7 of equidistant — which then changes an *output pixel*,
   not a rounding digit. The 6.7e-16 `f64` residual cannot reach that far given the
   tie-break below. Memory cost is irrelevant: the working buffer is a proxy at preview
   scale and a scanline window at export scale.

2. **"Exact match" in the golden suite means identical palette indices**, not identical
   floats (`04` §11). Comparing floats bitwise across libms would fail on correct code.
   Indices are what the user sees, and they are integers.

3. **Nearest-colour uses a deterministic tie-break** (`04` §4.2): a candidate wins only if
   `d < best - 1e-9`, so near-ties resolve to the *lowest palette index* in both languages.
   Distances are squared Oklab, so 1e-9 there is ~3.2e-5 in Oklab units against a JND of
   roughly 0.002 — the epsilon is ~60× too small to change a choice a human could see, and
   ~10⁹× larger than the cross-language residual it exists to absorb. Exact ties are not
   hypothetical: a mid-grey landing exactly between two entries of a bundled grayscale ramp
   hits one.

**Consequence for the constants:** they live once, in `shared/oklab.constants.json`, and
each language's unit tests assert their own literals against that file. Editing one
implementation without the other fails a test in the language that was not edited.

Rejected: `f32` in Rust with a wider tie-break epsilon (an epsilon big enough to absorb
3.6e-7 in squared distance is within an order of magnitude of a JND — it would start
making visible choices); requiring bit-identical floats (unachievable, see above);
shipping our own `cbrt` (correctly-rounded cube root is real work for no user-visible gain
once parity is defined on indices).

---

## D13 · Editor layers cross IPC on the **raw invoke body**

**Locked 2026-07-27.** Resolves `09-open-questions.md` Q7, by measurement.

Q7 listed three candidates — custom Tauri URI protocol, Tauri v2 Channels, temp file
handoff — for getting hand-drawn editor layers into Rust on export. Two are eliminated
before any stopwatch, on **capability** rather than speed:

- **Channels are the wrong direction.** A Tauri v2 `Channel` is created in JavaScript and
  handed *to* Rust, which sends through it. There is no frontend→Rust channel. Q7 asks
  about the inbound direction, so this candidate does not exist.
- **Temp file is strictly dominated.** A WebView cannot write a file itself; it must hand
  the bytes to native code first. That is *whichever IPC transport it is built on, plus a
  disk write and a disk read*. It can never beat the transport underneath it.

That leaves the raw invoke body (what `staging.rs` has used since Phase 1) against a
custom URI protocol. Both were measured **inside the real app**, against the real WebView,
because the WebView↔native bridge is the entire cost under test — a `cargo bench` would
have measured the wrong half. Payload is Q7's own figure: 10 layers × 512×512 RGBA =
10,485,760 bytes. Optimized build, five repeats:

| Transport | Median | Throughput |
|---|---|---|
| **Raw invoke body** | **26 ms** | **403 MB/s** |
| Custom URI protocol | 27 ms | 388 MB/s |
| JSON command argument | 2,533 ms | 4 MB/s |

**Decision: keep the raw invoke body.** It and the custom protocol are indistinguishable —
1 ms apart with overlapping ranges — so there is no speed argument for a second transport,
and the raw body wins on everything else: no extra URI scheme, no CORS surface, no
separate handler, and the same command surface and error type as everything else.

**The JSON row is the real result.** `02-architecture.md` §6.2's prohibition on passing
pixels through JSON command arguments was an architectural assertion; it is now a measured
**97× penalty**, and 4 MB/s would put a 48 MB source image at twelve seconds each way.

Reproduce with:

```bash
npm run build
RUSTFLAGS="-C debug-assertions=yes" cargo build --release --manifest-path src-tauri/Cargo.toml
TESSERICA_BENCH=q7 ./src-tauri/target/release/tesserica
```

The harness is `src-tauri/src/bench.rs` and `src/bench/q7.ts`, both compiled only under
`debug_assertions` — a release bundle contains no benchmark commands and no `bench://`
protocol.

---

## D14 · Canvas2D holds; **no WebGL2 renderer**

**Locked 2026-07-30.** Resolves `09-open-questions.md` Q8, by measurement, in Phase 4 as
scheduled.

Q8's own triggers were blend modes (already handled — `08-roadmap.md` Phase 3 uses native
`globalCompositeOperation` plus hand-rolled formulas where that falls short) and
"animation playback dropping frames." This decision is about the second one.

**Target fps.** No document states a numeric playback target, so one had to be chosen.
`docs/06-workflows.md` W3 step 7 uses "a uniform 12 fps" as its own walk-cycle example, and
frame-by-frame pixel-art animation is conventionally authored well under video frame rates
— 60 fps content would mean unique art on every single tick, which is not how any of the
workflows in `06-workflows.md` work. **24 fps (a ~41.7 ms budget per tick) is the target**,
chosen as the standard "reads as smooth, motion" threshold for hand-drawn animation rather
than a video-refresh number that this app's content model never asks for. 60 fps is kept
as an aspirational ceiling for interactive redraws (pointer-move while painting), not a
hard requirement, since the timeline's own scheduler (`panels/timeline.ts::startPlayback`)
retimes itself every tick against each frame's own `durationMs` rather than accumulating
drift, so an occasional slow tick delays the next frame slightly and does not compound.

**Harness.** `src/bench/animationPerf.ts` builds a synthetic worst-shaped sprite — a group
containing a clipping-mask layer (`canvas/renderer.ts::compositeScope`, the most expensive
composite path, per `02-architecture.md` §7's own prediction), 12 raster cels total, 24
independent frames (no linked cels, the worst case for cel-cache warm-up) — and times full
`CanvasView`-redraw-shaped ticks (checkerboard → onion-skin ghosts → active-frame composite
→ grid → border) with real `performance.now()` deltas against a real `<canvas>` 2D context.
Run inside a real Chromium (not Vitest/jsdom, which has no native canvas backing — see
`canvas/renderer.test.ts`'s own comment on why it stubs the context) hitting the plain Vite
dev server; no Tauri or IPC involved, so no `TESSERICA_BENCH` env var is needed. Reproduce:

```bash
npm run dev   # serves at http://localhost:1420, no Tauri required
# from a devtools console or any CDP session on that origin:
const m = await import('/src/bench/animationPerf.ts');
console.log(await m.runAnimationPerf());
```

**What was measured**, at the documented "typical" sprite size (`02-architecture.md` §7:
"typical sprite sizes (≤512×512)"), 512×512, steady state (per-cel canvases warm, so only
the composite step differs per tick — cold first-paint cost is a different question), 240
ticks:

| Scenario | p50 | p95 | mean | mean fps |
|---|---|---|---|---|
| No onion skin | 6.0–6.3 ms | 7.1–7.9 ms | 6.2–6.3 ms | **~160** |
| Onion skin, 1 before/1 after (W3's own example) | 6.1–6.6 ms | 6.5–7.1 ms | 6.1–6.7 ms | **~155–165** |
| Onion skin, 8 before/8 after (`state/uiStore.ts::MAX_ONION_SKIN_RANGE`, the worst case) | 6.5–6.6 ms | 7.2–7.9 ms | 6.6–6.8 ms | **~147–150** |

All three sit inside noise of each other, comfortably above both the 24 fps target and the
60 fps aspiration, at the size the architecture doc already calls typical.

**What the harness first found was a real bug, not just a slow path.** Before any fix,
onion skin at 8/8 recomposited all 16 ghost frames from scratch on *every* redraw —
including every pointer-move while painting with onion skin on, not only during playback —
because `tintedGhostFrame` had no cache at all:

| Scenario | mean | mean fps |
|---|---|---|
| Onion skin, 8/8, **uncached** | 111.9–112.0 ms | **~8.9** |

Well below both the 24 fps target and even a generous floor. **The fix was a targeted
cache, not a rewrite**: a per-(frame id, tint) cache in `canvas/renderer.ts`, keyed on the
same `signatureOf` string `compositeSprite`'s own single-slot cache already trusts, so a
ghost is only recomposited when the frame it names actually changes. The first version of
that fix keyed on frame id alone and looked like a win in isolation (112 ms → ~18–20 ms),
but benchmarking the *realistic* 1/1 range specifically — not just the 8/8 extreme —
exposed that it was still thrashing: a single frame is ghosted as "before" (past tint) and
"after" (future tint) at different points in every ordinary loop, so a cache keyed on frame
id alone had the two directions evict each other's entry and recompute on effectively every
touch. Keying on `(frame id, tint)` instead — bounded at 2 cached canvases per frame, not
unbounded — fixed it for real, landing at the ~6.1–6.8 ms figures in the table above.
Regression tests for exactly this (`canvas/renderer.test.ts`, "ghost caching") assert the
cache survives both-direction touches without thrashing, not just a same-request repeat.

**Pushed past "typical" as a stress point** (not the primary target, since
`02-architecture.md` §7 explicitly calls ≤512×512 typical and reserves "very large
canvases (2048²+)" as its own reassessment trigger), the same worst-case shape at 1024×1024
(4× the pixels):

| Scenario | p50 | p95 | mean | mean fps |
|---|---|---|---|---|
| No onion skin | 23.6–25.9 ms | 26.9–30.7 ms | 24.1–26.5 ms | **~38–42** |
| Onion skin, 8/8 | 36.6–49.7 ms | 43.5–63.9 ms | 37.5–51.1 ms | **~20–27** |

Still clears the 24 fps target on mean in every run, though the margin visibly narrows —
consistent with `02-architecture.md` §7's own prediction that 2048²+ is where Canvas2D
would need reassessing. A clean 2048×2048 data point was not obtained: this container's
shared desktop already carries dozens of long-lived Chrome renderer processes from
unrelated sessions (the same resource contention `08-roadmap.md`'s Linux-installer and
accessibility-pass notes already hit), and repeated attempts at that size did not return
inside a reasonable wall-clock budget. Reported honestly as unmeasured rather than guessed
— the 512×512 → 1024×1024 trend is enough to ground this decision without it.

**Decision: keep Canvas2D. No WebGL2 renderer.** At the sprite sizes this app actually
targets, the worst realistic combination (grouped layers with a clipping mask, maximum
onion-skin range) sustains ~150 fps mean after a bounded, well-tested cache fix — over 6×
the 24 fps target and comfortably past the 60 fps aspiration too. The uncached
~9 fps figure shows *something* needed fixing, but a full renderer rewrite would have been
solving the wrong layer of the problem: the bottleneck was a missing cache in application
code, not a Canvas2D throughput ceiling. `02-architecture.md` §7's own "reassess if very
large canvases (2048²+)" trigger stands as written for a future phase if the app's target
canvas size ever grows past what `00-vision-and-scope.md`/`03-data-model.md` currently
imply; nothing measured here contradicts it.

Rejected: building a WebGL2 renderer now (would have been solving for a bottleneck that
turned out to be a missing cache, not a rendering-API ceiling — see D-style precedent of
not reopening decisions on intuition); leaving the uncached onion-skin path as shipped
(measured ~9 fps is a real, user-visible failure at the feature's own advertised range,
not a hypothetical).

---

## D15 · Segmentation runtime: direct **`ort`**, not `rembg-rs`; loaded via `load-dynamic`

**Locked 2026-07-30.** Resolves the `07-tech-stack.md` §3.1 evaluation item
(`08-roadmap.md` Phase 5, "`segment` module; evaluate `rembg-rs` vs direct `ort`") by
re-checking both crates against crates.io rather than trusting the 2026-07-26 dependency
note.

**Re-verified state of `ort`.** Still no stable 2.x release: latest is `2.0.0-rc.13`
(created 2026-07-28, two days before this decision — the crate is actively maintained, not
stalled), up from the `2.0.0-rc.12` `07-tech-stack.md` recorded. License `MIT OR
Apache-2.0` (both `ort` and its `ort-sys` companion) — MIT-compatible, no GPL surface.

**`rembg-rs` evaluated, not assumed.** `07` §3.1 flagged it as worth checking before
hand-rolling. Real crates.io data (2026-07-30):

| | `rembg-rs` |
|---|---|
| Latest version | 0.1.4 |
| First published | 2025-10-23 (~9 months old) |
| Total downloads (all versions) | 747 |
| License | MIT |
| Its own `ort` dependency | `^2.0.0-rc.10` — an *older*, looser-pinned constraint than the one this project needs to hold exactly |
| Other dependencies pulled in | `imagequant` (palette/indexed-color quantization), `oxipng` (PNG recompression), `derive_builder` |

Two things make this a clear rejection, not a close call:

1. **It does not remove `ort` as a dependency, it adds a second version constraint on top
   of it.** `rembg-rs` depends on `ort ^2.0.0-rc.10`; this project would still need to
   track `ort`'s own pre-release churn, just through an extra layer that itself has had 747
   downloads total and a single maintainer.
2. **Its bundled postprocessing actively conflicts with locked decisions.** `imagequant` is
   an indexed-color quantizer — D9 ships RGBA only in v1, and quantization already happens
   in `pipeline::quantize` in both languages, in Oklab, matching `04` §4. `oxipng`
   recompresses PNGs after the fact, which this project has no use for since export already
   goes through `image`'s own PNG encoder. Using `rembg-rs` would mean either fighting its
   opinionated pipeline or carrying two unrelated dependency subtrees for no benefit over
   calling `ort` directly, where `04` §8.3's own preprocess/inference/postprocess steps can
   be implemented exactly as specified.

**Decision: depend on `ort` directly**, pinned to the exact `2.0.0-rc.13` (no caret range,
`src-tauri/Cargo.toml`), isolated entirely behind `src-tauri/src/segment/` — every other
module talks to `segment::Segmenter`, never to `ort`.

**Build-time isolation: `load-dynamic`, not `download-binaries`.** `ort`'s default feature
set includes `download-binaries`, which fetches a prebuilt ONNX Runtime binary from the
network *at build time* and links against it — a compile-time network dependency for a
crate this project wants to isolate, and a poor fit for a Linux-only app that will
eventually offer the runtime as an explicit, user-consented download (`07` §6, resolved
by D16). `Cargo.toml` instead sets `default-features = false` with `["std", "ndarray",
"load-dynamic"]`: `ort` compiles with zero system or network dependencies, and the actual
`libonnxruntime.so` is `dlopen`ed only when `Segmenter::load` is called with a real path —
which is also exactly the shape "no model bundled yet, degrade cleanly" needs, since a
missing dylib becomes an ordinary `SegmentError`, never a build failure.

**Verified in this container**, not assumed:

- `cargo check` / `cargo clippy -- -D warnings` / `cargo test` all pass with `ort` added —
  no system ONNX Runtime library was needed to get here, confirming `load-dynamic` really
  does defer everything to runtime.
- A real smoke test (`segment::tests::smoke_test_a_real_onnx_runtime_and_model_if_env_vars_point_at_them`,
  `#[ignore]`d by default since neither file is bundled or checked in) was run against a
  genuine ONNX Runtime 1.28.0 `libonnxruntime.so` (Linux x64, fetched transiently from
  `microsoft/onnxruntime`'s GitHub releases for this evaluation only — not vendored) and a
  real 176 MB `u2net.onnx` file already present on this machine from unrelated prior work.
  `Segmenter::load` `dlopen`ed the runtime and committed a real inference session in under
  a second. This is real evidence that `ort` + `load-dynamic` actually works end to end in
  this container, not just that it compiles.

Rejected: `rembg-rs` (above); linking ONNX Runtime at build time via `download-binaries`
(reintroduces a build-time network dependency and coarser isolation, for no benefit since
segmentation is never invoked from the build); hand-rolling ONNX Runtime C API bindings
directly (`ort` already is that, maintained, MIT/Apache-2.0 — there is no reason to
duplicate it).

---

## D16 · ONNX Runtime size: **download on first use** (option 1), now actually built

**Locked 2026-07-30.** Resolves `07-tech-stack.md` §6 / Q9, by measurement, in Phase 5 as
scheduled. Follows from D15.

**The mechanism was already mostly built without anyone deciding to build it.** D15's
`load-dynamic` choice means `ort` never links against a system or bundled ONNX Runtime at
compile time — the real `libonnxruntime.so` is `dlopen`ed only when `Segmenter::load` gets
a real path. That is structurally *exactly* what option 1 ("download the runtime on first
use") requires on the loading side. What was actually missing — checked rather than
assumed, since `src/segment/modelDownload.ts` and `commands::segment` turned out to cover
only the *model* download, never the runtime — was anything that **fetches** the runtime
library itself. That is what this decision locks in and this change builds.

**Real installer, measured, not estimated.** `npm run tauri build` (release profile,
`lto`, `opt-level = "s"`, `strip = true`, matching this repo's own `[profile.release]`)
produces the real Linux artifacts:

| Artifact | Real, measured 2026-07-30 |
|---|---|
| `.deb` | **2.1 MB** |
| `.AppImage` | 75 MB — see below |
| Stripped release binary alone | 4.9 MB |

Neither `u2netp.onnx` nor an ONNX Runtime library is present anywhere in either bundle
today (`tauri.conf.json`'s `bundle` has no `resources` entry) — confirmed by listing both
bundle trees, not assumed from the config alone. **The `.deb` is therefore the real,
already-shipping installer size under the current architecture: 2.1 MB against a 20 MB
budget, a 9.5× margin**, not a projection of what a future build might do. The `.AppImage`
being 75 MB is not a budget violation of this project's own making: an AppImage bundles
`webkit2gtk`/`gtk` itself for portability (confirmed by inspecting `Tesserica.AppDir` —
real `libwebkit2gtk`, `libgtk-3`, `libgdk_pixbuf`, etc. sit inside it), which is a property
of that packaging format on every Tauri/Electron/GTK app, not something this project adds
weight to; `00-vision-and-scope.md` §8's own budget line and this table both describe "the
Tauri binary + WebView glue," which the `.deb` (relying on the system's already-installed
`libwebkit2gtk-4.1-0`/`libgtk-3-0`, per `08-roadmap.md`'s own Phase 3 installer item) is
the artifact that actually measures.

`07-tech-stack.md` §6's own component-estimate table previously guessed "Tauri binary +
WebView glue ~8 MB" — the real stripped binary is 4.9 MB, half that guess.

**Real current ONNX Runtime release, not the doc's ~10–15 MB guess.** Checked against the
actual `microsoft/onnxruntime` GitHub Releases API (2026-07-30), not estimated: the latest
tag is `v1.28.0`, and its Linux x64 CPU asset is `onnxruntime-linux-x64-1.28.0.tgz`,
**9,125,960 bytes (8.7 MB)** as published (`Content-Length`/asset `size` from the release
API, matched by an independent local `sha256sum` after downloading it). Extracted, the one
file this project actually needs — `lib/libonnxruntime.so.1.28.0`, the real ELF shared
object; the archive's other two `.so` entries alongside it are symlinks to that same file,
plus a small `libonnxruntime_providers_shared.so` this project's CPU-only usage does not
need — is **24,268,848 bytes (24.3 MB)**. So the *download* the user pays for the runtime
(8.7 MB) is smaller than `07-tech-stack.md` §6's old estimate, and the *on-disk* cost once
extracted (24.3 MB) is larger than the low end of that estimate but landing squarely
inside the ~10–15 MB → mid-20s MB range that estimate was gesturing at; either way, since
option 1 means neither figure is ever added to the shipped installer, both numbers matter
only for what the confirm dialog states honestly to the user, not for the 20 MB budget
itself.

**Decision: option 1, download-on-first-use, for both the model and the runtime — and it
is now actually implemented, not just structurally possible.** `commands::onnx_runtime`
(`src-tauri/src/commands/onnx_runtime.rs`) extends the exact mechanism `commands::segment`
already used for the larger model — a static info command (no network, safe on mount), a
local status check (no network), and a save command gated on an explicit confirm click —
rather than building a second, parallel one:

- **Info/status**: `onnx_runtime_info` returns the hardcoded URL, sizes, version (`1.28.0`)
  and license (`MIT`, re-verified against the real GitHub API repository license field);
  `onnx_runtime_status` checks whether the extracted library already exists in the app-data
  directory. Neither touches the network.
- **The frontend fetch is still a plain `fetch()`**, unchanged from the model download —
  Rust makes no network call of its own. `src/segment/modelDownload.ts`'s single
  `downloadConsentedFile` function (generalized with two type parameters so it is no
  longer named or shaped only for the segmentation model) is reused by both
  `SegmentModelSection.tsx` and the new `OnnxRuntimeSection.tsx`, per this decision's own
  "reuse it, don't build a parallel one" bar — there are still zero new frontend network
  code paths, only a second confirm-gated caller of the one that already existed.
- **The one genuine new piece: archive extraction.** Unlike the model (a single file),
  upstream ships the runtime as a `.tar.gz` containing several entries. `save_downloaded_
  onnx_runtime` verifies a sha256 of the *whole archive* first — computed against a real
  download in this environment, since GitHub Releases does not itself publish a checksum
  for this project to trust, the same "this project's own verification is the checksum"
  posture D15's MD5 constant already established for the model — then decompresses
  (`flate2`, already resolved transitively via `zip`'s `deflate-flate2` feature, now also a
  direct dependency) and extracts (`tar`, genuinely new, small, MIT/Apache-2.0,
  `alexcrichton/tar-rs`) only the one real regular-file entry, writing *that* under a fixed
  name via temp-file-then-rename — the symlinks in the archive are never needed, since
  `Segmenter::load` takes an explicit path rather than depending on the dynamic linker's
  own conventional-name search.
- **Every failure mode degrades, never blocks.** A checksum mismatch, an archive missing
  the expected entry, an offline `fetch()`, or the user simply declining the confirm
  dialog all leave background removal exactly where it already was — the flood-fill
  fallback (`04` §8.5) — matching the "degrade rather than disappear" posture this project
  uses everywhere else this pattern appears (D15's own note about `ort`'s pre-release
  status; `commands::segment`'s `NoModelLoaded`, not an error).

**Verified for real, not assumed:** 6 new Rust unit tests build small in-memory fixture
`.tar.gz` archives (via `tar::Builder` + `flate2::write::GzEncoder`) to exercise checksum
rejection, missing-entry rejection, successful extraction, overwrite of a stale prior
download, and directory creation, without needing the real ~9 MB archive for ordinary
`cargo test` runs. Separately, a manually-run `#[ignore]`d smoke test
(`smoke_test_the_real_archive_passes_checksum_and_extracts`) was pointed at the *actual*
`onnxruntime-linux-x64-1.28.0.tgz` fetched via a real `curl` against the real GitHub
Releases URL this session, and it passed: the real sha256 matched, and extraction produced
exactly 24,268,848 bytes — the same figure the table above states, proving the production
constants are correct against a real download, not just internally consistent. 5 new
frontend component tests (`OnnxRuntimeSection.test.tsx`) mirror
`SegmentModelSection.test.tsx`'s own coverage: never downloads on mount, never downloads
after the initial click (only the confirm step shows), cancelling the confirm never
downloads, the save function only runs after the explicit "Download" click, and a failure
shows an inline, retryable error. `cargo test`, `cargo clippy --all-targets -- -D
warnings`, `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, and `npm
run test:golden` all pass with this change (no pipeline files touched, so the golden run is
a sanity check, not new coverage).

**Pipeline wiring remains explicitly out of scope**, exactly as D15 and `commands::
segment`'s own doc comments already disclosed for the model: nothing here calls
`Segmenter::load` with the extracted library. This decision's contract ends at "the runtime
library is on disk and its checksum is verified," matching the model download's own
contract boundary.

Rejected: shipping two builds, lite and full (option 2) — doubles the release-artifact
matrix and CI surface for a cost (one optional ~24 MB library) the measured `.deb` shows
was never actually threatening the budget; raising the budget to ~40 MB (option 3) — moot
once the real number is 2.1 MB, and raising a budget that is not being pressured invites
scope creep elsewhere; bundling the runtime unconditionally — would turn every install into
an ~26 MB+ download regardless of whether the user ever touches AI background removal,
contradicting `00-vision-and-scope.md` §7's "no image ever leaves the machine unless asked"
posture extended to "no unrequested weight either," which is exactly why the vision
document's own budget line already excludes the model from the count.

---

## D17 · `.ase` import: use **`aseprite-io`** (crates.io), not a hand-rolled parser

**Locked 2026-07-31.** Resolves `08-roadmap.md` Phase 6's last item, "`.ase` import;
evaluate `aseprite-io`" (`01-reference-analysis.md` §9). Follows from D11 (import only).

**Re-verified against crates.io directly, not trusted from `01`'s 2026-07-26 snapshot.**
`aseprite-io`:

| | `aseprite-io` |
|---|---|
| Latest version | 0.2.0 (published 2026-06-30; 0.1.0 published 2026-03-26 — two releases in ~3 months, actively maintained, not abandoned) |
| License | `MIT OR Apache-2.0` — MIT-compatible, no GPL surface |
| Total downloads | 580 (small, but the crate is 4 months old and this project only needs it to be *correct*, not popular) |
| Its own dependencies | `flate2` only (default features) — already resolved transitively via this project's own `zip` dependency's `deflate-flate2` feature, so adding it introduces **no new entry** to the dependency tree |
| Coverage (checked against its own source, `reader.rs`/`types.rs`/`writer.rs`, not just its README) | Full header/frame/chunk walk; palette (old and new chunk forms); every layer kind (normal/group/tilemap) with correct child-level→parent-index resolution; every cel kind (raw, zlib-compressed via `flate2`, linked, tilemap) — compression **is** handled, not assumed away; tags (name/range/direction/repeat — see the one real gap below); slices; tilesets (embedded and external); user data with typed properties; external file references; legacy mask chunks. Claims byte-perfect round-trip fidelity for its own write path. |

**One real, load-bearing gap found by reading the source, not assumed from the docs**:
`reader.rs::read_tags_chunk` reads a tag's name/range/direction/repeat but `skip`s the
deprecated 3-byte embedded RGB colour field outright rather than parsing it — an imported
tag's *colour* is not recoverable from this crate at 0.2.0, cosmetic only
(`Tag.color` is a chip colour, `docs/03-data-model.md` §2.3), but real. Handled in
`commands::ase_import` by assigning a deterministic placeholder colour and reporting it in
`LoadResult.warnings`, not by silently inventing one.

**Decision: use `aseprite-io` directly**, plain `.ase`/`.aseprite` import via
`AsepriteFile::from_reader`, converted onto this project's own `model::document::Sprite` in
`src-tauri/src/commands/ase_import.rs` — the same `LoadResult`/`LoadedCel` wire shape
`.tess` load (`commands::project`) already returns, so the frontend needed one new command
call, not new plumbing. `default-features = false` (no `image`/`tiny-skia` conversion
helpers): grayscale/indexed → straight-alpha RGBA conversion (D9) against the file's own
palette is small enough to hand-write, and skipping those features keeps the dependency
surface to `flate2` alone.

**Rejected: hand-rolling a parser against the public spec.** `01` §9 named this a
legitimate fallback, not a last resort — but the crate's own source shows it already
covers every chunk this project's `Sprite` model can use (raster/group layers, every cel
kind including zlib decompression, tags, palette), correctly, with a license this project
can ship. Hand-rolling that from the spec would mean re-implementing (and re-testing) work
this crate has already done, for identically-shaped output, at real risk of introducing
*new* bugs (chunk-order edge cases, the group child-level algorithm, zlib framing) rather
than avoiding them. The `Cargo.toml` dependency comment documents the same re-verification
so a future maintainer does not have to repeat it from scratch.

**What did not make it into this pass, reported rather than silently dropped** (also
disclosed in `commands::ase_import`'s own module doc comment and in every affected
`LoadResult.warnings` entry):

- **`.ase` tilemap layers are skipped.** Aseprite's own tile flip/rotate bit layout does not
  match this project's `model/tileIds.ts` packing (the tileset-*export* item earlier in
  Phase 6 already hit the analogous mismatch against Tiled's own bit layout) — repacking it
  correctly is real work distinct from the rest of this item, not attempted here.
- Aseprite's three non-W3C blend modes (`addition`/`subtract`/`divide`) import as `normal`
  — this project's `BlendMode` is the fixed W3C set (`03` §2.1).
- `pingpongReverse` (Aseprite's fourth tag loop direction) imports as `pingpong` — this
  project's `TagDirection` has three.
- Per-cel opacity and Aseprite slices have no field in this project's data model at all
  (`model::document::Cel` has no opacity; there is no `Slice` type) and are dropped without
  a per-instance warning, since there is nothing here for them to have failed to reach.

---

## Still open — deferred, not decided

These genuinely need measurement rather than a preference, and each is scheduled:

| # | Question | Decide at |
|---|---|---|
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
| D12 | Oklab is **`f64` both sides**; parity measured in **palette indices** |
| D13 | Editor layers cross IPC on the **raw invoke body** |
| D14 | **Canvas2D holds** at target sizes; no WebGL2 renderer |
| D15 | Segmentation: direct **`ort`** (not `rembg-rs`), loaded via `load-dynamic` |
| D16 | ONNX Runtime: **download on first use**, real installer measured at 2.1 MB |
| D17 | `.ase` import: use **`aseprite-io`** crate, not a hand-rolled parser |
