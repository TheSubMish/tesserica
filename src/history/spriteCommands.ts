/**
 * Whole-document operations (`docs/03-data-model.md` §6.1): canvas size, crop,
 * flip, rotate, flip layer.
 *
 * These rewrite every pixel of every cel they touch, so — unlike a stroke — the
 * undo record is a before/after pair of whole buffers, not a dirty-rect delta.
 * The command reports its real retained bytes so the history budget can evict.
 */

import { setBuffer } from '../model/pixelBuffers';
import { setIndexBuffer } from '../model/indexBuffers';
import { bytesPerPixelFor, getCelBuffer } from '../model/celStorage';
import {
  anchorOffset,
  opSize,
  resizeBuffer,
  transformBuffer,
  type Anchor,
  type CelPixels,
  type PixelOp,
} from '../model/spriteTransform';
import type { CelId, Layer, Sprite } from '../model/types';
import { MAX_SPRITE_SIZE, MIN_SPRITE_SIZE } from '../app/newSprite';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { useUIStore } from '../state/uiStore';
import type { Command, DocumentApi } from './command';

interface BufferEntry {
  readonly id: CelId;
  readonly bpp: 1 | 4;
  readonly before: CelPixels;
  readonly after: CelPixels;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Installs *copies* of the stored buffers: tools mutate the live buffer in place,
 * so handing out the stored array itself would let a later stroke corrupt the
 * snapshot a redo is about to restore.
 */
function install(entries: readonly BufferEntry[], which: 'before' | 'after'): void {
  for (const e of entries) {
    const copy = e[which].slice();
    if (e.bpp === 1) setIndexBuffer(e.id, copy as Uint8Array);
    else setBuffer(e.id, copy as Uint8ClampedArray);
  }
}

export class SpriteTransformCommand implements Command {
  readonly memoryCost: number;

  constructor(
    readonly label: string,
    private readonly entries: readonly BufferEntry[],
    private readonly before: Size,
    private readonly after: Size,
  ) {
    this.memoryCost = entries.reduce((n, e) => n + e.before.byteLength + e.after.byteLength, 0);
  }

