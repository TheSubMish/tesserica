import { describe, expect, it } from 'vitest';
import type { RGBA } from '../model/types';
import { cleanEdgeSample, cleanEdgeTransform, rotxelRotate } from './transform';

function makeBuffer(w: number, h: number, fill: (x: number, y: number) => RGBA): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

function pixelAt(buf: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];
const YELLOW: RGBA = [255, 255, 0, 255];
const TRANSPARENT: RGBA = [0, 0, 0, 0];

function sourceColorSet(buf: Uint8ClampedArray, w: number, h: number): Set<string> {
  const set = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      set.add(pixelAt(buf, w, x, y).join(','));
    }
  }
  set.add(TRANSPARENT.join(','));
  return set;
}

describe('rotxelRotate', () => {
  it('0 degrees is a no-op', () => {
    const buf = makeBuffer(4, 4, (x, y) => (x === y ? RED : GREEN));
    const out = rotxelRotate(buf, 4, 4, 0);
    expect([...out]).toEqual([...buf]);
    expect(out).not.toBe(buf); // still a fresh buffer, never mutates the input
  });

  it('180 degrees is an exact reversal, no rounding ambiguity', () => {
    // Asymmetric marker pattern so a wrong axis or off-by-one is visible.
    const buf = makeBuffer(4, 3, (x, y) => (x === 0 && y === 0 ? RED : GREEN));
    const out = rotxelRotate(buf, 4, 3, Math.PI);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        expect(pixelAt(out, 4, x, y)).toEqual(pixelAt(buf, 4, 3 - x, 2 - y));
      }
    }
    // The corner marker must have moved to the opposite corner exactly.
    expect(pixelAt(out, 4, 3, 2)).toEqual(RED);
    expect(pixelAt(out, 4, 0, 0)).toEqual(GREEN);
  });

  it('90 degrees on a square region is an exact transpose/flip, no smoothing applied', () => {
    // L-shaped marker: (0,0) and (1,0) are RED, rest GREEN.
    const buf = makeBuffer(4, 4, (x, y) => (y === 0 && (x === 0 || x === 1) ? RED : GREEN));
    const out = rotxelRotate(buf, 4, 4, Math.PI / 2);
    // Every output pixel must be a colour that existed in the source — an
    // exact permutation, never a blend — and running it twice more (270,
    // 360) must return to the exact original, which only holds if 90 is a
    // true bijective permutation with no lossy smoothing.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect([RED, GREEN]).toContainEqual(pixelAt(out, 4, x, y));
      }
    }
    const twice = rotxelRotate(out, 4, 4, Math.PI / 2);
    const thrice = rotxelRotate(twice, 4, 4, Math.PI / 2);
    const full = rotxelRotate(thrice, 4, 4, Math.PI / 2);
    expect([...full]).toEqual([...buf]);
  });

  it('270 degrees is the exact inverse of 90 degrees on a square region', () => {
    const buf = makeBuffer(5, 5, (x, y) => (x === 1 && y === 2 ? BLUE : YELLOW));
    const rotated90 = rotxelRotate(buf, 5, 5, Math.PI / 2);
    const back = rotxelRotate(rotated90, 5, 5, (3 * Math.PI) / 2);
    expect([...back]).toEqual([...buf]);
  });

  it('never introduces a colour absent from the source, at an arbitrary angle', () => {
    const buf = makeBuffer(9, 9, (x) => {
      if (x < 3) return RED;
      if (x < 6) return GREEN;
      return BLUE;
    });
    const palette = sourceColorSet(buf, 9, 9);
    for (const deg of [15, 30, 45, 60, 73, 137]) {
      const out = rotxelRotate(buf, 9, 9, (deg * Math.PI) / 180);
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          expect(palette.has(pixelAt(out, 9, x, y).join(','))).toBe(true);
        }
      }
    }
  });

  it('a solid colour square stays that one colour after an arbitrary rotation', () => {
    const buf = makeBuffer(10, 10, () => RED);
    const out = rotxelRotate(buf, 10, 10, (37 * Math.PI) / 180);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const p = pixelAt(out, 10, x, y);
        expect(p[3] === 0 || (p[0] === 255 && p[1] === 0 && p[2] === 0)).toBe(true);
      }
    }
  });

  it('never mutates the input buffer', () => {
    const buf = makeBuffer(6, 6, (x, y) => ((x + y) % 2 === 0 ? RED : GREEN));
    const before = [...buf];
    rotxelRotate(buf, 6, 6, (42 * Math.PI) / 180);
    expect([...buf]).toEqual(before);
  });
});

