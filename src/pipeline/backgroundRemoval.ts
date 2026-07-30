/**
 * Stage [1] — background removal, flood-fill fallback (`docs/04-image-pipeline.md`
 * §8.5).
 *
 * Mirrors `src-tauri/src/pipeline/backgroundRemoval.rs` — spelled
 * `background_removal.rs` on the Rust side.
 *
 * §8.5 names this explicitly: "Non-ML fallback for simple cases: flood-fill from
 * the corners with a color tolerance. Works on flat/studio backgrounds, needs no
 * model, instant." Unlike the ONNX segmentation model §8 otherwise describes —
 * which is Rust-only and a later Phase 5 item — this fallback needs no runtime
 * and is cheap enough to run identically in both the TS preview and the Rust
 * export pipeline, so it lives in the shared stage-order chain rather than being
 * bolted on as a Rust-only step.
 *
 * What makes this more than a naive chroma key: it floods by **connectivity**,
 * not by colour match alone. A red backdrop and a red prop that only touches it
 * at a corner of the *image*, not of each other, are different connected
 * components — only the one reachable from an image corner is cleared.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import { NEAREST_EPSILON, distanceSq, srgb8ToOklab } from './oklab.ts';
import type { BackgroundRemovalSettings } from './settings.ts';

/**
 * Flood-fill background removal.
 *
 * Seeds are the image's four corner pixels (deduplicated automatically for a
 * 1-pixel-wide or -tall image, since two corner indices coincide). For each seed
 * not already claimed by an earlier one's flood, walk its 4-connected component
 * — the same connectivity `cleanup.ts::despeckle` uses, for the same reason: an
 * 8-connected flood would leak through a diagonal gap a person would read as a
 * separating edge.
 *
 * A neighbour joins the flood when its colour is within `tolerance` (a plain,
 * un-squared Oklab distance) of **that seed's own colour** — a fixed reference
 * point, not a running average of the region so far. A running average would
 * let the flood slowly drift across a gradient background into the subject;
 * anchoring to the seed keeps the tolerance meaning one thing for the whole
 * component.
 *
 * Matched pixels get alpha `0`; their RGB is left untouched, since straight
 * alpha (`docs/02-architecture.md` §9) never needs a transparent pixel's colour
 * to change, and doing so would throw away information a later "undo the
 * removal" gesture might want.
 *
 * The inclusion test carries the same `NEAREST_EPSILON` (D12, `docs/04` §4.2)
 * the nearest-colour tie-break uses, for the same reason: Rust and JS Oklab
 * agree to ~6.7e-16 but not bit-for-bit, so a pixel sitting almost exactly on
 * the tolerance boundary could otherwise join the flood in one language and
 * not the other — and because a flood's connectivity depends on every earlier
 * decision, a single such flip can diverge a whole region, not just one pixel.
 */
export function removeBackgroundFloodFill(
  src: PixelBuffer,
  settings: BackgroundRemovalSettings,
): PixelBuffer {
  const { width, height, data } = src;
  const out = Uint8ClampedArray.from(data);
  const n = width * height;
  const visited = new Uint8Array(n);
  const thresholdSq = settings.tolerance * settings.tolerance;

  const corners = [0, width - 1, (height - 1) * width, (height - 1) * width + width - 1];
  const stack: number[] = [];

  for (const seed of corners) {
    if (visited[seed]) continue;

    const so = seed * 4;
    const seedColor = srgb8ToOklab(data[so], data[so + 1], data[so + 2]);

    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;

    while (stack.length > 0) {
      const p = stack.pop() as number;
      out[p * 4 + 3] = 0;

      const x = p % width;
      const y = (p - x) / width;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y + 1 < height ? p + width : -1,
      ];

      for (const q of neighbours) {
        if (q < 0 || visited[q]) continue;
        const qo = q * 4;
        const qColor = srgb8ToOklab(data[qo], data[qo + 1], data[qo + 2]);
        if (distanceSq(qColor, seedColor) <= thresholdSq + NEAREST_EPSILON) {
          visited[q] = 1;
          stack.push(q);
        }
      }
    }
  }

  return bufferFrom(width, height, out);
}
