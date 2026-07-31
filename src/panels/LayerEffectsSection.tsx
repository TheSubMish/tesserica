/**
 * Non-destructive layer effects (`docs/03-data-model.md` §5, roadmap Phase 7).
 *
 * Lives in its own file, the same way `SegmentModelSection` is split out of
 * `ConvertPanel` — a self-contained sub-section of `LayerPanel`, not a new
 * top-level panel. Every control here calls straight into
 * `history/layerCommands.ts`'s effect commands, so add/remove/toggle/reorder
 * and every parameter edit are undoable by construction, exactly like the
 * rest of the layer panel.
 */

import { useRef } from 'react';
import { SliderField } from '../app/SliderField';
import { fromHex, toHex } from '../lib/color';
import {
  addLayerEffect,
  removeLayerEffect,
  reorderLayerEffect,
  setLayerEffectEnabled,
  updateLayerEffect,
} from '../history/layerCommands';
import type { Effect, Layer, RGBA } from '../model/types';
import { usePaletteStore } from '../state/paletteStore';

const EFFECT_KINDS: { value: Effect['kind']; label: string }[] = [
  { value: 'outline', label: 'Outline' },
  { value: 'outline-inner', label: 'Inner Outline' },
  { value: 'drop-shadow', label: 'Drop Shadow' },
  { value: 'gradient-map', label: 'Gradient Map' },
  { value: 'hsv-shift', label: 'Hue / Saturation / Value' },
];

const EFFECT_LABEL: Record<Effect['kind'], string> = Object.fromEntries(
  EFFECT_KINDS.map((k) => [k.value, k.label]),
) as Record<Effect['kind'], string>;

/** A colour field: a native `<input type="color">` plus a separate 0..255 alpha number field. */
function ColorField({
  label,
  color,
  onChange,
}: {
  label: string;
  color: RGBA;
  onChange(next: RGBA): void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span style={{ display: 'flex', gap: 'var(--space-1)' }}>
        <input
          type="color"
          aria-label={`${label} colour`}
          value={toHex(color)}
          onChange={(e) => onChange(fromHex(e.target.value, color[3]))}
        />
        <input
          type="number"
          aria-label={`${label} alpha`}
          min={0}
          max={255}
          value={color[3]}
          onChange={(e) => {
            const a = Math.max(0, Math.min(255, Number(e.target.value)));
            onChange([color[0], color[1], color[2], a]);
          }}
        />
      </span>
    </label>
  );
}

