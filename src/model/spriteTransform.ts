/**
 * Pure pixel maths for whole-document operations (`docs/03-data-model.md` §6.1):
 * canvas resize/crop, flips and rotations.
 *
 * Works on raw cel buffers of either depth — 4 bytes/pixel RGBA or 1 byte/pixel
 * indexed — and never touches a store. A zero-filled buffer is transparent in both
 * (`TRANSPARENT_INDEX` is 0), so "new area" is simply left as zeros.
 */

export type CelPixels = Uint8ClampedArray | Uint8Array;

export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

export const ANCHORS: readonly Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export type PixelOp = 'flip-h' | 'flip-v' | 'rot-cw' | 'rot-ccw' | 'rot-180';

function blank(like: CelPixels, length: number): CelPixels {
  return like instanceof Uint8ClampedArray ? new Uint8ClampedArray(length) : new Uint8Array(length);
}

/**
 * Where the old image's top-left corner lands inside the new canvas. May be
 * negative (shrinking crops the side the anchor is *not* on).
 */
export function anchorOffset(
  anchor: Anchor,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): { x: number; y: number } {
  const dx = newW - oldW;
  const dy = newH - oldH;
  const col =
    anchor === 'tl' || anchor === 'l' || anchor === 'bl'
      ? 0
      : anchor === 't' || anchor === 'c' || anchor === 'b'
        ? 1
        : 2;
  const row =
    anchor === 'tl' || anchor === 't' || anchor === 'tr'
      ? 0
      : anchor === 'l' || anchor === 'c' || anchor === 'r'
        ? 1
        : 2;
  return {
    x: col === 0 ? 0 : col === 1 ? Math.floor(dx / 2) : dx,
    y: row === 0 ? 0 : row === 1 ? Math.floor(dy / 2) : dy,
  };
}

/**
 * Copy `src` into a new `newW × newH` buffer with its origin at `(offX, offY)`.
 * Pixels that fall outside the new canvas are dropped; uncovered area is transparent.
 */
export function resizeBuffer(
  src: CelPixels,
  w: number,
  h: number,
  bpp: number,
  newW: number,
  newH: number,
  offX: number,
  offY: number,
): CelPixels {
  const out = blank(src, newW * newH * bpp);
  const x0 = Math.max(0, -offX);
  const x1 = Math.min(w, newW - offX);
  if (x1 <= x0) return out;
  for (let y = Math.max(0, -offY); y < Math.min(h, newH - offY); y++) {
    const from = (y * w + x0) * bpp;
    const to = ((y + offY) * newW + x0 + offX) * bpp;
    out.set(src.subarray(from, from + (x1 - x0) * bpp), to);
  }
  return out;
}

/** The dimensions a buffer has after `op`. */
export function opSize(op: PixelOp, w: number, h: number): { width: number; height: number } {
  return op === 'rot-cw' || op === 'rot-ccw' ? { width: h, height: w } : { width: w, height: h };
}

/** Flip or rotate a buffer. Returns a new buffer; `src` is not modified. */
export function transformBuffer(
  src: CelPixels,
  w: number,
  h: number,
  bpp: number,
  op: PixelOp,
): CelPixels {
  const { width: nw } = opSize(op, w, h);
  const out = blank(src, src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      switch (op) {
        case 'flip-h':
          dx = w - 1 - x;
          dy = y;
          break;
        case 'flip-v':
          dx = x;
          dy = h - 1 - y;
          break;
        case 'rot-cw':
          dx = h - 1 - y;
          dy = x;
          break;
        case 'rot-ccw':
          dx = y;
          dy = w - 1 - x;
          break;
        case 'rot-180':
          dx = w - 1 - x;
          dy = h - 1 - y;
          break;
      }
      const s = (y * w + x) * bpp;
      const d = (dy * nw + dx) * bpp;
      for (let k = 0; k < bpp; k++) out[d + k] = src[s + k];
    }
  }
  return out;
}
