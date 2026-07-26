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
