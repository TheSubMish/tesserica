import { describe, expect, it } from 'vitest';

import { adjustOklab, applyAdjustments, type AdjustParams } from './adjust.ts';
import { removeBackgroundFloodFill } from './backgroundRemoval.ts';
import { bufferFrom, createBuffer, type PixelBuffer } from './buffer.ts';
import { despeckle, nearestPaletteIndex, outline } from './cleanup.ts';
import { convert } from './convert.ts';
import { crop, fitToSubject } from './crop.ts';
import { cellRange, downscale } from './downscale.ts';
import { srgb8ToOklab } from './oklab.ts';
import {
  TRANSPARENT_INDEX,
  nearestIndex,
  nearestIndexOklab,
  nearestIndexSrgb,
  preparePalette,
  quantizeNone,
} from './quantize.ts';
import {
  defaultSettings,
  targetSizeForPixelSize,
  type PaletteSpec,
  type Rgba,
} from './settings.ts';

/**
 * These mirror the `#[cfg(test)]` modules in `src-tauri/src/pipeline/`. Where a
 * test here has a counterpart there, the two assert the same thing on the same
 * input — the cheap half of parity. The expensive half, running both
 * implementations over the corpus and comparing index maps, is
 * `tests/golden/convert.parity.test.ts`.
 */

function solid(width: number, height: number, color: Rgba): PixelBuffer {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = color[0];
    buf.data[i + 1] = color[1];
    buf.data[i + 2] = color[2];
    buf.data[i + 3] = color[3];
  }
  return buf;
}

function pixels(width: number, height: number, list: Rgba[]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  list.forEach((c, p) => data.set(c, p * 4));
  return bufferFrom(width, height, data);
}

const BLACK_AND_WHITE: PaletteSpec = {
  kind: 'fixed',
  colors: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ],
};

describe('buffer', () => {
  it('rejects a mismatched buffer length', () => {
    expect(() => bufferFrom(2, 2, new Uint8ClampedArray(15))).toThrow();
    expect(() => bufferFrom(2, 2, new Uint8ClampedArray(16))).not.toThrow();
  });

  it('rejects a zero dimension', () => {
    expect(() => createBuffer(0, 4)).toThrow();
    expect(() => createBuffer(4, 0)).toThrow();
  });
});

describe('settings', () => {
  it('never derives a zero dimension from a pixel size', () => {
    expect(targetSizeForPixelSize(100, 50, 8)).toEqual({ width: 13, height: 6 });
    expect(targetSizeForPixelSize(10, 10, 1000)).toEqual({ width: 1, height: 1 });
    expect(() => targetSizeForPixelSize(10, 10, 0)).toThrow();
  });
});

describe('crop', () => {
  it('crops the requested window', () => {
    const src = solid(4, 4, [10, 20, 30, 255]);
    src.data.set([9, 9, 9, 255], (1 * 4 + 2) * 4);
    const out = crop(src, { x: 1, y: 1, w: 2, h: 2 });
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([...out.data.slice(4, 8)]).toEqual([9, 9, 9, 255]);
  });

  it('clamps a rect that hangs off the edge', () => {
    const out = crop(solid(4, 4, [1, 2, 3, 255]), { x: -2, y: -2, w: 4, h: 4 });
    expect([out.width, out.height]).toEqual([2, 2]);
  });

  it('rejects a rect that misses entirely', () => {
    expect(() => crop(solid(4, 4, [1, 2, 3, 255]), { x: 10, y: 10, w: 4, h: 4 })).toThrow();
  });

  it('fits to the opaque bounding box', () => {
    const src = solid(8, 8, [0, 0, 0, 0]);
    for (let y = 2; y < 5; y++) {
      for (let x = 3; x < 6; x++) src.data.set([255, 0, 0, 255], (y * 8 + x) * 4);
    }
    const out = fitToSubject(src, 128, 0);
    expect([out.width, out.height]).toEqual([3, 3]);
  });

  it('does nothing when the image is fully transparent', () => {
    const out = fitToSubject(solid(4, 4, [0, 0, 0, 0]), 128, 0);
    expect([out.width, out.height]).toEqual([4, 4]);
  });
});

