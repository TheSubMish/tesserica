# Image Pipeline & Algorithms

> Status: **draft for review** · Last updated: 2026-07-26
>
> ⚠️ **This document is normative.** Both the TypeScript preview implementation
> (`src/pipeline/`) and the Rust export implementation (`src-tauri/src/pipeline/`) must
> conform to it. Where they may legitimately differ, it is stated explicitly.

## 1. Why a fixed order

Pixel It's docs warn that "the order they are applied can change the final result"
(`01-reference-analysis.md` §4). That is true and unavoidable — so rather than exposing
the ambiguity, we fix the order and document it.

## 2. The pipeline

```
   source image (RGBA, full res)
        │
   [1]  ├─ background removal          (optional, Rust only, cached)
        │
   [2]  ├─ crop / fit-to-subject       (optional)
        │
   [3]  ├─ color adjustments           brightness, contrast, saturation, hue
        │                              ↑ BEFORE quantization — see §2.1
   [4]  ├─ downscale to target grid    box-average or nearest, see §3
        │
   [5]  ├─ quantize + dither           → palette indices, see §4–§5
        │
   [6]  ├─ cleanup                     despeckle / outline, see §6
        │
        ▼
   pixel art (indexed, target res)
        │
   [7]  └─ upscale for export          integer nearest-neighbour only, see §7
```

### 2.1 Why adjustments come before quantization

If you brighten *after* mapping to a 16-color palette, you push colors off the palette
and have to re-map, compounding error. Adjusting first means quantization sees the final
intended colors and picks the best available match once. Pixel Art Village orders it
this way too.

### 2.2 Settings struct

Identical in both languages (`camelCase` on the wire):

```ts
interface ConvertSettings {
  // [2] framing
  crop?: { x: number; y: number; w: number; h: number };
  fitToSubject: boolean;

  // [3] adjustments — all neutral at 0
  brightness: number;      // -1..1
  contrast: number;        // -1..1
  saturation: number;      // -1..1
  hueShift: number;        // -180..180 degrees

  // [4] downscale
  targetWidth: number;     // in output pixels
  targetHeight: number;
  downscaleMode: 'box' | 'nearest' | 'dominant';

  // [5] quantize
  palette: PaletteRef;     // fixed palette, or 'auto' with maxColors
  maxColors?: number;      // only when palette is 'auto'
  dither: DitherMode;
  ditherStrength: number;  // 0..1
  colorSpace: 'oklab' | 'srgb';   // default oklab

  // [6] cleanup
  despeckle: number;       // 0..3, minimum island size to remove
  outline?: { color: RGBA; thickness: number };

  // alpha
  alphaThreshold: number;  // 0..255, below this → fully transparent
}

type DitherMode = 'none' | 'floyd-steinberg' | 'atkinson' | 'bayer2' | 'bayer4' | 'bayer8';
```

---

## 3. Downscaling

Getting from a 4000×3000 photo to a 64×48 grid. **This step determines whether the
output looks like pixel art or like a broken thumbnail.**

Both AI references lead with grid snapping as their quality claim
(`01-reference-analysis.md` §6) — it matters that much.

### 3.1 Modes

| Mode | Method | Best for |
|---|---|---|
| `box` | Average all source pixels in each output cell | **Default.** Photos, smooth art. |
| `nearest` | Sample the center pixel of each cell | Sources that are *already* pixel art |
| `dominant` | Most frequent color in the cell (after a coarse pre-quantize) | Flat-color illustration, logos |

**Box averaging is the default** because it preserves detail that nearest throws away.
But note the interaction: box averaging *creates new colors* not present in the source,
which then get quantized. For sources that are already pixel art this is destructive —
hence `nearest`, and hence §3.3.

### 3.2 Aspect ratio

Target dimensions derive from a **single "pixel size" control** plus the source aspect
ratio, matching every reference converter. The user thinks "how big are the blocks", not
"what are my output dimensions".

```
targetWidth  = round(sourceWidth  / pixelSize)
targetHeight = round(sourceHeight / pixelSize)
```

Advanced users can set target dimensions directly, with an aspect-lock toggle.

### 3.3 Grid detection (v2)

