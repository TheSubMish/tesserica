import { describe, expect, it } from 'vitest';
import type { Frame } from './types';
import { onionSkinFrames } from './onionSkin';

function frames(n: number): Frame[] {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, durationMs: 100 }));
}

describe('onionSkinFrames', () => {
  it('returns nothing for a single-frame sprite', () => {
    expect(onionSkinFrames(frames(1), 0, 2, 2)).toEqual([]);
  });

  it('returns nothing when both counts are zero', () => {
    expect(onionSkinFrames(frames(5), 2, 0, 0)).toEqual([]);
  });

  it('picks the requested number of frames before and after, in the middle of the range', () => {
    const ghosts = onionSkinFrames(frames(5), 2, 1, 1);
    expect(ghosts).toEqual([
      { frameId: 'f2', distance: -1 },
      { frameId: 'f4', distance: 1 },
    ]);
  });

  it('honours asymmetric before/after counts', () => {
    // Active frame is index 3 (f4): one step back is f3, two steps back is
    // f2, one step forward is f5.
    const ghosts = onionSkinFrames(frames(6), 3, 2, 1);
    expect(ghosts).toEqual([
      { frameId: 'f3', distance: -1 },
      { frameId: 'f2', distance: -2 },
      { frameId: 'f5', distance: 1 },
    ]);
  });

  it('wraps past the start of the loop when going earlier from frame 0', () => {
    const ghosts = onionSkinFrames(frames(4), 0, 1, 0);
    expect(ghosts).toEqual([{ frameId: 'f4', distance: -1 }]);
  });

  it('wraps past the end of the loop when going later from the last frame', () => {
    const ghosts = onionSkinFrames(frames(4), 3, 0, 1);
    expect(ghosts).toEqual([{ frameId: 'f1', distance: 1 }]);
  });

  it('stops each direction before it would revisit an already-claimed frame', () => {
    // 3 frames, asking for 2 in each direction: going backward from frame 1
    // (index 0) reaches f3 (-1) then f2 (-2); going forward would reach f2
    // again at +1, which is already claimed, so the forward walk stops
    // immediately rather than showing f2 twice.
    const ghosts = onionSkinFrames(frames(3), 0, 2, 2);
    expect(ghosts).toEqual([
      { frameId: 'f3', distance: -1 },
      { frameId: 'f2', distance: -2 },
    ]);
  });

  it('never includes the active frame itself', () => {
    const ghosts = onionSkinFrames(frames(2), 0, 3, 3);
    for (const g of ghosts) expect(g.frameId).not.toBe('f1');
  });
});
