/**
 * Brush shapes and inks (`docs/03-data-model.md` §6.2).
 *
 * A *shape* decides which pixels a size-`n` stamp covers; an *ink* decides how a
 * covered pixel is written.
 */

export type BrushShape = 'square' | 'circle' | 'slash' | 'backslash';
export type Ink = 'normal' | 'lock-alpha';

export const BRUSH_SHAPES: readonly { id: BrushShape; label: string; hint: string }[] = [
  { id: 'square', label: '■', hint: 'Square brush' },
  { id: 'circle', label: '●', hint: 'Round brush' },
  { id: 'slash', label: '╱', hint: 'Diagonal brush (/)' },
  { id: 'backslash', label: '╲', hint: 'Diagonal brush (\\)' },
];

export const INKS: readonly { id: Ink; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normal', hint: 'Paint over anything' },
  {
    id: 'lock-alpha',
    label: 'Lock alpha',
    hint: 'Only recolour pixels that are already painted; transparency is preserved',
  },
];

export interface BrushOptions {
  readonly shape: BrushShape;
  readonly ink: Ink;
}

export const DEFAULT_BRUSH: BrushOptions = { shape: 'square', ink: 'normal' };

const cache = new Map<string, ReadonlyArray<readonly [number, number]>>();

/**
 * The `[dx, dy]` offsets, inside a `size × size` box, that a stamp covers.
 *
 * The circle keeps a pixel when it is within `(size/2)² − size/4` of the box
 * centre. That small deduction is what turns size 3 into the plus-shaped dot
 * pixel artists expect rather than a full 3×3 square, and size 4–5 into a tidy
 * rounded octagon.
 */
export function footprint(
  shape: BrushShape,
  size: number,
): ReadonlyArray<readonly [number, number]> {
  const n = Math.max(1, Math.round(size));
  const key = `${shape}:${n}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const out: [number, number][] = [];
  const centre = (n - 1) / 2;
  const limit = (n / 2) ** 2 - n / 4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const keep =
        n === 1 ||
        shape === 'square' ||
        (shape === 'circle' && (x - centre) ** 2 + (y - centre) ** 2 <= limit) ||
        (shape === 'slash' && x + y === n - 1) ||
        (shape === 'backslash' && x === y);
      if (keep) out.push([x, y]);
    }
  }
  cache.set(key, out);
  return out;
}
