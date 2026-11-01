/**
 * Merge Down and Flatten (`docs/03-data-model.md` §6.1).
 *
 * Both are compositions of commands that already exist — pixel deltas, layer
 * add and layer delete — wrapped in one `BatchCommand`, so each is a single undo
 * step and needs no new command type.
 */

import { applyEffects } from '../canvas/effects';
import { flattenSprite, leafLayerContent, mergeNormal } from '../canvas/flatten';
import { allocateBuffer, getBuffer } from '../model/pixelBuffers';
import { celBufferId, type Layer, type Sprite } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command } from './command';
import { PixelDeltaCommand } from './commands';
import { AddLayerCommand, BatchCommand, DeleteLayersCommand } from './layerCommands';
import { makePixelDelta } from './pixelDelta';
import { fail, type SpriteOpResult } from './spriteCommands';

/** The layer immediately below `layer` among its siblings (same parent), if any. */
export function layerBelow(sprite: Sprite, layer: Layer): Layer | undefined {
  const siblings = sprite.layers.filter((l) => l.parentId === layer.parentId);
  const i = siblings.findIndex((l) => l.id === layer.id);
  return i > 0 ? siblings[i - 1] : undefined;
}

export function mergeDown(): SpriteOpResult {
  const doc = useDocumentStore.getState();
  const { sprite } = doc;
  const upper = sprite.layers.find((l) => l.id === doc.activeLayerId);
  if (!upper) return fail('not-raster');
  if (sprite.colorMode === 'indexed') return fail('indexed');
  if (upper.kind !== 'raster' && upper.kind !== 'conversion') return fail('not-raster');

  const lower = layerBelow(sprite, upper);
  if (!lower || lower.kind !== 'raster') return fail('no-layer-below');
  if (upper.clippingMask || lower.clippingMask) return fail('clipping');
  const lowerCels = doc.celsForLayer(lower.id);
  if (lowerCels.some((c) => c.linkedTo)) return fail('linked-cels');

  const { width, height } = sprite;
  const commands: Command[] = [];

  for (const frame of sprite.frames) {
    const lowerCel = lowerCels.find((c) => c.frameId === frame.id);
    const upperCel = sprite.cels.find((c) => c.layerId === upper.id && c.frameId === frame.id);
    if (!lowerCel || !upperCel || !upper.visible || upper.opacity === 0) continue;

    const lowerBuf = getBuffer(celBufferId(lowerCel));
    if (!lowerBuf) continue;
    const content = leafLayerContent(sprite, upper, upperCel, width, height);
    if (!content) continue;

    // Same recipe the exporter uses for this layer: its enabled effects are baked
    // in, then its opacity and blend mode are applied against what is below.
    const own = applyEffects(content, width, height, upper.effects);
    const merged = lowerBuf.slice();
    mergeNormal(merged, own, upper.opacity, upper.blendMode);

    const delta = makePixelDelta(lowerCel.id, lowerBuf, merged, width, height, 4);
    if (delta) commands.push(new PixelDeltaCommand('Merge Down', delta, width));
  }

  commands.push(
    new DeleteLayersCommand(
      [{ layer: upper, cels: doc.celsForLayer(upper.id), index: doc.layerIndex(upper.id) }],
      upper.id,
      'Merge Down',
    ),
  );
  useHistoryStore.getState().run(new BatchCommand('Merge Down', commands));
  useDocumentStore.getState().setActiveLayer(lower.id);
  return { ok: true };
}

export function flattenLayers(): SpriteOpResult {
  const doc = useDocumentStore.getState();
  const { sprite } = doc;
  if (sprite.colorMode === 'indexed') return fail('indexed');
  if (sprite.layers.length < 2) return fail('single-layer');

  // Composite first, while the old layers still exist.
  const composites = sprite.frames.map((f) => flattenSprite(sprite, f.id));

  const { layer, cels } = doc.createLayer('Flattened');
  sprite.frames.forEach((frame, i) => {
    const cel = cels.find((c) => c.frameId === frame.id);
    // `insertLayer` only allocates a buffer when none exists, so allocating (and
    // filling) it here is what carries the composite into the new layer.
    if (cel) allocateBuffer(cel.id, sprite.width, sprite.height).set(composites[i]);
  });

  const old = sprite.layers.map((l) => ({
    layer: l,
    cels: doc.celsForLayer(l.id),
    index: doc.layerIndex(l.id),
  }));

  useHistoryStore
    .getState()
    .run(
      new BatchCommand('Flatten Layers', [
        new AddLayerCommand(layer, cels, sprite.layers.length),
        new DeleteLayersCommand(old, old[0].layer.id, 'Flatten Layers'),
      ]),
    );
  useDocumentStore.getState().setActiveLayer(layer.id);
  return { ok: true };
}
