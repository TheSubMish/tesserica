/**
 * Auto palette — "the best N colours for this image" (`docs/04` §4.3).
 *
 * Mirrors `src-tauri/src/pipeline/autopalette.rs`.
 *
 * **Wu's algorithm, then k-means in Oklab.** Wu gives a good *deterministic*
 * starting partition by greedily splitting a 3D colour histogram along the axis
 * that removes the most variance; k-means then refines it where perception
 * actually lives. Neither half is optional: k-means from a bad start converges
 * to a bad local minimum, and Wu alone optimizes squared error in RGB, which is
 * not what the eye measures.
 *
 * **Determinism is a correctness requirement, not a nicety.** The same input and
 * settings must produce the same palette in both languages, or preview and
 * export diverge in the most visible way possible — different colours. So:
 * integer moments, no random seeding, a fixed iteration count, and an explicit
 * tie-break everywhere a comparison could be equal.
 */

import { NEAREST_EPSILON, type Oklab, distanceSq, srgb8ToOklab, oklabToSrgb8 } from './oklab.ts';
import type { PixelBuffer } from './buffer.ts';
import type { Rgba } from './settings.ts';

/** Wu bins each channel to 5 bits; index 0 is the below-first-bin guard row. */
const SIDE = 33;
const CELLS = SIDE * SIDE * SIDE;

/** `docs/04` §4.3: "~8 iterations of k-means". Fixed, so the result is stable. */
export const KMEANS_ITERATIONS = 8;

const at = (r: number, g: number, b: number): number => (r * SIDE + g) * SIDE + b;

interface Moments {
  /** Pixel counts. */
  readonly weight: Float64Array;
  readonly sumR: Float64Array;
  readonly sumG: Float64Array;
  readonly sumB: Float64Array;
  /** Sum of squared magnitudes, for the variance term. */
  readonly sumSq: Float64Array;
}

interface Box {
  r0: number;
  r1: number;
  g0: number;
  g1: number;
  b0: number;
  b1: number;
  volume: number;
}

/**
 * Build the 3D histogram and turn it into cumulative moments.
 *
 * Counts are exact integers held in `Float64Array` — every value is well below
 * 2^53, so this is integer arithmetic that happens to be spelled in doubles, and
 * it is identical in both languages.
 */
function buildMoments(image: PixelBuffer, alphaThreshold: number): Moments {
  const weight = new Float64Array(CELLS);
  const sumR = new Float64Array(CELLS);
  const sumG = new Float64Array(CELLS);
  const sumB = new Float64Array(CELLS);
  const sumSq = new Float64Array(CELLS);

  for (let i = 0; i < image.data.length; i += 4) {
    // Fully transparent pixels have no colour worth spending a palette entry
    // on; including them would tug every centroid toward whatever RGB happens
    // to sit under the transparency.
    if (image.data[i + 3] < alphaThreshold) continue;

    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    const index = at((r >> 3) + 1, (g >> 3) + 1, (b >> 3) + 1);

    weight[index] += 1;
    sumR[index] += r;
    sumG[index] += g;
    sumB[index] += b;
    sumSq[index] += r * r + g * g + b * b;
  }

  // Cumulative sums over the three axes, so any box's totals are eight lookups.
  for (let r = 1; r < SIDE; r++) {
    const areaW = new Float64Array(SIDE);
    const areaR = new Float64Array(SIDE);
    const areaG = new Float64Array(SIDE);
    const areaB = new Float64Array(SIDE);
    const areaSq = new Float64Array(SIDE);

    for (let g = 1; g < SIDE; g++) {
      let lineW = 0;
      let lineR = 0;
      let lineG = 0;
      let lineB = 0;
      let lineSq = 0;

      for (let b = 1; b < SIDE; b++) {
        const i = at(r, g, b);
        lineW += weight[i];
        lineR += sumR[i];
        lineG += sumG[i];
        lineB += sumB[i];
        lineSq += sumSq[i];

        areaW[b] += lineW;
        areaR[b] += lineR;
        areaG[b] += lineG;
        areaB[b] += lineB;
        areaSq[b] += lineSq;

        const prev = at(r - 1, g, b);
        weight[i] = weight[prev] + areaW[b];
        sumR[i] = sumR[prev] + areaR[b];
        sumG[i] = sumG[prev] + areaG[b];
        sumB[i] = sumB[prev] + areaB[b];
        sumSq[i] = sumSq[prev] + areaSq[b];
      }
    }
  }

  return { weight, sumR, sumG, sumB, sumSq };
}