describe('adjust', () => {
  const neutral: AdjustParams = { brightness: 0, contrast: 0, saturation: 0, hueShift: 0 };

  it('is a no-op at neutral settings', () => {
    const src = pixels(1, 1, [[37, 111, 200, 128]]);
    expect(applyAdjustments(src, neutral)).toBe(src);
  });

  it('moves lightness and leaves alpha alone', () => {
    const src = pixels(1, 1, [[100, 100, 100, 77]]);
    const up = applyAdjustments(src, { ...neutral, brightness: 0.5 });
    expect(up.data[0]).toBeGreaterThan(100);
    expect(up.data[3]).toBe(77);
    expect(applyAdjustments(src, { ...neutral, brightness: -0.5 }).data[0]).toBeLessThan(100);
  });

  it('desaturates fully at saturation -1', () => {
    const out = applyAdjustments(pixels(1, 1, [[200, 40, 40, 255]]), {
      ...neutral,
      saturation: -1,
    });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
  });

  it('does not disturb a grey when saturating', () => {
    const out = applyAdjustments(pixels(1, 1, [[128, 128, 128, 255]]), {
      ...neutral,
      saturation: 0.8,
    });
    expect([...out.data.slice(0, 3)]).toEqual([128, 128, 128]);
  });

  it('returns a colour to itself after a full turn of hue', () => {
    const c = srgb8ToOklab(210, 90, 30);
    const turned = adjustOklab(c, { ...neutral, hueShift: 360 });
    expect(Math.abs(turned.a - c.a)).toBeLessThan(1e-12);
    expect(Math.abs(turned.b - c.b)).toBeLessThan(1e-12);
  });

  it('pushes away from mid-lightness with contrast', () => {
    const dark = adjustOklab({ l: 0.3, a: 0, b: 0 }, { ...neutral, contrast: 0.5 });
    const light = adjustOklab({ l: 0.7, a: 0, b: 0 }, { ...neutral, contrast: 0.5 });
    expect(dark.l).toBeLessThan(0.3);
    expect(light.l).toBeGreaterThan(0.7);
  });
});

