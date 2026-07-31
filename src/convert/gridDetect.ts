/**
 * Grid detection via autocorrelation (`docs/04-image-pipeline.md` §3.3).
 *
 * Unlocks W7 Case A (`docs/06-workflows.md`): a source that is *already* pixel
 * art saved at some integer upscale (a screenshot, an AI-generated sprite, a
 * PNG someone scaled up in an image editor) should have its true grid
 * recovered exactly, rather than being box-downscaled into mush by the
 * ordinary conversion pipeline.
 *
 * **Not a pipeline stage.** This never runs inside `convert()` in either
 * language — it is a one-shot, user-triggered analysis of the *preview proxy*
 * that only ever *suggests* a value for the pixel-size control the pipeline
 * already has (`docs/04` §3.2), the same control both implementations already
 * agree on bit-for-bit via the golden suite. Because its output is always
 * subject to the user's own accept/dismiss decision (`docs/06` W7 Case A step
 * 1: "offers … snap to original?"), and it never itself produces a pixel that
 * ships, it does not need a Rust mirror the way `src/pipeline/` does — there
 * is nothing here for the golden suite to compare, since Rust never runs this
 * code and never needs to agree with it. See `docs/08-roadmap.md` for the
 * fuller reasoning.
 *
 * **Colour-space choice**: plain per-channel (including alpha) absolute
 * difference in 8-bit sRGB, *not* Oklab. `docs/04` §4's "all colour distance
 * happens in Oklab" rule governs decisions about how different two colours
 * *look* — nearest-colour matching, error diffusion. This is a different kind
 * of question: a nearest-neighbour upscale by an integer factor repeats each
 * source pixel's bytes **exactly** across its block, so within a block every
 * one of these channel differences is genuinely zero, not "perceptually
 * negligible". A perceptual distance would spend `cbrt`/`pow` calls (and the
 * two languages' libms disagreeing at the 1e-16 level, D12) to answer a
 * question the raw bytes already answer exactly, and — since this never
 * crosses into Rust at all — there is no cross-language agreement to protect
 * in the first place.
 */

import type { PixelBuffer } from '../pipeline/buffer.ts';

export interface AxisDetection {
  /** The candidate period (in proxy pixels) that scored highest. */
  readonly period: number;
  /**
   * How much stronger the average change is at multiples of `period` than
   * the average change everywhere. 1.0 means "no periodic signal at all";
   * comfortably above {@link DEFAULT_CONFIDENCE_THRESHOLD} means a real grid.
   */
  readonly confidence: number;
}

export interface GridDetectionResult {
  /** The value to offer the pixel-size control. */
  readonly period: number;
  /** Column-axis detection, if any period cleared the confidence threshold. */
  readonly column: AxisDetection | undefined;
  /** Row-axis detection, if any period cleared the confidence threshold. */
  readonly row: AxisDetection | undefined;
  /** True when both axes independently agree on the same period. */
  readonly agreement: boolean;
}

export interface GridDetectionOptions {
  /** Smallest period worth suggesting. A period of 1 is "no upscale", not a detection. */
  readonly minPeriod?: number;
  /** Largest period to search. Matches the pixel-size control's own ceiling by default. */
  readonly maxPeriod?: number;
  /**
   * Minimum `confidence` (on-grid mean / overall mean) required to accept a
   * period rather than report "no strong periodicity found" (`docs/04` §3.3).
   */
  readonly confidenceThreshold?: number;
}

const DEFAULT_MIN_PERIOD = 2;
/** Mirrors `MAX_PIXEL_SIZE` (`state/convertStore.ts`) without importing it — this module has no UI dependency. */
const DEFAULT_MAX_PERIOD = 64;
/**
 * Tuned against the unit tests in `gridDetect.test.ts`: comfortably separates
 * a genuine integer-upscaled grid (confidence effectively unbounded, since
 * in-block differences are exactly zero) from photo-like noise (confidence
 * hovers near 1.0 for every candidate period, since a real photo has no
 * preferred column spacing).
 */
const DEFAULT_CONFIDENCE_THRESHOLD = 3;

/**
 * Detect the strongest column and row period in `buffer` and offer a single
 * suggested pixel size, or `undefined` when neither axis shows a confident
 * periodic grid (`docs/04` §3.3's "handle the already pixel-sized … case
 * gracefully").
 */
export function detectGrid(
  buffer: PixelBuffer,
  options: GridDetectionOptions = {},
): GridDetectionResult | undefined {
  const minPeriod = Math.max(2, Math.floor(options.minPeriod ?? DEFAULT_MIN_PERIOD));
  const maxPeriodCeiling = Math.floor(options.maxPeriod ?? DEFAULT_MAX_PERIOD);
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const columnDiff = columnDifferenceSignal(buffer);
  const rowDiff = rowDifferenceSignal(buffer);

  const column = strongestPeriod(
    columnDiff,
    minPeriod,
    Math.min(maxPeriodCeiling, Math.floor((buffer.width - 1) / 2)),
    confidenceThreshold,
  );
  const row = strongestPeriod(
    rowDiff,
    minPeriod,
    Math.min(maxPeriodCeiling, Math.floor((buffer.height - 1) / 2)),
    confidenceThreshold,
  );

  if (!column && !row) return undefined;

  if (column && row) {
    const agreement = column.period === row.period;
    // Neither axis is inherently more trustworthy; when they disagree, take
    // the one with the stronger signal rather than always preferring columns.
    const period = agreement
      ? column.period
      : column.confidence >= row.confidence
        ? column.period
        : row.period;
    return { period, column, row, agreement };
  }

  const only = (column ?? row)!;
  return { period: only.period, column, row, agreement: false };
}

