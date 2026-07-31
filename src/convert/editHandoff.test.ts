import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllBuffers, getBuffer } from '../model/pixelBuffers';
import { bufferFrom, createBuffer } from '../pipeline/buffer.ts';
import { defaultSettings, type PaletteSpec, type Rgba } from '../pipeline/settings.ts';
import { useDocumentStore } from '../state/documentStore';
import { conversionDocument, reconvertLayer } from './editHandoff.ts';

/**
 * `[ Edit → ]` is the product thesis, so what these tests protect is the thing
 * that makes it a thesis rather than a button: **nothing is lost in the
 * handoff.** The layer keeps the source handle and the settings, and changing
 * those settings later re-renders from the original image rather than from the
 * pixels already on the layer.
 */

const BW: PaletteSpec = {
  kind: 'fixed',
  colors: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ],
};

function solid(width: number, height: number, color: Rgba) {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) buf.data.set(color, i);
  return buf;
}

describe('conversionDocument', () => {
  it('keeps the source handle and the settings on the layer', () => {
    const image = solid(8, 6, [255, 255, 255, 255]);
    const settings = defaultSettings(8, 6, BW);
    const { sprite, layerId } = conversionDocument(image, 42, settings, 'photo.jpg');

    const layer = sprite.layers.find((l) => l.id === layerId);
    expect(layer?.kind).toBe('conversion');
    if (layer?.kind !== 'conversion') throw new Error('unreachable');
    expect(layer.source.sourceId).toBe(42);
    expect(layer.source.settings).toEqual(settings);
    expect(layer.name).toBe('photo.jpg');
  });

  it('sizes the sprite and its cel to the conversion output', () => {
    const { sprite } = conversionDocument(
      solid(11, 7, [1, 2, 3, 255]),
      1,
      defaultSettings(11, 7, BW),
      'x',
    );
    expect([sprite.width, sprite.height]).toEqual([11, 7]);
    expect(sprite.cels).toHaveLength(1);
    expect([sprite.cels[0].width, sprite.cels[0].height]).toEqual([11, 7]);
  });

  it('copies the pixels rather than aliasing the conversion result', () => {
    const image = solid(4, 4, [10, 20, 30, 255]);
    const { pixels, sprite } = conversionDocument(image, 1, defaultSettings(4, 4, BW), 'x');
    const copy = pixels.get(sprite.cels[0].id);
    expect(copy?.[0]).toBe(10);

    image.data[0] = 99;
    expect(copy?.[0]).toBe(10);
  });
});

describe('reconvertLayer — live re-editing', () => {
  beforeEach(() => {
    clearAllBuffers();
  });

  /** Put a conversion layer into the document, as `[ Edit → ]` would. */
  function seed(sourcePixel: Rgba = [90, 90, 90, 255]) {
    const proxy = solid(8, 8, sourcePixel);
    const image = solid(4, 4, [0, 0, 0, 255]);
    const { sprite, pixels, layerId } = conversionDocument(
      image,
      7,
      defaultSettings(4, 4, BW),
      'photo',
    );
    useDocumentStore.getState().replaceDocument(sprite, pixels);
    return { layerId, proxy, celId: sprite.cels[0].id };
  }

  it('re-renders from the source, not from the pixels already on the layer', () => {
    const { layerId, proxy, celId } = seed();

    // sRGB 90 quantizes to black in this palette.
    reconvertLayer(layerId, {}, proxy);
    expect(getBuffer(celId)?.[0]).toBe(0);

    // Brightening is applied to the *source* before quantization, so the layer
    // flips to white. If it re-rendered from its own black pixels it could not.
    reconvertLayer(layerId, { brightness: 0.9 }, proxy);
    expect(getBuffer(celId)?.[0]).toBe(255);
  });

  it('remembers the new settings for next time', () => {
    const { layerId, proxy } = seed();
    reconvertLayer(layerId, { dither: 'atkinson', brightness: 0.3 }, proxy);

    const layer = useDocumentStore.getState().sprite.layers.find((l) => l.id === layerId);
    if (layer?.kind !== 'conversion') throw new Error('expected a conversion layer');
    expect(layer.source.settings.dither).toBe('atkinson');
    expect(layer.source.settings.brightness).toBe(0.3);
    expect(layer.source.sourceId).toBe(7);
  });

  it('keeps the document size, ignoring the settings’ target size', () => {
    const { layerId, proxy } = seed();
    reconvertLayer(layerId, { targetWidth: 999, targetHeight: 999 }, proxy);

    const doc = useDocumentStore.getState();
    expect([doc.sprite.width, doc.sprite.height]).toEqual([4, 4]);
    const layer = doc.sprite.layers.find((l) => l.id === layerId);
    if (layer?.kind !== 'conversion') throw new Error('expected a conversion layer');
    expect(layer.source.settings.targetWidth).toBe(4);
  });

  it('refuses on a layer that is not a conversion', () => {
    const proxy = solid(4, 4, [1, 2, 3, 255]);
    useDocumentStore.getState().replaceDocument(
      {
        width: 2,
        height: 2,
        layers: [
          {
            id: 'raster1',
            kind: 'raster',
            name: 'plain',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            parentId: null,
            clippingMask: false,
            effects: [],
          },
        ],
        frames: [{ id: 'f1', durationMs: 100 }],
        cels: [{ id: 'c1', layerId: 'raster1', frameId: 'f1', x: 0, y: 0, width: 2, height: 2 }],
        tags: [],
        tilesets: [],
      },
      new Map([['c1', new Uint8ClampedArray(16)]]),
    );

    expect(() => reconvertLayer('raster1', {}, proxy)).toThrow(/not a conversion layer/);
  });

  it('survives a proxy of a different size to the document', () => {
    // The proxy is the *source* at preview resolution; it has no reason to match
    // the document, and the conversion is what bridges them.
    const { layerId, celId } = seed();
    const oddProxy = bufferFrom(
      13,
      7,
      Uint8ClampedArray.from({ length: 13 * 7 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 200)),
    );
    reconvertLayer(layerId, {}, oddProxy);
    expect(getBuffer(celId)?.length).toBe(4 * 4 * 4);
  });
});
