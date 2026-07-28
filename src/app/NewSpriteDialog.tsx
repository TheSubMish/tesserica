/**
 * `Ctrl+N` — New Sprite dialog (`docs/06-workflows.md` W2 step 1).
 *
 * Presets plus a custom size, a fixed colour mode, and a starting palette —
 * the exact three fields the workflow names, no more. Confirming replaces the
 * current document via `createNewSprite`, which is the same `replaceDocument`
 * primitive `openProject` and `[ Edit → ]` use.
 */

import { useState } from 'react';
import { usePaletteStore } from '../state/paletteStore';
import { createNewSprite, MAX_SPRITE_SIZE, MIN_SPRITE_SIZE } from './newSprite';

/** `docs/06-workflows.md` W2 step 1. */
const PRESETS = [16, 32, 64, 128] as const;

export function NewSpriteDialog({ onClose }: { onClose: () => void }) {
  const palettes = usePaletteStore((s) => s.palettes);
  const activePaletteId = usePaletteStore((s) => s.activePaletteId);

  const [preset, setPreset] = useState<(typeof PRESETS)[number] | 'custom'>(32);
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const [paletteId, setPaletteId] = useState(activePaletteId);

  const clampedWidth = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, width)));
  const clampedHeight = Math.round(Math.max(MIN_SPRITE_SIZE, Math.min(MAX_SPRITE_SIZE, height)));
  const valid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

  const choosePreset = (size: (typeof PRESETS)[number]) => {
    setPreset(size);
    setWidth(size);
    setHeight(size);
  };

  const create = () => {
    createNewSprite({ width: clampedWidth, height: clampedHeight, paletteId });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New sprite"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>New Sprite</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <fieldset className="scale-row">
          <legend className="sr-only">Size</legend>
          {PRESETS.map((size) => (
            <button
              key={size}
              className="scale-btn"
              aria-pressed={preset === size}
              onClick={() => choosePreset(size)}
            >
              {size}²
            </button>
          ))}
          <button
            className="scale-btn"
            aria-pressed={preset === 'custom'}
            onClick={() => setPreset('custom')}
          >
            Custom
          </button>
        </fieldset>

        {preset === 'custom' && (
          <div className="field dims-row">
            <label>
              <span className="sr-only">Width</span>
              <input
                type="number"
                className="dim-input"
                aria-label="Width"
                min={MIN_SPRITE_SIZE}
                max={MAX_SPRITE_SIZE}
                value={width}
                onChange={(e) => setWidth(e.target.valueAsNumber)}
              />
            </label>
            <span aria-hidden="true">×</span>
            <label>
              <span className="sr-only">Height</span>
              <input
                type="number"
                className="dim-input"
                aria-label="Height"
                min={MIN_SPRITE_SIZE}
                max={MAX_SPRITE_SIZE}
                value={height}
                onChange={(e) => setHeight(e.target.valueAsNumber)}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span>Color mode</span>
          {/* D9 — v1 is RGBA only. Shown rather than hidden so the field exists
              when indexed mode lands in Phase 7, but nothing here implements it. */}
          <select aria-label="Color mode" value="rgba" disabled>
            <option value="rgba">RGBA</option>
          </select>
        </label>

        <label className="field">
          <span>Palette</span>
          <select
            aria-label="Starting palette"
            value={paletteId}
            onChange={(e) => setPaletteId(e.target.value)}
          >
            {palettes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <p className="hint">
          {clampedWidth}×{clampedHeight}
        </p>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={create}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
