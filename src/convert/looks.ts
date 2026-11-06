import type { DitherMode } from '../pipeline/settings.ts';

/**
 * One-click "looks" for Convert mode: a palette plus a dither, previewed on the
 * user's own image so they choose by looking rather than by reading a dropdown.
 *
 * Only bundled hardware palettes and the image-derived auto palette appear here
 * (`docs/07-tech-stack.md` §8) — no artist palettes, which carry their own licences.
 */
export interface Look {
  readonly id: string;
  readonly label: string;
  /** A bundled palette id, or `'auto'`. */
  readonly paletteId: string;
  /** Only meaningful when `paletteId` is `'auto'`. */
  readonly autoMaxColors?: number;
  readonly dither: DitherMode;
}

export const LOOKS: readonly Look[] = [
  { id: 'natural', label: 'Natural', paletteId: 'auto', autoMaxColors: 24, dither: 'none' },
  { id: 'bold', label: 'Bold', paletteId: 'auto', autoMaxColors: 8, dither: 'none' },
  { id: 'dithered', label: 'Dithered', paletteId: 'auto', autoMaxColors: 8, dither: 'bayer4' },
  { id: 'soft', label: 'Soft', paletteId: 'auto', autoMaxColors: 16, dither: 'floyd-steinberg' },
  { id: 'gameboy', label: 'Game Boy', paletteId: 'gameboy', dither: 'bayer4' },
  { id: 'nes', label: 'NES', paletteId: 'nes', dither: 'none' },
  { id: 'c64', label: 'C64', paletteId: 'c64', dither: 'floyd-steinberg' },
  { id: 'cga', label: 'CGA', paletteId: 'cga', dither: 'bayer2' },
  { id: 'zx', label: 'ZX Spectrum', paletteId: 'zx-spectrum', dither: 'atkinson' },
];

/** Whether the store's current choices are exactly this look. */
export function isLookActive(
  look: Look,
  state: { paletteId: string; autoMaxColors: number; dither: DitherMode },
): boolean {
  if (look.paletteId !== state.paletteId || look.dither !== state.dither) return false;
  return look.paletteId !== 'auto' || look.autoMaxColors === state.autoMaxColors;
}
