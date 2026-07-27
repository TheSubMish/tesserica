/**
 * The settings matrix for the parity suite (`docs/04-image-pipeline.md` §11):
 * each palette × each dither mode × three pixel sizes.
 *
 * Kept separate from the tests so that adding a dither mode or a downscale mode
 * extends the coverage of every source at once, rather than requiring a new test
 * to be remembered.
 */

import { BUILTIN_PALETTES } from '../../src/lib/palettes/builtin.ts';
import type {
  ConvertSettings,
  DitherMode,
  DownscaleMode,
  PaletteSpec,
  Rgba,
} from '../../src/pipeline/settings.ts';
import { defaultSettings, targetSizeForPixelSize } from '../../src/pipeline/settings.ts';
import { SOURCES, type GoldenSource } from './corpus.ts';

/** Bundled palettes, as pipeline `PaletteSpec`s. Auto is covered separately. */
export const MATRIX_PALETTES: ReadonlyArray<{ name: string; spec: PaletteSpec }> =
  BUILTIN_PALETTES.map((p) => ({
    name: p.id,
    spec: { kind: 'fixed', colors: p.colors as readonly Rgba[] },
  }));

/** §3.2's control: how big the blocks are, not what the output dimensions are. */
export const MATRIX_PIXEL_SIZES: readonly number[] = [4, 8, 16];

export const MATRIX_DOWNSCALE_MODES: readonly DownscaleMode[] = ['box', 'nearest', 'dominant'];

/**
 * Dither modes currently implemented in **both** languages.
 *
 * Extending this list is how a new dither mode enters the parity suite. A mode
 * that is not in it has no cross-implementation coverage, which is the exact
 * situation the corpus exists to prevent — so add the mode and the entry
 * together.
 */
export const MATRIX_DITHER_MODES: readonly DitherMode[] = [
  'none',
  'floyd-steinberg',
  'atkinson',
  'bayer2',
  'bayer4',
  'bayer8',
];

export interface MatrixCase {
  readonly id: string;
  readonly source: GoldenSource;
  readonly settings: ConvertSettings;
}

/**
 * The full cross-product: 7 sources × 8 palettes × 3 sizes × 3 downscale modes ×
 * 6 dither modes. Every case runs inside one already-started process, so breadth
 * is cheap — and breadth is exactly what catches a divergence that only one
 * palette, or only one dither mode, provokes.
 */
export function matrixCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (const source of SOURCES) {
    for (const palette of MATRIX_PALETTES) {
      for (const pixelSize of MATRIX_PIXEL_SIZES) {
        const { width, height } = targetSizeForPixelSize(source.width, source.height, pixelSize);
        for (const downscaleMode of MATRIX_DOWNSCALE_MODES) {
          for (const dither of MATRIX_DITHER_MODES) {
            cases.push({
              id: `convert/${source.name}__${palette.name}__px${pixelSize}__${downscaleMode}__${dither}`,
              source,
              settings: {
                ...defaultSettings(width, height, palette.spec),
                downscaleMode,
                dither,
              },
            });
          }
        }
      }
    }
  }
  return cases;
}

/**
 * Cases that exercise the stages the plain matrix leaves at their defaults:
 * adjustments, crop, fit-to-subject, despeckle, outline, sRGB distance, and
 * `preserveAlpha`.
 *
 * These are the settings most likely to diverge, because each one is a place
 * where two implementations can round or order things differently.
 */
export function edgeCases(): MatrixCase[] {
  const palette = MATRIX_PALETTES[0].spec;
  const cases: MatrixCase[] = [];

  const push = (source: GoldenSource, name: string, patch: Partial<ConvertSettings>): void => {
    const { width, height } = targetSizeForPixelSize(source.width, source.height, 8);
    cases.push({
      id: `convert/edge__${source.name}__${name}`,
      source,
      settings: { ...defaultSettings(width, height, palette), ...patch },
    });
  };

  const portrait = SOURCES[0];
  const landscape = SOURCES[1];
  const pixelArt = SOURCES[3];
  const alpha = SOURCES[4];
  const contrast = SOURCES[5];
  const gradient = SOURCES[6];

  push(portrait, 'brightness-up', { brightness: 0.4 });
  push(portrait, 'brightness-down', { brightness: -0.4 });
  push(landscape, 'contrast-up', { contrast: 0.6 });
  push(landscape, 'saturation-down', { saturation: -0.7 });
  push(gradient, 'saturation-up', { saturation: 0.8 });
  push(gradient, 'hue-shift', { hueShift: 137 });
  push(gradient, 'all-adjustments', {
    brightness: 0.2,
    contrast: -0.3,
    saturation: 0.5,
    hueShift: -60,
  });

  push(portrait, 'crop', { crop: { x: 10, y: 20, w: 60, h: 70 } });
  push(alpha, 'fit-to-subject', { fitToSubject: true });
  push(alpha, 'preserve-alpha', { preserveAlpha: true });
  push(alpha, 'low-alpha-threshold', { alphaThreshold: 8 });
  push(alpha, 'high-alpha-threshold', { alphaThreshold: 250 });
  push(alpha, 'outline-corners', {
    outline: { color: [0, 0, 0, 255], thickness: 1, corners: true },
  });
  push(alpha, 'outline-thick-no-corners', {
    outline: { color: [255, 255, 255, 255], thickness: 2, corners: false },
  });

  push(contrast, 'despeckle-1', { despeckle: 1 });
  push(contrast, 'despeckle-3', { despeckle: 3 });
  push(pixelArt, 'despeckle-3-nearest', { despeckle: 3, downscaleMode: 'nearest' });

  push(portrait, 'srgb-distance', { colorSpace: 'srgb' });
  push(gradient, 'srgb-distance', { colorSpace: 'srgb' });

  // Dither strength is a multiplier on the diffused error and on the Bayer
  // threshold; a value that is neither 0 nor 1 is where a scaling mistake in one
  // implementation would show.
  for (const dither of ['floyd-steinberg', 'atkinson', 'bayer4'] as const) {
    push(gradient, `${dither}-strength-half`, { dither, ditherStrength: 0.5 });
    push(portrait, `${dither}-strength-zero`, { dither, ditherStrength: 0 });
  }
  push(alpha, 'floyd-steinberg-over-alpha', { dither: 'floyd-steinberg' });
  push(alpha, 'atkinson-over-alpha', { dither: 'atkinson', preserveAlpha: true });

  // Auto palette (§4.3). The highest-risk case in the whole suite: Wu's greedy
  // split and eight k-means iterations have to agree *exactly* across two
  // languages, and a divergence here changes the palette itself rather than a
  // pixel's assignment to it. Covered across every source, several colour
  // counts, and with dithering on top.
  for (const source of SOURCES) {
    for (const maxColors of [4, 8, 16, 32]) {
      push(source, `auto-${maxColors}`, { palette: { kind: 'auto', maxColors } });
    }
  }
  push(portrait, 'auto-16-floyd-steinberg', {
    palette: { kind: 'auto', maxColors: 16 },
    dither: 'floyd-steinberg',
  });
  push(gradient, 'auto-8-bayer4', {
    palette: { kind: 'auto', maxColors: 8 },
    dither: 'bayer4',
  });
  push(alpha, 'auto-8-over-alpha', { palette: { kind: 'auto', maxColors: 8 } });
  push(pixelArt, 'auto-4-nearest', {
    palette: { kind: 'auto', maxColors: 4 },
    downscaleMode: 'nearest',
  });

  return cases;
}
