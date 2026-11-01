import { describe, expect, it } from 'vitest';

import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import { LOOKS, isLookActive } from './looks';

describe('looks', () => {
  it('only references bundled palettes or auto', () => {
    const ids = new Set(BUILTIN_PALETTES.map((p) => p.id));
    for (const l of LOOKS) expect(l.paletteId === 'auto' || ids.has(l.paletteId)).toBe(true);
  });

  it('has unique ids and a colour budget on every auto look', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    for (const l of LOOKS.filter((x) => x.paletteId === 'auto')) {
      expect(l.autoMaxColors).toBeGreaterThan(1);
    }
  });

  it('recognises the active look, ignoring the colour budget for fixed palettes', () => {
    const gb = LOOKS.find((l) => l.id === 'gameboy')!;
    expect(isLookActive(gb, { paletteId: 'gameboy', autoMaxColors: 99, dither: 'bayer4' })).toBe(
      true,
    );
    expect(isLookActive(gb, { paletteId: 'gameboy', autoMaxColors: 16, dither: 'none' })).toBe(
      false,
    );
    const bold = LOOKS.find((l) => l.id === 'bold')!;
    expect(isLookActive(bold, { paletteId: 'auto', autoMaxColors: 16, dither: 'none' })).toBe(
      false,
    );
    expect(isLookActive(bold, { paletteId: 'auto', autoMaxColors: 8, dither: 'none' })).toBe(true);
  });
});
