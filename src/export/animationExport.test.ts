import { beforeEach, describe, expect, it } from 'vitest';
import { allocateBuffer, clearAllBuffers, setPixel } from '../model/pixelBuffers';
import type { Cel, Frame, Layer, Sprite, Tag } from '../model/types';
import {
  concatFlattenedFrames,
  DEFAULT_SPRITESHEET_COLUMNS,
  gifFrameSequence,
  spritesheetSelection,
} from './animationExport';

const W = 2;
const H = 2;

function layer(id: string): Layer {
  return {
    id,
    kind: 'raster',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId: null,
    clippingMask: false,
    effects: [],
  };
}

/** A sprite with `frameCount` frames, one raster layer, one solid color per frame. */
function makeSprite(frameCount: number, tags: Tag[] = []): Sprite {
  const frames: Frame[] = Array.from({ length: frameCount }, (_, i) => ({
    id: `f${i}`,
    durationMs: 100 + i * 10,
  }));
  const cels: Cel[] = frames.map((f, i) => ({
    id: `cel-${i}`,
    layerId: 'a',
    frameId: f.id,
    x: 0,
    y: 0,
    width: W,
    height: H,
  }));
  for (const [i, c] of cels.entries()) {
    const buf = allocateBuffer(c.id, W, H);
    // Each frame gets a distinct, recognizable color at (0,0): 10, 20, 30...
    setPixel(buf, W, H, 0, 0, [(i + 1) * 10, 0, 0, 255]);
  }
  return { width: W, height: H, layers: [layer('a')], frames, cels, tags, tilesets: [] };
}

const px = (buf: Uint8ClampedArray, frameIndex: number, x = 0, y = 0) => {
  const perFrame = W * H * 4;
  const o = frameIndex * perFrame + (y * W + x) * 4;
  return Array.from(buf.subarray(o, o + 4));
};

beforeEach(() => clearAllBuffers());

describe('spritesheetSelection', () => {
  it('returns every frame and every tag, unscoped, when no tag is given', () => {
    const tag: Tag = {
      id: 't1',
      name: 'walk',
      from: 1,
      to: 2,
      direction: 'forward',
      color: '#fff',
    };
    const sprite = makeSprite(4, [tag]);
    const selection = spritesheetSelection(sprite, null);
    expect(selection.frames.map((f) => f.id)).toEqual(['f0', 'f1', 'f2', 'f3']);
    expect(selection.tags).toEqual([{ name: 'walk', from: 1, to: 2, direction: 'forward' }]);
  });

  it('scopes to a tag’s forward index range, re-based to the subset', () => {
    const tag: Tag = {
      id: 't1',
      name: 'walk',
      from: 1,
      to: 3,
      direction: 'forward',
      color: '#fff',
    };
    const sprite = makeSprite(5, [tag]);
    const selection = spritesheetSelection(sprite, 't1');
    expect(selection.frames.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    // Re-based: the tag now spans the whole 3-frame subset, not [1,3].
    expect(selection.tags).toEqual([{ name: 'walk', from: 0, to: 2, direction: 'forward' }]);
  });

  it('does not duplicate frames for a reverse or ping-pong tag', () => {
    // Unlike GIF playback, a spritesheet is a set of unique images — the
    // engine reads direction from frameTags at runtime, not from a
    // pre-expanded frame list.
    const tag: Tag = {
      id: 't1',
      name: 'bounce',
      from: 0,
      to: 2,
      direction: 'pingpong',
      color: '#fff',
    };
    const sprite = makeSprite(3, [tag]);
    const selection = spritesheetSelection(sprite, 't1');
    expect(selection.frames.map((f) => f.id)).toEqual(['f0', 'f1', 'f2']);
  });

  it('falls back to the whole sprite for an unknown tag id', () => {
    const sprite = makeSprite(2);
    const selection = spritesheetSelection(sprite, 'nope');
    expect(selection.frames.map((f) => f.id)).toEqual(['f0', 'f1']);
    expect(selection.tags).toEqual([]);
  });
});

describe('gifFrameSequence', () => {
  it('returns every frame in order when no tag is given', () => {
    const sprite = makeSprite(3);
    expect(gifFrameSequence(sprite, null).map((f) => f.id)).toEqual(['f0', 'f1', 'f2']);
  });

  it('expands a ping-pong tag into its actual playback order', () => {
    const tag: Tag = {
      id: 't1',
      name: 'bounce',
      from: 0,
      to: 2,
      direction: 'pingpong',
      color: '#fff',
    };
    const sprite = makeSprite(3, [tag]);
    // Forward pass then the interior frame in reverse — matches
    // model/tags.ts::tagFrameSequence exactly, since this is a direct call to it.
    expect(gifFrameSequence(sprite, 't1').map((f) => f.id)).toEqual(['f0', 'f1', 'f2', 'f1']);
  });

  it('reverses a reverse tag', () => {
    const tag: Tag = {
      id: 't1',
      name: 'back',
      from: 0,
      to: 2,
      direction: 'reverse',
      color: '#fff',
    };
    const sprite = makeSprite(3, [tag]);
    expect(gifFrameSequence(sprite, 't1').map((f) => f.id)).toEqual(['f2', 'f1', 'f0']);
  });
});

describe('concatFlattenedFrames', () => {
  it('lays out each frame’s flattened pixels back to back, in the given order', () => {
    const sprite = makeSprite(3);
    const buf = concatFlattenedFrames(sprite, sprite.frames);
    expect(buf).toHaveLength(3 * W * H * 4);
    expect(px(buf, 0)).toEqual([10, 0, 0, 255]);
    expect(px(buf, 1)).toEqual([20, 0, 0, 255]);
    expect(px(buf, 2)).toEqual([30, 0, 0, 255]);
  });

  it('honours a caller-supplied order, including repeats', () => {
    const sprite = makeSprite(3);
    const [f0, f1, f2] = sprite.frames;
    const buf = concatFlattenedFrames(sprite, [f2, f0, f0]);
    expect(px(buf, 0)).toEqual([30, 0, 0, 255]);
    expect(px(buf, 1)).toEqual([10, 0, 0, 255]);
    expect(px(buf, 2)).toEqual([10, 0, 0, 255]);
    expect(f1).toBeDefined(); // silence unused-var lint without renaming the destructure
  });

  it('produces an empty buffer for an empty frame list', () => {
    const sprite = makeSprite(2);
    expect(concatFlattenedFrames(sprite, [])).toHaveLength(0);
  });
});

describe('DEFAULT_SPRITESHEET_COLUMNS', () => {
  it('matches the workflow doc’s own 4-column walk-cycle example', () => {
    expect(DEFAULT_SPRITESHEET_COLUMNS).toBe(4);
  });
});
