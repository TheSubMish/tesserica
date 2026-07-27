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

## Still open — deferred, not decided

These genuinely need measurement rather than a preference, and each is scheduled:

| # | Question | Decide at |
|---|---|---|
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
| D12 | Oklab is **`f64` both sides**; parity measured in **palette indices** |
| D13 | Editor layers cross IPC on the **raw invoke body** |
