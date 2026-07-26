/**
 * Flatten the sprite to a straight-alpha RGBA buffer at document scale.
 *
 * **Why not read it back off the display canvas.** Canvas2D stores pixels
 * *premultiplied*. A `putImageData` → `getImageData` round trip therefore
 * quantizes every semi-transparent pixel twice and loses colour precision on
 * exactly the pixels that matter — the soft edges. Alpha is straight
 * everywhere in this project (`docs/02-architecture.md` §9), and export is the
 * one place where "close enough for the screen" is not good enough, so the
 * composite is done arithmetically instead.
 *
 * The per-pixel maths is `compositeOver` from `sample.ts`, shared so that what
 * the eyedropper reports and what export writes cannot drift apart.
 */

import type { Sprite } from '../model/types';
import { getBuffer } from '../model/pixelBuffers';
import { compositeOver } from './sample';

export function flattenSprite(sprite: Sprite, frameId: string): Uint8ClampedArray {
  const { width, height } = sprite;
  const out = new Uint8ClampedArray(width * height * 4);

  for (const layer of sprite.layers) {
    if (!layer.visible || layer.opacity === 0) continue;

    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    if (!cel) continue;

    const buf = getBuffer(cel.id);
    if (!buf) continue;

    for (let y = 0; y < cel.height; y++) {
      const dy = cel.y + y;
      if (dy < 0 || dy >= height) continue;

      for (let x = 0; x < cel.width; x++) {
        const dx = cel.x + x;
        if (dx < 0 || dx >= width) continue;

        const s = (y * cel.width + x) * 4;
        // Fully transparent source contributes nothing; skipping it is both
        // faster and avoids pointless rounding.
        if (buf[s + 3] === 0) continue;

        const d = (dy * width + dx) * 4;
        const [r, g, b, a] = compositeOver(
          [buf[s], buf[s + 1], buf[s + 2], buf[s + 3]],
          layer.opacity,
          [out[d], out[d + 1], out[d + 2], out[d + 3]],
        );
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = b;
        out[d + 3] = a;
      }
    }
  }

  return out;
}