/**
 * `diff[x] = sum over y of |pixel[x,y] - pixel[x-1,y]|` (`docs/04` §3.3),
 * summed across all four RGBA channels. Index 0 is unused (there is no
 * column -1); valid indices are `1..width-1`.
 */
function columnDifferenceSignal(buffer: PixelBuffer): Float64Array {
  const { width, height, data } = buffer;
  const diff = new Float64Array(width);
  for (let x = 1; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const a = (y * width + x) * 4;
      const b = a - 4;
      sum +=
        Math.abs(data[a] - data[b]) +
        Math.abs(data[a + 1] - data[b + 1]) +
        Math.abs(data[a + 2] - data[b + 2]) +
        Math.abs(data[a + 3] - data[b + 3]);
    }
    diff[x] = sum;
  }
  return diff;
}

/** Row-axis mirror of {@link columnDifferenceSignal}: `diff[y] = sum over x of |pixel[x,y] - pixel[x,y-1]|`. */
function rowDifferenceSignal(buffer: PixelBuffer): Float64Array {
  const { width, height, data } = buffer;
  const diff = new Float64Array(height);
  for (let y = 1; y < height; y++) {
    let sum = 0;
    const rowA = y * width;
    const rowB = rowA - width;
    for (let x = 0; x < width; x++) {
      const a = (rowA + x) * 4;
      const b = (rowB + x) * 4;
      sum +=
        Math.abs(data[a] - data[b]) +
        Math.abs(data[a + 1] - data[b + 1]) +
        Math.abs(data[a + 2] - data[b + 2]) +
        Math.abs(data[a + 3] - data[b + 3]);
    }
    diff[y] = sum;
  }
  return diff;
}

/**
 * A period whose "on-grid" bucket has fewer samples than this is not
 * considered, no matter how high its mean. A large candidate period (say,
 * within a factor of 2 of the whole signal's length) only ever gets one or
 * two samples, and with genuinely random per-pixel colour data the mean of
 * one or two samples has enough variance on its own to spuriously clear the
 * confidence threshold.
 */
const MIN_SAMPLES_PER_PERIOD = 6;

/**
 * A candidate period must score within this fraction of the best score found
 * to be considered "as good as the best" (see {@link strongestPeriod}). A true
 * subharmonic (`p0/k`) only has a `1/k` chance of any given one of its
 * multiples landing on a real edge — the rest land on genuinely zero-diff
 * interior columns — so its confidence is diluted by roughly that same factor
 * below the true period's. A harmonic (`k*p0`) lands on real edges every time,
 * so its confidence stays close to the true period's; 0.75 comfortably
 * separates "diluted by a missing subharmonic factor of at least 2" from
 * "statistical noise around the same real signal".
 */
const NEAR_BEST_FRACTION = 0.75;

/**
 * Autocorrelation-by-periodicity (`docs/04` §3.3: "take the strongest
 * period"). For each candidate period `p`, compares the mean of `diff` at
 * indices that are multiples of `p` (where a genuine `p`-upscaled grid's hard
 * block edges land) against the mean over the whole signal.
 *
 * **Smallest period that is near the best score wins, not simply the
 * highest-scoring one.** A true period `p0`'s hard edges sit at *every*
 * multiple of `p0`. A harmonic (`2p0`, `3p0`, …) lands on a subset of those
 * same real edges, so it scores about as well — scanning candidates from the
 * smallest up and accepting the first one within {@link NEAR_BEST_FRACTION}
 * of the best score picks `p0` over any of its harmonics (the classic "octave
 * error" familiar from pitch-detection autocorrelation, avoided the same way
 * here). A *subharmonic* (`p0/k`) instead scores markedly *lower*, because
 * most of its own "on-grid" positions land on genuinely zero-diff interior
 * columns rather than real edges — `NEAR_BEST_FRACTION` is what keeps a
 * subharmonic from being mistaken for the true period.
 */
function strongestPeriod(
  diff: Float64Array,
  minPeriod: number,
  maxPeriod: number,
  confidenceThreshold: number,
): AxisDetection | undefined {
  if (maxPeriod < minPeriod) return undefined;

  const length = diff.length;
  let sumAll = 0;
  let countAll = 0;
  for (let x = 1; x < length; x++) {
    sumAll += diff[x];
    countAll++;
  }
  if (countAll === 0) return undefined;
  const meanAll = sumAll / countAll;
  // A perfectly flat signal (blank or uniform source) has nothing to detect.
  if (meanAll <= 0) return undefined;

  const confidenceByPeriod = new Map<number, number>();
  let bestConfidence = 0;
  for (let p = minPeriod; p <= maxPeriod; p++) {
    let sumAt = 0;
    let countAt = 0;
    for (let x = p; x < length; x += p) {
      sumAt += diff[x];
      countAt++;
    }
    if (countAt < MIN_SAMPLES_PER_PERIOD) continue;
    const confidence = sumAt / countAt / meanAll;
    confidenceByPeriod.set(p, confidence);
    if (confidence > bestConfidence) bestConfidence = confidence;
  }

  if (bestConfidence < confidenceThreshold) return undefined;

  for (let p = minPeriod; p <= maxPeriod; p++) {
    const confidence = confidenceByPeriod.get(p);
    if (confidence !== undefined && confidence >= bestConfidence * NEAR_BEST_FRACTION) {
      return { period: p, confidence };
    }
  }

  return undefined;
}