describe('cleanEdgeSample', () => {
  it('returns the exact centre pixel when sampled exactly on it', () => {
    const buf = makeBuffer(4, 4, (x) => (x < 2 ? RED : GREEN));
    expect(cleanEdgeSample(buf, 4, 4, 1, 1)).toEqual(RED);
  });

  it('falls back to plain nearest-neighbour when there is no diagonal edge to slice', () => {
    // A flat vertical boundary: the neighbour "toward" any diagonal quadrant
    // from a boundary pixel is never a same-colour diagonal run, so nothing
    // should move away from the nearest pixel.
    const buf = makeBuffer(4, 4, (x) => (x < 2 ? RED : GREEN));
    // Sample just off-centre from pixel (1,1), leaning right+down.
    const out = cleanEdgeSample(buf, 4, 4, 1.3, 1.3);
    expect(out).toEqual(RED); // (2,1) is GREEN, (1,2) is RED — not similar, no slice
  });

  it('slices toward the horizontal neighbour when the sample leans further horizontally across a real 45-degree run', () => {
    // f=(2,1) and d=(1,2) are both BLUE (a diagonal run), c=(1,1) is YELLOW,
    // corner=(2,2) is BLUE too — no single-pixel-diagonal guard should fire.
    const buf = makeBuffer(4, 4, (x, y) => {
      if (x === 1 && y === 1) return YELLOW; // c
      if (x === 2 && y === 1) return BLUE; // f
      if (x === 1 && y === 2) return BLUE; // d
      if (x === 2 && y === 2) return BLUE; // corner
      return RED;
    });
    const leansHorizontal = cleanEdgeSample(buf, 4, 4, 1.3, 1.1); // ax > ay
    expect(leansHorizontal).toEqual(BLUE);
    const leansVertical = cleanEdgeSample(buf, 4, 4, 1.1, 1.3); // ay > ax
    expect(leansVertical).toEqual(BLUE);
  });

  it('protects a single-pixel-wide diagonal line from being eaten by its neighbours', () => {
    // c and the opposite corner share a colour that differs from both f and
    // d, which themselves agree with each other — the "don't flip" guard.
    const buf = makeBuffer(4, 4, (x, y) => {
      if (x === 1 && y === 1) return YELLOW; // c
      if (x === 2 && y === 2) return YELLOW; // corner, same as c
      if (x === 2 && y === 1) return BLUE; // f
      if (x === 1 && y === 2) return BLUE; // d
      return RED;
    });
    expect(cleanEdgeSample(buf, 4, 4, 1.3, 1.3)).toEqual(YELLOW);
  });

  it('every answer is a colour that exists somewhere in the source', () => {
    const buf = makeBuffer(6, 6, (x, y) => {
      if ((x + y) % 3 === 0) return RED;
      if ((x + y) % 3 === 1) return GREEN;
      return BLUE;
    });
    const palette = sourceColorSet(buf, 6, 6);
    for (let sy = 0; sy < 60; sy++) {
      for (let sx = 0; sx < 60; sx++) {
        const out = cleanEdgeSample(buf, 6, 6, sx / 10, sy / 10);
        expect(palette.has(out.join(','))).toBe(true);
      }
    }
  });
});

