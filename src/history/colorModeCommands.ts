/**
 * Convert an already-open `'rgba'`-mode sprite to `'indexed'` mode in place.
 *
 * `docs/08-roadmap.md` Phase 7 shipped indexed mode only as a choice at
 * sprite-*creation* time (`app/NewSpriteDialog.tsx`) — there was no way to
 * take an existing, already-drawn `'rgba'` sprite and quantize it into
 * indexed storage after the fact. This closes that gap.
 *
 * **Conversion-layer scope decision, mirroring `model/celStorage.ts`'s own
 * documented one.** A `conversion`-kind layer's cel is left untouched here,
 * exactly as it already is for a sprite that was *created* as indexed:
 * `celStorage.ts::isIndexedLayer` only ever routes a `raster` layer to
 * indexed storage. A conversion layer's pixels are the converter pipeline's
 * own RGBA output (`docs/04-image-pipeline.md`), and re-quantizing that
 * output into the sprite's separate indexed palette would be a second,
 * unrelated quantization step — not something this command builds. Refusing
 * the whole conversion just because a conversion layer exists elsewhere in
 * the stack would be far more hostile than "every raster layer snaps to the
 * palette, the live-converted layer keeps its own colours" — the exact mix
 * `celStorage.ts`'s compositing path already handles correctly today for a
 * sprite created as indexed from the start. `group`/`tilemap` layers have no
 * pixel cels either way, so they are skipped for the same reason.
 *
 * **Undo decision: this *is* one ordinary undoable `Command`.**
 * `history/command.ts`'s own doc comment frames the problem commands exist to
 * solve as "a full document snapshot per keystroke would be ~300 MB" — true
 * for a pencil stroke fired hundreds of times a session, not for an action a
 * user triggers once, deliberately, from a menu. Storing the pre-conversion
 * RGBA bytes of every affected cel is exactly one document-sized snapshot —
 * the same order of magnitude `SetSpritePaletteCommand` already accepts for a
 * whole embedded `Palette`, just bigger — and `memoryCost` (the same field
 * the history budget already reads to evict old steps,
 * `state/historyStore.ts::evict`) makes an oversized one self-limiting rather
 * than unbounded. Silently refusing undo for a lossy, easy-to-fat-finger
 * action would be the worse trade, especially since the command pattern
 * already has the machinery (`memoryCost`, eviction) to absorb it gracefully.
 */

import { celBufferId, type CelId, type Palette } from '../model/types';
import { getBuffer, releaseBuffer, setBuffer } from '../model/pixelBuffers';
import { releaseIndexBuffer, setIndexBuffer } from '../model/indexBuffers';
import { nearestPaletteIndex } from '../model/indexedColor';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import type { Command, DocumentApi } from './command';

interface CelConversion {
  /** `celBufferId` — the id the two buffer stores are actually keyed on. */
  bufferId: CelId;
  /** Pre-conversion bytes, restored on `invert`. */
  rgba: Uint8ClampedArray;
  /** Post-conversion bytes, (re)written on `apply`/redo. */
  indices: Uint8Array;
}

export class ConvertToIndexedCommand implements Command {
  readonly label = 'Convert to Indexed';
  readonly memoryCost: number;

  constructor(
    private readonly paletteBefore: Palette | undefined,
    private readonly paletteAfter: Palette,
    private readonly cels: readonly CelConversion[],
  ) {
    // Two full copies per affected cel (before + after) — an accurate,
    // deliberately generous estimate, not the rough "small and bounded" one
    // `SetSpritePaletteCommand` uses for a palette alone.
    this.memoryCost = cels.reduce((n, c) => n + c.rgba.byteLength + c.indices.byteLength, 0);
  }

  apply(doc: DocumentApi): void {
    for (const c of this.cels) {
      releaseBuffer(c.bufferId);
      setIndexBuffer(c.bufferId, c.indices);
    }
    doc.setColorMode('indexed', this.paletteAfter);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    for (const c of this.cels) {
      releaseIndexBuffer(c.bufferId);
      setBuffer(c.bufferId, c.rgba);
    }
    doc.setColorMode('rgba', this.paletteBefore);
    doc.touch();
  }
}

export type ConvertToIndexedResult =
  { ok: true } | { ok: false; reason: 'already-indexed' | 'empty-palette' };

/**
 * Snap every pixel of every `raster` layer's cel (across every frame) to its
 * nearest colour in `palette`, via the exact same Oklab out-of-palette policy
 * painting already uses (`model/indexedColor.ts::nearestPaletteIndex`, not a
 * second one), then flip `Sprite.colorMode`. Pushes one undoable `Command`.
 *
 * A linked cel (`Cel.linkedTo`) shares its target's buffer id
 * (`model/types.ts::celBufferId`), so this walks unique buffer ids rather
 * than unique cels — converting the same shared buffer twice would be
 * harmless but wasteful, and would double-count it in `memoryCost`.
 */
export function convertSpriteToIndexed(palette: Palette): ConvertToIndexedResult {
  const doc = useDocumentStore.getState();
  if (doc.sprite.colorMode === 'indexed') return { ok: false, reason: 'already-indexed' };
  if (palette.colors.length === 0) return { ok: false, reason: 'empty-palette' };

  const seen = new Set<CelId>();
  const cels: CelConversion[] = [];

  for (const layer of doc.sprite.layers) {
    if (layer.kind !== 'raster') continue; // group/tilemap: no pixel cels; conversion: stays RGBA
    for (const cel of doc.celsForLayer(layer.id)) {
      const bufferId = celBufferId(cel);
      if (seen.has(bufferId)) continue;
      seen.add(bufferId);

      const rgba = getBuffer(bufferId);
      if (!rgba) continue; // defensive — every raster cel should have an RGBA buffer pre-conversion

      const indices = new Uint8Array(cel.width * cel.height);
      for (let p = 0; p < indices.length; p++) {
        const i = p * 4;
        indices[p] = nearestPaletteIndex([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], palette);
      }
      cels.push({ bufferId, rgba: rgba.slice(), indices });
    }
  }

  const embedded: Palette = { ...palette, colors: [...palette.colors] };
  const cmd = new ConvertToIndexedCommand(doc.sprite.palette, embedded, cels);
  cmd.apply(doc);
  useHistoryStore.getState().push(cmd);
  return { ok: true };
}
