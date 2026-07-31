import { describe, expect, it } from 'vitest';
import type { Effect } from '../model/types';
import {
  applyEffects,
  dropShadowEffect,
  effectsFingerprint,
  gradientMapEffect,
  hasEnabledEffects,
  hsvShiftEffect,
  outlineEffect,
  outlineInnerEffect,
} from './effects';

const W = 5;
const H = 5;

function emptyBuffer(w = W, h = H): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

function setPixel(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const i = (y * w + x) * 4;
  buf[i] = color[0];
  buf[i + 1] = color[1];
  buf[i + 2] = color[2];
  buf[i + 3] = color[3];
}

function getPixel(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

function fillRect(
  buf: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setPixel(buf, w, x, y, color);
  }
}

const OUTLINE_COLOR: readonly [number, number, number, number] = [255, 0, 0, 255];
const RED: readonly [number, number, number, number] = [200, 20, 20, 255];

function outline(
  over: Partial<Extract<Effect, { kind: 'outline' }>> = {},
): Extract<Effect, { kind: 'outline' }> {
  return {
    id: 'e-outline',
    kind: 'outline',
    enabled: true,
    color: OUTLINE_COLOR,
    thickness: 1,
    corners: false,
    ...over,
  };
}

function outlineInner(
  over: Partial<Extract<Effect, { kind: 'outline-inner' }>> = {},
): Extract<Effect, { kind: 'outline-inner' }> {
  return {
    id: 'e-outline-inner',
    kind: 'outline-inner',
    enabled: true,
    color: OUTLINE_COLOR,
    thickness: 1,
    ...over,
  };
}

function dropShadow(
  over: Partial<Extract<Effect, { kind: 'drop-shadow' }>> = {},
): Extract<Effect, { kind: 'drop-shadow' }> {
  return {
    id: 'e-shadow',
    kind: 'drop-shadow',
    enabled: true,
    dx: 1,
    dy: 1,
    color: [0, 0, 255, 255],
    ...over,
  };
}

function gradientMap(
  over: Partial<Extract<Effect, { kind: 'gradient-map' }>> = {},
): Extract<Effect, { kind: 'gradient-map' }> {
  return {
    id: 'e-gradient',
    kind: 'gradient-map',
    enabled: true,
    palette: [
      [0, 0, 0, 255],
      [255, 0, 0, 255],
    ],
    ...over,
  };
}

function hsvShift(
  over: Partial<Extract<Effect, { kind: 'hsv-shift' }>> = {},
): Extract<Effect, { kind: 'hsv-shift' }> {
  return { id: 'e-hsv', kind: 'hsv-shift', enabled: true, h: 0, s: 0, v: 0, ...over };
}

describe('outlineEffect', () => {
  it('grows a "+" shape one ring out with corners: false', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);

    const out = outlineEffect(buf, W, H, outline({ corners: false, thickness: 1 }));

    // The four orthogonal neighbours get the outline colour...
    expect(getPixel(out, W, 1, 2)).toEqual(OUTLINE_COLOR);
    expect(getPixel(out, W, 3, 2)).toEqual(OUTLINE_COLOR);
    expect(getPixel(out, W, 2, 1)).toEqual(OUTLINE_COLOR);
    expect(getPixel(out, W, 2, 3)).toEqual(OUTLINE_COLOR);
    // ...but not the diagonals.
    expect(getPixel(out, W, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(getPixel(out, W, 3, 3)).toEqual([0, 0, 0, 0]);
    // The original opaque pixel is untouched.
    expect(getPixel(out, W, 2, 2)).toEqual(RED);
  });

  it('grows a solid 3x3-minus-center with corners: true', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);

    const out = outlineEffect(buf, W, H, outline({ corners: true, thickness: 1 }));

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        expect(getPixel(out, W, 2 + dx, 2 + dy)).toEqual(OUTLINE_COLOR);
      }
    }
  });

  it('grows exactly `thickness` rings, not more (a diamond, since orthogonal steps compound)', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);

    const out = outlineEffect(buf, W, H, outline({ corners: false, thickness: 2 }));

    expect(getPixel(out, W, 0, 2)).toEqual(OUTLINE_COLOR); // Manhattan distance 2, straight line
    // Two 4-connected steps compound into a diamond, so a diagonal neighbour
    // one step in each axis (Manhattan distance 2) is reached too — this is
    // not a bug, `corners` only changes *single-step* adjacency.
    expect(getPixel(out, W, 1, 1)).toEqual(OUTLINE_COLOR);
    // But a pixel outside the Manhattan-distance-2 diamond is not.
    expect(getPixel(out, W, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('thickness 0 is a no-op', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);
    const out = outlineEffect(buf, W, H, outline({ thickness: 0 }));
    expect(getPixel(out, W, 1, 2)).toEqual([0, 0, 0, 0]);
    expect(getPixel(out, W, 2, 2)).toEqual(RED);
  });

  it('is clipped by the canvas edge rather than wrapping or throwing', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 0, 0, RED);
    expect(() => outlineEffect(buf, W, H, outline({ corners: true, thickness: 1 }))).not.toThrow();
  });
});