/** Inclusion–exclusion over the eight corners of a box. */
function volume(box: Box, m: Float64Array): number {
  return (
    m[at(box.r1, box.g1, box.b1)] -
    m[at(box.r1, box.g1, box.b0)] -
    m[at(box.r1, box.g0, box.b1)] +
    m[at(box.r1, box.g0, box.b0)] -
    m[at(box.r0, box.g1, box.b1)] +
    m[at(box.r0, box.g1, box.b0)] +
    m[at(box.r0, box.g0, box.b1)] -
    m[at(box.r0, box.g0, box.b0)]
  );
}

/** The part of a box's total that lies below `pos` on `axis`. */
function bottom(box: Box, axis: 0 | 1 | 2, m: Float64Array): number {
  if (axis === 0) {
    return (
      -m[at(box.r0, box.g1, box.b1)] +
      m[at(box.r0, box.g1, box.b0)] +
      m[at(box.r0, box.g0, box.b1)] -
      m[at(box.r0, box.g0, box.b0)]
    );
  }
  if (axis === 1) {
    return (
      -m[at(box.r1, box.g0, box.b1)] +
      m[at(box.r1, box.g0, box.b0)] +
      m[at(box.r0, box.g0, box.b1)] -
      m[at(box.r0, box.g0, box.b0)]
    );
  }
  return (
    -m[at(box.r1, box.g1, box.b0)] +
    m[at(box.r1, box.g0, box.b0)] +
    m[at(box.r0, box.g1, box.b0)] -
    m[at(box.r0, box.g0, box.b0)]
  );
}

function top(box: Box, axis: 0 | 1 | 2, pos: number, m: Float64Array): number {
  if (axis === 0) {
    return (
      m[at(pos, box.g1, box.b1)] -
      m[at(pos, box.g1, box.b0)] -
      m[at(pos, box.g0, box.b1)] +
      m[at(pos, box.g0, box.b0)]
    );
  }
  if (axis === 1) {
    return (
      m[at(box.r1, pos, box.b1)] -
      m[at(box.r1, pos, box.b0)] -
      m[at(box.r0, pos, box.b1)] +
      m[at(box.r0, pos, box.b0)]
    );
  }
  return (
    m[at(box.r1, box.g1, pos)] -
    m[at(box.r1, box.g0, pos)] -
    m[at(box.r0, box.g1, pos)] +
    m[at(box.r0, box.g0, pos)]
  );
}

/** Weighted variance of a box — the quantity Wu greedily removes. */
function variance(box: Box, m: Moments): number {
  const w = volume(box, m.weight);
  if (w === 0) return 0;
  const r = volume(box, m.sumR);
  const g = volume(box, m.sumG);
  const b = volume(box, m.sumB);
  return volume(box, m.sumSq) - (r * r + g * g + b * b) / w;
}

interface Cut {
  readonly position: number;
  readonly gain: number;
}

