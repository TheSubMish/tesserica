/**
 * Onion-skin ghost-frame selection — pure logic, no canvas, no store.
 *
 * `docs/08-roadmap.md` Phase 4 "Onion skinning with tint and configurable
 * range"; `docs/06-workflows.md` W3 step 5 ("Enable onion skin, 1 before / 1
 * after"); `docs/05-ui-design.md` §5 ("Onion skinning toggle with
 * configurable before/after counts and tint").
 *
 * This is view-only: the frames it names are read for compositing a ghost
 * overlay (`canvas/renderer.ts::drawOnionSkin`) and never touched for
 * anything that could end up in a cel buffer, undo history, or export
 * (`canvas/flatten.ts` has no dependency on any of this, by construction).
 */

import type { Frame, FrameId } from './types';

export interface OnionSkinGhost {
  frameId: FrameId;
  /** Steps from the active frame — negative is earlier, positive is later. */
  distance: number;
}

/**
 * The frames to ghost around `activeIndex`, up to `before` steps earlier and
 * `after` steps later, wrapping around the ends the same way playback loops
 * (`panels/timeline.ts::nextFrameIndex`/`prevFrameIndex`) — appropriate here
 * since the flagship animation workflow (W3) is a looping walk cycle, so the
 * frame "before" frame 1 is usefully the last frame, not nothing.
 *
 * Each direction stops as soon as it would wrap onto a frame already claimed
 * — by the active frame itself, or by a ghost already placed on the other
 * side — rather than ever showing the same frame twice. This only matters
 * when `before + after` reaches or exceeds the number of other frames that
 * exist, e.g. a 3-frame loop with a range of 2 in both directions.
 */
export function onionSkinFrames(
  frames: readonly Frame[],
  activeIndex: number,
  before: number,
  after: number,
): OnionSkinGhost[] {
  const count = frames.length;
  if (count <= 1 || (before <= 0 && after <= 0)) return [];

  const claimed = new Set<number>([((activeIndex % count) + count) % count]);
  const ghosts: OnionSkinGhost[] = [];

  for (let i = 1; i <= before; i++) {
    const idx = (((activeIndex - i) % count) + count) % count;
    if (claimed.has(idx)) break;
    claimed.add(idx);
    ghosts.push({ frameId: frames[idx].id, distance: -i });
  }
  for (let i = 1; i <= after; i++) {
    const idx = (((activeIndex + i) % count) + count) % count;
    if (claimed.has(idx)) break;
    claimed.add(idx);
    ghosts.push({ frameId: frames[idx].id, distance: i });
  }

  return ghosts;
}
