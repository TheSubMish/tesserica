/**
 * Options for the active tool.
 *
 * Only the options that apply to the current tool are shown — the alternative
 * is a wall of controls that are mostly inert, which makes it harder to see
 * the ones that matter.
 */

import { applyTransform, canApplyTransform } from '../canvas/applyTransform';
import { SliderField } from '../app/SliderField';
import { useToolStore, type SelectMode } from '../state/toolStore';
import { BRUSH_SHAPES, INKS, type Ink } from '../tools/brush';
import { MIRRORABLE_TOOLS } from '../tools/symmetry';
import { Icon } from '../ui/icons';
import { toolLabel } from './toolMeta';

const SELECT_MODES: { id: SelectMode; label: string }[] = [
  { id: 'rect', label: 'Rect' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'lasso', label: 'Lasso' },
  { id: 'wand', label: 'Wand' },
];

export function ToolOptions() {
  const tool = useToolStore((s) => s.activeTool);
  const brushSize = useToolStore((s) => s.brushSize);
  const brushShape = useToolStore((s) => s.brushShape);
  const ink = useToolStore((s) => s.ink);
  const symmetryX = useToolStore((s) => s.symmetryX);
  const symmetryY = useToolStore((s) => s.symmetryY);
  const pixelPerfect = useToolStore((s) => s.pixelPerfect);
  const shapeFill = useToolStore((s) => s.shapeFill);
  const fillContiguous = useToolStore((s) => s.fillContiguous);
  const selectMode = useToolStore((s) => s.selectMode);
  const transformAlgorithm = useToolStore((s) => s.transformAlgorithm);
  const transformAngle = useToolStore((s) => s.transformAngle);
  const transformScale = useToolStore((s) => s.transformScale);

  const hasBrush = tool === 'pencil' || tool === 'eraser' || tool === 'line';
  const isShape = tool === 'rect' || tool === 'ellipse';

  return (
    <section className="tool-bar" aria-label="Tool options">
      <strong className="tool-bar-name">{toolLabel(tool)}</strong>

      {hasBrush && (
        <SliderField
          label="Size"
          min={1}
          max={16}
          value={brushSize}
          onChange={(v) => useToolStore.getState().setBrushSize(v)}
        />
      )}

      {hasBrush && (
        <div className="brush-shapes" role="radiogroup" aria-label="Brush shape">
          {BRUSH_SHAPES.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={brushShape === b.id}
              aria-pressed={brushShape === b.id}
              title={b.hint}
              disabled={brushSize <= 1}
              onClick={() => useToolStore.getState().setBrushShape(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {(tool === 'pencil' || tool === 'line') && (
        <label className="field">
          <span>Ink</span>
          <select
            aria-label="Ink"
            value={ink}
            title={INKS.find((i) => i.id === ink)?.hint}
            onChange={(e) => useToolStore.getState().setInk(e.target.value as Ink)}
          >
            {INKS.map((i) => (
              <option key={i.id} value={i.id} title={i.hint}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {tool === 'pencil' && (
        <label className="field check">
          <input
            type="checkbox"
            checked={pixelPerfect}
            onChange={(e) => useToolStore.getState().setPixelPerfect(e.target.checked)}
          />
          Pixel-perfect
        </label>
      )}

      {isShape && (
        <label className="field check">
          <input
            type="checkbox"
            checked={shapeFill}
            onChange={(e) => useToolStore.getState().setShapeFill(e.target.checked)}
          />
          Filled
        </label>
      )}

      {tool === 'fill' && (
        <label className="field check">
          <input
            type="checkbox"
            checked={fillContiguous}
            onChange={(e) => useToolStore.getState().setFillContiguous(e.target.checked)}
          />
          Contiguous
        </label>
      )}

      {tool === 'select' && (
        <div className="select-modes" role="radiogroup" aria-label="Selection shape">
          {SELECT_MODES.map((m) => (
            <label key={m.id} className="select-mode-option">
              <input
                type="radio"
                name="select-mode"
                checked={selectMode === m.id}
                onChange={() => useToolStore.getState().setSelectMode(m.id)}
              />
              {m.label}
            </label>
          ))}
        </div>
      )}

      {tool === 'eyedropper' && <p className="hint">Alt picks a colour from any tool.</p>}

      {tool === 'zoom' && <p className="hint">Click to zoom in, Alt+click to zoom out.</p>}

      {tool === 'stamp' && (
        <p className="hint">
          Pick a tile in the Tileset panel, then click or drag on a tile layer to place it.
        </p>
      )}

      {tool === 'transform' && (
        <>
          <label className="field">
            <span>Algorithm</span>
            <select
              aria-label="Transform algorithm"
              value={transformAlgorithm}
              onChange={(e) =>
                useToolStore
                  .getState()
                  .setTransformAlgorithm(e.target.value as 'rotxel' | 'cleanEdge')
              }
            >
              <option value="rotxel">Rotxel (rotation only)</option>
              <option value="cleanEdge">cleanEdge (rotate + scale)</option>
            </select>
          </label>

          <SliderField
            label="Angle"
            min={-180}
            max={180}
            step={1}
            value={transformAngle}
            format={(v) => `${v}°`}
            onChange={(v) => useToolStore.getState().setTransformAngle(v)}
          />

          <SliderField
            label="Scale"
            min={10}
            max={400}
            step={1}
            value={transformScale}
            disabled={transformAlgorithm === 'rotxel'}
            format={(v) => `${v}%`}
            onChange={(v) => useToolStore.getState().setTransformScale(v)}
          />

          <p className="hint long">
            Rotates (and, with cleanEdge, scales) the selection — or the whole layer when nothing is
            selected — in place, using a pixel-art-aware algorithm that never invents a new colour.
          </p>

          <button
            className="primary"
            disabled={!canApplyTransform()}
            onClick={() =>
              applyTransform({
                algorithm: transformAlgorithm,
                angleDegrees: transformAngle,
                scalePercent: transformScale,
              })
            }
          >
            Apply
          </button>
        </>
      )}

      {MIRRORABLE_TOOLS.has(tool) && (
        <div className="symmetry-toggles" role="group" aria-label="Symmetry">
          <button
            type="button"
            aria-pressed={symmetryX}
            title="Mirror left–right across the sprite's centre"
            onClick={() => useToolStore.getState().setSymmetryX(!symmetryX)}
          >
            <Icon name="mirror" size={14} /> X
          </button>
          <button
            type="button"
            aria-pressed={symmetryY}
            title="Mirror top–bottom across the sprite's centre"
            onClick={() => useToolStore.getState().setSymmetryY(!symmetryY)}
          >
            <Icon name="mirror" size={14} /> Y
          </button>
        </div>
      )}
    </section>
  );
}