When the source is *already* pixel art that was scaled up (a screenshot, an AI-generated
sprite, a saved PNG at 8×), we should detect the original grid and recover it exactly.

Approach: autocorrelation on row/column difference signals. Compute per-column
`sum(|pixel[x] - pixel[x-1]|)` down the image; for an N× upscaled image this spikes at
multiples of N. Take the strongest period, verify against rows, and offer it as a
detected snap value.

This is what makes the difference between "clean sprite" and "mush" on the very common
"I have a pixel art PNG that's the wrong size" workflow. **v2**, but design for it now.

---

## 4. Color quantization

### 4.1 Oklab

Nearest-color matching in sRGB is perceptually wrong — equal RGB distances do not look
equally different, and dark colors collapse together. Research (`01-reference-analysis.md`
§8) confirms Oklab as the right space, and that error diffusion in Oklab is materially
better.

**All color distance and all error diffusion happen in Oklab. Default and strongly
recommended.** `srgb` is exposed only as an escape hatch for matching another tool's
output.

```
sRGB → linear sRGB → LMS → Oklab
```

```rust
pub fn srgb_to_oklab(r: f32, g: f32, b: f32) -> [f32; 3] {
    let (r, g, b) = (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b));

    let l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b;
    let m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b;
    let s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b;

    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());

    [ 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
      1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
      0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_ ]
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
```

### 4.2 Fixed palette (the common case)

The user picks Game Boy or PICO-8; we map each pixel to its nearest palette entry.

**Optimization — mandatory, not optional.** Naive nearest-color is
`pixels × paletteSize` distance computations. At 12M pixels × 54 NES colors that is
648M — too slow even in Rust for a responsive feel.

Use a **cache keyed on quantized RGB**. Pre-convert the palette to Oklab once. Then key
a lookup table on the top 5 bits per channel (32³ = 32,768 entries):

```rust
let key = ((r >> 3) as usize) << 10 | ((g >> 3) as usize) << 5 | ((b >> 3) as usize);
```

Real images touch a small fraction of that space, so hit rates are very high and the
cost collapses to roughly one distance computation per *distinct* color.

> ⚠️ **The cache is invalid when dithering with error diffusion**, because diffused error
> pushes colors to arbitrary values — a cache built on quantized keys would round away
> the very error we are trying to propagate. Use the cache for `none` and ordered
> dithering; compute directly for Floyd–Steinberg and Atkinson.

For large palettes (>64), a k-d tree in Oklab is worth it. For ≤64 entries, linear scan
with the cache wins on simplicity.

### 4.3 Auto palette (`palette: 'auto'`)

When the user wants "the best N colors for this image":

**Wu's algorithm, then ~8 iterations of k-means in Oklab** — described in the research as
the best general-purpose approach. Wu gives a good deterministic starting partition;
k-means refines it. Deterministic seeding matters: the same input and settings must
always produce the same palette, or preview and export diverge.

Median cut is the simpler fallback if Wu proves fiddly, at some quality cost.

### 4.4 Alpha

Alpha is **not** quantized against the palette. Handled separately:

- `alpha < alphaThreshold` → fully transparent, pixel not quantized at all
- `alpha >= alphaThreshold` → fully opaque (default; pixel art is usually 1-bit alpha)
- Optional "preserve alpha" mode keeps the original value for soft edges

Straight alpha throughout (`02-architecture.md` §9). Never average a transparent pixel's
RGB into a box downscale — weight by alpha, or transparent black bleeds dark fringes
into edges. **This is the single most common bug in naive converters.**

---

## 5. Dithering

Three families, all shipped, because they are aesthetic choices rather than quality
tiers.

### 5.1 Error diffusion — Floyd–Steinberg

The 1976 standard. Pushes residual quantization error onto not-yet-processed neighbours:

```
        X    7/16
 3/16  5/16  1/16
```

```rust
for y in 0..h {
    for x in 0..w {
        let old = buf[y][x];                    // Oklab, f32
        let new = nearest_palette_color(old);
        out[y][x] = new;
        let err = old - new;                    // per-channel
        // serpentine: alternate direction per row to avoid directional artifacts
        distribute(&mut buf, x+1, y,   err * 7.0/16.0 * strength);
        distribute(&mut buf, x-1, y+1, err * 3.0/16.0 * strength);
        distribute(&mut buf, x,   y+1, err * 5.0/16.0 * strength);
        distribute(&mut buf, x+1, y+1, err * 1.0/16.0 * strength);
    }
}
```

