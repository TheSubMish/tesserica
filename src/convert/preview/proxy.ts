/**
 * The preview proxy (`docs/02-architecture.md` §3.1).
 *
 * Preview runs on a downscaled copy of the source, capped at ~1024 px on the
 * long edge. The user is looking at a pixelated result a few hundred pixels
 * wide; putting 12 M source pixels through the pipeline to show them 64×48
 * blocks is pure waste.
 *
 * It is also the honest source of the residual preview/export difference: at a
 * different input resolution, error diffusion genuinely produces a different
 * pattern. `tests/golden/dither.structural.test.ts` measures how different, and
 * the status bar says "preview (proxy)" whenever this has been applied
 * (`docs/05` §3).
 */

import type { PixelBuffer } from '../../pipeline/buffer.ts';
import { downscale } from '../../pipeline/downscale.ts';

/** Long-edge cap, per `docs/02` §3.1. */
export const PREVIEW_PROXY_MAX_EDGE = 1024;

export interface Proxy {
  readonly buffer: PixelBuffer;
  /** False when the source was already small enough to use directly. */
  readonly downscaled: boolean;
}

/**
 * Box-downscale `source` so its long edge is at most `maxEdge`.
 *
 * Box, not nearest: the proxy stands in for the *source*, and throwing away
 * three quarters of the source's detail before the pipeline's own downscale
 * would make the preview worse than it needs to be. The aspect ratio is
 * preserved, and neither dimension ever reaches zero.
 */
export function makeProxy(source: PixelBuffer, maxEdge = PREVIEW_PROXY_MAX_EDGE): Proxy {
  const longEdge = Math.max(source.width, source.height);
  if (longEdge <= maxEdge) return { buffer: source, downscaled: false };

  const scale = maxEdge / longEdge;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  return { buffer: downscale(source, width, height, 'box'), downscaled: true };
}
