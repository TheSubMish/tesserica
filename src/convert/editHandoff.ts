/**
 * `[ Edit → ]` — the product thesis in one function (D6, `docs/05` §3).
 *
 * The seam between the two halves of the app is the whole point of Tesserica:
 * a conversion produces a **live, re-editable layer inside a real editor**,
 * not a PNG the user has to re-import. So this does not rasterize and forget.
 * It creates a `conversion` layer that keeps the `SourceId` Rust still holds
 * *and* the settings that produced the pixels, so the palette can be changed
 * weeks later and the layer re-renders (`docs/03-data-model.md` §2.1).
 *
 * Nothing is lost in the handoff, which is the property worth protecting when
 * anything here is changed.
 */

import { convert } from '../pipeline/convert.ts';
import { bufferFrom, type PixelBuffer } from '../pipeline/buffer.ts';
import type { ConvertSettings } from '../pipeline/settings.ts';
import { allocateBuffer, getBuffer } from '../model/pixelBuffers';
import { celBufferId, type Cel, type Frame, type Layer, type Sprite } from '../model/types';
import { makeId, useDocumentStore } from '../state/documentStore';
import { buildSettings, useConvertStore } from '../state/convertStore';
import { useUIStore } from '../state/uiStore';
import { previewRuntime } from './previewRuntime.ts';

export interface HandoffResult {
  readonly layerId: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Build a one-layer document from a conversion result.
 *
 * Exported separately from {@link handoffToEdit} so the document shape can be
 * tested without a store, a worker or a backend.
 */
export function conversionDocument(
  image: PixelBuffer,
  sourceId: number,
  settings: ConvertSettings,
  name: string,
): { sprite: Sprite; pixels: Map<string, Uint8ClampedArray>; layerId: string } {
  const layerId = makeId('layer');
  const frameId = makeId('frame');
  const celId = makeId('cel');

  const layer: Layer = {
    id: layerId,
    kind: 'conversion',
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId: null,
    clippingMask: false,
    source: { sourceId, settings },
  };

  const frame: Frame = { id: frameId, durationMs: 100 };
  const cel: Cel = {
    id: celId,
    layerId,
    frameId,
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  };

  const sprite: Sprite = {
    width: image.width,
    height: image.height,
    layers: [layer],
    frames: [frame],
    cels: [cel],
  };

  return {
    sprite,
    pixels: new Map([[celId, Uint8ClampedArray.from(image.data)]]),
    layerId,
  };
}

/**
 * Convert the current preview settings into a document and switch to Edit.
 *
 * The conversion is re-run here rather than reusing the preview's pixels: the
 * preview result is the thing the user approved, but it is also the thing that
 * may have been superseded by an in-flight job. Re-running from the same proxy
 * and the same settings is cheap and removes the race entirely.
 */
export function handoffToEdit(): HandoffResult {
  const convertState = useConvertStore.getState();
  const source = convertState.source;
  if (!source) throw new Error('there is no image to edit');

  const proxy = previewRuntime.current.source;
  if (!proxy) throw new Error('the preview has no image loaded');

  const settings = buildSettings(convertState);
  const result = convert(
    bufferFrom(proxy.width, proxy.height, new Uint8ClampedArray(proxy.data)),
    settings,
  );

  const name = source.path.split('/').pop() ?? 'Conversion';
  const { sprite, pixels, layerId } = conversionDocument(
    result.image,
    source.sourceId,
    settings,
    name,
  );

  useDocumentStore.getState().replaceDocument(sprite, pixels);
  useDocumentStore.getState().setActiveLayer(layerId);
  useUIStore.getState().setMode('edit');

  return { layerId, width: result.image.width, height: result.image.height };
}

/**
 * Re-render a conversion layer in place from new settings — the "live" in live
 * re-editing.
 *
 * The layer's own `settings` are updated too, so the next re-render starts from
 * what the user last chose rather than from what the conversion originally used.
 *
 * Re-rendering at the *document's* size rather than the settings' target size:
 * a conversion layer sits in a sprite with fixed dimensions, and silently
 * resizing the document under the user's other layers would be a worse surprise
 * than clamping the output.
 */
export function reconvertLayer(
  layerId: string,
  patch: Partial<ConvertSettings>,
  proxy: PixelBuffer,
): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === layerId);
  if (!layer || layer.kind !== 'conversion') {
    throw new Error(`layer ${layerId} is not a conversion layer`);
  }

  const settings: ConvertSettings = {
    ...layer.source.settings,
    ...patch,
    targetWidth: doc.sprite.width,
    targetHeight: doc.sprite.height,
  };

  const result = convert(proxy, settings);

  const cel = doc.sprite.cels.find((c) => c.layerId === layerId);
  if (!cel) throw new Error(`conversion layer ${layerId} has no cel`);

  const bufferId = celBufferId(cel);
  const buffer = getBuffer(bufferId) ?? allocateBuffer(bufferId, cel.width, cel.height);
  buffer.set(result.image.data);

  doc.updateLayerSource(layerId, { sourceId: layer.source.sourceId, settings });
}
