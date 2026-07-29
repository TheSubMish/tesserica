import { describe, expect, it } from 'vitest';
import type { Frame, Tag } from './types';
import {
  clampTagRange,
  nextTagColor,
  shiftTagRangeForInsert,
  shiftTagRangeForRemove,
  tagFrameSequence,
} from './tags';

function tag(over: Partial<Tag> = {}): Tag {
  return {
    id: 't1',
    name: 'walk',
    from: 1,
    to: 2,
    direction: 'forward',
    color: '#000',
    ...over,
  };
}

describe('nextTagColor', () => {
  it('cycles through the palette by creation order', () => {
    const first = nextTagColor(0);
    const second = nextTagColor(1);
    expect(first).not.toBe(second);
    // Wraps once every tag has consumed a distinct color.
    expect(nextTagColor(0)).toBe(first);
  });
});

describe('clampTagRange', () => {
  it('leaves an in-bounds, ordered range untouched', () => {
    expect(clampTagRange(1, 3, 5)).toEqual({ from: 1, to: 3 });
  });

  it('orders a reversed pair', () => {
    expect(clampTagRange(3, 1, 5)).toEqual({ from: 1, to: 3 });
  });

  it('clamps into [0, frameCount - 1]', () => {
    expect(clampTagRange(-2, 10, 4)).toEqual({ from: 0, to: 3 });
  });
});

describe('shiftTagRangeForInsert', () => {
  it('shifts the whole range right when the insertion is at or before it', () => {
    expect(shiftTagRangeForInsert(tag({ from: 1, to: 2 }), 0)).toMatchObject({ from: 2, to: 3 });
    expect(shiftTagRangeForInsert(tag({ from: 1, to: 2 }), 1)).toMatchObject({ from: 2, to: 3 });
  });

  it('extends the range by one when the insertion falls inside it', () => {
    expect(shiftTagRangeForInsert(tag({ from: 1, to: 3 }), 2)).toMatchObject({ from: 1, to: 4 });
  });

  it('extends the range when the insertion lands right after it', () => {
    expect(shiftTagRangeForInsert(tag({ from: 1, to: 2 }), 3)).toMatchObject({ from: 1, to: 3 });
  });

  it('leaves the range untouched when the insertion is strictly after it', () => {
    const t = tag({ from: 1, to: 2 });
    expect(shiftTagRangeForInsert(t, 4)).toBe(t); // same reference: no-op returns the input
  });
});

describe('shiftTagRangeForRemove', () => {
  it('is the exact inverse of shiftTagRangeForInsert at the same index', () => {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const original = tag({ from: 1, to: 3 });
      const inserted = shiftTagRangeForInsert(original, index);
      const restored = shiftTagRangeForRemove(inserted, index, 6);
      expect(restored).toMatchObject({ from: original.from, to: original.to });
    }
  });

  it('shrinks the range by one when the removed frame was inside it', () => {
    // frames [F0,F1,F2,F3], tag covers [1,2]; remove index 2 (F2).
    expect(shiftTagRangeForRemove(tag({ from: 1, to: 2 }), 2, 3)).toMatchObject({ from: 1, to: 1 });
  });

  it('shifts the range left when the removed frame was entirely before it', () => {
    expect(shiftTagRangeForRemove(tag({ from: 2, to: 3 }), 0, 3)).toMatchObject({ from: 1, to: 2 });
  });

  it('leaves the range untouched when the removed frame was entirely after it', () => {
    const t = tag({ from: 1, to: 2 });
    expect(shiftTagRangeForRemove(t, 4, 4)).toBe(t);
  });

  it('collapses a tag whose only frame was removed instead of going invalid', () => {
    const result = shiftTagRangeForRemove(tag({ from: 2, to: 2 }), 2, 3);
    expect(result.from).toBeLessThanOrEqual(result.to);
    expect(result.from).toBeGreaterThanOrEqual(0);
  });
});

describe('tagFrameSequence', () => {
  const frames: Frame[] = [
    { id: 'f0', durationMs: 100 },
    { id: 'f1', durationMs: 100 },
    { id: 'f2', durationMs: 100 },
    { id: 'f3', durationMs: 100 },
  ];

  it('plays the range forward in order', () => {
    const seq = tagFrameSequence(frames, tag({ from: 1, to: 3, direction: 'forward' }));
    expect(seq.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('plays the range reversed', () => {
    const seq = tagFrameSequence(frames, tag({ from: 1, to: 3, direction: 'reverse' }));
    expect(seq.map((f) => f.id)).toEqual(['f3', 'f2', 'f1']);
  });

  it('bounces the interior frames back for pingpong without repeating an endpoint', () => {
    const seq = tagFrameSequence(frames, tag({ from: 0, to: 3, direction: 'pingpong' }));
    expect(seq.map((f) => f.id)).toEqual(['f0', 'f1', 'f2', 'f3', 'f2', 'f1']);
  });

  it('pingpong on a 2-frame or shorter range is just the forward pass', () => {
    const seq = tagFrameSequence(frames, tag({ from: 1, to: 2, direction: 'pingpong' }));
    expect(seq.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('clamps an out-of-range tag into the frames that actually exist', () => {
    const seq = tagFrameSequence(frames, tag({ from: 2, to: 99, direction: 'forward' }));
    expect(seq.map((f) => f.id)).toEqual(['f2', 'f3']);
  });
});
