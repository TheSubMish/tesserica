/**
 * Options for the active tool.
 *
 * Only the options that apply to the current tool are shown — the alternative
 * is a wall of controls that are mostly inert, which makes it harder to see
 * the ones that matter.
 */

import { useToolStore } from '../state/toolStore';

export function ToolOptions() {
  const tool = useToolStore((s) => s.activeTool);
  const brushSize = useToolStore((s) => s.brushSize);
  const pixelPerfect = useToolStore((s) => s.pixelPerfect);
  const shapeFill = useToolStore((s) => s.shapeFill);
  const fillContiguous = useToolStore((s) => s.fillContiguous);

  const hasBrush = tool === 'pencil' || tool === 'eraser' || tool === 'line';
  const isShape = tool === 'rect' || tool === 'ellipse';

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Tool</span>
      </div>

      {hasBrush && (
        <label className="field">
          Size
          <input
            type="range"
            min={1}
            max={16}
            value={brushSize}
            onChange={(e) => useToolStore.getState().setBrushSize(Number(e.target.value))}
          />
          <span className="value">{brushSize}</span>
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

      {tool === 'eyedropper' && <p className="hint">Alt picks a colour from any tool.</p>}
    </section>
  );
}
