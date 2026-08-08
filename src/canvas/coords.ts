/**
 * Screen ↔ document coordinate mapping.
 *
 * Kept separate and pure because every tool depends on getting this exactly
 * right — an off-by-one here means strokes land on the wrong pixel at some
 * zoom levels and not others, which is miserable to debug from the symptom.
 */

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

/** Screen pixel → document pixel. Floors, so it returns the containing cell. */
export function screenToDoc(
  vp: Viewport,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: Math.floor((screenX - vp.panX) / vp.zoom),
    y: Math.floor((screenY - vp.panY) / vp.zoom),
  };
}

/** Document pixel → screen position of that cell's top-left corner. */
export function docToScreen(vp: Viewport, docX: number, docY: number): { x: number; y: number } {
  return {
    x: docX * vp.zoom + vp.panX,
    y: docY * vp.zoom + vp.panY,
  };
}

/** Pan that centers a sprite of the given size in a viewport of the given size. */
export function centerPan(
  zoom: number,
  spriteW: number,
  spriteH: number,
  viewW: number,
  viewH: number,
): { panX: number; panY: number } {
  return {
    panX: Math.round((viewW - spriteW * zoom) / 2),
    panY: Math.round((viewH - spriteH * zoom) / 2),
  };
}

/** Largest integer zoom at which the sprite fits the viewport with margin. */
export function fitZoom(
  spriteW: number,
  spriteH: number,
  viewW: number,
  viewH: number,
  margin = 48,
): number {
  const z = Math.min((viewW - margin) / spriteW, (viewH - margin) / spriteH);
  // Integer zoom only — non-integer scaling produces uneven pixel sizes
  // (docs/04-image-pipeline.md §7).
  return Math.max(1, Math.floor(z));
}

/**
 * One axis' scrollbar geometry (`canvas/ScrollBar.tsx`).
 *
 * `CanvasView` already lets space/middle-drag push the sprite well past the
 * viewport's edges — that pan is never clamped. The scrollbar has to agree
 * with that freedom rather than fight it, so its track represents the
 * content plus a viewport's worth of margin on *each* side (an "overscroll"
 * exactly as generous as free-drag panning already is), not just the bare
 * content. A track this size still shows a moving, meaningfully-sized thumb
 * even when the sprite is much smaller than the viewport (fully zoomed out),
 * where a bare content-sized track would otherwise degenerate to a thumb
 * that fills the whole bar.
 */
const SCROLL_OVERSCROLL_RATIO = 1;

export interface ScrollBarGeometry {
  /** Fraction of the track the thumb covers, in `[0, 1]`. */
  thumbRatio: number;
  /** Fraction of the track before the thumb starts, in `[0, 1 - thumbRatio]`. */
  thumbOffset: number;
}

/** Thumb size and position for one axis, from that axis' content size, viewport size, and current pan. */
export function scrollBarGeometry(
  content: number,
  viewport: number,
  pan: number,
): ScrollBarGeometry {
  if (viewport <= 0) return { thumbRatio: 1, thumbOffset: 0 };
  const margin = viewport * SCROLL_OVERSCROLL_RATIO;
  const virtualLength = content + 2 * margin;
  const thumbRatio = Math.min(1, viewport / virtualLength);
  const maxScroll = Math.max(0, virtualLength - viewport);
  const scroll = Math.min(maxScroll, Math.max(0, margin - pan));
  const usableTrack = 1 - thumbRatio;
  const thumbOffset = maxScroll > 0 && usableTrack > 0 ? (scroll / maxScroll) * usableTrack : 0;
  return { thumbRatio, thumbOffset };
}

/**
 * The inverse of {@link scrollBarGeometry}'s scroll position: a track-relative
 * thumb offset (`[0, 1 - thumbRatio]`, e.g. from a drag) back to `pan`.
 */
export function panFromScrollOffset(content: number, viewport: number, offset: number): number {
  if (viewport <= 0) return 0;
  const margin = viewport * SCROLL_OVERSCROLL_RATIO;
  const virtualLength = content + 2 * margin;
  const thumbRatio = Math.min(1, viewport / virtualLength);
  const maxScroll = Math.max(0, virtualLength - viewport);
  const usableTrack = 1 - thumbRatio;
  const scroll = usableTrack > 0 ? (offset / usableTrack) * maxScroll : 0;
  return margin - Math.min(maxScroll, Math.max(0, scroll));
}