describe('downscale', () => {
  it('partitions the source into non-empty, non-overlapping cells', () => {
    for (let src = 1; src < 40; src++) {
      for (let dst = 1; dst < 40; dst++) {
        const covered = new Array<number>(src).fill(0);
        for (let i = 0; i < dst; i++) {
          const [a, b] = cellRange(i, dst, src);
          expect(a).toBeLessThan(b);
          for (let c = a; c < b; c++) covered[c]++;
        }
        if (dst <= src) expect(covered.every((c) => c === 1)).toBe(true);
      }
    }
  });

  it('averages a 2x2 block in linear light', () => {
    const src = pixels(2, 2, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    // Half black, half white in linear light is 188, not 128. Averaging
    // gamma-encoded values would give 128 and visibly darken every texture.
    expect([...downscale(src, 1, 1, 'box').data]).toEqual([188, 188, 188, 255]);
  });

  it('never bleeds a transparent pixel’s RGB into the average', () => {
    const src = pixels(2, 1, [
      [245, 120, 40, 255],
      [0, 255, 0, 0],
    ]);
    const out = downscale(src, 1, 1, 'box');
    expect([...out.data.slice(0, 3)]).toEqual([245, 120, 40]);
    expect(out.data[3]).toBe(128);
  });

  it('leaves a fully transparent cell as transparent black', () => {
    const src = pixels(2, 1, [
      [10, 20, 30, 0],
      [40, 50, 60, 0],
    ]);
    expect([...downscale(src, 1, 1, 'box').data]).toEqual([0, 0, 0, 0]);
  });

  it('recovers an upscaled sprite exactly with nearest', () => {
    const colors: Rgba[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ];
    const src = createBuffer(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        src.data.set(colors[((y / 4) | 0) * 2 + ((x / 4) | 0)], (y * 8 + x) * 4);
      }
    }
    expect([...downscale(src, 2, 2, 'nearest').data]).toEqual(colors.flatMap((c) => [...c]));
  });

  it('picks the most common colour with dominant, not the average', () => {
    const src = pixels(4, 1, [
      [200, 0, 0, 255],
      [200, 0, 0, 255],
      [200, 0, 0, 255],
      [0, 0, 200, 255],
    ]);
    expect([...downscale(src, 1, 1, 'dominant').data.slice(0, 3)]).toEqual([200, 0, 0]);
  });

  it('ignores transparent pixels when voting for the dominant colour', () => {
    const src = pixels(3, 1, [
      [0, 255, 0, 0],
      [0, 255, 0, 0],
      [200, 0, 0, 255],
    ]);
    expect([...downscale(src, 1, 1, 'dominant').data.slice(0, 3)]).toEqual([200, 0, 0]);
  });

  it('returns the source for a no-op resize', () => {
    const src = pixels(2, 1, [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    for (const mode of ['box', 'nearest', 'dominant'] as const) {
      expect(downscale(src, 2, 1, mode)).toBe(src);
    }
  });
});

describe('quantize', () => {
  it('rejects an empty palette', () => {
    expect(() => preparePalette([])).toThrow();
  });

  it('picks the obvious nearest colour', () => {
    const p = preparePalette([
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
    ]);
    expect(nearestIndex(p, 250, 5, 5, 'oklab')).toBe(2);
    expect(nearestIndex(p, 8, 8, 8, 'oklab')).toBe(0);
    expect(nearestIndex(p, 250, 250, 250, 'oklab')).toBe(1);
  });

  it('resolves an exact tie to the lower index', () => {
    const p = preparePalette([
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const mid = {
      l: (p.lab[0].l + p.lab[1].l) / 2,
      a: (p.lab[0].a + p.lab[1].a) / 2,
      b: (p.lab[0].b + p.lab[1].b) / 2,
    };
    expect(nearestIndexOklab(p, mid)).toBe(0);
  });

  it('resolves an sRGB tie to the lower index too', () => {
    const p = preparePalette([
      [100, 100, 100, 255],
      [140, 140, 140, 255],
    ]);
    expect(nearestIndexSrgb(p, 120, 120, 120)).toBe(0);
  });

  it('maps a greyscale ramp monotonically', () => {
    const colors: Rgba[] = [0, 1, 2, 3, 4].map((i) => {
      const v = Math.round((i * 255) / 4);
      return [v, v, v, 255];
    });
    const p = preparePalette(colors);
    let previous = 0;
    for (let v = 0; v <= 255; v++) {
      const i = nearestIndex(p, v, v, v, 'oklab');
      expect(i).toBeGreaterThanOrEqual(previous);
      previous = i;
    }
    expect(previous).toBe(4);
  });

  it('does not quantize transparent pixels', () => {
    const p = preparePalette([[255, 0, 0, 255]]);
    const src = pixels(2, 1, [
      [10, 200, 30, 10],
      [10, 200, 30, 250],
    ]);
    const out = quantizeNone(src, p, 'oklab', { alphaThreshold: 128, preserveAlpha: false });
    expect(out.indices[0]).toBe(TRANSPARENT_INDEX);
    expect([...out.image.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(out.indices[1]).toBe(0);
    expect([...out.image.data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it('keeps the source alpha under preserveAlpha', () => {
    const p = preparePalette([[255, 0, 0, 255]]);
    const out = quantizeNone(pixels(1, 1, [[250, 10, 10, 200]]), p, 'oklab', {
      alphaThreshold: 128,
      preserveAlpha: true,
    });
    expect(out.image.data[3]).toBe(200);
  });

  it('ignores a palette entry’s own alpha', () => {
    const p = preparePalette([[255, 0, 0, 7]]);
    const out = quantizeNone(pixels(1, 1, [[250, 10, 10, 255]]), p, 'oklab', {
      alphaThreshold: 128,
      preserveAlpha: false,
    });
    expect(out.image.data[3]).toBe(255);
  });
});

describe('cleanup', () => {
  it('removes a lone pixel', () => {
    const indices = new Uint16Array(9);
    indices[4] = 1;
    expect([...despeckle(3, 3, indices, 1)]).toEqual(new Array(9).fill(0));
  });

  it('leaves a region larger than the threshold', () => {
    const indices = new Uint16Array(9);
    indices[4] = 1;
    indices[5] = 1;
    expect([...despeckle(3, 3, indices, 1)]).toEqual([...indices]);
  });

  it('is off at zero', () => {
    const indices = new Uint16Array(9);
    indices[4] = 1;
    expect(despeckle(3, 3, indices, 0)).toBe(indices);
  });

  it('fills a one-pixel transparent hole', () => {
    const indices = new Uint16Array(9).fill(3);
    indices[4] = TRANSPARENT_INDEX;
    expect(despeckle(3, 3, indices, 1)[4]).toBe(3);
  });

  it('leaves a uniform image alone', () => {
    const indices = new Uint16Array(4).fill(2);
    expect([...despeckle(2, 2, indices, 4)]).toEqual([2, 2, 2, 2]);
  });

  it('rings a single opaque pixel', () => {
    const p = preparePalette([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    const indices = new Uint16Array(9).fill(TRANSPARENT_INDEX);
    indices[4] = 0;
    const alpha = Uint8ClampedArray.from([0, 0, 0, 0, 255, 0, 0, 0, 0]);
    const out = outline(3, 3, indices, alpha, p, {
      color: [0, 0, 0, 255],
      thickness: 1,
      corners: true,
    });
    expect([...out.indices].every((i) => i !== TRANSPARENT_INDEX)).toBe(true);
    expect(out.indices[0]).toBe(1);
    expect(out.alpha[0]).toBe(255);
    expect(out.indices[4]).toBe(0);
  });

  it('leaves the diagonals alone without corners', () => {
    const p = preparePalette([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    const indices = new Uint16Array(9).fill(TRANSPARENT_INDEX);
    indices[4] = 0;
    const out = outline(3, 3, indices, new Uint8ClampedArray(9), p, {
      color: [0, 0, 0, 255],
      thickness: 1,
      corners: false,
    });
    expect(out.indices[0]).toBe(TRANSPARENT_INDEX);
    expect(out.indices[1]).toBe(1);
  });

  it('snaps the outline colour to the palette', () => {
    const p = preparePalette([
      [255, 255, 255, 255],
      [10, 10, 10, 255],
    ]);
    expect(nearestPaletteIndex(p, [4, 4, 4, 255])).toBe(1);
  });
});

describe('backgroundRemoval', () => {
  it('clears a uniform image entirely, leaving RGB untouched', () => {
    const src = solid(4, 4, [200, 200, 200, 255]);
    const out = removeBackgroundFloodFill(src, { tolerance: 0.02 });
    expect([...out.data].filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
    expect([...out.data.slice(0, 3)]).toEqual([200, 200, 200]);
  });

  it('leaves a disconnected interior patch of the background colour alone', () => {
    // 5x5 white background; a black ring fully encloses a single white centre
    // pixel, so the centre matches the corner seed's colour but is not
    // *connected* to it.
    const src = solid(5, 5, [255, 255, 255, 255]);
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) {
        if (x === 2 && y === 2) continue;
        src.data.set([0, 0, 0, 255], (y * 5 + x) * 4);
      }
    }
    const out = removeBackgroundFloodFill(src, { tolerance: 0.02 });
    expect(out.data[(2 * 5 + 2) * 4 + 3]).toBe(255);
    expect(out.data[3]).toBe(0);
  });

  it('stops the flood at a neighbour outside tolerance', () => {
    const src = solid(3, 3, [255, 255, 255, 255]);
    src.data.set([0, 0, 200, 255], 1 * 4);
    const out = removeBackgroundFloodFill(src, { tolerance: 0.02 });
    expect(out.data[3]).toBe(0);
    expect(out.data[1 * 4 + 3]).toBe(255);
  });

  it('at tolerance 0, clears only exact matches to the seed', () => {
    const src = solid(3, 3, [10, 10, 10, 255]);
    src.data.set([11, 10, 10, 255], 1 * 4);
    const out = removeBackgroundFloodFill(src, { tolerance: 0 });
    expect(out.data[3]).toBe(0);
    expect(out.data[1 * 4 + 3]).toBe(255);
  });

  it('does not throw on coincident corners in a 1-pixel-tall image', () => {
    const src = solid(4, 1, [128, 64, 32, 255]);
    const out = removeBackgroundFloodFill(src, { tolerance: 0.02 });
    expect([...out.data].filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
  });
});

describe('convert', () => {
  it('removes the background before crop / fit-to-subject run', () => {
    // A 4x4 opaque white image with a 2x2 black square at its centre. Without
    // background removal, fit-to-subject sees the whole image as opaque and
    // does nothing; with it, the flood clears the white border first and
    // fit-to-subject can crop down to just the black square.
    const src = solid(4, 4, [255, 255, 255, 255]);
    for (let y = 1; y <= 2; y++) {
      for (let x = 1; x <= 2; x++) src.data.set([0, 0, 0, 255], (y * 4 + x) * 4);
    }
    const settings = {
      ...defaultSettings(2, 2, BLACK_AND_WHITE),
      downscaleMode: 'nearest' as const,
      backgroundRemoval: { tolerance: 0.02 },
      fitToSubject: true,
    };
    const out = convert(src, settings);
    expect([...out.indices].every((i) => i === 0)).toBe(true);
  });

  it('converts a white image to the white palette entry', () => {
    const out = convert(solid(8, 8, [255, 255, 255, 255]), defaultSettings(4, 4, BLACK_AND_WHITE));
    expect([out.image.width, out.image.height]).toEqual([4, 4]);
    expect([...out.indices].every((i) => i === 1)).toBe(true);
  });

  it('keeps a transparent source transparent all the way through', () => {
    const out = convert(solid(8, 8, [0, 255, 0, 0]), defaultSettings(4, 4, BLACK_AND_WHITE));
    expect([...out.indices].every((i) => i === TRANSPARENT_INDEX)).toBe(true);
  });

  it('runs adjustments before quantization', () => {
    // sRGB 90 is Oklab L≈0.447, so it sits nearer black in this palette;
    // brightening first must flip it to white.
    const src = solid(4, 4, [90, 90, 90, 255]);
    const settings = {
      ...defaultSettings(2, 2, BLACK_AND_WHITE),
      downscaleMode: 'nearest' as const,
    };

    expect([...convert(src, settings).indices].every((i) => i === 0)).toBe(true);
    expect([...convert(src, { ...settings, brightness: 0.9 }).indices].every((i) => i === 1)).toBe(
      true,
    );
  });

  it('runs despeckle after quantization', () => {
    const src = solid(5, 5, [255, 255, 255, 255]);
    src.data.set([0, 0, 0, 255], (2 * 5 + 2) * 4);
    const settings = {
      ...defaultSettings(5, 5, BLACK_AND_WHITE),
      downscaleMode: 'nearest' as const,
    };

    expect(convert(src, settings).indices[12]).toBe(0);
    expect(convert(src, { ...settings, despeckle: 1 }).indices[12]).toBe(1);
  });

  it('outlines last, onto transparent pixels', () => {
    const src = solid(3, 3, [0, 0, 0, 0]);
    src.data.set([255, 255, 255, 255], (1 * 3 + 1) * 4);
    const out = convert(src, {
      ...defaultSettings(3, 3, BLACK_AND_WHITE),
      downscaleMode: 'nearest',
      outline: { color: [0, 0, 0, 255], thickness: 1, corners: true },
    });
    expect(out.indices[4]).toBe(1);
    expect([...out.indices].every((i) => i !== TRANSPARENT_INDEX)).toBe(true);
    expect([...out.image.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it('crops before anything else', () => {
    const src = solid(4, 2, [0, 0, 0, 255]);
    for (let x = 2; x < 4; x++) {
      for (let y = 0; y < 2; y++) src.data.set([255, 255, 255, 255], (y * 4 + x) * 4);
    }
    const out = convert(src, {
      ...defaultSettings(2, 2, BLACK_AND_WHITE),
      downscaleMode: 'nearest',
      crop: { x: 2, y: 0, w: 2, h: 2 },
    });
    expect([...out.indices].every((i) => i === 1)).toBe(true);
  });
});
