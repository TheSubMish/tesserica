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
 *
 * Groups (roadmap Phase 3, "Layer groups, clipping masks") reuse this same
 * vocabulary rather than adding a parallel one: a group is a `Layer` like any
 * other, so `AddLayerCommand`/`SetLayerPropsCommand` work on it unchanged.
 * Deleting one is the exception — it has to take its descendants with it
 * atomically, which is what `DeleteLayersCommand` generalizes
 * `DeleteLayerCommand` into. Reparenting (`parentId`) and clipping
 * (`clippingMask`) are both plain `LayerBase` fields, so they are just more
 * `setProps` calls, not new command types.
 */

import { getBuffer, releaseBuffer, setBuffer } from '../model/pixelBuffers';
import { getGrid, releaseGrid, setGrid } from '../model/tileGridBuffers';
import { descendantIds, wouldCreateCycle } from '../model/layerTree';
import type { BlendMode, Cel, CelId, Effect, EffectId, Layer, LayerId } from '../model/types';
import { makeId, useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

/**
 * Add and delete are the same operation run in opposite directions.
 *
 * A tilemap layer's cels (roadmap Phase 6) hold no pixel buffer — their
 * content is a grid of packed tile ids in `model/tileGridBuffers.ts` instead
 * — so `capture`/`add`/`remove` snapshot whichever storage this layer's kind
 * actually uses, keyed off `layer.kind` exactly once at the top of each
 * method rather than duplicating this class per layer kind.
 */
class LayerExistence {
  /** Pixels (raster/conversion) or grids (tilemap) held while the layer is absent. */
  private savedPixels: Map<CelId, Uint8ClampedArray> | null = null;
  private savedGrids: Map<CelId, Uint32Array> | null = null;

  constructor(
    readonly layer: Layer,
    readonly cels: Cel[],
    readonly index: number,
  ) {}

  get retainedBytes(): number {
    let n = 0;
    if (this.savedPixels) for (const buf of this.savedPixels.values()) n += buf.byteLength;
    if (this.savedGrids) for (const g of this.savedGrids.values()) n += g.byteLength;
    return n;
  }

  /**
   * Snapshot the pixels/grid now, before the layer is removed.
   *
   * A linked cel (`docs/03-data-model.md` §2.2) has no buffer of its own —
   * `linkedTo` always names another cel *on this same layer*, so its target
   * is captured here too and there is nothing extra to snapshot for the link
   * itself.
   */
  capture(): void {
    const savedPixels = new Map<CelId, Uint8ClampedArray>();
    const savedGrids = new Map<CelId, Uint32Array>();
    for (const cel of this.cels) {
      if (cel.linkedTo) continue;
      if (this.layer.kind === 'tilemap') {
        const g = getGrid(cel.id);
        if (g) savedGrids.set(cel.id, g);
      } else {
        const buf = getBuffer(cel.id);
        if (buf) savedPixels.set(cel.id, buf);
      }
    }
    this.savedPixels = savedPixels;
    this.savedGrids = savedGrids;
  }

  add(doc: DocumentApi): void {
    doc.insertLayer(this.layer, this.cels, this.index);
    if (this.savedPixels) {
      for (const [id, buf] of this.savedPixels) setBuffer(id, buf);
      this.savedPixels = null;
    }
    if (this.savedGrids) {
      for (const [id, g] of this.savedGrids) setGrid(id, g);
      this.savedGrids = null;
    }
    doc.setActiveLayer(this.layer.id);
    doc.touch();
  }

  remove(doc: DocumentApi): void {
    this.capture();
    doc.removeLayerMetadata(this.layer.id);
    // Every cel a link on this layer could point to also belongs to this
    // layer, so it dies in this same cascade — a linked cel never needs its
    // target released separately, and never owned a buffer to release itself.
    for (const cel of this.cels) {
      if (cel.linkedTo) continue;
      if (this.layer.kind === 'tilemap') releaseGrid(cel.id);
      else releaseBuffer(cel.id);
    }
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

/**
 * Delete one or more layers atomically — one undo step whether it is a plain
 * layer or a group taking its whole subtree with it.
 *
 * Each entry's `index` is captured from the *original* array, before any of
 * the batch is removed. Removal itself is order-independent
 * (`removeLayerMetadata` filters by id), but re-insertion on undo splices at
 * a fixed numeric index, so entries are restored lowest-index-first: by
 * induction, every earlier splice only shifts slots this entry does not
 * occupy yet, so each one lands back exactly where it started.
 */
export class DeleteLayersCommand implements Command {
  readonly label: string;
  private readonly cores: LayerExistence[];
  private readonly rootId: LayerId;

  constructor(
    entries: { layer: Layer; cels: Cel[]; index: number }[],
    rootId: LayerId,
    label = 'Delete Layer',
  ) {
    this.cores = [...entries]
      .sort((a, b) => a.index - b.index)
      .map((e) => new LayerExistence(e.layer, e.cels, e.index));
    this.rootId = rootId;
    this.label = label;
  }

  get memoryCost(): number {
    return this.cores.reduce((n, c) => n + c.retainedBytes, 0);
  }

  apply(doc: DocumentApi): void {
    for (const core of this.cores) core.remove(doc);
  }

  invert(doc: DocumentApi): void {
    for (const core of this.cores) core.add(doc);
    // Each `add()` selects the layer it just restored; the root (the group or
    // single layer the user actually deleted) is the more useful one to land
    // on than whichever descendant happened to sort last.
    doc.setActiveLayer(this.rootId);
  }
}

export class MoveLayerCommand implements Command {
  readonly label = 'Reorder Layer';
  readonly memoryCost = 0;

  constructor(
    private readonly a: LayerId,
    private readonly b: LayerId,
  ) {}

  apply(doc: DocumentApi): void {
    doc.swapLayers(this.a, this.b);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    // A transposition is its own inverse.
    doc.swapLayers(this.a, this.b);
    doc.touch();
  }
}

/**
 * Run several commands as one undo step — e.g. "Group Layer" is both
 * creating the group and reparenting the layer into it, and "Ungroup" is
 * reparenting every child out before deleting the now-empty group.
 */
export class BatchCommand implements Command {
  constructor(
    readonly label: string,
    private readonly commands: Command[],
  ) {}

  get memoryCost(): number {
    return this.commands.reduce((n, c) => n + c.memoryCost, 0);
  }

  apply(doc: DocumentApi): void {
    for (const c of this.commands) c.apply(doc);
  }

  invert(doc: DocumentApi): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].invert(doc);
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

/**
 * Deleting a group takes every descendant with it, atomically — an orphaned
 * layer whose `parentId` no longer resolves is not a state the compositor or
 * the panel's tree walk should have to tolerate (`state/documentStore.ts`'s
 * `removeLayer` convenience does the same cascade for the non-undoable path).
 */
export function deleteLayer(id: LayerId): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;

  const ids = [id, ...descendantIds(doc.sprite.layers, id)];
  // A document with no layers has nowhere to draw; refuse rather than
  // producing a state the tools have to special-case.
  if (doc.sprite.layers.length - ids.length < 1) return;

  const entries = ids.map((lid) => ({
    layer: doc.sprite.layers.find((l) => l.id === lid)!,
    cels: doc.celsForLayer(lid),
    index: doc.layerIndex(lid),
  }));
  useHistoryStore.getState().run(new DeleteLayersCommand(entries, id));
}

/**
 * `delta` is +1 for "up the stack" (towards the viewer). Moves relative to
 * `id`'s own siblings (same `parentId`) rather than the whole flat array, so
 * nudging a layer inside a group never disturbs anything outside it.
 */
export function moveLayer(id: LayerId, delta: number): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  const siblings = doc.sprite.layers.filter((l) => l.parentId === layer.parentId);
  const from = siblings.findIndex((l) => l.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= siblings.length) return;
  useHistoryStore.getState().run(new MoveLayerCommand(id, siblings[to].id));
}

/** Create an empty group as a sibling of the active layer. */
export function addGroup(name?: string): void {
  const doc = useDocumentStore.getState();
  const active = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);
  const { layer, cels } = doc.createGroup(name, active?.parentId ?? null);
  const index = doc.layerIndex(doc.activeLayerId) + 1;
  useHistoryStore.getState().run(new AddLayerCommand(layer, cels, index));
}

