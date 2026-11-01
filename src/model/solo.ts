import { ancestorsOf, descendantIds } from './layerTree';
import type { LayerId, Sprite } from './types';

/**
 * The sprite as the canvas should draw it while one layer is soloed
 * (`docs/03-data-model.md` §6.2): that layer, its ancestor groups (a layer inside
 * a group cannot show without it) and, for a soloed group, its own contents keep
 * showing; every other layer is hidden.
 *
 * Returns the same sprite object when nothing is soloed, or when the soloed layer
 * no longer exists — so a stale id never blanks the canvas, and callers can use
 * identity to skip work. The result shares cels with the original; only layer
 * `visible` flags differ, and it is for display only (export never sees it).
 */
export function withSolo(sprite: Sprite, soloId: LayerId | null): Sprite {
  if (!soloId || !sprite.layers.some((l) => l.id === soloId)) return sprite;

  const shown = new Set<LayerId>([soloId, ...ancestorsOf(sprite.layers, soloId).map((a) => a.id)]);
  const inside = new Set<LayerId>(descendantIds(sprite.layers, soloId));

  return {
    ...sprite,
    layers: sprite.layers.map((l) => {
      if (shown.has(l.id)) return l.visible ? l : { ...l, visible: true };
      if (inside.has(l.id)) return l; // a soloed group's own children keep their own flag
      return l.visible ? { ...l, visible: false } : l;
    }),
  };
}
