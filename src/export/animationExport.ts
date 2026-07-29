/**
 * Frame selection and flattening for multi-frame export — spritesheet (+
 * metadata JSON) and animated GIF (`docs/08-roadmap.md` Phase 4 "Export:
 * spritesheet ..., animated GIF").
 *
 * Kept pure and independent of the IPC/dialog layer (`app/ExportDialog.tsx`)
 * so the two things worth unit-testing without a backend — "which frames,
 * in what order, with what tag metadata" and "how they get concatenated into
 * one staged buffer" — are testable without mounting a dialog or a Tauri
 * shell, the same split every other pure-logic module in this project uses
 * (`model/tags.ts`, `panels/timeline.ts`).
 *
 * **Rust never composites layers** (`docs/08-roadmap.md` Phase 3 exit notes).
 * `flattenSprite` — already the export path for single-frame PNG export — is
 * reused here per frame; this module's only job is picking *which* frames
 * and in *what order*, then gluing their already-flattened bytes together
 * into the one buffer the raw IPC body carries.
 */

import { flattenSprite } from '../canvas/flatten';
import { clampTagRange, tagFrameSequence } from '../model/tags';
import type { Frame, Sprite, TagDirection, TagId } from '../model/types';

export interface ExportTagMeta {
  name: string;
  /** Frame indices *within the exported frame list*, not the whole sprite. */
  from: number;
  to: number;
  direction: TagDirection;
}

export interface SpritesheetSelection {
  frames: Frame[];
  tags: ExportTagMeta[];
}

/**
 * Frames for spritesheet/JSON export: every frame the whole sprite has, or —
 * scoped to one tag — the tag's forward index range with no ping-pong
 * duplication. A spritesheet is a set of *unique* images; a tag's playback
 * direction is metadata for the engine to interpret at runtime
 * (`frameTags`), not something baked into which cells exist.
 */
export function spritesheetSelection(sprite: Sprite, tagId: TagId | null): SpritesheetSelection {
  if (tagId === null) {
    return {
      frames: sprite.frames,
      tags: sprite.tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
      })),
    };
  }

  const tag = sprite.tags.find((t) => t.id === tagId);
  if (!tag) {
    return { frames: sprite.frames, tags: [] };
  }

  const { from, to } = clampTagRange(tag.from, tag.to, sprite.frames.length);
  const frames = sprite.frames.slice(from, to + 1);
  return {
    frames,
    tags: [
      { name: tag.name, from: 0, to: Math.max(0, frames.length - 1), direction: tag.direction },
    ],
  };
}

/**
 * Frames for GIF export, in actual playback order. Unlike the spritesheet
 * selection, a GIF *is* the playback — there's no metadata layer left for a
 * player to interpret direction from afterwards — so a reverse or ping-pong
 * tag has to be expanded here via `model/tags.ts::tagFrameSequence`, the
 * exact same ordering the Timeline panel's scoped playback already uses.
 */
export function gifFrameSequence(sprite: Sprite, tagId: TagId | null): Frame[] {
  if (tagId === null) return sprite.frames;
  const tag = sprite.tags.find((t) => t.id === tagId);
  if (!tag) return sprite.frames;
  return tagFrameSequence(sprite.frames, tag);
}

/**
 * Flatten every frame in `frames` (in order) and concatenate the results
 * into one buffer — what actually crosses the raw IPC body in one
 * `stageBytes` call, rather than one call per frame.
 */
export function concatFlattenedFrames(sprite: Sprite, frames: readonly Frame[]): Uint8ClampedArray {
  const perFrame = sprite.width * sprite.height * 4;
  const out = new Uint8ClampedArray(perFrame * frames.length);
  frames.forEach((frame, i) => {
    out.set(flattenSprite(sprite, frame.id), i * perFrame);
  });
  return out;
}

/**
 * `docs/06-workflows.md` W3 step 9's own example: a 4-frame walk cycle
 * exported as "a horizontal strip, 4 columns" — i.e. one row when the frame
 * count is small, wrapping into a grid once it grows past that. Used as the
 * dialog's starting value; the user can still type a different column count.
 */
export const DEFAULT_SPRITESHEET_COLUMNS = 4;
