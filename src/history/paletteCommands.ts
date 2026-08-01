/**
 * Undoable palette assignment/recolor for an indexed-mode sprite
 * (`docs/08-roadmap.md` Phase 7, `docs/10-decisions.md` D9).
 *
 * A full palette swap (picking a different palette entirely) and an
 * in-place recolor (editing one swatch's colour) are the same primitive —
 * both just replace `sprite.palette` wholesale, mirroring
 * `layerCommands.ts::SetLayerPropsCommand`'s coalescing shape one field
 * over: dragging a colour picker for one swatch collapses into one undo
 * step via `coalesceKey`, exactly like an opacity slider does.
 */

import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

export class SetSpritePaletteCommand implements Command {
  readonly label: string;
  readonly memoryCost: number;

  constructor(
    private readonly before: Palette | undefined,
    private readonly after: Palette,
    /** Non-null merges consecutive edits — dragging one swatch's colour picker. */
    readonly coalesceKey: string | null = null,
    label = 'Change Palette',
  ) {
    this.label = label;
    // Small and bounded (at most 255 colours × 4 bytes) — a rough estimate
    // is enough for the history budget, unlike a pixel delta's real byte count.
    this.memoryCost = after.colors.length * 4 * 2;
  }

  apply(doc: DocumentApi): void {
    doc.setSpritePalette(this.after);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    if (this.before) doc.setSpritePalette(this.before);
    doc.touch();
  }

  coalesceWith(next: Command): Command | null {
    if (!(next instanceof SetSpritePaletteCommand)) return null;
    if (this.coalesceKey === null || this.coalesceKey !== next.coalesceKey) return null;
    return new SetSpritePaletteCommand(this.before, next.after, this.coalesceKey, this.label);
  }
}

function setSpritePalette(palette: Palette, coalesceKey: string | null, label: string): void {
  const doc = useDocumentStore.getState();
  const cmd = new SetSpritePaletteCommand(doc.sprite.palette, palette, coalesceKey, label);
  cmd.apply(doc);
  useHistoryStore.getState().push(cmd);
}

/** Swap the sprite's palette for a different one entirely — the retro "team colors" trick. */
export function assignSpritePalette(palette: Palette): void {
  setSpritePalette({ ...palette, colors: [...palette.colors] }, null, 'Assign Palette');
}

/**
 * Recolor one swatch of the sprite's *own* palette in place — every pixel
 * using that index updates the moment this runs, with zero cel-data writes
 * (`model/celStorage.ts::resolveRasterToRgba`). `session` coalesces a drag
 * on the same swatch's colour picker into one undo step, the same
 * `session` convention `setLayerOpacity` uses.
 */
export function recolorSpritePaletteEntry(index: number, rgba: Palette['colors'][number]): void {
  const doc = useDocumentStore.getState();
  const palette = doc.sprite.palette;
  if (!palette || index < 0 || index >= palette.colors.length) return;
  const colors = palette.colors.slice();
  colors[index] = rgba;
  setSpritePalette({ ...palette, colors }, `recolor:${index}`, 'Recolor Palette');
}