describe('cleanEdgeTransform', () => {
  it('produces the same width x height footprint as the input', () => {
    const buf = makeBuffer(8, 5, () => RED);
    const out = cleanEdgeTransform(buf, 8, 5, 0, 1);
    expect(out.length).toBe(buf.length);
  });

  it('a solid colour square stays that one colour at a non-integer scale', () => {
    const buf = makeBuffer(10, 10, () => GREEN);
    const out = cleanEdgeTransform(buf, 10, 10, 0, 1.37);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const p = pixelAt(out, 10, x, y);
        expect(p[3] === 0 || (p[0] === 0 && p[1] === 255 && p[2] === 0)).toBe(true);
      }
    }
  });

  it('never introduces a colour absent from the source at a combined rotate + non-integer scale', () => {
    const buf = makeBuffer(9, 9, (x) => {
      if (x < 3) return RED;
      if (x < 6) return GREEN;
      return BLUE;
    });
    const palette = sourceColorSet(buf, 9, 9);
    const out = cleanEdgeTransform(buf, 9, 9, (23 * Math.PI) / 180, 1.6);
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        expect(palette.has(pixelAt(out, 9, x, y).join(','))).toBe(true);
      }
    }
  });

  it('reduces stray single-pixel artifacts on a rotated diagonal edge, versus naive nearest-neighbour', () => {
    // A clean 45-degree diagonal split: RED above/left of the diagonal, BLUE
    // below/right of it.
    const size = 16;
    const buf = makeBuffer(size, size, (x, y) => (x + y < size ? RED : BLUE));

    function naiveNnRotate(angle: number): Uint8ClampedArray {
      const out = new Uint8ClampedArray(buf.length);
      const px = size / 2;
      const py = size / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - px;
          const dy = y - py;
          const ox = Math.round(dx * cos - dy * sin + px);
          const oy = Math.round(dx * sin + dy * cos + py);
          const i = (y * size + x) * 4;
          if (ox >= 0 && ox < size && oy >= 0 && oy < size) {
            const si = (oy * size + ox) * 4;
            out[i] = buf[si];
            out[i + 1] = buf[si + 1];
            out[i + 2] = buf[si + 2];
            out[i + 3] = buf[si + 3];
          }
        }
      }
      return out;
    }

    function strayPixelCount(img: Uint8ClampedArray): number {
      let strays = 0;
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          const c = pixelAt(img, size, x, y);
          if (c[3] === 0) continue;
          const neighbours = [
            pixelAt(img, size, x - 1, y),
            pixelAt(img, size, x + 1, y),
            pixelAt(img, size, x, y - 1),
            pixelAt(img, size, x, y + 1),
          ];
          const agrees = neighbours.some(
            (n) => n[0] === c[0] && n[1] === c[1] && n[2] === c[2] && n[3] === c[3],
          );
          if (!agrees) strays++;
        }
      }
      return strays;
    }

    const angle = (17 * Math.PI) / 180;
    const naive = naiveNnRotate(angle);
    const cleaned = cleanEdgeTransform(buf, size, size, angle, 1);

    expect(strayPixelCount(cleaned)).toBeLessThanOrEqual(strayPixelCount(naive));
  });
});

// ---------------------------------------------------------------------------
// Indexed storage (`bytesPerPixel = 1`) — the generalisation that lets the
// Transform tool operate on an indexed-mode cel (`model/celStorage.ts`,
// `docs/08-roadmap.md` Phase 7 follow-up). Mirrors the RGBA "never introduces
// a colour absent from the source" assertions above, one axis over: "never
// introduces an index absent from the source".
// ---------------------------------------------------------------------------

function makeIndexBuffer(w: number, h: number, fill: (x: number, y: number) => number): Uint8Array {
  const buf = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) buf[y * w + x] = fill(x, y);
  }
  return buf;
}

function indexAt(buf: Uint8Array, w: number, x: number, y: number): number {
  return buf[y * w + x];
}

