/**
 * `Ctrl+N` — new sprite (`docs/06-workflows.md` W2 step 1, `docs/08-roadmap.md`
 * "belongs at the head of Phase 3").
 *
 * Deliberately thin: `documentStore.newDocument` already does the buffer and
 * id bookkeeping (it is routed through `replaceDocument`, the same primitive
 * `openProject` and `[ Edit → ]` use). This module's job is the three things
 * that are specific to *starting fresh* rather than *loading something*: drop
 * the undo history, invalidate the cached composite, and re-fit the viewport.
 */

import { invalidateRenderCache } from '../canvas/renderer';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { usePaletteStore } from '../state/paletteStore';
import { useUIStore } from '../state/uiStore';

/** No doc mandates a ceiling; this is a sanity bound against fat-fingering a size field. */
export const MIN_SPRITE_SIZE = 1;
export const MAX_SPRITE_SIZE = 2048;

export interface NewSpriteOptions {
  width: number;
  height: number;
  /** Palette to make active, e.g. what the dialog's palette picker selected. */
  paletteId?: string;
}

export function createNewSprite(options: NewSpriteOptions): void {
  const width = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, options.width)));
  const height = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, options.height)));

  useDocumentStore.getState().newDocument(width, height);
  // A brand-new document has never been saved anywhere, even if one that came
  // before it had a path.
  useDocumentStore.getState().setProjectPath(null);

  // Mirrors `openProject` (`docs/03-data-model.md` §6): the fresh document
  // shares no history with whatever it replaced, and any cached composite
  // pointed at buffers `newDocument` already released.
  useHistoryStore.getState().clear();
  invalidateRenderCache();

  if (options.paletteId) usePaletteStore.getState().setActivePalette(options.paletteId);

  // W2 is Edit-only; a brand-new sprite has nothing to convert from.
  useUIStore.getState().setMode('edit');
  useUIStore.getState().requestFit();
}
