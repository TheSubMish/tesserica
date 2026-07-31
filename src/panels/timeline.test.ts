import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame, Sprite } from '../model/types';
import { celAt, nextFrameIndex, prevFrameIndex, startPlayback } from './timeline';

describe('celAt', () => {
  const sprite: Sprite = {
    width: 4,
    height: 4,
    layers: [
      {
        id: 'l1',
        kind: 'raster',
        name: 'a',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        parentId: null,
        clippingMask: false,
        effects: [],
      },
    ],
    frames: [
      { id: 'f1', durationMs: 100 },
      { id: 'f2', durationMs: 100 },
    ],
    cels: [{ id: 'c1', layerId: 'l1', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 }],
    tags: [],
    colorMode: 'rgba',
    tilesets: [],
  };

  it('finds the cel a layer has at a frame', () => {
    expect(celAt(sprite, 'l1', 'f1')?.id).toBe('c1');
  });

  it('returns undefined when the layer has no cel at that frame', () => {
    expect(celAt(sprite, 'l1', 'f2')).toBeUndefined();
  });
});

describe('nextFrameIndex / prevFrameIndex', () => {
  it('advances within bounds', () => {
    expect(nextFrameIndex(0, 3)).toBe(1);
    expect(nextFrameIndex(1, 3)).toBe(2);
  });

  it('loops from the last frame back to the first', () => {
    expect(nextFrameIndex(2, 3)).toBe(0);
  });

  it('steps back within bounds', () => {
    expect(prevFrameIndex(2, 3)).toBe(1);
  });

  it('loops from the first frame back to the last', () => {
    expect(prevFrameIndex(0, 3)).toBe(2);
  });

  it('does not divide by zero on an empty timeline', () => {
    expect(nextFrameIndex(0, 0)).toBe(0);
    expect(prevFrameIndex(0, 0)).toBe(0);
  });
});

describe('startPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tiny in-memory "document" the scheduler reads and writes through getters. */
  function fixture(frames: Frame[]) {
    let currentId = frames[0].id;
    return {
      frames,
      getFrames: () => frames,
      getCurrentFrameId: () => currentId,
      advance: vi.fn((id: string) => {
        currentId = id;
      }),
      currentId: () => currentId,
    };
  }

  it('advances to the next frame after the current frame’s own duration', () => {
    const f = fixture([
      { id: 'f1', durationMs: 100 },
      { id: 'f2', durationMs: 200 },
      { id: 'f3', durationMs: 300 },
    ]);

    startPlayback(f.getFrames, f.getCurrentFrameId, f.advance);

    vi.advanceTimersByTime(99);
    expect(f.advance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(f.currentId()).toBe('f2');
  });

  it('loops back to the first frame after the last', () => {
    const f = fixture([
      { id: 'f1', durationMs: 10 },
      { id: 'f2', durationMs: 10 },
      { id: 'f3', durationMs: 10 },
    ]);

    startPlayback(f.getFrames, f.getCurrentFrameId, f.advance);

    vi.advanceTimersByTime(10); // -> f2
    vi.advanceTimersByTime(10); // -> f3
    vi.advanceTimersByTime(10); // -> f1 (loops)
    expect(f.currentId()).toBe('f1');
    expect(f.advance).toHaveBeenCalledTimes(3);
  });

  it('stops advancing once stop() is called', () => {
    const f = fixture([
      { id: 'f1', durationMs: 10 },
      { id: 'f2', durationMs: 10 },
    ]);

    const handle = startPlayback(f.getFrames, f.getCurrentFrameId, f.advance);
    vi.advanceTimersByTime(10);
    expect(f.currentId()).toBe('f2');

    handle.stop();
    vi.advanceTimersByTime(1000);
    expect(f.currentId()).toBe('f2'); // no further advances
    expect(f.advance).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a timeline with no frames', () => {
    const advance = vi.fn();
    const handle = startPlayback(
      () => [],
      () => 'nope',
      advance,
    );
    vi.advanceTimersByTime(10_000);
    expect(advance).not.toHaveBeenCalled();
    handle.stop();
  });

  it('re-reads the frame list on every tick, so a mid-playback edit is honoured', () => {
    const frames: Frame[] = [
      { id: 'f1', durationMs: 10 },
      { id: 'f2', durationMs: 10 },
    ];
    let currentId = 'f1';
    const advance = vi.fn((id: string) => {
      currentId = id;
    });

    startPlayback(
      () => frames,
      () => currentId,
      advance,
    );

    // Insert a frame between f1 and f2 before the first tick fires.
    frames.splice(1, 0, { id: 'f1b', durationMs: 10 });

    vi.advanceTimersByTime(10);
    expect(currentId).toBe('f1b');
  });
});