Notes:
- **Serpentine scanning** (alternating row direction) noticeably reduces the diagonal
  streaking plain left-to-right scanning produces.
- Error accumulates in an `f32` working buffer in **Oklab**, not sRGB.
- `ditherStrength` scales the diffused error. 1.0 is classic; lower values give a
  cleaner, less noisy result that often suits pixel art better.
- **Inherently sequential** — each pixel depends on its predecessors. This is the one
  pipeline stage `rayon` cannot trivially parallelize, and the reason preview and export
  cannot match exactly at different resolutions (`02-architecture.md` §3.3).

### 5.2 Error diffusion — Atkinson

Classic Mac. Distributes only 6/8 of the error, deliberately discarding the rest:

```
        X    1/8  1/8
 1/8   1/8   1/8
       1/8
```

Higher contrast, cleaner highlights and shadows, more "crunchy". Often the better look
for pixel art than Floyd–Steinberg.

### 5.3 Ordered / Bayer

A fixed threshold matrix — structured, repeating, unmistakably retro. Bayer 4×4:

```
 0  8  2 10
12  4 14  6
 3 11  1  9
15  7 13  5
```

```
threshold = (bayer[y % n][x % n] + 0.5) / (n*n) - 0.5
adjusted  = pixel + threshold * ditherStrength * spread
result    = nearest_palette_color(adjusted)
```

Fully **parallelizable** (no inter-pixel dependency) and **resolution-independent in
character**, which makes it the safest mode for preview/export parity.

`spread` should scale with the palette's average color spacing — a fixed value looks
wrong on both a 4-color and a 64-color palette.

### 5.4 References

