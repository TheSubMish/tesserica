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

import { useRef, useState } from 'react';
import { sameRgb, toCss, toHex } from '../lib/color';
import { parsePaletteFile } from '../lib/formats/palette';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';

/** Extensions the parsers understand (`docs/03-data-model.md` §3). */
const ACCEPT = '.hex,.gpl,.pal,.txt';

export function PalettePanel() {
  const palettes = usePaletteStore((s) => s.palettes);
  const activePaletteId = usePaletteStore((s) => s.activePaletteId);
  const primary = useToolStore((s) => s.primary);

  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const palette = palettes.find((p) => p.id === activePaletteId) ?? palettes[0];

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        usePaletteStore.getState().addPalette(parsePaletteFile(file.name, bytes));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    // Let the same file be picked twice in a row.
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Palette</span>
        <span>
          <button
            title={`Import palette (${ACCEPT})`}
            aria-label="Import palette"
            onClick={() => fileInput.current?.click()}
          >
            ⬇
          </button>
        </span>
      </div>

      {/* Read in the WebView with the File API rather than through a Tauri
          command: palette files are kilobytes, and this keeps Phase 1 free of
          filesystem permissions it does not otherwise need. */}
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        aria-label="Palette file"
        onChange={(e) => void importFiles(e.target.files)}
      />

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

      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
