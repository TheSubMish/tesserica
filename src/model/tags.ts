/**
 * Pure logic for `Tag`s (`docs/03-data-model.md` §2.3, roadmap Phase 4 "Tags
 * with preset names") — kept independent of the store/command layers so it is
 * unit-testable without a document, the same split `panels/timeline.ts` and
 * `model/onionSkin.ts` already use.
 */

import type { Frame, Tag } from './types';

/**
 * Per `docs/01-reference-analysis.md` §6 / `docs/03-data-model.md` §2.3: the
 * quick-pick names offered on tag creation. A custom name is exactly as valid
 * — this list is what the UI *suggests*, not an enum the model enforces.
 */
export const TAG_PRESET_NAMES = ['idle', 'walk', 'run', 'attack', 'hurt', 'death'] as const;
export type TagPresetName = (typeof TAG_PRESET_NAMES)[number];

/** Cycled by creation order so consecutive tags are visually distinguishable. */
const TAG_COLOR_PALETTE = ['#4d9de0', '#e15554', '#3bb273', '#e1b12c', '#7768ae', '#e67e22'];

export function nextTagColor(existingCount: number): string {
  return TAG_COLOR_PALETTE[existingCount % TAG_COLOR_PALETTE.length];
}

/** Clamp a candidate `[from, to]` pair into `[0, frameCount - 1]`, ordered. */
export function clampTagRange(
  from: number,
  to: number,
  frameCount: number,
): { from: number; to: number } {
  const maxIndex = Math.max(0, frameCount - 1);
  const lo = Math.min(Math.max(Math.min(from, to), 0), maxIndex);
  const hi = Math.min(Math.max(Math.max(from, to), 0), maxIndex);
  return { from: lo, to: hi };
}

/**
 * Adjust a tag's range for a frame inserted at `index` (Aseprite's own
 * convention: a `from`/`to` pair is frame *indices*, not frame ids, so
 * inserting or removing a frame elsewhere in the timeline has to renumber
 * every tag that comes after it or it would silently point at the wrong
 * content).
 *
 * - Insertion at or before `from` shifts the whole range right by one (the
 *   tag's content is unaffected — it just moved).
 * - Insertion inside the range, or immediately after it (`to + 1`), grows the
 *   range by one so the new frame becomes part of the tag.
 * - Insertion strictly after the range leaves it untouched.
 */
export function shiftTagRangeForInsert(tag: Tag, index: number): Tag {
  const from = tag.from + (index <= tag.from ? 1 : 0);
  const to = tag.to + (index <= tag.to + 1 ? 1 : 0);
  return from === tag.from && to === tag.to ? tag : { ...tag, from, to };
}

/**
 * The exact inverse of `shiftTagRangeForInsert` for the same `index` — so
 * `AddFrameCommand`/`DeleteFrameCommand` undo restores tag ranges bit-for-bit,
 * not just approximately.
 *
 * A tag whose only frame is the one being removed cannot stay valid (`from`
 * would end up greater than `to`); it collapses to the single surviving frame
 * nearest its old `to` rather than being silently dropped — `docs/03` doesn't
 * say what should happen here, and dropping a named tag outright felt like
 * more surprise than shrinking it to one frame.
 */
export function shiftTagRangeForRemove(tag: Tag, index: number, frameCountAfter: number): Tag {
  let from = tag.from - (index < tag.from ? 1 : 0);
  let to = tag.to - (index <= tag.to ? 1 : 0);
  const maxIndex = Math.max(0, frameCountAfter - 1);
  from = Math.min(Math.max(from, 0), maxIndex);
  to = Math.min(Math.max(to, 0), maxIndex);
  if (from > to) from = to;
  return from === tag.from && to === tag.to ? tag : { ...tag, from, to };
}

/**
 * The frames a tag plays, in playback order, honouring `direction`.
 *
 * Feeding this straight into `panels/timeline.ts::startPlayback` as its
 * `getFrames()` is what lets scoped ("play just this tag") playback reuse the
 * exact same scheduler as whole-sprite playback — the scheduler only ever
 * treats its frame list as an ordered, looping sequence, so a pre-ordered
 * pingpong/reverse list is indistinguishable from a plain forward one to it.
 */
export function tagFrameSequence(frames: readonly Frame[], tag: Tag): Frame[] {
  if (frames.length === 0) return [];
  const { from, to } = clampTagRange(tag.from, tag.to, frames.length);
  const slice = frames.slice(from, to + 1);
  if (slice.length === 0) return [];
  switch (tag.direction) {
    case 'reverse':
      return [...slice].reverse();
    case 'pingpong':
      // Bounce without repeating either endpoint twice per lap: forward pass,
      // then the interior frames in reverse.
      return slice.length <= 2 ? slice : [...slice, ...slice.slice(1, -1).reverse()];
    case 'forward':
    default:
      return slice;
  }
}