describe('outlineInnerEffect vs. outlineEffect', () => {
  it("recolours the shape's own edge pixels instead of adding new ones outside it", () => {
    const buf = emptyBuffer();
    fillRect(buf, W, 1, 1, 3, 3, RED); // a solid 3x3 square

    const inner = outlineInnerEffect(buf, W, H, outlineInner({ thickness: 1 }));

    // Border ring recoloured...
    expect(getPixel(inner, W, 1, 1)).toEqual(OUTLINE_COLOR);
    expect(getPixel(inner, W, 2, 1)).toEqual(OUTLINE_COLOR);
    expect(getPixel(inner, W, 3, 3)).toEqual(OUTLINE_COLOR);
    // ...center pixel keeps its own colour.
    expect(getPixel(inner, W, 2, 2)).toEqual(RED);
    // Nothing transparent became opaque.
    expect(getPixel(inner, W, 0, 0)).toEqual([0, 0, 0, 0]);

    const countOpaque = (b: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 3; i < b.length; i += 4) if (b[i] > 0) n++;
      return n;
    };
    // outline-inner only recolours — it never changes which pixels are opaque.
    expect(countOpaque(inner)).toBe(countOpaque(buf));

    const outer = outlineEffect(buf, W, H, outline({ corners: false, thickness: 1 }));
    // outline (outward) only ever *adds* newly-opaque pixels.
    expect(countOpaque(outer)).toBeGreaterThan(countOpaque(buf));
    // ...and never touches the square's own pixels.
    expect(getPixel(outer, W, 2, 2)).toEqual(RED);
    expect(getPixel(outer, W, 1, 1)).toEqual(RED);
  });

  it('canvas edge counts as a real edge (missing neighbour = background)', () => {
    const buf = emptyBuffer();
    fillRect(buf, W, 0, 0, 1, 1, RED); // touches the top-left canvas corner
    const inner = outlineInnerEffect(buf, W, H, outlineInner({ thickness: 1 }));
    // Every pixel of a 2x2 block is within 1 of *some* edge (including the
    // canvas boundary itself), so the whole block recolours.
    expect(getPixel(inner, W, 0, 0)).toEqual(OUTLINE_COLOR);
    expect(getPixel(inner, W, 1, 1)).toEqual(OUTLINE_COLOR);
  });
});

describe('dropShadowEffect', () => {
  it("offsets a silhouette in `color`, behind the layer's own content", () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);

    const out = dropShadowEffect(buf, W, H, dropShadow({ dx: 1, dy: 1, color: [0, 0, 255, 255] }));

    // Shadow appears one pixel down-right, since nothing of the layer's own
    // content is there to win.
    expect(getPixel(out, W, 3, 3)).toEqual([0, 0, 255, 255]);
    // The layer's own pixel is completely unaffected — it's drawn on top.
    expect(getPixel(out, W, 2, 2)).toEqual(RED);
    // No shadow leaks anywhere else.
    expect(getPixel(out, W, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('dx=dy=0 collapses to the original content, since the own pixel always wins', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);
    const out = dropShadowEffect(buf, W, H, dropShadow({ dx: 0, dy: 0 }));
    expect(getPixel(out, W, 2, 2)).toEqual(RED);
    // Nowhere else becomes opaque.
    let opaqueCount = 0;
    for (let i = 3; i < out.length; i += 4) if (out[i] > 0) opaqueCount++;
    expect(opaqueCount).toBe(1);
  });
});

