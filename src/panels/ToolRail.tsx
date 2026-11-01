import { useEffect, useRef, useState } from 'react';

import { useToolStore } from '../state/toolStore';
import type { RGBA } from '../model/types';
import { Icon } from '../ui/icons';
import { TOOLS } from './toolMeta';
import { makeRamp, nearestInPalette } from '../lib/colorSpaces';
import { toHex } from '../lib/color';
import { usePaletteStore } from '../state/paletteStore';
import { ColorPicker } from './ColorPicker';

const rgba = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

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
          <Icon name={t.glyph} size={18} />
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
      const t = useToolStore.getState();
      t.pushRecentColor(editing === 'primary' ? t.primary : t.secondary);
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
        <Icon name="swap" size={14} />
      </button>
      {editing && (
        <div className="color-popover" role="dialog" aria-label={`Edit ${editing} color`}>
          <ColorPicker
            color={editing === 'primary' ? primary : secondary}
            onChange={(picked) => {
              const t = useToolStore.getState();
              const c = t.lockToPalette
                ? nearestInPalette(picked, usePaletteStore.getState().activePalette().colors)
                : picked;
              if (editing === 'primary') t.setPrimary(c);
              else t.setSecondary(c);
            }}
          />
          <ColorExtras
            color={editing === 'primary' ? primary : secondary}
            onPick={(c) =>
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

const RAMP_STEPS = [3, 5, 7, 9] as const;

/** Recent colours, shading-ramp generation and lock-to-palette, under the picker. */
function ColorExtras({ color, onPick }: { color: RGBA; onPick: (c: RGBA) => void }) {
  const recent = useToolStore((s) => s.recentColors);
  const lock = useToolStore((s) => s.lockToPalette);
  const paletteName = usePaletteStore((s) => s.activePalette().name);
  const [steps, setSteps] = useState<(typeof RAMP_STEPS)[number]>(5);
  const [added, setAdded] = useState(false);

  const addRamp = (): void => {
    const colors = makeRamp(color, steps);
    for (const c of colors) usePaletteStore.getState().addCustomColor(c);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1600);
  };

  return (
    <div className="color-extras">
      {recent.length > 0 && (
        <div className="color-recent" role="group" aria-label="Recent colours">
          {recent.map((c) => (
            <button
              key={toHex(c)}
              type="button"
              className="color-recent-swatch"
              style={{ background: rgba(c) }}
              title={toHex(c)}
              aria-label={`Use ${toHex(c)}`}
              onClick={() => onPick(c)}
            />
          ))}
        </div>
      )}

      <div className="color-ramp">
        <select
          aria-label="Ramp length"
          value={steps}
          onChange={(e) => setSteps(Number(e.target.value) as (typeof RAMP_STEPS)[number])}
        >
          {RAMP_STEPS.map((n) => (
            <option key={n} value={n}>
              {n} shades
            </option>
          ))}
        </select>
        <button
          type="button"
          title="Add a shadow-to-highlight ramp of this colour to your Custom palette"
          onClick={addRamp}
        >
          {added ? 'Added ✓' : 'Make ramp'}
        </button>
      </div>
      <div className="color-ramp-preview" aria-hidden="true">
        {makeRamp(color, steps).map((c, i) => (
          <span key={i} style={{ background: rgba(c) }} />
        ))}
      </div>

      <label className="color-lock">
        <input
          type="checkbox"
          checked={lock}
          onChange={(e) => useToolStore.getState().setLockToPalette(e.target.checked)}
        />
        Lock to palette
        <small>{paletteName}</small>
      </label>
    </div>
  );
}
