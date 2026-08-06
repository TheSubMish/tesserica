import { describe, expect, it } from 'vitest';
import { BUILTIN_PALETTES, fromHex, grayscaleRamp } from './builtin';

const byId = (id: string) => BUILTIN_PALETTES.find((p) => p.id === id)!;

describe('fromHex', () => {
  it('parses RRGGBB as opaque RGBA', () => {
    expect(fromHex('ff8000')).toEqual([255, 128, 0, 255]);
    expect(fromHex('000000')).toEqual([0, 0, 0, 255]);
  });
});

describe('bundled palettes', () => {
  it('ships only hardware palettes — no artist-made sets', () => {
    // docs/07-tech-stack.md §8: hardware colour lists are factual and safe;
    // artist palettes each carry their own licence and are imported, never
    // bundled. This test is the guard on that.
    const ids = BUILTIN_PALETTES.map((p) => p.id);
    expect(ids).toEqual([
      'gameboy',
      'nes',
      'cga',
      'c64',
      'zx-spectrum',
      'grayscale-4',
      'grayscale-8',
      'grayscale-16',
    ]);
    for (const forbidden of ['pico-8', 'pico8', 'sweetie-16', 'dawnbringer-16', 'db32']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('has the expected sizes after de-duplication', () => {
    expect(byId('gameboy').colors).toHaveLength(4);
    // 64 PPU register values, nine of them a repeat of black.
    expect(byId('nes').colors).toHaveLength(55);
    expect(byId('cga').colors).toHaveLength(16);
    expect(byId('c64').colors).toHaveLength(16);
    // Eight hues × two brightnesses, but the two blacks are the same colour.
    expect(byId('zx-spectrum').colors).toHaveLength(15);
  });

  it('contains no duplicates', () => {
    for (const p of BUILTIN_PALETTES) {
      const keys = p.colors.map((c) => c.join(','));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('is fully opaque — a palette swatch is a colour, not a colour plus alpha', () => {
    for (const p of BUILTIN_PALETTES) {
      for (const c of p.colors) expect(c[3]).toBe(255);
    }
  });

  it('marks everything as a builtin source', () => {
    for (const p of BUILTIN_PALETTES) expect(p.source).toEqual({ kind: 'builtin' });
  });

  it('has the Game Boy greens in dark-to-light order', () => {
    expect(byId('gameboy').colors).toEqual([
      [15, 56, 15, 255],
      [48, 98, 48, 255],
      [139, 172, 15, 255],
      [155, 188, 15, 255],
    ]);
  });
});

describe('grayscaleRamp', () => {
  it('spans pure black to pure white', () => {
    const ramp = grayscaleRamp(4);
    expect(ramp.colors[0]).toEqual([0, 0, 0, 255]);
    expect(ramp.colors[3]).toEqual([255, 255, 255, 255]);
  });

  it('is evenly spaced', () => {
    expect(grayscaleRamp(3).colors.map((c) => c[0])).toEqual([0, 128, 255]);
  });
});
