/**
 * Wires `transform.ts`'s rotxel/cleanEdge into the document — the "Transform"
 * tool (`docs/08-roadmap.md` Phase 7).
 *
 * Not a drag tool like `Move` — it is a one-shot action with numeric
 * parameters (angle, scale, algorithm), the same shape `LayerEffectsSection`'s
 * sliders are, so it reuses the document's plain command-pattern undo
 * (`beginStroke`/`finishStroke`, `history/strokeRecorder.ts`) rather than the
 * pointer-gesture `Tool` interface — `tools/transform.ts` registers a
 * read-only no-op `Tool` purely so `transform` is a selectable `ToolId` that
 * shows the right options panel; the actual edit happens here, from an
 * "Apply" button.
 *
 * Operates on the active selection's **bounding box** (or the whole cel when
 * nothing is selected), not the selection's mask shape — a rotation does not
 * preserve which destination cell each masked source cell lands on, so unlike
 * `Move` (a pure translation, where the mask maps cell-for-cell) there is no
 * well-defined way to keep the mask's shape through an arbitrary rotation.
 * This is the same rectangular footprint `Move`'s own `bounds` uses.
 */

import { getBuffer } from '../model/pixelBuffers';
import { celBufferId } from '../model/types';
import { intersectRect, type Rect } from '../model/rect';
import { isEffectivelyLocked, isEffectivelyVisible } from '../model/layerTree';
import { blitRegion, extractRegion } from '../history/pixelDelta';
import { beginStroke, finishStroke } from '../history/strokeRecorder';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { cleanEdgeTransform, rotxelRotate, type TransformAlgorithm } from './transform';

export interface TransformSettings {
  algorithm: TransformAlgorithm;
  angleDegrees: number;
  /** Ignored for `rotxel` — a rotation-only algorithm, matching Pixelorama's
   * own CPU `rotxel()` (no scale parameter exists in the source). */
  scalePercent: number;
}

/** Whether `applyTransform` currently has anything to act on. */
export function canApplyTransform(): boolean {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);
  if (!layer || layer.kind === 'group' || layer.kind === 'tilemap') return false;
  if (isEffectivelyLocked(doc.sprite.layers, layer.id)) return false;
  if (!isEffectivelyVisible(doc.sprite.layers, layer.id)) return false;
  const cel = doc.activeCel();
  if (!cel) return false;
  return !!getBuffer(celBufferId(cel));
}

/** Rotate/scale the active cel's selection bounds (or the whole cel). Undoable. */
export function applyTransform(settings: TransformSettings): void {
  if (!canApplyTransform()) return;
  const doc = useDocumentStore.getState();
  const cel = doc.activeCel();
  if (!cel) return;
  const bufferId = celBufferId(cel);
  const buffer = getBuffer(bufferId);
  if (!buffer) return;

  const full: Rect = { x: 0, y: 0, width: cel.width, height: cel.height };
  const selection = useSelectionStore.getState().selection;
  const bounds = intersectRect(selection?.bounds ?? full, full);
  if (bounds.width <= 0 || bounds.height <= 0) return;

  const snapshot = beginStroke(bufferId, buffer, cel.width, cel.height);

  const region = extractRegion(buffer, cel.width, bounds);
  const angleRad = (settings.angleDegrees * Math.PI) / 180;
  const scale = Math.max(0.01, settings.scalePercent / 100);
  const transformed =
    settings.algorithm === 'rotxel'
      ? rotxelRotate(region, bounds.width, bounds.height, angleRad)
      : cleanEdgeTransform(region, bounds.width, bounds.height, angleRad, scale);

  blitRegion(buffer, cel.width, bounds, transformed);
  doc.touch(bufferId);

  const cmd = finishStroke(snapshot, buffer, 'Transform');
  if (cmd) useHistoryStore.getState().push(cmd);
}
