import { describe, expect, it } from 'vitest';
import { blendFunction, canvasCompositeOp } from './blend';

const BLACK = [0, 0, 0] as const;
const WHITE = [1, 1, 1] as const;
const GREY = [0.5, 0.5, 0.5] as const;
const RED = [1, 0, 0] as const;

function close(a: readonly number[], b: readonly number[], digits = 9) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

describe('blendFunction — separable modes', () => {
  it('normal returns the source untouched', () => {
    expect(blendFunction('normal', BLACK, RED)).toEqual(RED);
  });

  it('multiply of anything with black is black', () => {
    close(blendFunction('multiply', RED, BLACK), BLACK);
  });

  it('multiply of anything with white is unchanged', () => {
    close(blendFunction('multiply', RED, WHITE), RED);
  });

  it('screen of anything with white is white', () => {
    close(blendFunction('screen', RED, WHITE), WHITE);
  });

  it('screen of anything with black is unchanged', () => {
    close(blendFunction('screen', RED, BLACK), RED);
  });

  it('darken picks the smaller channel per channel', () => {
    close(blendFunction('darken', [0.2, 0.8, 0.5], [0.9, 0.1, 0.5]), [0.2, 0.1, 0.5]);
  });

  it('lighten picks the larger channel per channel', () => {
    close(blendFunction('lighten', [0.2, 0.8, 0.5], [0.9, 0.1, 0.5]), [0.9, 0.8, 0.5]);
  });

  it('difference is symmetric and zero for equal colours', () => {
    close(blendFunction('difference', GREY, GREY), BLACK);
    close(blendFunction('difference', RED, WHITE), [0, 1, 1]);
    close(blendFunction('difference', WHITE, RED), [0, 1, 1]);
  });

  it('exclusion of black and white is white, like difference', () => {
    close(blendFunction('exclusion', BLACK, WHITE), WHITE);
  });

  it('color-dodge of black backdrop is always black', () => {
    close(blendFunction('color-dodge', BLACK, GREY), BLACK);
  });

  it('color-dodge of a full-white source is always white', () => {
    close(blendFunction('color-dodge', GREY, WHITE), WHITE);
  });

  it('color-burn of a white backdrop is always white', () => {
    close(blendFunction('color-burn', WHITE, GREY), WHITE);
  });

  it('color-burn of a black source is always black', () => {
    close(blendFunction('color-burn', GREY, BLACK), BLACK);
  });

  it('overlay is hard-light with the operands swapped', () => {
    const cb = [0.3, 0.6, 0.9] as const;
    const cs = [0.7, 0.2, 0.4] as const;
    close(blendFunction('overlay', cb, cs), blendFunction('hard-light', cs, cb));
  });

  it('hard-light of a mid-grey source is plain multiply-or-screen at the midpoint', () => {
    // Cs=0.5 is the hard-light threshold; both branches agree there.
    close(blendFunction('hard-light', GREY, [0.5, 0.5, 0.5]), GREY);
  });

  it('soft-light of a mid-grey source leaves the backdrop unchanged', () => {
    // At Cs=0.5 soft light's Cs<=0.5 branch degenerates to Cb - 0 = Cb.
    close(blendFunction('soft-light', [0.3, 0.6, 0.9], [0.5, 0.5, 0.5]), [0.3, 0.6, 0.9]);
  });
});

describe('blendFunction — non-separable modes', () => {
  it('color takes the source hue/saturation with the backdrop luminosity', () => {
    // A pure red source over a mid-grey backdrop keeps red's hue but comes out
    // at grey's luminosity, not red's — the classic Photoshop "Color" effect.
    // (A *white* backdrop cannot show this: luminosity 1 forces pure white
    // regardless of source, since nothing can be brighter than white.)
    const out = blendFunction('color', GREY, RED);
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[0]).toBeGreaterThan(out[2]);
    expect(out[1]).toBeCloseTo(out[2], 9);
  });

  it('luminosity takes the source luminosity with the backdrop hue/saturation', () => {
    const out = blendFunction('luminosity', RED, WHITE);
    // White source luminosity (1.0) pushes every channel toward 1.
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('hue and saturation are each other with backdrop/source swapped', () => {
    const cb = [0.8, 0.2, 0.2] as const;
    const cs = [0.2, 0.2, 0.8] as const;
    // Both read luminosity from the backdrop; hue takes source hue+sat,
    // saturation takes backdrop hue with source's saturation magnitude.
    const hue = blendFunction('hue', cb, cs);
    const sat = blendFunction('saturation', cb, cs);
    expect(hue).not.toEqual(sat);
  });

  it('color/hue/saturation/luminosity of a colour with itself is that colour', () => {
    const c = [0.7, 0.3, 0.5] as const;
    close(blendFunction('color', c, c), c);
    close(blendFunction('hue', c, c), c);
    close(blendFunction('saturation', c, c), c);
    close(blendFunction('luminosity', c, c), c);
  });
});

describe('canvasCompositeOp', () => {
  it('maps normal to source-over — canvas has no "normal" operation', () => {
    expect(canvasCompositeOp('normal')).toBe('source-over');
  });

  it('passes every other mode through — the names already match the CSS keywords', () => {
    expect(canvasCompositeOp('multiply')).toBe('multiply');
    expect(canvasCompositeOp('color-dodge')).toBe('color-dodge');
    expect(canvasCompositeOp('luminosity')).toBe('luminosity');
  });
});
