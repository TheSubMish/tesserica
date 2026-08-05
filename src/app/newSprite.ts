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
/**
 * Raised from 2048 (`docs/08-roadmap.md` Phase 8, "raise the tilemap/document
 * size ceiling for large maps"). A tilemap layer's cel cannot exceed its
 * sprite (`03-data-model.md` §9), so this cap was also the tilemap cap; 2048
 * left barely 128×128 tiles at a 16 px tile size, well short of a "large map".
 * 4096 gives 256×256 tiles at 16 px (or 128×128 at 32 px) — solidly past
 * `06-workflows.md` W4's own 128×128-*pixel*-canvas example.
 *
 * Checked before raising, not assumed:
 * - `convert/preview/proxy.ts::PREVIEW_PROXY_MAX_EDGE` (1024) is a wholly
 *   separate constant for Convert mode's proxy preview and does not read this
 *   one — confirmed independent, as `08-roadmap.md` required.
 * - The viewport (`canvas/coords.ts::fitZoom`) has no fixed-size assumption;
 *   it clamps to integer zoom ≥1 and scrolls for anything larger, same as
 *   today.
 * - `model/tileIds.ts::tileGridDims`'s shape-aware extent walk is O(cols +
 *   rows), not O(cols × rows) — trivial even at this ceiling.
 * - Rust's `Sprite`/`Cel` dimension fields are `u32` (`src-tauri/src/model/
 *   document.rs`) — no truncation risk from a larger cap.
 * - **A real cost that does grow with this cap, measured rather than
 *   guessed**: `history/pixelDelta.ts::diffBounds`, run once per finished
 *   drawing gesture on a *raster* layer, walks the whole cel to find the
 *   dirty rect regardless of how small the edit was — O(cel area), not O(edit
 *   size). A pure-algorithm microbenchmark of that walk (single-pixel edit,
 *   worst case since location doesn't change the cost) measured ~54 ms at the
 *   old 2048² cap and ~221 ms at 4096² on this machine. A *tilemap* layer is
 *   unaffected — `history/tileStrokeRecorder.ts` diffs the tile-id grid
 *   (`cols × rows`, e.g. 256×256 at 16 px tiles), not raw pixels, so painting
 *   a large map stays cheap regardless of this cap. The regression only bites
 *   freehand pixel drawing on a raster layer sized all the way up to the new
 *   ceiling, was already present (just smaller) at the old cap, and is a
 *   known limitation of the dirty-rect *discovery* mechanism itself — fixing
 *   it would mean threading a touched-rect hint through every drawing tool,
 *   which is a separate, larger change than raising this constant and is not
 *   attempted here.
 */
export const MAX_SPRITE_SIZE = 4096;

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
