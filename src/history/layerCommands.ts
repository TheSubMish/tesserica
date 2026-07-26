/**
 * Undoable layer operations.
 *
 * Layer structure changes are cheap to record *except* deletion, which has to
 * retain the layer's pixels for as long as the step lives — there is nothing
 * to diff against. That is the one place in the history where a full copy is
 * unavoidable, and it is charged honestly to `memoryCost` so the budget in
 * `historyStore` evicts it like anything else.
 *
 * Property edits (`opacity`, `name`, …) carry a coalesce key so that dragging
 * the opacity slider is one undo step rather than sixty
 * (`docs/03-data-model.md` §6).
 */

import { getBuffer, releaseBuffer, setBuffer } from '../model/pixelBuffers';
import type { Cel, CelId, Layer, LayerId } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

/** Add and delete are the same operation run in opposite directions. */
class LayerExistence {
  /** Pixels held while the layer is absent from the document. */
  private saved: Map<CelId, Uint8ClampedArray> | null = null;

  constructor(
    readonly layer: Layer,
    readonly cels: Cel[],
    readonly index: number,
  ) {}

  get retainedBytes(): number {
    let n = 0;
    if (this.saved) for (const buf of this.saved.values()) n += buf.byteLength;
    return n;
  }

  /** Snapshot the pixels now, before the layer is removed. */
  capture(): void {
    const saved = new Map<CelId, Uint8ClampedArray>();
    for (const cel of this.cels) {
      const buf = getBuffer(cel.id);
      if (buf) saved.set(cel.id, buf);
    }
    this.saved = saved;
  }

  add(doc: DocumentApi): void {
    doc.insertLayer(this.layer, this.cels, this.index);
    if (this.saved) {
      for (const [id, buf] of this.saved) setBuffer(id, buf);
      this.saved = null;
    }
    doc.setActiveLayer(this.layer.id);
    doc.touch();
  }

  remove(doc: DocumentApi): void {
    this.capture();
    doc.removeLayerMetadata(this.layer.id);
    for (const cel of this.cels) releaseBuffer(cel.id);
    doc.touch();
  }
}

export class AddLayerCommand implements Command {
  readonly label = 'Add Layer';
  private readonly core: LayerExistence;

  constructor(layer: Layer, cels: Cel[], index: number) {
    this.core = new LayerExistence(layer, cels, index);
  }

  get memoryCost(): number {
    return this.core.retainedBytes;
  }

  apply(doc: DocumentApi): void {
    this.core.add(doc);
  }

  invert(doc: DocumentApi): void {
    this.core.remove(doc);
  }
}

export class DeleteLayerCommand implements Command {
  readonly label = 'Delete Layer';
  private readonly core: LayerExistence;

  constructor(layer: Layer, cels: Cel[], index: number) {
    this.core = new LayerExistence(layer, cels, index);
  }

  get memoryCost(): number {
    return this.core.retainedBytes;
  }

  apply(doc: DocumentApi): void {
    this.core.remove(doc);
  }

  invert(doc: DocumentApi): void {
    this.core.add(doc);
  }
}

export class MoveLayerCommand implements Command {
  readonly label = 'Reorder Layer';
  readonly memoryCost = 0;

  constructor(
    private readonly id: LayerId,
    private readonly from: number,
    private readonly to: number,
  ) {}

  apply(doc: DocumentApi): void {
    doc.moveLayer(this.id, this.to);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.moveLayer(this.id, this.from);
    doc.touch();
  }
}

export class SetLayerPropsCommand implements Command {
  readonly memoryCost = 0;

  constructor(
    readonly label: string,
    readonly id: LayerId,
    readonly before: Partial<Layer>,
    readonly after: Partial<Layer>,
    /** Non-null merges consecutive edits — one slider drag, one undo step. */
    readonly coalesceKey: string | null = null,
  ) {}

  apply(doc: DocumentApi): void {
    doc.updateLayer(this.id, this.after);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.updateLayer(this.id, this.before);
    doc.touch();
  }

  coalesceWith(next: Command): Command | null {
    if (!(next instanceof SetLayerPropsCommand)) return null;
    if (this.coalesceKey === null || this.coalesceKey !== next.coalesceKey) return null;
    if (this.id !== next.id) return null;
    // Keep the oldest "before" and the newest "after": the pair that describes
    // the whole drag.
    return new SetLayerPropsCommand(this.label, this.id, this.before, next.after, this.coalesceKey);
  }
}

// ---------------------------------------------------------------------------
// Actions — what the UI calls.
// ---------------------------------------------------------------------------

export function addLayer(name?: string): void {
  const doc = useDocumentStore.getState();
  const { layer, cels } = doc.createLayer(name);
  // New layers land directly above the active one, which is where an artist
  // expects them; appending to the top would be surprising once the stack is
  // more than two deep.
  const index = doc.layerIndex(doc.activeLayerId) + 1;
  useHistoryStore.getState().run(new AddLayerCommand(layer, cels, index));
}

export function deleteLayer(id: LayerId): void {
  const doc = useDocumentStore.getState();
  // A document with no layers has nowhere to draw; refuse rather than
  // producing a state the tools have to special-case.
  if (doc.sprite.layers.length <= 1) return;
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  const index = doc.layerIndex(id);
  useHistoryStore.getState().run(new DeleteLayerCommand(layer, doc.celsForLayer(id), index));
}

/** `delta` is +1 for "up the stack" (towards the viewer). */
export function moveLayer(id: LayerId, delta: number): void {
  const doc = useDocumentStore.getState();
  const from = doc.layerIndex(id);
  if (from < 0) return;
  const to = from + delta;
  if (to < 0 || to >= doc.sprite.layers.length) return;
  useHistoryStore.getState().run(new MoveLayerCommand(id, from, to));
}

function setProps(
  label: string,
  id: LayerId,
  patch: Partial<Layer>,
  coalesceKey: string | null = null,
): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;

  const before: Partial<Layer> = {};
  let changed = false;
  for (const key of Object.keys(patch) as (keyof Layer)[]) {
    if (layer[key] === patch[key]) continue;
    (before as Record<string, unknown>)[key] = layer[key];
    changed = true;
  }
  if (!changed) return;

  useHistoryStore.getState().run(new SetLayerPropsCommand(label, id, before, patch, coalesceKey));
}

export function renameLayer(id: LayerId, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  setProps('Rename Layer', id, { name: trimmed });
}

/**
 * `session` identifies one continuous drag. Coalescing on the layer id alone
 * would silently glue two *separate* opacity adjustments into a single undo
 * step; the caller bumps the session when the drag starts.
 */
export function setLayerOpacity(id: LayerId, opacity: number, session: number): void {
  const clamped = Math.max(0, Math.min(1, opacity));
  setProps('Layer Opacity', id, { opacity: clamped }, `opacity:${id}:${session}`);
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  setProps(visible ? 'Show Layer' : 'Hide Layer', id, { visible });
}

export function setLayerLocked(id: LayerId, locked: boolean): void {
  setProps(locked ? 'Lock Layer' : 'Unlock Layer', id, { locked });
}
