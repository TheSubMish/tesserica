/**
 * Pure logic behind the Timeline panel (`docs/05-ui-design.md` §5,
 * `docs/08-roadmap.md` Phase 4 "Timeline panel") — grid lookup and the
 * playback scheduler, kept independent of React so both are unit-testable
 * without mounting the panel or a real clock.
 */

import type { Cel, Frame, FrameId, LayerId, Sprite } from '../model/types';

/** The cel a given layer has at a given frame, if any. */
export function celAt(sprite: Sprite, layerId: LayerId, frameId: FrameId): Cel | undefined {
  return sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId);
}

/** Index of the frame that plays after `currentIndex`, looping back to the start. */
export function nextFrameIndex(currentIndex: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return (currentIndex + 1) % frameCount;
}

/** Index of the frame that plays before `currentIndex`, looping back to the end. */
export function prevFrameIndex(currentIndex: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return (currentIndex - 1 + frameCount) % frameCount;
}

export interface PlaybackHandle {
  stop(): void;
}

/**
 * Advance through `getFrames()` at each current frame's own `durationMs`,
 * looping back to the start indefinitely, until `stop()` is called.
 *
 * Frames and the active frame id are read through getters — rather than
 * captured once at the start — because a frame can be added, removed or
 * reordered while playback is running, and the next tick must see the
 * document as it is then, not as it was when playback began.
 *
 * `schedule`/`cancel` are injected (defaulting to `setTimeout`/`clearTimeout`)
 * so playback can be driven by fake timers in tests, with no real clock and
 * no mounted component.
 */
export function startPlayback(
  getFrames: () => readonly Frame[],
  getCurrentFrameId: () => FrameId,
  advance: (frameId: FrameId) => void,
  schedule: (cb: () => void, ms: number) => number = (cb, ms) =>
    window.setTimeout(cb, ms) as unknown as number,
  cancel: (handle: number) => void = (h) => window.clearTimeout(h),
): PlaybackHandle {
  let stopped = false;
  let handle: number | undefined;

  const tick = (): void => {
    if (stopped) return;
    const frames = getFrames();
    if (frames.length === 0) return;
    const idx = frames.findIndex((f) => f.id === getCurrentFrameId());
    const current = frames[idx < 0 ? 0 : idx];

    // Floor at 1ms — a malformed/zero duration would otherwise reschedule
    // immediately, forever, and busy-loop the tab.
    handle = schedule(
      () => {
        if (stopped) return;
        const framesNow = getFrames();
        if (framesNow.length === 0) return;
        const curIdx = framesNow.findIndex((f) => f.id === getCurrentFrameId());
        const next = nextFrameIndex(curIdx < 0 ? 0 : curIdx, framesNow.length);
        advance(framesNow[next].id);
        tick();
      },
      Math.max(1, current.durationMs),
    );
  };

  tick();

  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) cancel(handle);
    },
  };
}
