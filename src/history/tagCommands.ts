/**
 * Undoable tag operations (`docs/03-data-model.md` §2.3, roadmap Phase 4
 * "Tags with preset names").
 *
 * A tag is pure metadata — no pixel buffers involved — so this file is
 * simpler than `frameCommands.ts`'s cel-buffer bookkeeping; it mirrors that
 * module's vocabulary (existence pairs, a patch command) one axis over again.
 */

import type { Tag, TagDirection, TagId } from '../model/types';
import { clampTagRange, nextTagColor, TAG_PRESET_NAMES } from '../model/tags';
import { makeId, useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

export { TAG_PRESET_NAMES };
export type { TagDirection };

/** Add and delete are the same operation run in opposite directions. */
class TagExistence {
  constructor(
    readonly tag: Tag,
    readonly index: number,
  ) {}

  add(doc: DocumentApi): void {
    doc.insertTag(this.tag, this.index);
    doc.touch();
  }

  remove(doc: DocumentApi): void {
    doc.removeTagMetadata(this.tag.id);
    doc.touch();
  }
}

export class AddTagCommand implements Command {
  readonly label = 'Add Tag';
  readonly memoryCost = 0;
  private readonly core: TagExistence;

  constructor(tag: Tag, index: number) {
    this.core = new TagExistence(tag, index);
  }

  apply(doc: DocumentApi): void {
    this.core.add(doc);
  }

  invert(doc: DocumentApi): void {
    this.core.remove(doc);
  }
}

export class DeleteTagCommand implements Command {
  readonly label = 'Delete Tag';
  readonly memoryCost = 0;
  private readonly core: TagExistence;

  constructor(tag: Tag, index: number) {
    this.core = new TagExistence(tag, index);
  }

  apply(doc: DocumentApi): void {
    this.core.remove(doc);
  }

  invert(doc: DocumentApi): void {
    this.core.add(doc);
  }
}

/** Patches any subset of a tag's metadata — name, range, direction, color, repeat. */
export class UpdateTagCommand implements Command {
  readonly label = 'Edit Tag';
  readonly memoryCost = 0;

  constructor(
    private readonly id: TagId,
    private readonly before: Partial<Tag>,
    private readonly after: Partial<Tag>,
    /** Non-null merges consecutive edits — one drag, one undo step. */
    private readonly coalesceKey: string | null = null,
  ) {}

  apply(doc: DocumentApi): void {
    doc.updateTag(this.id, this.after);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.updateTag(this.id, this.before);
    doc.touch();
  }

  coalesceWith(next: Command): Command | null {
    if (!(next instanceof UpdateTagCommand)) return null;
    if (this.coalesceKey === null || this.coalesceKey !== next.coalesceKey) return null;
    if (this.id !== next.id) return null;
    return new UpdateTagCommand(this.id, this.before, next.after, this.coalesceKey);
  }
}

// ---------------------------------------------------------------------------
// Actions — what the UI calls.
// ---------------------------------------------------------------------------

/**
 * Create a tag over `[from, to]` (frame indices, inclusive; either order is
 * accepted and normalized). `name` is any string — the six presets
 * (`TAG_PRESET_NAMES`) are the UI's quick-pick options, not a model-level
 * enum.
 */
export function addTag(name: string, from: number, to: number): void {
  const doc = useDocumentStore.getState();
  const trimmed = name.trim();
  if (!trimmed) return;
  const range = clampTagRange(from, to, doc.sprite.frames.length);
  const tag: Tag = {
    id: makeId('t'),
    name: trimmed,
    from: range.from,
    to: range.to,
    direction: 'forward',
    color: nextTagColor(doc.sprite.tags.length),
  };
  useHistoryStore.getState().run(new AddTagCommand(tag, doc.sprite.tags.length));
}

export function deleteTag(id: TagId): void {
  const doc = useDocumentStore.getState();
  const index = doc.tagIndex(id);
  if (index < 0) return;
  useHistoryStore.getState().run(new DeleteTagCommand(doc.sprite.tags[index], index));
}

export function renameTag(id: TagId, name: string): void {
  const doc = useDocumentStore.getState();
  const trimmed = name.trim();
  const tag = doc.sprite.tags.find((t) => t.id === id);
  if (!tag || !trimmed || tag.name === trimmed) return;
  useHistoryStore.getState().run(new UpdateTagCommand(id, { name: tag.name }, { name: trimmed }));
}

/** `session` groups a continuous drag/edit of the same tag's range into one undo step. */
export function setTagRange(id: TagId, from: number, to: number, session: number): void {
  const doc = useDocumentStore.getState();
  const tag = doc.sprite.tags.find((t) => t.id === id);
  if (!tag) return;
  const range = clampTagRange(from, to, doc.sprite.frames.length);
  if (range.from === tag.from && range.to === tag.to) return;
  useHistoryStore
    .getState()
    .run(
      new UpdateTagCommand(
        id,
        { from: tag.from, to: tag.to },
        { from: range.from, to: range.to },
        `tag-range:${id}:${session}`,
      ),
    );
}

export function setTagDirection(id: TagId, direction: TagDirection): void {
  const doc = useDocumentStore.getState();
  const tag = doc.sprite.tags.find((t) => t.id === id);
  if (!tag || tag.direction === direction) return;
  useHistoryStore
    .getState()
    .run(new UpdateTagCommand(id, { direction: tag.direction }, { direction }));
}
