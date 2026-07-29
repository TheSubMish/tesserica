/**
 * Undoable frame and cel-link operations (`docs/03-data-model.md` §2.2,
 * roadmap Phase 4 "Frames, cels, linked cels").
 *
 * These mirror `layerCommands.ts`'s vocabulary one axis over: `AddFrameCommand`
 * / `DeleteFrameCommand` are `FrameExistence` run in opposite directions, the
 * same shape as `AddLayerCommand` / `DeleteLayersCommand`'s `LayerExistence`.
 *
 * **Buffer ownership across frame deletion is the one genuinely new wrinkle.**
 * Deleting a *layer* takes every cel it owns with it atomically, so any link
 * between two of those cels dies in the same breath and there is nothing left
 * to dangle. Deleting a single *frame* is different: sibling frames on the
 * same layer survive, and one of their cels may be linked to the very cel this
 * deletion is about to remove. `FrameExistence.remove` checks the surviving
 * cels for a `linkedTo` pointing at the one being deleted before releasing its
 * buffer — releasing it regardless would leave a surviving linked cel pointing
 * at nothing.
 */

import { getBuffer, releaseBuffer, setBuffer } from '../model/pixelBuffers';
import { celBufferId, type Cel, type CelId, type Frame, type FrameId } from '../model/types';
import { makeId, useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

/** Add and delete are the same operation run in opposite directions. */
class FrameExistence {
  /** Pixels held while the frame is absent from the document. */
  private saved: Map<CelId, Uint8ClampedArray> | null = null;

  constructor(
    readonly frame: Frame,
    readonly cels: Cel[],
    readonly index: number,
  ) {}

  get retainedBytes(): number {
    let n = 0;
    if (this.saved) for (const buf of this.saved.values()) n += buf.byteLength;
    return n;
  }

  /** Snapshot the pixels this frame's cels *own* now, before removal. */
  capture(): void {
    const saved = new Map<CelId, Uint8ClampedArray>();
    for (const cel of this.cels) {
      if (cel.linkedTo) continue; // no buffer of its own to snapshot
      const buf = getBuffer(cel.id);
      if (buf) saved.set(cel.id, buf);
    }
    this.saved = saved;
  }

  add(doc: DocumentApi): void {
    doc.insertFrame(this.frame, this.cels, this.index);
    if (this.saved) {
      for (const [id, buf] of this.saved) setBuffer(id, buf);
      this.saved = null;
    }
    doc.touch();
  }

  remove(doc: DocumentApi): void {
    this.capture();

    // Cels outside this frame that still link to one of this frame's cels —
    // their target must survive this removal even though the frame it
    // belongs to does not.
    const removedIds = new Set(this.cels.map((c) => c.id));
    const stillLinkedTo = new Set(
      doc.sprite.cels
        .filter((c) => !removedIds.has(c.id))
        .map((c) => c.linkedTo)
        .filter((t): t is CelId => t !== undefined),
    );

    doc.removeFrameMetadata(this.frame.id);
    for (const cel of this.cels) {
      if (cel.linkedTo) continue; // shares a buffer that belongs elsewhere
      if (stillLinkedTo.has(cel.id)) continue; // a surviving cel still needs it
      releaseBuffer(cel.id);
    }
    doc.touch();
  }
}

export class AddFrameCommand implements Command {
  readonly label = 'Add Frame';
  private readonly core: FrameExistence;

  constructor(frame: Frame, cels: Cel[], index: number) {
    this.core = new FrameExistence(frame, cels, index);
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

export class DeleteFrameCommand implements Command {
  readonly label = 'Delete Frame';
  private readonly core: FrameExistence;

  constructor(frame: Frame, cels: Cel[], index: number) {
    this.core = new FrameExistence(frame, cels, index);
  }

  get memoryCost(): number {
    return this.core.retainedBytes;
  }

  apply(doc: DocumentApi): void {
    this.core.remove(doc);
  }

  invert(doc: DocumentApi): void {
    this.core.add(doc);
    doc.setActiveFrame(this.core.frame.id);
  }
}

export class MoveFrameCommand implements Command {
  readonly label = 'Reorder Frame';
  readonly memoryCost = 0;

  constructor(
    private readonly a: FrameId,
    private readonly b: FrameId,
  ) {}

  apply(doc: DocumentApi): void {
    doc.swapFrames(this.a, this.b);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    // A transposition is its own inverse.
    doc.swapFrames(this.a, this.b);
    doc.touch();
  }
}

export class SetFrameDurationCommand implements Command {
  readonly memoryCost = 0;
  readonly label = 'Frame Duration';

  constructor(
    readonly id: FrameId,
    readonly before: number,
    readonly after: number,
    /** Non-null merges consecutive edits — one drag, one undo step. */
    readonly coalesceKey: string | null = null,
  ) {}

  apply(doc: DocumentApi): void {
    doc.updateFrame(this.id, { durationMs: this.after });
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.updateFrame(this.id, { durationMs: this.before });
    doc.touch();
  }

  coalesceWith(next: Command): Command | null {
    if (!(next instanceof SetFrameDurationCommand)) return null;
    if (this.coalesceKey === null || this.coalesceKey !== next.coalesceKey) return null;
    if (this.id !== next.id) return null;
    return new SetFrameDurationCommand(this.id, this.before, next.after, this.coalesceKey);
  }
}

/**
 * Turn an independent cel into a link pointing at `targetCelId`'s buffer.
 *
 * Captures whatever the cel owned before linking (metadata and, if it was
 * unlinked, its own pixels) exactly once, so redo after an intervening undo
 * restores the identical bytes rather than re-deriving them from whatever the
 * shared buffer looks like by then.
 */
export class LinkCelCommand implements Command {
  readonly label = 'Link Cel';
  private previousLinkedTo: CelId | undefined;
  private previousBuffer: Uint8ClampedArray | null = null;
  private captured = false;

  constructor(
    private readonly celId: CelId,
    private readonly targetCelId: CelId,
  ) {}

  get memoryCost(): number {
    return this.previousBuffer?.byteLength ?? 0;
  }

  apply(doc: DocumentApi): void {
    if (!this.captured) {
      const cel = doc.sprite.cels.find((c) => c.id === this.celId);
      this.previousLinkedTo = cel?.linkedTo;
      if (cel && !cel.linkedTo) {
        const buf = getBuffer(this.celId);
        this.previousBuffer = buf ? new Uint8ClampedArray(buf) : null;
      }
      this.captured = true;
    }
    doc.setCelLink(this.celId, this.targetCelId);
    releaseBuffer(this.celId);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.setCelLink(this.celId, this.previousLinkedTo);
    if (this.previousBuffer) setBuffer(this.celId, new Uint8ClampedArray(this.previousBuffer));
    doc.touch();
  }
}

/**
 * Turn a linked cel back into an independent one, carrying a copy of the
 * shared content it displayed at the moment of unlinking — the conventional
 * meaning of "unlink" (Aseprite's "Unlink Cel"), not an empty cel.
 */
export class UnlinkCelCommand implements Command {
  readonly label = 'Unlink Cel';
  private copiedBuffer: Uint8ClampedArray | null = null;

  constructor(
    private readonly celId: CelId,
    private readonly linkedTo: CelId,
  ) {}

  get memoryCost(): number {
    return this.copiedBuffer?.byteLength ?? 0;
  }

  apply(doc: DocumentApi): void {
    if (!this.copiedBuffer) {
      const src = getBuffer(this.linkedTo);
      this.copiedBuffer = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(0);
    }
    doc.setCelLink(this.celId, undefined);
    setBuffer(this.celId, new Uint8ClampedArray(this.copiedBuffer));
    doc.touch(this.celId);
  }

  invert(doc: DocumentApi): void {
    releaseBuffer(this.celId);
    doc.setCelLink(this.celId, this.linkedTo);
    doc.touch();
  }
}

// ---------------------------------------------------------------------------
// Actions — what the UI calls.
// ---------------------------------------------------------------------------

/** Insert a new blank frame after `afterFrameId` (or at the end when omitted). */
export function addFrame(afterFrameId?: FrameId): void {
  const doc = useDocumentStore.getState();
  const { frame, cels } = doc.createFrame();
  const index = afterFrameId ? doc.frameIndex(afterFrameId) + 1 : doc.sprite.frames.length;
  useHistoryStore.getState().run(new AddFrameCommand(frame, cels, index));
  useDocumentStore.getState().setActiveFrame(frame.id);
}

/** A document with no frames has nowhere to draw; refuse rather than allow it. */
export function deleteFrame(frameId: FrameId): void {
  const doc = useDocumentStore.getState();
  if (doc.sprite.frames.length <= 1) return;
  const index = doc.frameIndex(frameId);
  if (index < 0) return;
  const frame = doc.sprite.frames[index];
  const cels = doc.celsForFrame(frameId);
  useHistoryStore.getState().run(new DeleteFrameCommand(frame, cels, index));
}

/**
 * Insert an independent copy of `frameId` right after it — real duplicated
 * pixels, not a link, matching what "duplicate" means everywhere else in the
 * app (`layerCommands.ts` has no equivalent because duplicating a *layer*
 * isn't in scope yet either, but the shape here is the one that would match).
 */
export function duplicateFrame(frameId: FrameId): void {
  const doc = useDocumentStore.getState();
  const index = doc.frameIndex(frameId);
  if (index < 0) return;
  const source = doc.sprite.frames[index];
  const sourceCels = doc.celsForFrame(frameId);

  const frame: Frame = { id: makeId('f'), durationMs: source.durationMs };
  const cels: Cel[] = sourceCels.map((c) => {
    const newId = makeId('c');
    const srcBuf = getBuffer(celBufferId(c));
    const buf = new Uint8ClampedArray(c.width * c.height * 4);
    if (srcBuf) buf.set(srcBuf);
    setBuffer(newId, buf);
    return { ...c, id: newId, frameId: frame.id, linkedTo: undefined };
  });

  useHistoryStore.getState().run(new AddFrameCommand(frame, cels, index + 1));
  useDocumentStore.getState().setActiveFrame(frame.id);
}

/** `delta` is +1 for "later in time". */
export function moveFrame(id: FrameId, delta: number): void {
  const doc = useDocumentStore.getState();
  const from = doc.frameIndex(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= doc.sprite.frames.length) return;
  useHistoryStore.getState().run(new MoveFrameCommand(id, doc.sprite.frames[to].id));
}

export function setFrameDuration(id: FrameId, durationMs: number, session: number): void {
  const doc = useDocumentStore.getState();
  const frame = doc.sprite.frames.find((f) => f.id === id);
  if (!frame) return;
  const clamped = Math.max(1, Math.round(durationMs));
  if (clamped === frame.durationMs) return;
  useHistoryStore
    .getState()
    .run(
      new SetFrameDurationCommand(id, frame.durationMs, clamped, `frame-duration:${id}:${session}`),
    );
}

/**
 * Link `celId` to `targetCelId`'s buffer. Both must belong to the same layer
 * (a link is "this layer doesn't change on these frames", never a cross-layer
 * reference), refer to different frames, and the target must itself be
 * unlinked — chaining links would need to be resolved every time a buffer is
 * read, for no benefit over pointing directly at the canonical cel.
 */
export function linkCel(celId: CelId, targetCelId: CelId): void {
  const doc = useDocumentStore.getState();
  if (celId === targetCelId) return;
  const cel = doc.sprite.cels.find((c) => c.id === celId);
  const target = doc.sprite.cels.find((c) => c.id === targetCelId);
  if (!cel || !target) return;
  if (cel.layerId !== target.layerId) return;
  if (cel.frameId === target.frameId) return;
  if (target.linkedTo) return;
  useHistoryStore.getState().run(new LinkCelCommand(celId, targetCelId));
}

export function unlinkCel(celId: CelId): void {
  const doc = useDocumentStore.getState();
  const cel = doc.sprite.cels.find((c) => c.id === celId);
  if (!cel?.linkedTo) return;
  useHistoryStore.getState().run(new UnlinkCelCommand(celId, cel.linkedTo));
}
