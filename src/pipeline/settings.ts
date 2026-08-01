/**
 * `ConvertSettings` — the parameter struct for the whole pipeline
 * (`docs/04-image-pipeline.md` §2.2).
 *
 * Mirrors `src-tauri/src/pipeline/settings.rs` field for field, `camelCase` on
 * the wire in both directions.
 *
 * The pipeline deliberately defines its own `Rgba` rather than importing the
 * editor's `RGBA` from `src/model/types.ts`: this code runs in a Web Worker and
 * again, independently, in Rust, and it should not acquire a dependency on the
 * document model to do it. The two types are structurally identical.
 */

export type Rgba = readonly [r: number, g: number, b: number, a: number];

export type DitherMode = 'none' | 'floyd-steinberg' | 'atkinson' | 'bayer2' | 'bayer4' | 'bayer8';

export type DownscaleMode = 'box' | 'nearest' | 'dominant';

export type ColorSpace = 'oklab' | 'srgb';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutlineSettings {
  color: Rgba;
  /** In output pixels. */
  thickness: number;
  /** 8-connectivity when true (rounder corners), 4-connectivity when false. */
  corners: boolean;
}

/**
 * Which algorithm produces stage [1]'s mask (`docs/04` §8).
 *
 * `'flood-fill'` needs no model and runs identically here and in
 * `src-tauri/src/pipeline/background_removal.rs`. `'ml'` runs the real
 * `u2netp` ONNX model (`src-tauri/src/segment/`) — **Rust-only**: there is no
 * ONNX runtime in the browser/worker, so `convert()` below treats `'ml'` as a
 * no-op at preview time rather than silently substituting flood-fill, which
 * would show a result export would not reproduce. `ConvertPanel` surfaces
 * this explicitly next to the toggle. Undefined means `'flood-fill'`, so
 * every settings object built before this field existed keeps meaning
 * exactly what it always meant.
 */
export type BackgroundRemovalMethod = 'flood-fill' | 'ml';

/**
 * Stage [1]'s settings (`docs/04` §8) — which method produces the mask, and,
 * for flood-fill, its tolerance.
 *
 * `threshold`/`close`/`feather` are the mask post-processing steps §8.3 step 5
 * describes (`pipeline/maskPostProcess.ts`), run in that fixed order after
 * *either* method produces its mask — one shared post-processing path, not
 * two. All three are optional/"off by default" — flood-fill's own output is
 * already a clean binary mask, and they are equally applicable to the ML
 * method's softer matte when a caller wants to clean it up too.
 */
export interface BackgroundRemovalSettings {
  /** Which algorithm produces the mask. Undefined means `'flood-fill'`. */
  method?: BackgroundRemovalMethod;
  /**
   * Un-squared Oklab colour distance. Only meaningful for `'flood-fill'`. A
   * neighbour joins a corner's flood when it is within this of that corner's
   * own colour. 0 admits only exact matches; higher values tolerate more
   * variation (soft shadows, mild gradients) before the flood stops at an
   * edge.
   */
  tolerance: number;
  /**
   * 0..255. When set, re-binarizes the mask at this cutoff before close and
   * feather run: alpha below the cutoff goes fully transparent, at or above
   * goes fully opaque. Undefined skips this step entirely.
   */
  threshold?: number;
  /**
   * 0 = off. Structuring-element radius, in pixels, for a dilate-then-erode
   * closing pass that fills small holes/gaps without growing the mask's outer
   * boundary.
   */
  close?: number;
  /**
   * 0 = off. Box-blur radius, in pixels, applied to the alpha channel only,
   * that softens the mask's edge instead of a hard aliased cutoff.
   */
  feather?: number;
}

/**
 * Where the palette comes from.
 *
 * `docs/04` §2.2 writes this as "a fixed palette, or `'auto'` with maxColors".
 * A tagged union makes both halves explicit and makes `auto` (§4.3) an
 * extension rather than a special case threaded through every call site.
 */
export type PaletteSpec =
  { kind: 'fixed'; colors: readonly Rgba[] } | { kind: 'auto'; maxColors: number };

export interface ConvertSettings {
  // [1] background removal — flood-fill fallback only; see BackgroundRemovalSettings
  backgroundRemoval?: BackgroundRemovalSettings;

  // [2] framing
  crop?: CropRect;
  /**
   * Crop to the bounding box of what is opaque.
   *
   * `docs/04` §8.5 describes this against a segmentation mask. Until Phase 5
   * produces one, the source's own alpha *is* the mask — which is exactly right
   * for a source that already has alpha, and a no-op for one that does not.
   */
  fitToSubject: boolean;

  // [3] adjustments — all neutral at 0
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 */
  saturation: number;
  /** -180..180 degrees */
  hueShift: number;

  // [4] downscale
  targetWidth: number;
  targetHeight: number;
  downscaleMode: DownscaleMode;

  // [5] quantize
  palette: PaletteSpec;
  dither: DitherMode;
  /** 0..1 */
  ditherStrength: number;
  colorSpace: ColorSpace;

  // [6] cleanup
  /** 0..3; regions of this area or smaller are absorbed. 0 = off. */
  despeckle: number;
  outline?: OutlineSettings;

  // alpha (§4.4)
  /** 0..255. Below this, a pixel becomes fully transparent and is not quantized. */
  alphaThreshold: number;
  /**
   * Keep the source's alpha for pixels at or above the threshold, instead of
   * snapping them to fully opaque. Off by default — pixel art is usually 1-bit
   * alpha (`docs/04` §4.4).
   */
  preserveAlpha: boolean;
}

/**
 * Neutral settings: nothing adjusted, box downscale, no dither, no cleanup.
 *
 * Callers must still supply a palette and a target size, which is why this is a
 * function taking both rather than a bare constant.
 */
export function defaultSettings(
  targetWidth: number,
  targetHeight: number,
  palette: PaletteSpec,
): ConvertSettings {
  return {
    fitToSubject: false,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hueShift: 0,
    targetWidth,
    targetHeight,
    downscaleMode: 'box',
    palette,
    dither: 'none',
    ditherStrength: 1,
    colorSpace: 'oklab',
    despeckle: 0,
    alphaThreshold: 128,
    preserveAlpha: false,
  };
}

/**
 * Target dimensions from a single "pixel size" control (`docs/04` §3.2).
 *
 * The user thinks "how big are the blocks", not "what are my output
 * dimensions". Never smaller than 1×1.
 */
export function targetSizeForPixelSize(
  sourceWidth: number,
  sourceHeight: number,
  pixelSize: number,
): { width: number; height: number } {
  // NaN must be rejected too, hence the explicit test.
  if (Number.isNaN(pixelSize) || pixelSize <= 0) {
    throw new Error(`pixelSize must be > 0, got ${pixelSize}`);
  }
  return {
    width: Math.max(1, Math.round(sourceWidth / pixelSize)),
    height: Math.max(1, Math.round(sourceHeight / pixelSize)),
  };
}
