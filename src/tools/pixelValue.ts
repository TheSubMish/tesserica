/**
 * The one place every painting tool converts "the colour the user picked"
 * into "the bytes to actually write" (`docs/08-roadmap.md` Phase 7).
 *
 * For an `'rgba'`-mode cel this is the identity — an `RGBA` tuple already is
 * what `setPixel`/`stampBrush`/… expect. For an `'indexed'`-mode cel it is
 * the "colour not in the palette" policy `docs/10-decisions.md` D9 names as
 * unresolved: snap to the nearest palette entry in Oklab
 * (`model/indexedColor.ts::nearestPaletteIndex`), which also handles alpha 0
 * mapping to the reserved transparent index.
 */

import { nearestPaletteIndex } from '../model/indexedColor';
import { TRANSPARENT_INDEX } from '../model/indexBuffers';
import type { RGBA } from '../model/types';
import type { ToolContext } from './Tool';

export function pixelValueFor(ctx: ToolContext, color: RGBA): readonly number[] {
  if (ctx.colorMode !== 'indexed') return color;
  if (!ctx.palette) return [TRANSPARENT_INDEX]; // no palette assigned — nothing to resolve against
  return [nearestPaletteIndex(color, ctx.palette)];
}
