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
import { fromHex, sameRgb, toCss, toHex } from '../lib/color';
import { COLOR_BLIND_MODES, simulateColorBlindness, type ColorBlindMode } from '../lib/colorBlind';
import { parsePaletteFile } from '../lib/formats/palette';
import { convertSpriteToIndexed } from '../history/colorModeCommands';
import { assignSpritePalette, recolorSpritePaletteEntry } from '../history/paletteCommands';
import { useDocumentStore } from '../state/documentStore';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';
import { LospecImportSection } from './LospecImportSection';

/** Extensions the parsers understand (`docs/03-data-model.md` §3). */
const ACCEPT = '.hex,.gpl,.pal,.txt';

export function PalettePanel() {
  const palettes = usePaletteStore((s) => s.palettes);
  const activePaletteId = usePaletteStore((s) => s.activePaletteId);
  const primary = useToolStore((s) => s.primary);
  // `docs/08-roadmap.md` Phase 7 — an indexed-mode sprite owns its own
  // embedded palette, distinct from the session picker above (which still
  // works normally: any colour chosen from it gets snapped to the sprite's
  // own nearest palette entry when painting, `model/indexedColor.ts`).
  const spriteColorMode = useDocumentStore((s) => s.sprite.colorMode);
  const spritePalette = useDocumentStore((s) => s.sprite.palette);

  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Session-only: a simulation preview, not a document setting, so it does
  // not belong in a persisted store (`docs/05-ui-design.md` §8).
  const [colorBlind, setColorBlind] = useState<ColorBlindMode>('none');

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

      <LospecImportSection />

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
        {palette.colors.map((c, i) => {
          // The swatch always *picks* the true colour — simulation previews
          // what the palette looks like, it does not change what gets painted.
          const shown = simulateColorBlindness(c, colorBlind);
          const isCustom = palette.source?.kind === 'custom';
          const swatch = (
            <button
              className="palette-swatch"
              style={{ background: toCss(shown) }}
              aria-label={
                colorBlind === 'none' ? toHex(c) : `${toHex(c)}, simulated as ${toHex(shown)}`
              }
              aria-pressed={sameRgb(c, primary)}
              title={`${toHex(c)} — right-click for secondary`}
              onClick={() => useToolStore.getState().setPrimary(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                useToolStore.getState().setSecondary(c);
              }}
            />
          );
          // Only the hand-built Custom palette is editable in place — every
          // other palette (bundled, imported, Lospec) is a fixed list, so a
          // remove affordance only appears here.
          if (!isCustom)
            return (
              <span key={`${toHex(c)}-${i}`} className="palette-swatch-cell">
                {swatch}
              </span>
            );
          return (
            <div key={`${toHex(c)}-${i}`} className="palette-swatch-custom-wrap">
              {swatch}
              <button
                className="palette-swatch-remove"
                aria-label={`Remove ${toHex(c)} from Custom palette`}
                title="Remove from Custom palette"
                onClick={() => usePaletteStore.getState().removeCustomColor(i)}
              >
                ×
              </button>
            </div>
          );
        })}
        <label
          className="palette-swatch palette-swatch-add"
          title="Add a custom color (opens color picker)"
        >
          <span className="sr-only">Add custom color to your palette</span>
          <input
            type="color"
            aria-label="Add custom color to your palette"
            className="sr-only"
            value="#ffffff"
            onChange={(e) =>
              usePaletteStore.getState().addCustomColor(fromHex(e.target.value, 255))
            }
          />
          <span aria-hidden="true">+</span>
        </label>
      </div>

      <label className="field">
        <span>Simulate</span>
        <select
          aria-label="Simulate colour blindness"
          value={colorBlind}
          onChange={(e) => setColorBlind(e.target.value as ColorBlindMode)}
        >
          {COLOR_BLIND_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <p className="hint">
        {palette.name} · {palette.colors.length} colors
      </p>

      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}

      {spriteColorMode === 'rgba' && (
        <div className="palette-sprite-section">
          <div className="panel-head">
            <span>Color Mode</span>
          </div>
          <p className="hint">
            Convert this sprite to indexed colour, snapping every pixel on every layer to the
            selected palette above ({palette.name}). Colours not already in the palette snap to
            their nearest match. Undoable.
          </p>
          <button
            onClick={() => {
              const result = convertSpriteToIndexed(palette);
              setError(
                result.ok
                  ? null
                  : result.reason === 'empty-palette'
                    ? 'Pick a palette with at least one colour first.'
                    : 'This sprite is already indexed.',
              );
            }}
          >
            Convert to Indexed…
          </button>
        </div>
      )}

      {spriteColorMode === 'indexed' && (
        <div className="palette-sprite-section">
          <div className="panel-head">
            <span>This Sprite&rsquo;s Palette</span>
          </div>

          <label className="field">
            <span className="sr-only">Assign a different palette to this sprite</span>
            <select
              aria-label="Assign a different palette to this sprite"
              value=""
              onChange={(e) => {
                const p = palettes.find((x) => x.id === e.target.value);
                if (p) assignSpritePalette(p);
                e.target.value = '';
              }}
            >
              <option value="" disabled>
                Assign palette…
              </option>
              {palettes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <p className="hint">
            Every pixel is one of these colours. Swap the palette above, or click a swatch below to
            recolor it — the whole sprite updates instantly, no pixels are touched.
          </p>

          <div
            className="swatch-grid"
            role="group"
            aria-label={`${spritePalette?.name ?? 'Sprite'} colors — click to recolor`}
          >
            {(spritePalette?.colors ?? []).map((c, i) => (
              <label
                key={i}
                className="palette-swatch-recolor"
                title={`${toHex(c)} — click to recolor`}
              >
                <span className="sr-only">
                  Recolor sprite palette entry {i + 1} ({toHex(c)})
                </span>
                <input
                  type="color"
                  aria-label={`Recolor sprite palette entry ${i + 1}`}
                  value={toHex(c)}
                  onChange={(e) => recolorSpritePaletteEntry(i, fromHex(e.target.value, c[3]))}
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