- [Ditherpunk — surma.dev](https://surma.dev/things/ditherpunk/) — the best explainer
- [Reducing Colors In An Image ⇢ Dithering — shihn.ca](https://shihn.ca/posts/2020/dithering/)
- [Floyd–Steinberg (Wikipedia)](https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering)

---

## 6. Cleanup

Pixel Art Village exposes a "cleanup" control without defining it
(`01-reference-analysis.md` §3). We define ours concretely:

### 6.1 Despeckle

After quantization you get isolated single pixels — a lone bright dot in a dark region,
which reads as noise rather than detail.

Connected-component analysis on the index map; any region with area `< despeckle` is
replaced by the most common color among its neighbours. Levels 0–3 (0 = off).

### 6.2 Outline

Add a border around non-transparent regions. Extremely common for game sprites — it is
what makes a character read against a busy background.

Detect alpha boundary pixels, expand by `thickness`, fill with `color`. The `corners`
flag chooses 4- vs 8-connectivity (8 gives rounder corners).

### 6.3 Not doing

Deliberately avoiding: anti-alias removal (belongs in a dedicated pixel-art-cleanup
feature), automatic color count reduction (the user chose their palette), and edge
sharpening (fights the medium).

---

## 7. Export scaling

**Integer factors, nearest-neighbour, no exceptions.**

```rust
// 1x, 2x, 4x, 8x, 16x
for y in 0..h*scale {
    for x in 0..w*scale {
        out[y][x] = src[y/scale][x/scale];
    }
}
```

Any smoothing filter on pixel-art upscale destroys the entire point. Non-integer scaling
produces uneven pixel sizes — some blocks 3 wide, some 4 — which is instantly visible.

**Rotation and non-integer scaling** (v2) need pixel-art-aware algorithms, not bilinear.
Pixelorama's `rotxel`, `cleanEdge`, and `OmniScale` are the references
(`01-reference-analysis.md` §2). Do not ship naive rotation.

---

## 8. Background removal

**Local ONNX inference. No cloud, no upload.**

### 8.1 Model

| Model | Size | Notes |
|---|---|---|
| **`isnet-general-use`** | ~170 MB | Best general quality — **recommended default** |
| `u2netp` | ~4.7 MB | Tiny, fast, lower quality — good bundled fallback |
| `silueta` | ~43 MB | U2-Net reduced; good size/quality balance |
| `isnet-anime` | ~170 MB | High accuracy on anime/illustration |

The model classifies every pixel as subject or background and outputs a **matte** — a
grayscale mask where white is subject and black is background.

**Decision:** ship `u2netp` bundled (4.7 MB fits the installer budget), offer the larger
models as **on-demand downloads** with an explicit consent prompt, since downloading is a
network action and our local-first promise means we ask first.

### 8.2 Runtime

`ort` (ONNX Runtime bindings for Rust). **Caveat: `ort` is at `2.0.0-rc.12` with no
stable release** (verified 2026-07-26). Pin the exact version and keep it behind our
`segment` module so it can be swapped without touching the rest of the app.

`rembg-rs` (ONNX Runtime + U2-Net) exists and may be usable directly — evaluate before
hand-rolling.

### 8.3 Pipeline

1. Resize input to model resolution (typically 320×320 or 1024×1024)
2. Normalize to the model's expected mean/std
3. Run inference
4. Upscale the mask back to source resolution (**bilinear here is correct** — it is a
   mask, not pixel art)
5. Post-process: threshold, morphological close to fill holes, optional feather
6. Apply as alpha

### 8.4 Why this pairs well with pixel art

Segmentation masks are usually soft and imperfect at the edges — wispy hair, motion blur.
For photo editing that is a problem. **For pixel art it mostly does not matter**, because
step [4] downscales 60× and step [5] snaps alpha to 1-bit. Errors that would be obvious
at full resolution vanish entirely at 64×64.

This means even the small `u2netp` model is likely good enough for our actual use case —
worth benchmarking before assuming we need the 170 MB one.

### 8.5 Fit-to-subject

Once we have a mask, "resize to fit the character" is nearly free: compute the mask's
bounding box, add padding, crop. This is the `fitToSubject` flag in §2.2, and it is a
genuinely useful little feature that falls out of work we are already doing.

Non-ML fallback for simple cases: flood-fill from the corners with a color tolerance.
Works on flat/studio backgrounds, needs no model, instant. Worth having as a first option.

---

## 9. Adjustments

Applied in Oklab where it makes perceptual sense:

| Adjustment | Method |
|---|---|
| Brightness | Scale Oklab `L` |
| Contrast | `L = (L - 0.5) * (1 + contrast) + 0.5` |
| Saturation | Scale Oklab chroma (`a`, `b`) |
| Hue shift | Rotate the `a`/`b` plane |

Doing these in Oklab rather than sRGB avoids the classic artifacts — sRGB saturation
boosts blow out hues, sRGB brightness crushes shadows.

---

## 10. Performance targets

| Operation | Size | Target |
|---|---|---|
| Preview (proxy ≤1024px) | any source | < 16 ms |
| Full-res convert, no dither | 12 MP | < 500 ms |
| Full-res convert, FS dither | 12 MP | < 2 s |
| Background removal (`u2netp`) | 12 MP | < 3 s |
| Export PNG at 8× | 512×512 → 4096² | < 300 ms |

Parallelization notes:
- Adjustments, box downscale, ordered dither, upscale → **`rayon` over scanlines**
- Error diffusion → **sequential**; parallelize across independent *tiles* only if
  measurement demands it, accepting seam artifacts
- Nearest-color with cache → parallel, but needs a per-thread cache or a lock-free
  shared one

---

## 11. Testing

**Golden-image corpus** — the mechanism that keeps the two implementations honest
(`02-architecture.md` §3.3):

- Sources: photo (portrait), photo (landscape), flat illustration, existing pixel art,
  image with alpha, high-contrast graphic, gradient
- Settings matrix: each palette × each dither mode × 3 pixel sizes
- Both implementations run each combination; compare with mean ΔE in Oklab
- **Non-dithered modes: exact match required** (both are deterministic)
- **Dithered modes: structural comparison** — histogram of palette-index usage within
  tolerance, since exact match is impossible across resolutions

Unit tests: Oklab round-trip accuracy, palette parsers against real Lospec files,
Bayer matrix generation, connected-component despeckle on hand-built cases.
