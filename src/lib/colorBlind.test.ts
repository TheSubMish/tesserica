import { describe, expect, it } from 'vitest';
import { simulateColorBlindness } from './colorBlind';

describe('simulateColorBlindness', () => {
  it('leaves the colour untouched in "none" mode', () => {
    expect(simulateColorBlindness([10, 20, 30, 255], 'none')).toEqual([10, 20, 30, 255]);
  });

  it('never touches alpha — this simulates colour perception, not transparency', () => {
    const [, , , a] = simulateColorBlindness([200, 50, 10, 128], 'protanopia');
    expect(a).toBe(128);
  });

  it('leaves black and white alone — every mode is a weighted average of equal channels', () => {
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      expect(simulateColorBlindness([0, 0, 0, 255], mode)).toEqual([0, 0, 0, 255]);
      expect(simulateColorBlindness([255, 255, 255, 255], mode)).toEqual([255, 255, 255, 255]);
    }
  });

  it('stays within byte range for saturated primaries', () => {
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      for (const c of [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ] as const) {
        const [r, g, b] = simulateColorBlindness(c, mode);
        for (const channel of [r, g, b]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('makes red and green harder to tell apart under deuteranopia', () => {
    // The whole point of the simulation: red and green, whose sRGB distance is
    // large, must come out much closer together once simulated.
    const red = simulateColorBlindness([220, 20, 20, 255], 'deuteranopia');
    const green = simulateColorBlindness([20, 220, 20, 255], 'deuteranopia');
    const sRgbDistance = Math.hypot(220 - 20, 20 - 220, 20 - 20);
    const simDistance = Math.hypot(red[0] - green[0], red[1] - green[1], red[2] - green[2]);
    expect(simDistance).toBeLessThan(sRgbDistance);
  });
});
