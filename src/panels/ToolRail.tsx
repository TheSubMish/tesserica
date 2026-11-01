import { useEffect, useRef, useState } from 'react';

import { useToolStore, type ToolId } from '../state/toolStore';
import type { RGBA } from '../model/types';
import { ColorPicker } from './ColorPicker';

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
  { id: 'select', glyph: '⬚', label: 'Select', key: 'M' },
  { id: 'move', glyph: '⇄', label: 'Move', key: 'V' },
  { id: 'zoom', glyph: '🔍', label: 'Zoom', key: 'Z' },
  { id: 'stamp', glyph: '🧩', label: 'Stamp', key: 'S' },
  // Phase 7 — rotxel/cleanEdge rotate & scale (`docs/08-roadmap.md`), added
  // beyond the `05-ui-design.md` §4.1 v1 table the same way Stamp was.
  { id: 'transform', glyph: '⟳', label: 'Transform', key: 'R' },
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

      <ColorSwatches primary={primary} secondary={secondary} />
    </nav>
  );
}

/**
 * The two paint colours. Clicking a swatch opens the colour picker for that
 * colour; the small arrow swaps them (also `X`). Before this, clicking a
 * swatch could only swap — there was no way to choose a colour that was not
 * already in a palette.
 */
function ColorSwatches({ primary, secondary }: { primary: RGBA; secondary: RGBA }) {
  const [editing, setEditing] = useState<'primary' | 'secondary' | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const away = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setEditing(undefined);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditing(undefined);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [editing]);

  const toggle = (which: 'primary' | 'secondary'): void =>
    setEditing((cur) => (cur === which ? undefined : which));

  return (
    <div className="swatch-stack" ref={root}>
      <button
        className="swatch"
        style={{ background: rgba(primary) }}
        title="Primary color — click to edit"
        aria-label="Primary color"
        aria-expanded={editing === 'primary'}
        onClick={() => toggle('primary')}
      />
      <button
        className="swatch"
        style={{ background: rgba(secondary) }}
        title="Secondary color — click to edit; right-drag paints with it"
        aria-label="Secondary color"
        aria-expanded={editing === 'secondary'}
        onClick={() => toggle('secondary')}
      />
      <button
        className="swatch-swap"
        title="Swap colors — X"
        aria-label="Swap primary and secondary colors"
        onClick={() => useToolStore.getState().swapColors()}
      >
        ⇅
      </button>
      {editing && (
        <div className="color-popover" role="dialog" aria-label={`Edit ${editing} color`}>
          <ColorPicker
            color={editing === 'primary' ? primary : secondary}
            onChange={(c) =>
              editing === 'primary'
                ? useToolStore.getState().setPrimary(c)
                : useToolStore.getState().setSecondary(c)
            }
          />
        </div>
      )}
    </div>
  );
}
