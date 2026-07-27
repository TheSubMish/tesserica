/**
 * Placing an image inside a box for the before/after view.
 *
 * Its own module because `ConvertCanvas.tsx` may only export components — and
 * because this is the piece worth testing directly: the split view relies on
 * both images being placed *identically*, or the comparison compares two
 * different framings.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Largest fit of `image` inside `box`, centred, aspect ratio preserved. */
export function fitRect(image: Size, box: Size): Rect {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, w, h };
}
