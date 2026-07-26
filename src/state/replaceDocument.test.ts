import { describe, expect, it } from 'vitest';
import { getBuffer, getPixel } from '../model/pixelBuffers';
import type { Sprite } from '../model/types';
import { useDocumentStore } from './documentStore';

const doc = () => useDocumentStore.getState();

/** A document shaped exactly as a `.tess` load hands it back. */
function loaded(): Sprite {
  return {
    width: 4,
    height: 4,
    layers: [
      {
        id: 'l1',
        kind: 'raster',
        name: 'bg',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
      },
      {
        id: 'l2',
        kind: 'raster',
        name: 'ink',
        visible: true,
        locked: false,
        opacity: 0.5,
        blendMode: 'normal',
      },
    ],
    frames: [{ id: 'f1', durationMs: 100 }],
    cels: [
      { id: 'c1', layerId: 'l1', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 },
      { id: 'c2', layerId: 'l2', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 },
    ],
  };
}

describe('replaceDocument', () => {
  it('installs the loaded sprite, its pixels and a sane selection', () => {
    const pixels = new Map<string, Uint8ClampedArray>();
    const c1 = new Uint8ClampedArray(4 * 4 * 4);
    c1.set([1, 2, 3, 255], 0);
    pixels.set('c1', c1);

    doc().replaceDocument(loaded(), pixels);

    const s = doc();
    expect(s.sprite.layers.map((l) => l.name)).toEqual(['bg', 'ink']);
    // Top layer is selected, which is where an artist expects to be.
    expect(s.activeLayerId).toBe('l2');
    expect(s.activeFrameId).toBe('f1');
    expect(getPixel(getBuffer('c1')!, 4, 4, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('allocates a blank buffer for a cel whose pixels are missing', () => {
    // Rust warns and omits the cel when its PNG is absent; the layer must still
    // open, empty, rather than the document failing.
    doc().replaceDocument(loaded(), new Map());
    expect(getBuffer('c2')).toBeDefined();
    expect(getBuffer('c2')!.every((v) => v === 0)).toBe(true);
  });

  it('rejects a buffer whose length does not match the cel', () => {
    const pixels = new Map<string, Uint8ClampedArray>([['c1', new Uint8ClampedArray(8)]]);
    doc().replaceDocument(loaded(), pixels);
    expect(getBuffer('c1')).toHaveLength(4 * 4 * 4);
  });

  it('does not keep the previous document’s buffers alive', () => {
    doc().addLayer('doomed');
    const stale = doc().celsForLayer(doc().activeLayerId)[0].id;
    expect(getBuffer(stale)).toBeDefined();

    doc().replaceDocument(loaded(), new Map());
    expect(getBuffer(stale)).toBeUndefined();
  });

  it('never mints an id that collides with one it just loaded', () => {
    // The loaded ids came from another run of the generator. Handing out `c2`
    // again would give two layers the same pixel buffer.
    doc().replaceDocument(loaded(), new Map());
    doc().addLayer('after');

    const ids = [...doc().sprite.layers.map((l) => l.id), ...doc().sprite.cels.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tracks the project path so Save can write back without asking', () => {
    doc().setProjectPath('/tmp/x.tess');
    expect(doc().projectPath).toBe('/tmp/x.tess');
    doc().setProjectPath(null);
    expect(doc().projectPath).toBeNull();
  });
});