/**
 * Wrap a single layer in a brand-new group — creating the group and
 * reparenting the layer into it as one undo step.
 *
 * Multi-select does not exist in the layer panel (`docs/08-roadmap.md` Phase
 * 3 keeps that minimal); grouping one layer at a time and then dragging more
 * layers into it via `setLayerParent` covers the same ground without it.
 */
export function groupLayer(id: LayerId): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;

  const { layer: group, cels } = doc.createGroup(undefined, layer.parentId);
  const index = doc.layerIndex(id) + 1;
  const add = new AddLayerCommand(group, cels, index);
  const reparent = new SetLayerPropsCommand(
    'Group Layer',
    id,
    { parentId: layer.parentId },
    { parentId: group.id },
  );
  useHistoryStore.getState().run(new BatchCommand('Group Layer', [add, reparent]));
}

/**
 * Dissolve a group: its children move up to the group's own `parentId`, then
 * the now-empty group is deleted. One undo step, reparents first so undo
 * restores the children's membership before the group they belonged to comes
 * back.
 */
export function ungroupLayer(id: LayerId): void {
  const doc = useDocumentStore.getState();
  const group = doc.sprite.layers.find((l) => l.id === id);
  if (!group || group.kind !== 'group') return;

  const children = doc.sprite.layers.filter((l) => l.parentId === id);
  const reparents = children.map(
    (c) =>
      new SetLayerPropsCommand('Ungroup', c.id, { parentId: id }, { parentId: group.parentId }),
  );
  const del = new DeleteLayersCommand(
    [{ layer: group, cels: doc.celsForLayer(id), index: doc.layerIndex(id) }],
    id,
    'Ungroup',
  );
  useHistoryStore.getState().run(new BatchCommand('Ungroup', [...reparents, del]));
}

