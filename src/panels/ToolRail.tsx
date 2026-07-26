import { useToolStore, type ToolId } from '../state/toolStore';
import type { RGBA } from '../model/types';

const rgba = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

/** Order, glyphs and shortcuts follow docs/05-ui-design.md §4.1. */
const TOOLS: { id: ToolId; glyph: string; label: string; key: string }[] = [
  { id: 'pencil', glyph: '✏', label: 'Pencil', key: 'B' },
  { id: 'eraser', glyph: '⌫', label: 'Eraser', key: 'E' },
  { id: 'fill', glyph: '🪣', label: 'Fill', key: 'G' },
  { id: 'line', glyph: '╱', label: 'Line', key: 'L' },
  { id: 'rect', glyph: '▭', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', glyph: '◯', label: 'Ellipse', key: 'O' },
  { id: 'eyedropper', glyph: '💧', label: 'Eyedropper', key: 'I' },
];

export function ToolRail() {
  const activeTool = useToolStore((s) => s.activeTool);
  const primary = useToolStore((s) => s.primary);
  const secondary = useToolStore((s) => s.secondary);

  return (
    <nav className="tool-rail" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className="tool-btn"
          aria-pressed={activeTool === t.id}
          aria-label={`${t.label} (${t.key})`}
          title={`${t.label} — ${t.key}`}
          onClick={() => useToolStore.getState().setTool(t.id)}
        >
          {t.glyph}
        </button>
      ))}

      <div className="rail-sep" />

      <button
        className="swatch"
        style={{ background: rgba(primary) }}
        title="Primary color — X to swap"
        aria-label="Primary color"
        onClick={() => useToolStore.getState().swapColors()}
      />
      <button
        className="swatch"
        style={{ background: rgba(secondary) }}
        title="Secondary color — right-drag to paint with it"
        aria-label="Secondary color"
        onClick={() => useToolStore.getState().swapColors()}
      />
    </nav>
  );
}