/** Best cut along one axis, or `position < 0` when the axis cannot be split. */
function bestCut(box: Box, axis: 0 | 1 | 2, m: Moments, wholeW: number): Cut {
  const first = axis === 0 ? box.r0 + 1 : axis === 1 ? box.g0 + 1 : box.b0 + 1;
  const last = axis === 0 ? box.r1 : axis === 1 ? box.g1 : box.b1;

  const baseW = bottom(box, axis, m.weight);
  const baseR = bottom(box, axis, m.sumR);
  const baseG = bottom(box, axis, m.sumG);
  const baseB = bottom(box, axis, m.sumB);

  const wholeR = volume(box, m.sumR);
  const wholeG = volume(box, m.sumG);
  const wholeB = volume(box, m.sumB);

  let best = -1;
  let bestGain = 0;

  for (let pos = first; pos < last; pos++) {
    const halfW = baseW + top(box, axis, pos, m.weight);
    if (halfW === 0) continue;
    const otherW = wholeW - halfW;
    if (otherW === 0) break;

    const halfR = baseR + top(box, axis, pos, m.sumR);
    const halfG = baseG + top(box, axis, pos, m.sumG);
    const halfB = baseB + top(box, axis, pos, m.sumB);

    const otherR = wholeR - halfR;
    const otherG = wholeG - halfG;
    const otherB = wholeB - halfB;

    const gain =
      (halfR * halfR + halfG * halfG + halfB * halfB) / halfW +
      (otherR * otherR + otherG * otherG + otherB * otherB) / otherW;

    // Strictly greater: on a tie the *lower* cut position wins, in both
    // languages, so an image with a symmetric histogram cannot split two ways.
    if (gain > bestGain) {
      bestGain = gain;
      best = pos;
    }
  }

  return { position: best, gain: bestGain };
}

/** Wu's greedy split. Returns the boxes, at most `maxColors` of them. */
function wuBoxes(m: Moments, maxColors: number): Box[] {
  const boxes: Box[] = [
    { r0: 0, r1: SIDE - 1, g0: 0, g1: SIDE - 1, b0: 0, b1: SIDE - 1, volume: 0 },
  ];
  const variances: number[] = [variance(boxes[0], m)];

  while (boxes.length < maxColors) {
    // Split the box with the most variance; ties go to the lowest index.
    let target = -1;
    let worst = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (variances[i] > worst) {
        worst = variances[i];
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const wholeW = volume(box, m.weight);
    const cuts: Cut[] = [
      bestCut(box, 0, m, wholeW),
      bestCut(box, 1, m, wholeW),
      bestCut(box, 2, m, wholeW),
    ];

    // Axis order r, g, b with strict `>` again fixes ties to the earliest axis.
    let axis = -1;
    let gain = 0;
    for (let a = 0; a < 3; a++) {
      if (cuts[a].position >= 0 && cuts[a].gain > gain) {
        gain = cuts[a].gain;
        axis = a;
      }
    }
    if (axis < 0) {
      // Unsplittable: retire it so the loop cannot spin on it forever.
      variances[target] = 0;
      continue;
    }

    const cut = cuts[axis].position;
    const next: Box = { ...box };
    if (axis === 0) {
      next.r0 = cut;
      box.r1 = cut;
    } else if (axis === 1) {
      next.g0 = cut;
      box.g1 = cut;
    } else {
      next.b0 = cut;
      box.b1 = cut;
    }

    variances[target] = variance(box, m);
    boxes.push(next);
    variances.push(variance(next, m));
  }

  return boxes;
}

function boxCentroid(box: Box, m: Moments): Rgba | undefined {
  const w = volume(box, m.weight);
  if (w === 0) return undefined;
  return [
    Math.round(volume(box, m.sumR) / w),
    Math.round(volume(box, m.sumG) / w),
    Math.round(volume(box, m.sumB) / w),
    255,
  ];
}

interface Sample {
  readonly lab: Oklab;
  readonly count: number;
}

/**
 * One sample per *distinct* colour, weighted by how often it occurs.
 *
 * Iterating distinct colours rather than pixels makes k-means cost independent
 * of image size, and — more importantly — makes it independent of pixel *order*,
 * so the two implementations cannot drift on traversal alone.
 */
function distinctSamples(image: PixelBuffer, alphaThreshold: number): Sample[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < alphaThreshold) continue;
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Sorted by colour key: a deterministic order in both languages, which a JS
  // `Map` and a Rust `HashMap` would otherwise not share.
  const keys = [...counts.keys()].sort((a, b) => a - b);
  return keys.map((key) => ({
    lab: srgb8ToOklab((key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff),
    count: counts.get(key) as number,
  }));
}

/**
 * Lloyd's algorithm in Oklab, weighted by colour frequency.
 *
 * Fixed iteration count and no random restarts — see the determinism note at the
 * top of this file. An empty cluster keeps its previous centroid rather than
 * being re-seeded, which is the behaviour that has no arbitrary choice in it.
 */
export function kmeansOklab(
  samples: readonly Sample[],
  initial: readonly Oklab[],
  iterations = KMEANS_ITERATIONS,
): Oklab[] {
  const centroids = initial.map((c) => ({ ...c }));
  if (centroids.length === 0 || samples.length === 0) return centroids;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const sumL = new Float64Array(centroids.length);
    const sumA = new Float64Array(centroids.length);
    const sumB = new Float64Array(centroids.length);
    const weight = new Float64Array(centroids.length);

    for (const sample of samples) {
      let best = 0;
      let bestD = distanceSq(sample.lab, centroids[0]);
      for (let i = 1; i < centroids.length; i++) {
        const d = distanceSq(sample.lab, centroids[i]);
        // The D12 tie-break again: equidistant samples join the lowest cluster.
        if (d < bestD - NEAREST_EPSILON) {
          bestD = d;
          best = i;
        }
      }
      sumL[best] += sample.lab.l * sample.count;
      sumA[best] += sample.lab.a * sample.count;
      sumB[best] += sample.lab.b * sample.count;
      weight[best] += sample.count;
    }

    let moved = false;
    for (let i = 0; i < centroids.length; i++) {
      if (weight[i] === 0) continue;
      const next = { l: sumL[i] / weight[i], a: sumA[i] / weight[i], b: sumB[i] / weight[i] };
      if (next.l !== centroids[i].l || next.a !== centroids[i].a || next.b !== centroids[i].b) {
        moved = true;
      }
      centroids[i] = next;
    }
    if (!moved) break;
  }

  return centroids;
}

