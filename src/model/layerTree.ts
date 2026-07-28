/**
 * Layer-tree helpers over the flat `Sprite.layers` array (`docs/03-data-model.md`
 * §2.1).
 *
 * Nesting is expressed with `parentId` pointers into that same flat array —
 * there is no separate tree structure. A layer's siblings are every layer
 * sharing its `parentId`, in the order they appear in the flat array.
 *
 * **Design choice: children need not be contiguous with their group, or with
 * each other.** A layer's flat-array position only matters relative to its
 * *siblings* (same `parentId`); everything in between belongs to some other
 * scope and is simply skipped by `childrenOf`'s filter. This is what lets
 * `moveLayer` (`history/layerCommands.ts`) implement "move up/down the stack"
 * as a plain two-element swap instead of reshuffling the whole array to keep
 * a group's members adjacent.
 */

import type { Layer, LayerId } from './types';

/** Direct children of `parentId`, in stack order (bottom → top). */
export function childrenOf(layers: readonly Layer[], parentId: LayerId | null): Layer[] {
  return layers.filter((l) => l.parentId === parentId);
}

/** Every descendant of `id`, any depth, in no particular order. */
export function descendantIds(layers: readonly Layer[], id: LayerId): LayerId[] {
  const out: LayerId[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of childrenOf(layers, cur)) {
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** Ancestor chain of `id`, immediate parent first, root last. */
export function ancestorsOf(layers: readonly Layer[], id: LayerId): Layer[] {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const out: Layer[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur !== null) {
    const parent = byId.get(cur);
    if (!parent) break;
    out.push(parent);
    cur = parent.parentId;
  }
  return out;
}

/** Nesting depth — 0 for a top-level layer. Used to indent the layer panel. */
export function depthOf(layers: readonly Layer[], id: LayerId): number {
  return ancestorsOf(layers, id).length;
}

/**
 * A hidden group hides everything inside it regardless of the descendant's
 * own `visible` flag (roadmap Phase 3, "Layer groups, clipping masks").
 */
export function isEffectivelyVisible(layers: readonly Layer[], id: LayerId): boolean {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const self = byId.get(id);
  if (!self || !self.visible) return false;
  return ancestorsOf(layers, id).every((a) => a.visible);
}

/** A locked group locks every descendant for editing, same reasoning. */
export function isEffectivelyLocked(layers: readonly Layer[], id: LayerId): boolean {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const self = byId.get(id);
  if (self?.locked) return true;
  return ancestorsOf(layers, id).some((a) => a.locked);
}

/**
 * True when re-parenting `id` under `newParentId` would nest a layer inside
 * its own descendant (a cycle). `newParentId === id` is also rejected.
 */
export function wouldCreateCycle(
  layers: readonly Layer[],
  id: LayerId,
  newParentId: LayerId | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  return descendantIds(layers, id).includes(newParentId);
}
