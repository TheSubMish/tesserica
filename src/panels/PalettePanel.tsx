/**
 * Palette panel (`docs/05-ui-design.md` §4).
 *
 * Left click sets the primary colour, right click the secondary — the same
 * convention the canvas uses, so the two halves of the app agree about which
 * button means what.
 *
 * Accessibility (§8): the selected swatch gets a ring *and* `aria-pressed`,
 * never colour alone, and each swatch's label is its hex value so a screen
 * reader announces something meaningful rather than "button".
 */

import { sameRgb, toCss, toHex } from '../lib/color';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';

export function PalettePanel() {
  const palettes = usePaletteStore((s) => s.palettes);
  const activePaletteId = usePaletteStore((s) => s.activePaletteId);
  const primary = useToolStore((s) => s.primary);

  const palette = palettes.find((p) => p.id === activePaletteId) ?? palettes[0];

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Palette</span>
      </div>

      <label className="field">
        <span className="sr-only">Palette</span>
        <select
          aria-label="Palette"
          value={palette.id}
          onChange={(e) => usePaletteStore.getState().setActivePalette(e.target.value)}
        >
          {palettes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <div className="swatch-grid" role="group" aria-label={`${palette.name} colors`}>
        {palette.colors.map((c, i) => (
          <button
            key={`${toHex(c)}-${i}`}
            className="palette-swatch"
            style={{ background: toCss(c) }}
            aria-label={toHex(c)}
            aria-pressed={sameRgb(c, primary)}
            title={`${toHex(c)} — right-click for secondary`}
            onClick={() => useToolStore.getState().setPrimary(c)}
            onContextMenu={(e) => {
              e.preventDefault();
              useToolStore.getState().setSecondary(c);
            }}
          />
        ))}
      </div>

      <p className="hint">
        {palette.name} · {palette.colors.length} colors
      </p>
    </section>
  );
}
