import { useState } from 'react';

import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import type { DitherMode, DownscaleMode } from '../pipeline/settings.ts';
import {
  MAX_PIXEL_SIZE,
  MIN_PIXEL_SIZE,
  paletteColors,
  targetSize,
  useConvertStore,
} from '../state/convertStore';

/**
 * Convert mode's right rail (`docs/05-ui-design.md` §3).
 *
 * **Only four controls are visible**: pixel size, palette, dither, strength.
 * Everything else lives behind collapsed sections. That restraint is what makes
 * the 10-second path (workflow W6) achievable — not a lack of features, but a
 * deliberate ordering of them.
 */

const DITHER_LABELS: ReadonlyArray<{ value: DitherMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'floyd-steinberg', label: 'Floyd–Steinberg' },
  { value: 'atkinson', label: 'Atkinson' },
  { value: 'bayer2', label: 'Bayer 2×2' },
  { value: 'bayer4', label: 'Bayer 4×4' },
  { value: 'bayer8', label: 'Bayer 8×8' },
];

const DOWNSCALE_LABELS: ReadonlyArray<{ value: DownscaleMode; label: string }> = [
  { value: 'box', label: 'Box average' },
  { value: 'nearest', label: 'Nearest (source is pixel art)' },
  { value: 'dominant', label: 'Dominant colour' },
];

export interface ConvertPanelProps {
  readonly onExport: () => void;
  readonly onEdit: () => void;
}

export function ConvertPanel({ onExport, onEdit }: ConvertPanelProps) {
  const state = useConvertStore();
  const { width, height } = targetSize(state);
  const colors = paletteColors(state.paletteId);
  const ready = state.source !== undefined;

  return (
    <aside className="panels convert-panel" aria-label="Convert settings">
      <section className="panel">
        <h2>Convert</h2>

        <label className="field">
          <span>Pixel size</span>
          <input
            type="range"
            min={MIN_PIXEL_SIZE}
            max={MAX_PIXEL_SIZE}
            value={state.pixelSize}
            onChange={(e) => state.setPixelSize(Number(e.target.value))}
          />
          <output>{state.pixelSize}</output>
        </label>

        <p className="field-note">
          Output{' '}
          <strong>
            {width || '—'} × {height || '—'}
          </strong>
        </p>
      </section>

      <section className="panel">
        <label className="field">
          <span>Palette</span>
          <select value={state.paletteId} onChange={(e) => state.setPaletteId(e.target.value)}>
            {BUILTIN_PALETTES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.colors.length})
              </option>
            ))}
          </select>
        </label>

        <ul className="swatch-strip" aria-label="Palette colours">
          {colors.map((c, i) => (
            <li
              key={`${c[0]}-${c[1]}-${c[2]}-${i}`}
              style={{ background: `rgb(${c[0]} ${c[1]} ${c[2]})` }}
              title={`#${[c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`}
            />
          ))}
        </ul>

        <label className="field">
          <span>Dither</span>
          <select
            value={state.dither}
            onChange={(e) => state.setDither(e.target.value as DitherMode)}
          >
            {DITHER_LABELS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Strength</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.ditherStrength}
            disabled={state.dither === 'none'}
            onChange={(e) => state.setDitherStrength(Number(e.target.value))}
          />
          <output>{state.ditherStrength.toFixed(2)}</output>
        </label>
      </section>

      <Collapsible title="Adjustments">
        <Slider
          label="Brightness"
          value={state.brightness}
          onChange={(brightness) => state.setAdvanced({ brightness })}
        />
        <Slider
          label="Contrast"
          value={state.contrast}
          onChange={(contrast) => state.setAdvanced({ contrast })}
        />
        <Slider
          label="Saturation"
          value={state.saturation}
          onChange={(saturation) => state.setAdvanced({ saturation })}
        />
        <label className="field">
          <span>Hue</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={state.hueShift}
            onChange={(e) => state.setAdvanced({ hueShift: Number(e.target.value) })}
          />
          <output>{state.hueShift}°</output>
        </label>
      </Collapsible>

      <Collapsible title="Cleanup">
        <label className="field">
          <span>Downscale</span>
          <select
            value={state.downscaleMode}
            onChange={(e) => state.setAdvanced({ downscaleMode: e.target.value as DownscaleMode })}
          >
            {DOWNSCALE_LABELS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Despeckle</span>
          <input
            type="range"
            min={0}
            max={3}
            step={1}
            value={state.despeckle}
            onChange={(e) => state.setAdvanced({ despeckle: Number(e.target.value) })}
          />
          <output>{state.despeckle}</output>
        </label>
        <label className="field">
          <span>Alpha cut</span>
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={state.alphaThreshold}
            onChange={(e) => state.setAdvanced({ alphaThreshold: Number(e.target.value) })}
          />
          <output>{state.alphaThreshold}</output>
        </label>
      </Collapsible>

      <section className="panel convert-actions">
        <button type="button" onClick={onExport} disabled={!ready}>
          Export…
        </button>
        {/* The product thesis in one control (D6): conversion becomes a live,
            re-editable layer rather than a PNG dump. */}
        <button type="button" className="primary" onClick={onEdit} disabled={!ready}>
          Edit →
        </button>
      </section>
    </aside>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value.toFixed(2)}</output>
    </label>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <button
        type="button"
        className="collapsible-header"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}
