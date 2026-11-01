import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUTO_PALETTE_ID,
  DEFAULT_AUTO_COLORS,
  MAX_AUTO_COLORS,
  buildSettings,
  useConvertStore,
} from './convertStore';

describe('auto palette', () => {
  beforeEach(() => {
    useConvertStore.setState({ paletteId: AUTO_PALETTE_ID, autoMaxColors: DEFAULT_AUTO_COLORS });
  });

  it('is the default, so a photo is not forced onto a 4-colour palette', () => {
    expect(useConvertStore.getState().paletteId).toBe(AUTO_PALETTE_ID);
    expect(buildSettings(useConvertStore.getState()).palette).toEqual({
      kind: 'auto',
      maxColors: DEFAULT_AUTO_COLORS,
    });
  });

  it('clamps the colour budget', () => {
    useConvertStore.getState().setAutoMaxColors(10_000);
    expect(useConvertStore.getState().autoMaxColors).toBe(MAX_AUTO_COLORS);
    useConvertStore.getState().setAutoMaxColors(0);
    expect(useConvertStore.getState().autoMaxColors).toBe(2);
  });

  it('a bundled palette still produces a fixed spec', () => {
    useConvertStore.getState().setPaletteId('gameboy');
    expect(buildSettings(useConvertStore.getState()).palette.kind).toBe('fixed');
  });
});
