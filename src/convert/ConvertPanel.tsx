import { useState } from 'react';

import { SliderField } from '../app/SliderField';
import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import type { DitherMode, DownscaleMode } from '../pipeline/settings.ts';
import { SegmentModelSection } from '../segment/SegmentModelSection.tsx';
import {
  MAX_BACKGROUND_REMOVAL_TOLERANCE,
  MAX_MASK_CLOSE,
  MAX_MASK_FEATHER,
  MAX_MASK_THRESHOLD,
  MAX_PIXEL_SIZE,
  MIN_BACKGROUND_REMOVAL_TOLERANCE,
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

        <SliderField
          label="Pixel size"
          min={MIN_PIXEL_SIZE}
          max={MAX_PIXEL_SIZE}
          value={state.pixelSize}
          onChange={(v) => state.setPixelSize(v)}
        />

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

        <SliderField
          label="Strength"
          min={0}
          max={1}
          step={0.05}
          value={state.ditherStrength}
          disabled={state.dither === 'none'}
          format={(v) => v.toFixed(2)}
          onChange={(v) => state.setDitherStrength(v)}
        />
      </section>

      <Collapsible title="Adjustments">
        <SliderField
          label="Brightness"
          min={-1}
          max={1}
          step={0.05}
          value={state.brightness}
          format={(v) => v.toFixed(2)}
          onChange={(brightness) => state.setAdvanced({ brightness })}
        />
        <SliderField
          label="Contrast"
          min={-1}
          max={1}
          step={0.05}
          value={state.contrast}
          format={(v) => v.toFixed(2)}
          onChange={(contrast) => state.setAdvanced({ contrast })}
        />
        <SliderField
          label="Saturation"
          min={-1}
          max={1}
          step={0.05}
          value={state.saturation}
          format={(v) => v.toFixed(2)}
          onChange={(saturation) => state.setAdvanced({ saturation })}
        />
        <SliderField
          label="Hue"
          min={-180}
          max={180}
          value={state.hueShift}
          format={(v) => `${v}°`}
          onChange={(hueShift) => state.setAdvanced({ hueShift })}
        />
      </Collapsible>

      <Collapsible title="Background">
        <label className="field check">
          <input
            type="checkbox"
            checked={state.backgroundRemovalEnabled}
            onChange={(e) => state.setAdvanced({ backgroundRemovalEnabled: e.target.checked })}
          />
          Remove background (flood-fill)
        </label>
        <p className="field-note">
          Clears pixels connected to a corner within a colour tolerance — no model, instant. Works
          on flat or studio backgrounds; a segmentation-based option arrives later.
        </p>
        <SliderField
          label="Tolerance"
          min={MIN_BACKGROUND_REMOVAL_TOLERANCE}
          max={MAX_BACKGROUND_REMOVAL_TOLERANCE}
          step={0.01}
          value={state.backgroundRemovalTolerance}
          disabled={!state.backgroundRemovalEnabled}
          format={(v) => v.toFixed(2)}
          onChange={(backgroundRemovalTolerance) =>
            state.setAdvanced({ backgroundRemovalTolerance })
          }
        />

        <hr className="field-divider" />
        <p className="field-note">
          Mask post-processing: cleans up whatever produced the mask above — today only the
          flood-fill, later a segmentation model too.
        </p>

        <label className="field check">
          <input
            type="checkbox"
            checked={state.maskThresholdEnabled}
            disabled={!state.backgroundRemovalEnabled}
            onChange={(e) => state.setAdvanced({ maskThresholdEnabled: e.target.checked })}
          />
          Re-threshold mask
        </label>
        <SliderField
          label="Threshold"
          min={0}
          max={MAX_MASK_THRESHOLD}
          value={state.maskThreshold}
          disabled={!state.backgroundRemovalEnabled || !state.maskThresholdEnabled}
          onChange={(maskThreshold) => state.setAdvanced({ maskThreshold })}
        />
        <SliderField
          label="Close radius"
          min={0}
          max={MAX_MASK_CLOSE}
          value={state.maskClose}
          disabled={!state.backgroundRemovalEnabled}
          onChange={(maskClose) => state.setAdvanced({ maskClose })}
        />
        <SliderField
          label="Feather radius"
          min={0}
          max={MAX_MASK_FEATHER}
          value={state.maskFeather}
          disabled={!state.backgroundRemovalEnabled}
          onChange={(maskFeather) => state.setAdvanced({ maskFeather })}
        />

        <hr className="field-divider" />
        <SegmentModelSection />
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
        <SliderField
          label="Despeckle"
          min={0}
          max={3}
          value={state.despeckle}
          onChange={(despeckle) => state.setAdvanced({ despeckle })}
        />
        <SliderField
          label="Alpha cut"
          min={0}
          max={255}
          value={state.alphaThreshold}
          onChange={(alphaThreshold) => state.setAdvanced({ alphaThreshold })}
        />
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
