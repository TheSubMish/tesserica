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
import type { ColorMode } from '../model/types';
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
  /**
   * `docs/08-roadmap.md` Phase 7. Defaults to `'rgba'`. When `'indexed'`,
   * `paletteId` (or the session's current active palette) is embedded as the
   * sprite's own `Palette` — see `model/types.ts::Sprite.palette` for why a
   * copy, not a live reference to the session palette list.
   */
  colorMode?: ColorMode;
}

export function createNewSprite(options: NewSpriteOptions): void {
  const width = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, options.width)));
  const height = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, options.height)));
  const colorMode = options.colorMode ?? 'rgba';

  if (colorMode === 'indexed') {
    const paletteState = usePaletteStore.getState();
    const source =
      paletteState.palettes.find((p) => p.id === options.paletteId) ?? paletteState.activePalette();
    // The sprite's own copy — `model/types.ts::Palette`'s doc comment on why
    // an indexed sprite embeds its palette rather than referencing the
    // session list by id.
    const palette = { ...source, colors: [...source.colors] };
    useDocumentStore.getState().newDocument(width, height, 'indexed', palette);
  } else {
    useDocumentStore.getState().newDocument(width, height);
  }
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
