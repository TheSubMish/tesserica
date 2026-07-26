/**
 * Bundled palettes.
 *
 * **Only hardware palettes may live here** (`docs/07-tech-stack.md` §8). These
 * are factual lists of the colours a machine could display — not authored
 * works — so shipping them is safe. Artist-made Lospec palettes each carry
 * their own licence and are *never* bundled; users import their own, which is
 * what the `.hex` / `.gpl` / `.pal` / `.txt` importers are for.
 *
 * They are compiled in rather than read from `assets/palettes/` at runtime:
 * the core makes no I/O and no network calls (`docs/02-architecture.md` §9),
 * and compiling them in means the app, the tests and the eventual Rust export
 * path all see byte-identical data with no load-order concerns. The whole set
 * is a few kilobytes.
 */

import type { Palette, RGBA } from '../../model/types';

/** `RRGGBB` → opaque RGBA. */
export function fromHex(hex: string): RGBA {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function palette(id: string, name: string, hexes: string[]): Palette {
  // Duplicates are noise in a swatch grid: the NES sends the same black
  // through nine different register values, and an artist wants one.
  const seen = new Set<string>();
  const colors: RGBA[] = [];
  for (const hex of hexes) {
    const key = hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push(fromHex(hex));
  }
  return { id, name, colors, source: { kind: 'builtin' } };
}

/** Game Boy (DMG) — the four shades the original LCD could show. */
const GAME_BOY = palette('gameboy', 'Game Boy', ['0f380f', '306230', '8bac0f', '9bbc0f']);

/**
 * NES 2C02. The PPU has 64 register values but far fewer distinct colours —
 * `$0D`–`$0F`, `$1D`–`$1F`, `$2E`–`$2F` and `$3E`–`$3F` are all black.
 */
// prettier-ignore
const NES = palette('nes', 'NES', [
  '7c7c7c', '0000fc', '0000bc', '4428bc', '940084', 'a80020', 'a81000', '881400',
  '503000', '007800', '006800', '005800', '004058', '000000', '000000', '000000',
  'bcbcbc', '0078f8', '0058f8', '6844fc', 'd800cc', 'e40058', 'f83800', 'e45c10',
  'ac7c00', '00b800', '00a800', '00a844', '008888', '000000', '000000', '000000',
  'f8f8f8', '3cbcfc', '6888fc', '9878f8', 'f878f8', 'f85898', 'f87858', 'fca044',
  'f8b800', 'b8f818', '58d854', '58f898', '00e8d8', '787878', '000000', '000000',
  'fcfcfc', 'a4e4fc', 'b8b8f8', 'd8b8f8', 'f8b8f8', 'f8a4c0', 'f0d0b0', 'fce0a8',
  'f8d878', 'd8f878', 'b8f8b8', 'b8f8d8', '00fcfc', 'f8d8f8', '000000', '000000',
]);

/** IBM CGA — the standard 16-colour text/graphics set. */
// prettier-ignore
const CGA = palette('cga', 'CGA', [
  '000000', '0000aa', '00aa00', '00aaaa', 'aa0000', 'aa00aa', 'aa5500', 'aaaaaa',
  '555555', '5555ff', '55ff55', '55ffff', 'ff5555', 'ff55ff', 'ffff55', 'ffffff',
]);

/** Commodore 64 VIC-II, using Pepto's measured values. */
// prettier-ignore
const C64 = palette('c64', 'Commodore 64', [
  '000000', 'ffffff', '880000', 'aaffee', 'cc44cc', '00cc55', '0000aa', 'eeee77',
  'dd8855', '664400', 'ff7777', '333333', '777777', 'aaff66', '0088ff', 'bbbbbb',
]);

/** ZX Spectrum — eight hues at two brightnesses; the two blacks are the same. */
// prettier-ignore
const ZX_SPECTRUM = palette('zx-spectrum', 'ZX Spectrum', [
  '000000', '0000d7', 'd70000', 'd700d7', '00d700', '00d7d7', 'd7d700', 'd7d7d7',
  '000000', '0000ff', 'ff0000', 'ff00ff', '00ff00', '00ffff', 'ffff00', 'ffffff',
]);

/** Evenly spaced grey ramp, endpoints included. */
export function grayscaleRamp(steps: number): Palette {
  const colors: RGBA[] = [];
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i * 255) / (steps - 1));
    colors.push([v, v, v, 255]);
  }
  return {
    id: `grayscale-${steps}`,
    name: `Grayscale ${steps}`,
    colors,
    source: { kind: 'builtin' },
  };
}

export const BUILTIN_PALETTES: Palette[] = [
  GAME_BOY,
  NES,
  CGA,
  C64,
  ZX_SPECTRUM,
  grayscaleRamp(4),
  grayscaleRamp(8),
  grayscaleRamp(16),
];