/**
 * Move `id` into `parentId` (or to the top level when `null`). Refuses a
 * no-op, a self-parent, and anything that would nest a group inside its own
 * descendant.
 */
export function setLayerParent(id: LayerId, parentId: LayerId | null): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer || layer.parentId === parentId) return;
  if (wouldCreateCycle(doc.sprite.layers, id, parentId)) return;
  if (parentId !== null) {
    const target = doc.sprite.layers.find((l) => l.id === parentId);
    if (!target || target.kind !== 'group') return;
  }
  setProps('Move to Group', id, { parentId });
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

export function setLayerBlendMode(id: LayerId, blendMode: BlendMode): void {
  setProps('Layer Blend Mode', id, { blendMode });
}

/** "Clip to layer below" (roadmap Phase 3) — scoped to the layer's own group. */
export function setLayerClippingMask(id: LayerId, clippingMask: boolean): void {
  setProps(clippingMask ? 'Enable Clipping Mask' : 'Disable Clipping Mask', id, { clippingMask });
}

// ---------------------------------------------------------------------------
// Non-destructive layer effects (`docs/03-data-model.md` §5, roadmap Phase 7)
//
// The whole `effects` array is one `LayerBase` field, so every operation
// below is a single `setProps` call replacing it wholesale — the same
// "diff-and-patch" vocabulary every other property edit here already uses,
// not a new command type. `setProps`'s own before/after diff always considers
// a new array reference "changed" (arrays compare by identity), which is
// exactly right: every function below only ever runs when it genuinely
// intends to record a step.
// ---------------------------------------------------------------------------

function defaultEffect(kind: Effect['kind']): Effect {
  const id = makeId('fx');
  switch (kind) {
    case 'outline':
      return { id, kind, enabled: true, color: [0, 0, 0, 255], thickness: 1, corners: false };
    case 'outline-inner':
      return { id, kind, enabled: true, color: [0, 0, 0, 255], thickness: 1 };
    case 'drop-shadow':
      return { id, kind, enabled: true, dx: 2, dy: 2, color: [0, 0, 0, 160] };
    case 'gradient-map':
      return {
        id,
        kind,
        enabled: true,
        palette: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
      };
    case 'hsv-shift':
      return { id, kind, enabled: true, h: 0, s: 0, v: 0 };
  }
}

/** Appends a new effect of `kind`, with reasonable defaults, to the top of the layer's stack. */
export function addLayerEffect(id: LayerId, kind: Effect['kind']): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  setProps('Add Effect', id, { effects: [...layer.effects, defaultEffect(kind)] });
}

export function removeLayerEffect(id: LayerId, effectId: EffectId): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  setProps('Remove Effect', id, { effects: layer.effects.filter((e) => e.id !== effectId) });
}

export function setLayerEffectEnabled(id: LayerId, effectId: EffectId, enabled: boolean): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  setProps(enabled ? 'Enable Effect' : 'Disable Effect', id, {
    effects: layer.effects.map((e) => (e.id === effectId ? { ...e, enabled } : e)),
  });
}

/**
 * Patches one effect's own parameters — `patch` must match its `kind`
 * (callers narrow via `Extract<Effect, {kind: '...'}>`, e.g. the panel's
 * thickness slider only ever sends `{ thickness }` to an outline effect).
 * `coalesceKey`, like `setLayerOpacity`, lets one continuous slider drag
 * become one undo step rather than one per tick.
 */
export function updateLayerEffect(
  id: LayerId,
  effectId: EffectId,
  patch: Partial<Effect>,
  coalesceKey?: string,
): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  setProps(
    'Edit Effect',
    id,
    {
      effects: layer.effects.map((e) => (e.id === effectId ? ({ ...e, ...patch } as Effect) : e)),
    },
    coalesceKey ? `effect:${effectId}:${coalesceKey}` : null,
  );
}

/** `delta` is +1 towards the end of the stack (composited later), -1 towards the start. */
export function reorderLayerEffect(id: LayerId, effectId: EffectId, delta: number): void {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === id);
  if (!layer) return;
  const from = layer.effects.findIndex((e) => e.id === effectId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= layer.effects.length) return;
  const next = [...layer.effects];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  setProps('Reorder Effect', id, { effects: next });
}
