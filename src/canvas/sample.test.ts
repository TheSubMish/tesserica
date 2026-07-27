import { describe, expect, it } from 'vitest';
import { allocateBuffer, setPixel } from '../model/pixelBuffers';
import type { Cel, Frame, Layer, LayerBase, Sprite } from '../model/types';
import { compositeOver, samplePixel } from './sample';
import { picker } from '../tools/picker';
import { harness } from '../tools/testHarness';

function layer(id: string, over: Partial<LayerBase> = {}): Layer {
  return {
    id,
    kind: 'raster',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    ...over,
  };
}

function sprite(layers: Layer[], size = 4): { sprite: Sprite; frameId: string } {
  const frame: Frame = { id: 'f1', durationMs: 100 };
  const cels: Cel[] = layers.map((l) => ({
    id: `cel-${l.id}`,
    layerId: l.id,
    frameId: frame.id,
    x: 0,
    y: 0,
    width: size,
    height: size,
  }));
  cels.forEach((c) => allocateBuffer(c.id, size, size));
  return {
    sprite: { width: size, height: size, layers, frames: [frame], cels },
    frameId: frame.id,
  };
}

describe('compositeOver', () => {
  it('leaves an opaque source untouched', () => {
    expect(compositeOver([10, 20, 30, 255], 1, [200, 200, 200, 255])).toEqual([10, 20, 30, 255]);
  });

  it('shows the destination through a transparent source', () => {
    expect(compositeOver([10, 20, 30, 0], 1, [200, 200, 200, 255])).toEqual([200, 200, 200, 255]);
  });

  it('does not darken edges the way premultiplied maths would', () => {
    // A half-transparent white over transparent black stays white with half
    // alpha. Premultiplying would give a grey, which is the classic fringing
    // bug (docs/02-architecture.md §9).
    expect(compositeOver([255, 255, 255, 128], 1, [0, 0, 0, 0])).toEqual([255, 255, 255, 128]);
  });

  it('scales the source by layer opacity', () => {
    expect(compositeOver([0, 0, 0, 255], 0.5, [255, 255, 255, 255])).toEqual([128, 128, 128, 255]);
  });
});

describe('samplePixel', () => {
  it('returns the flattened colour, not the active layer', () => {
    const bottom = layer('a');
    const top = layer('b');
    const { sprite: s, frameId } = sprite([bottom, top]);
    setPixel(allocateBuffer('cel-a', 4, 4), 4, 4, 1, 1, [10, 200, 10, 255]);
    // Top layer is transparent there, so the green below must come through.
    expect(samplePixel(s, frameId, 1, 1)).toEqual([10, 200, 10, 255]);
  });

  it('skips hidden layers', () => {
    const bottom = layer('a');
    const top = layer('b', { visible: false });
    const { sprite: s, frameId } = sprite([bottom, top]);
    setPixel(allocateBuffer('cel-a', 4, 4), 4, 4, 0, 0, [1, 2, 3, 255]);
    setPixel(allocateBuffer('cel-b', 4, 4), 4, 4, 0, 0, [9, 9, 9, 255]);
    expect(samplePixel(s, frameId, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('returns null outside the sprite', () => {
    const { sprite: s, frameId } = sprite([layer('a')]);
    expect(samplePixel(s, frameId, -1, 0)).toBeNull();
    expect(samplePixel(s, frameId, 4, 0)).toBeNull();
  });
});

describe('eyedropper', () => {
  it('assigns to primary on the left button and secondary on the right', () => {
    const c = harness();
    c.sampleSource = () => [7, 8, 9, 255];

    picker.onPointerDown(c, 1, 1);
    expect(c.picked[c.picked.length - 1]).toEqual({ color: [7, 8, 9, 255], slot: 'primary' });

    c.button = 2;
    picker.onPointerDown(c, 1, 1);
    expect(c.picked[c.picked.length - 1]).toEqual({ color: [7, 8, 9, 255], slot: 'secondary' });
  });

  it('is read-only, so it makes no undo step', () => {
    expect(picker.readOnly).toBe(true);
  });

  it('ignores a sample outside the sprite', () => {
    const c = harness();
    c.sampleSource = () => null;
    picker.onPointerDown(c, 99, 99);
    expect(c.picked).toHaveLength(0);
  });
});