describe('gradientMapEffect', () => {
  it('maps the darkest opaque pixel to palette[0] and the brightest to palette[last]', () => {
    const buf = emptyBuffer(2, 1);
    setPixel(buf, 2, 0, 0, [0, 0, 0, 255]); // darkest
    setPixel(buf, 2, 1, 0, [255, 255, 255, 255]); // brightest

    const out = gradientMapEffect(
      buf,
      2,
      1,
      gradientMap({
        palette: [
          [10, 20, 30, 255],
          [200, 210, 220, 255],
        ],
      }),
    );

    expect(getPixel(out, 2, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(getPixel(out, 2, 1, 0)).toEqual([200, 210, 220, 255]);
  });

  it('leaves transparent pixels completely untouched', () => {
    const buf = emptyBuffer(1, 1);
    setPixel(buf, 1, 0, 0, [10, 20, 30, 0]);
    const out = gradientMapEffect(buf, 1, 1, gradientMap());
    expect(getPixel(out, 1, 0, 0)).toEqual([10, 20, 30, 0]);
  });

  it('a flat-luminance layer maps everything to palette[0]', () => {
    const buf = emptyBuffer(2, 1);
    setPixel(buf, 2, 0, 0, [128, 128, 128, 255]);
    setPixel(buf, 2, 1, 0, [128, 128, 128, 255]);
    const out = gradientMapEffect(
      buf,
      2,
      1,
      gradientMap({
        palette: [
          [1, 2, 3, 255],
          [250, 251, 252, 255],
        ],
      }),
    );
    expect(getPixel(out, 2, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(getPixel(out, 2, 1, 0)).toEqual([1, 2, 3, 255]);
  });

  it('an empty palette is a no-op', () => {
    const buf = emptyBuffer(1, 1);
    setPixel(buf, 1, 0, 0, [10, 20, 30, 255]);
    const out = gradientMapEffect(buf, 1, 1, gradientMap({ palette: [] }));
    expect(getPixel(out, 1, 0, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe('hsvShiftEffect', () => {
  it('shifts hue and wraps at 0/360', () => {
    const buf = emptyBuffer(1, 1);
    setPixel(buf, 1, 0, 0, [255, 0, 0, 255]); // pure red, hue 0
    const out = hsvShiftEffect(buf, 1, 1, hsvShift({ h: -30 }));
    // hue 0 - 30 wraps to 330, exact channel maths worked out by hand.
    expect(getPixel(out, 1, 0, 0)).toEqual([255, 0, 128, 255]);
  });

  it('shifts saturation by percentage points, exact channel maths', () => {
    const buf = emptyBuffer(1, 1);
    setPixel(buf, 1, 0, 0, [128, 128, 128, 255]); // mid-gray, s=0
    const out = hsvShiftEffect(buf, 1, 1, hsvShift({ s: 50 }));
    expect(getPixel(out, 1, 0, 0)).toEqual([128, 64, 64, 255]);
  });

  it('leaves transparent pixels untouched', () => {
    const buf = emptyBuffer(1, 1);
    setPixel(buf, 1, 0, 0, [10, 20, 30, 0]);
    const out = hsvShiftEffect(buf, 1, 1, hsvShift({ h: 90 }));
    expect(getPixel(out, 1, 0, 0)).toEqual([10, 20, 30, 0]);
  });
});

describe('applyEffects', () => {
  it('skips disabled effects entirely', () => {
    const buf = emptyBuffer();
    setPixel(buf, W, 2, 2, RED);
    const out = applyEffects(buf, W, H, [outline({ enabled: false })]);
    expect(getPixel(out, W, 1, 2)).toEqual([0, 0, 0, 0]);
  });

  it('returns the same reference when there is nothing to apply', () => {
    const buf = emptyBuffer();
    expect(applyEffects(buf, W, H, [])).toBe(buf);
    expect(applyEffects(buf, W, H, [outline({ enabled: false })])).toBe(buf);
  });

  it("composites each effect onto the previous one's output, in order", () => {
    const buf = emptyBuffer(3, 1);
    setPixel(buf, 3, 1, 0, [0, 0, 0, 255]); // one opaque black pixel, centered

    const outlineFx = outline({ color: [255, 0, 0, 255], thickness: 1, corners: false });
    const gradientFx = gradientMap({
      palette: [
        [0, 255, 0, 255], // green
        [0, 0, 255, 255], // blue
      ],
    });

    // outline, then gradient-map: the outline's own red pixels also get
    // remapped by the gradient afterwards.
    const outlineThenGradient = applyEffects(buf, 3, 1, [outlineFx, gradientFx]);
    // gradient-map, then outline: the gradient only ever saw the original
    // single black pixel, so its red outline is untouched by the mapping.
    const gradientThenOutline = applyEffects(buf, 3, 1, [gradientFx, outlineFx]);

    expect(getPixel(gradientThenOutline, 3, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(getPixel(outlineThenGradient, 3, 0, 0)).not.toEqual([255, 0, 0, 255]);
  });
});

describe('effectsFingerprint / hasEnabledEffects', () => {
  it('is empty for an empty stack', () => {
    expect(effectsFingerprint([])).toBe('');
  });

  it("differs when an effect's own parameters differ", () => {
    const a = effectsFingerprint([outline({ thickness: 1 })]);
    const b = effectsFingerprint([outline({ thickness: 2 })]);
    expect(a).not.toBe(b);
  });

  it('hasEnabledEffects is false unless at least one entry is enabled', () => {
    expect(hasEnabledEffects([])).toBe(false);
    expect(hasEnabledEffects([outline({ enabled: false })])).toBe(false);
    expect(hasEnabledEffects([outline({ enabled: false }), hsvShift({ enabled: true })])).toBe(
      true,
    );
  });
});
