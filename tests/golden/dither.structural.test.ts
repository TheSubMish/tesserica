import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bufferFrom } from '../../src/pipeline/buffer.ts';
import { convert } from '../../src/pipeline/convert.ts';
import { downscale } from '../../src/pipeline/downscale.ts';
import { TRANSPARENT_INDEX } from '../../src/pipeline/quantize.ts';
import {
  defaultSettings,
  targetSizeForPixelSize,
  type ConvertSettings,
  type DitherMode,
} from '../../src/pipeline/settings.ts';
import { SOURCES } from './corpus.ts';
import { MATRIX_PALETTES } from './matrix.ts';
import {
  ACTUAL_DIR,
  SOURCES_DIR,
  assertCorpusIsCurrent,
  readConvertPayload,
  readSource,
  runRust,
  type Job,
} from './runner.ts';

/**
 * The comparison `docs/04` §11 actually asks for on dithered modes — and the one
 * that maps onto the real risk.
 *
 * `convert.parity.test.ts` gives both implementations the same bytes at the same
 * size, so error diffusion is deterministic there and an exact match is
 * demanded. **That is not the shipping situation.** In the app, preview runs the
 * TS pipeline on a ~1024px *proxy* while export runs the Rust pipeline on the
 * full-resolution original (`docs/02` §3.3). Error diffusion is legitimately
 * resolution-dependent, so those two cannot be identical — and the honest
 * question is whether they are close enough that a user who approved the preview
 * recognises the export.
 *
 * This test simulates exactly that: TS converts a half-size proxy, Rust converts
 * the full source, both to the same output dimensions, and the two are compared
 * on the **distribution of palette indices**.
 *
 * The metric is total variation distance over the palette-usage histogram:
 * `0.5 * Σ |p_i − q_i|` on normalized frequencies, so 0 means identical usage and
 * 1 means no overlap at all.
 */

/**
 * Threshold, chosen from measurement rather than taste.
 *
 * The observed worst case across this matrix is recorded in
 * `tests/golden/README.md`; this bound sits above it with headroom, and far
 * below the point where a preview would stop resembling its export. A dither
 * implementation that genuinely diverged — a wrong kernel weight, a missing
 * serpentine flip — moves this metric by an order of magnitude, not a few
 * percent.
 */
const MAX_TOTAL_VARIATION = 0.2;

const DITHER_MODES: readonly DitherMode[] = ['floyd-steinberg', 'atkinson', 'bayer4'];

interface Case {
  readonly id: string;
  readonly sourceName: string;
  readonly settings: ConvertSettings;
}

function histogram(indices: Uint16Array, paletteSize: number): Float64Array {
  // One extra bucket for transparency: a mode that dropped or gained
  // transparent pixels would otherwise look identical.
  const h = new Float64Array(paletteSize + 1);
  for (const i of indices) h[i === TRANSPARENT_INDEX ? paletteSize : i]++;
  for (let i = 0; i < h.length; i++) h[i] /= indices.length;
  return h;
}

function totalVariation(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

describe('dither structural parity: TS on a proxy vs Rust at full resolution', () => {
  // Four palettes of different sizes — a 4-colour palette and a 54-colour one
  // fail differently, and the small ones are the harsh case for error diffusion.
  const palettes = MATRIX_PALETTES.filter((p) =>
    ['gameboy', 'nes', 'c64', 'grayscale-4'].includes(p.name),
  );

  const cases: Case[] = [];
  for (const source of SOURCES) {
    for (const palette of palettes) {
      for (const dither of DITHER_MODES) {
        const { width, height } = targetSizeForPixelSize(source.width, source.height, 8);
        cases.push({
          id: `convert/structural__${source.name}__${palette.name}__${dither}`,
          sourceName: source.name,
          settings: { ...defaultSettings(width, height, palette.spec), dither },
        });
      }
    }
  }

  const distances = new Map<string, number>();

  beforeAll(() => {
    assertCorpusIsCurrent();

    const jobs: Job[] = cases.map((c) => {
      const source = SOURCES.find((s) => s.name === c.sourceName)!;
      return {
        id: c.id,
        kind: 'convert',
        rgba: join(SOURCES_DIR, `${source.name}.rgba`),
        width: source.width,
        height: source.height,
        settings: c.settings,
      };
    });
    runRust(jobs);

    for (const c of cases) {
      const source = SOURCES.find((s) => s.name === c.sourceName)!;
      const full = bufferFrom(source.width, source.height, readSource(source));

      // The preview's proxy: the same image at half the linear resolution, the
      // way `docs/02` §8 downsamples a large source before previewing it.
      const proxy = downscale(
        full,
        Math.max(1, Math.floor(source.width / 2)),
        Math.max(1, Math.floor(source.height / 2)),
        'box',
      );

      const preview = convert(proxy, c.settings);
      const exported = readConvertPayload(c.id);
      const paletteSize =
        c.settings.palette.kind === 'fixed' ? c.settings.palette.colors.length : 0;

      distances.set(
        c.id,
        totalVariation(
          histogram(preview.indices, paletteSize),
          histogram(exported.indices, paletteSize),
        ),
      );
    }
  }, 1_800_000);

  it('covers every source, several palette sizes, and both dither families', () => {
    expect(cases.length).toBe(SOURCES.length * palettes.length * DITHER_MODES.length);
  });

  it('preview and export use the palette the same way', () => {
    const worst = [...distances.entries()].sort((a, b) => b[1] - a[1]);

    writeFileSync(
      join(ACTUAL_DIR, 'dither-structural.json'),
      `${JSON.stringify(
        {
          note:
            'Total variation distance between the palette-usage histograms of the TS ' +
            'preview (half-resolution proxy) and the Rust export (full resolution). ' +
            `Bound: ${MAX_TOTAL_VARIATION}.`,
          cases: cases.length,
          max: worst[0][1],
          worst10: worst.slice(0, 10).map(([id, d]) => ({ id, distance: d })),
        },
        null,
        2,
      )}\n`,
    );

    const over = worst.filter(([, d]) => d > MAX_TOTAL_VARIATION);
    expect(over.map(([id, d]) => `${id}: ${d.toFixed(4)}`)).toEqual([]);
  });

  it('ordered dithering is far more resolution-stable than error diffusion', () => {
    // §5.3's claim, checked rather than assumed: Bayer has no inter-pixel
    // dependency, so changing the source resolution barely moves it, while
    // error diffusion's whole mechanism is a chain through neighbours.
    const mean = (mode: DitherMode): number => {
      const ds = [...distances.entries()]
        .filter(([id]) => id.endsWith(`__${mode}`))
        .map(([, d]) => d);
      return ds.reduce((a, b) => a + b, 0) / ds.length;
    };
    expect(mean('bayer4')).toBeLessThan(mean('floyd-steinberg'));
  });
});
