/**
 * Tile Stamp — place a tile from the picker onto a tilemap layer's grid
 * (`docs/08-roadmap.md` Phase 6, `docs/03-data-model.md` §4).
 *
 * Unlike every painting tool, Stamp never touches a `Uint8ClampedArray` cel
 * buffer — a tilemap cel's content is a packed-tile-id `Uint32Array` grid
 * (`model/tileGridBuffers.ts`), which `ToolContext` has no concept of and
 * generic dispatch cannot even reach: `CanvasView`'s dispatch always resolves
 * `getBuffer(bufferId)` before calling a tool, and that is `undefined` for a
 * tilemap cel by construction. So, exactly like `tools/zoom.ts`,
 * `CanvasView.onPointerDown`/`onPointerMove`/pointer-up special-case
 * `activeTool === 'stamp'` *before* generic dispatch and call into
 * `tools/stampSession.ts` directly — this entry exists only so `stamp` is a
 * valid `ToolId` the rail can render and the registry stays exhaustive.
 */

import type { Tool } from './Tool';

export const stamp: Tool = {
  id: 'stamp',
  label: 'Stamp',
  readOnly: true,
  onPointerDown() {
    // Real behaviour lives in CanvasView + tools/stampSession.ts (see above).
  },
  onPointerMove() {
    // Real behaviour lives in CanvasView + tools/stampSession.ts (see above).
  },
};