  apply(doc: DocumentApi): void {
    install(this.entries, 'after');
    if (this.after.width !== this.before.width || this.after.height !== this.before.height) {
      doc.resizeSprite(this.after.width, this.after.height);
    }
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    install(this.entries, 'before');
    if (this.after.width !== this.before.width || this.after.height !== this.before.height) {
      doc.resizeSprite(this.before.width, this.before.height);
    }
    doc.touch();
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type SpriteOpFailure =
  | 'tilemap-layers'
  | 'conversion-layers'
  | 'not-raster'
  | 'no-selection'
  | 'invalid-size'
  | 'no-change'
  | 'indexed'
  | 'no-layer-below'
  | 'clipping'
  | 'linked-cels'
  | 'single-layer';

export type SpriteOpResult = { ok: true } | { ok: false; reason: SpriteOpFailure; message: string };

const FAIL_MESSAGE: Record<SpriteOpFailure, string> = {
  'tilemap-layers':
    'This sprite has a tilemap layer, and a tile grid cannot be resampled. Delete or hide-and-export it first.',
  'conversion-layers':
    'This sprite has a conversion layer, which re-renders from its source image. Convert it to a normal layer first.',
  'not-raster': 'Select a normal (raster) layer first.',
  'no-selection': 'Make a selection first.',
  'invalid-size': `Size must be a whole number from ${MIN_SPRITE_SIZE} to ${MAX_SPRITE_SIZE}.`,
  'no-change': 'Nothing to change.',
  indexed:
    'This works on colours, which an indexed sprite does not blend. Convert the sprite back to RGBA first.',
  'no-layer-below':
    'There is no normal layer directly below this one (in the same group) to merge into.',
  clipping: 'Clipping-mask layers cannot be merged. Turn the mask off first.',
  'linked-cels':
    'The layer below has linked cels, which share pixels across frames. Unlink them first.',
  'single-layer': 'There is only one layer.',
};

export const fail = (reason: SpriteOpFailure): SpriteOpResult => ({
  ok: false,
  reason,
  message: FAIL_MESSAGE[reason],
});

/** Why a sprite-wide pixel operation cannot be applied, if it cannot. */
export function spriteBlocker(sprite: Sprite): SpriteOpFailure | null {
  if (sprite.layers.some((l) => l.kind === 'tilemap')) return 'tilemap-layers';
  if (sprite.layers.some((l) => l.kind === 'conversion')) return 'conversion-layers';
  return null;
}

// ---------------------------------------------------------------------------
// Buffer collection
// ---------------------------------------------------------------------------

function ownBuffer(sprite: Sprite, layer: Layer, celId: CelId): CelPixels | undefined {
  return getCelBuffer(sprite, layer, celId);
}

/** Every unlinked cel's own buffer — a linked cel shares its target's, which is transformed once. */
function buffersOf(sprite: Sprite, layerIds?: ReadonlySet<string>) {
  const out: { id: CelId; bpp: 1 | 4; pixels: CelPixels }[] = [];
  for (const cel of sprite.cels) {
    if (cel.linkedTo) continue;
    if (layerIds && !layerIds.has(cel.layerId)) continue;
    const layer = sprite.layers.find((l) => l.id === cel.layerId);
    if (!layer) continue;
    const pixels = ownBuffer(sprite, layer, cel.id);
    if (!pixels) continue;
    out.push({ id: cel.id, bpp: bytesPerPixelFor(sprite, layer), pixels });
  }
  return out;
}

function finish(label: string, entries: BufferEntry[], before: Size, after: Size): SpriteOpResult {
  useHistoryStore.getState().run(new SpriteTransformCommand(label, entries, before, after));
  useSelectionStore.getState().setSelection(null);
  if (before.width !== after.width || before.height !== after.height) {
    useUIStore.getState().requestFit();
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Actions — what the UI calls.
// ---------------------------------------------------------------------------

/**
 * Resize the canvas. `offset` is where the old image's top-left lands in the new
 * canvas; negative values crop. Shared by Canvas Size and Crop to Selection.
 */
function resizeTo(
  label: string,
  newW: number,
  newH: number,
  offX: number,
  offY: number,
): SpriteOpResult {
  const sprite = useDocumentStore.getState().sprite;
  const valid = (n: number) => Number.isInteger(n) && n >= MIN_SPRITE_SIZE && n <= MAX_SPRITE_SIZE;
  if (!valid(newW) || !valid(newH)) return fail('invalid-size');
  if (newW === sprite.width && newH === sprite.height && offX === 0 && offY === 0) {
    return fail('no-change');
  }
  const blocker = spriteBlocker(sprite);
  if (blocker) return fail(blocker);

  const entries = buffersOf(sprite).map((b) => ({
    id: b.id,
    bpp: b.bpp,
    before: b.pixels.slice(),
    after: resizeBuffer(b.pixels, sprite.width, sprite.height, b.bpp, newW, newH, offX, offY),
  }));
  return finish(label, entries, sprite, { width: newW, height: newH });
}

export function resizeCanvas(width: number, height: number, anchor: Anchor): SpriteOpResult {
  const { sprite } = useDocumentStore.getState();
  const off = anchorOffset(anchor, sprite.width, sprite.height, width, height);
  return resizeTo('Canvas Size', width, height, off.x, off.y);
}

export function cropToSelection(): SpriteOpResult {
  const { sprite } = useDocumentStore.getState();
  const sel = useSelectionStore.getState().selection;
  if (!sel) return fail('no-selection');
  const x0 = Math.max(0, sel.bounds.x);
  const y0 = Math.max(0, sel.bounds.y);
  const x1 = Math.min(sprite.width, sel.bounds.x + sel.bounds.width);
  const y1 = Math.min(sprite.height, sel.bounds.y + sel.bounds.height);
  if (x1 <= x0 || y1 <= y0) return fail('no-selection');
  return resizeTo('Crop to Selection', x1 - x0, y1 - y0, -x0, -y0);
}

const OP_LABEL: Record<PixelOp, string> = {
  'flip-h': 'Flip Horizontal',
  'flip-v': 'Flip Vertical',
  'rot-cw': 'Rotate 90° Clockwise',
  'rot-ccw': 'Rotate 90° Counter-clockwise',
  'rot-180': 'Rotate 180°',
};

/** Flip or rotate the whole sprite. */
export function transformSprite(op: PixelOp): SpriteOpResult {
  const { sprite } = useDocumentStore.getState();
  const blocker = spriteBlocker(sprite);
  if (blocker) return fail(blocker);

  const entries = buffersOf(sprite).map((b) => ({
    id: b.id,
    bpp: b.bpp,
    before: b.pixels.slice(),
    after: transformBuffer(b.pixels, sprite.width, sprite.height, b.bpp, op),
  }));
  const after = opSize(op, sprite.width, sprite.height);
  return finish(`${OP_LABEL[op]} (Sprite)`, entries, sprite, after);
}

/** Flip the active raster layer only (all its frames). */
export function flipActiveLayer(axis: 'h' | 'v'): SpriteOpResult {
  const { sprite, activeLayerId } = useDocumentStore.getState();
  const layer = sprite.layers.find((l) => l.id === activeLayerId);
  if (!layer || layer.kind !== 'raster') return fail('not-raster');

  const op: PixelOp = axis === 'h' ? 'flip-h' : 'flip-v';
  const entries = buffersOf(sprite, new Set([layer.id])).map((b) => ({
    id: b.id,
    bpp: b.bpp,
    before: b.pixels.slice(),
    after: transformBuffer(b.pixels, sprite.width, sprite.height, b.bpp, op),
  }));
  return finish(`${OP_LABEL[op]} (Layer)`, entries, sprite, sprite);
}