describe('rotxelRotate — indexed storage (bytesPerPixel = 1)', () => {
  it('returns a Uint8Array (not Uint8ClampedArray) when given one', () => {
    const buf = makeIndexBuffer(4, 4, () => 1);
    const out = rotxelRotate(buf, 4, 4, Math.PI / 2, undefined, undefined, 1);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).not.toBeInstanceOf(Uint8ClampedArray);
  });

  it('180 degrees is an exact reversal of indices, no rounding ambiguity', () => {
    const buf = makeIndexBuffer(4, 3, (x, y) => (x === 0 && y === 0 ? 5 : 2));
    const out = rotxelRotate(buf, 4, 3, Math.PI, undefined, undefined, 1);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        expect(indexAt(out, 4, x, y)).toBe(indexAt(buf, 4, 3 - x, 2 - y));
      }
    }
  });

  it('90 degrees is an exact bijective permutation of indices, no smoothing applied', () => {
    const buf = makeIndexBuffer(4, 4, (x, y) => (y === 0 && (x === 0 || x === 1) ? 5 : 2));
    const out = rotxelRotate(buf, 4, 4, Math.PI / 2, undefined, undefined, 1);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect([5, 2]).toContain(indexAt(out, 4, x, y));
      }
    }
    const twice = rotxelRotate(out, 4, 4, Math.PI / 2, undefined, undefined, 1);
    const thrice = rotxelRotate(twice, 4, 4, Math.PI / 2, undefined, undefined, 1);
    const full = rotxelRotate(thrice, 4, 4, Math.PI / 2, undefined, undefined, 1);
    expect([...full]).toEqual([...buf]);
  });

  it('never introduces an index absent from the source, at an arbitrary angle', () => {
    const buf = makeIndexBuffer(9, 9, (x) => (x < 3 ? 1 : x < 6 ? 2 : 3));
    const validIndices = new Set([0, 1, 2, 3]); // 0 = TRANSPARENT_INDEX / off-canvas
    for (const deg of [15, 30, 45, 60, 73, 137]) {
      const out = rotxelRotate(buf, 9, 9, (deg * Math.PI) / 180, undefined, undefined, 1);
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          expect(validIndices.has(indexAt(out, 9, x, y))).toBe(true);
        }
      }
    }
  });

  it('a solid index stays that one index after an arbitrary rotation', () => {
    const buf = makeIndexBuffer(10, 10, () => 9);
    const out = rotxelRotate(buf, 10, 10, (37 * Math.PI) / 180, undefined, undefined, 1);
    for (const v of out) expect(v === 0 || v === 9).toBe(true);
  });

  it('does not treat numerically-close indices as interchangeable the way an RGBA tolerance would', () => {
    // Indices 5 and 6 are one integer apart — well inside `rgbaSimilar`'s
    // default tolerance, which would wrongly call them "the same colour" if
    // index bytes were ever run through the RGBA comparator by mistake. Every
    // output value must still be one of the source's own distinct indices.
    const buf = makeIndexBuffer(6, 6, (x, y) => {
      const m = (x + y) % 3;
      return m === 0 ? 5 : m === 1 ? 6 : 7;
    });
    const out = rotxelRotate(buf, 6, 6, (23 * Math.PI) / 180, undefined, undefined, 1);
    for (const v of out) expect([0, 5, 6, 7]).toContain(v);
  });

  it('never mutates the input buffer', () => {
    const buf = makeIndexBuffer(6, 6, (x, y) => ((x + y) % 2 === 0 ? 5 : 2));
    const before = [...buf];
    rotxelRotate(buf, 6, 6, (42 * Math.PI) / 180, undefined, undefined, 1);
    expect([...buf]).toEqual(before);
  });
});

describe('cleanEdgeTransform — indexed storage (bytesPerPixel = 1)', () => {
  it('returns a Uint8Array (not Uint8ClampedArray) when given one', () => {
    const buf = makeIndexBuffer(4, 4, () => 3);
    const out = cleanEdgeTransform(buf, 4, 4, 0, 1, undefined, undefined, 1);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).not.toBeInstanceOf(Uint8ClampedArray);
  });

  it('a solid index stays that one index at a non-integer scale', () => {
    const buf = makeIndexBuffer(10, 10, () => 9);
    const out = cleanEdgeTransform(buf, 10, 10, 0, 1.37, undefined, undefined, 1);
    for (const v of out) expect(v === 0 || v === 9).toBe(true);
  });

  it('never introduces an index absent from the source at a combined rotate + non-integer scale', () => {
    const buf = makeIndexBuffer(9, 9, (x) => (x < 3 ? 1 : x < 6 ? 2 : 3));
    const validIndices = new Set([0, 1, 2, 3]);
    const out = cleanEdgeTransform(buf, 9, 9, (23 * Math.PI) / 180, 1.6, undefined, undefined, 1);
    for (const v of out) expect(validIndices.has(v)).toBe(true);
  });
});