/** One effect kind's own parameters — the panel's per-kind editor. */
function EffectParams({ layerId, effect }: { layerId: string; effect: Effect }) {
  const session = useRef(0);
  const palettes = usePaletteStore((s) => s.palettes);
  const coalesce = (field: string) => `${field}:${session.current}`;

  switch (effect.kind) {
    case 'outline':
    case 'outline-inner':
      return (
        <>
          <ColorField
            label="Colour"
            color={effect.color}
            onChange={(color) => updateLayerEffect(layerId, effect.id, { color })}
          />
          <SliderField
            label="Thickness"
            min={0}
            max={16}
            value={effect.thickness}
            onDragStart={() => session.current++}
            onChange={(v) =>
              updateLayerEffect(layerId, effect.id, { thickness: v }, coalesce('thickness'))
            }
          />
          {effect.kind === 'outline' && (
            <label className="field-inline">
              <input
                type="checkbox"
                checked={effect.corners}
                onChange={(e) =>
                  updateLayerEffect(layerId, effect.id, { corners: e.target.checked })
                }
              />
              8-connected corners
            </label>
          )}
        </>
      );
    case 'drop-shadow':
      return (
        <>
          <ColorField
            label="Colour"
            color={effect.color}
            onChange={(color) => updateLayerEffect(layerId, effect.id, { color })}
          />
          <SliderField
            label="Offset X"
            min={-32}
            max={32}
            value={effect.dx}
            onDragStart={() => session.current++}
            onChange={(v) => updateLayerEffect(layerId, effect.id, { dx: v }, coalesce('dx'))}
          />
          <SliderField
            label="Offset Y"
            min={-32}
            max={32}
            value={effect.dy}
            onDragStart={() => session.current++}
            onChange={(v) => updateLayerEffect(layerId, effect.id, { dy: v }, coalesce('dy'))}
          />
        </>
      );
    case 'gradient-map':
      return (
        <>
          <div className="gradient-preview" aria-hidden="true">
            {effect.palette.map((c, i) => (
              <span
                key={i}
                style={{
                  background: toHex(c),
                  width: `${100 / Math.max(1, effect.palette.length)}%`,
                }}
              />
            ))}
          </div>
          <label className="field">
            <span>Load from palette</span>
            <select
              aria-label="Load gradient from palette"
              value=""
              onChange={(e) => {
                const palette = palettes.find((p) => p.id === e.target.value);
                if (palette && palette.colors.length > 0) {
                  // A snapshot of the palette's colours, not a live reference
                  // (`docs/03-data-model.md` §5's own `palette: RGBA[]`) — the
                  // effect keeps working even if the named palette is later
                  // renamed, edited or removed.
                  updateLayerEffect(layerId, effect.id, { palette: palette.colors.slice() });
                }
                e.target.value = '';
              }}
            >
              <option value="" disabled>
                Choose a palette…
              </option>
              {palettes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </>
      );
    case 'hsv-shift':
      return (
        <>
          <SliderField
            label="Hue"
            min={-180}
            max={180}
            format={(v) => `${v}°`}
            value={effect.h}
            onDragStart={() => session.current++}
            onChange={(v) => updateLayerEffect(layerId, effect.id, { h: v }, coalesce('h'))}
          />
          <SliderField
            label="Saturation"
            min={-100}
            max={100}
            format={(v) => `${v}%`}
            value={effect.s}
            onDragStart={() => session.current++}
            onChange={(v) => updateLayerEffect(layerId, effect.id, { s: v }, coalesce('s'))}
          />
          <SliderField
            label="Value"
            min={-100}
            max={100}
            format={(v) => `${v}%`}
            value={effect.v}
            onDragStart={() => session.current++}
            onChange={(v) => updateLayerEffect(layerId, effect.id, { v: v }, coalesce('v'))}
          />
        </>
      );
  }
}

export function LayerEffectsSection({ layer }: { layer: Layer }) {
  return (
    <section className="layer-effects">
      <div className="panel-head">
        <span>Effects</span>
        <select
          aria-label="Add effect"
          value=""
          onChange={(e) => {
            const kind = e.target.value as Effect['kind'] | '';
            if (kind) addLayerEffect(layer.id, kind);
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            + Add effect…
          </option>
          {EFFECT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      {layer.effects.length === 0 && <p className="hint">No effects on this layer.</p>}

      {layer.effects.map((fx, i) => (
        <div key={fx.id} className="effect-row">
          <div className="effect-row-head">
            <button
              className="layer-vis"
              aria-label={
                fx.enabled ? `Disable ${EFFECT_LABEL[fx.kind]}` : `Enable ${EFFECT_LABEL[fx.kind]}`
              }
              aria-pressed={fx.enabled}
              title={fx.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              onClick={() => setLayerEffectEnabled(layer.id, fx.id, !fx.enabled)}
            >
              {fx.enabled ? '◉' : '○'}
            </button>
            <span className="effect-kind-label">{EFFECT_LABEL[fx.kind]}</span>
            <button
              aria-label={`Move ${EFFECT_LABEL[fx.kind]} up`}
              title="Move up (composites later)"
              disabled={i === 0}
              onClick={() => reorderLayerEffect(layer.id, fx.id, -1)}
            >
              ↑
            </button>
            <button
              aria-label={`Move ${EFFECT_LABEL[fx.kind]} down`}
              title="Move down (composites earlier)"
              disabled={i === layer.effects.length - 1}
              onClick={() => reorderLayerEffect(layer.id, fx.id, 1)}
            >
              ↓
            </button>
            <button
              aria-label={`Remove ${EFFECT_LABEL[fx.kind]}`}
              title="Remove effect"
              onClick={() => removeLayerEffect(layer.id, fx.id)}
            >
              🗑
            </button>
          </div>
          <EffectParams layerId={layer.id} effect={fx} />
        </div>
      ))}
    </section>
  );
}