/**
 * Choose up to `maxColors` colours for `image`.
 *
 * Always returns at least one colour: a fully transparent image still needs a
 * palette for the pipeline to be defined on, and black is the least surprising
 * answer for an image with no visible pixels.
 */
export function autoPalette(image: PixelBuffer, maxColors: number, alphaThreshold: number): Rgba[] {
  if (!Number.isInteger(maxColors) || maxColors < 1) {
    throw new Error(`maxColors must be a positive integer, got ${maxColors}`);
  }

  const samples = distinctSamples(image, alphaThreshold);
  if (samples.length === 0) return [[0, 0, 0, 255]];

  // Fewer distinct colours than requested: return them exactly. Inventing
  // extra entries by splitting a flat image is worse than a short palette.
  if (samples.length <= maxColors) {
    return samples.map((s) => {
      const [r, g, b] = oklabToSrgb8(s.lab);
      return [r, g, b, 255] as Rgba;
    });
  }

  const moments = buildMoments(image, alphaThreshold);
  const seeds: Oklab[] = [];
  for (const box of wuBoxes(moments, maxColors)) {
    const centroid = boxCentroid(box, moments);
    if (centroid) seeds.push(srgb8ToOklab(centroid[0], centroid[1], centroid[2]));
  }
  if (seeds.length === 0) return [[0, 0, 0, 255]];

  const refined = kmeansOklab(samples, seeds);

  // Deduplicate: k-means can collapse two centroids onto the same 8-bit colour,
  // and a palette with a repeated entry wastes a slot and confuses the index
  // map's meaning.
  const seen = new Set<number>();
  const out: Rgba[] = [];
  for (const centroid of refined) {
    const [r, g, b] = oklabToSrgb8(centroid);
    const key = (r << 16) | (g << 8) | b;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([r, g, b, 255]);
  }

  // Sorted for stability: the palette's *order* is visible in the index map, and
  // an order that depended on Wu's split sequence would make the golden suite
  // sensitive to an implementation detail rather than to the colours chosen.
  out.sort((x, y) => (x[0] << 16) + (x[1] << 8) + x[2] - ((y[0] << 16) + (y[1] << 8) + y[2]));
  return out;
}
