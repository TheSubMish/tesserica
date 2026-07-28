/**
 * A range slider that is also a number field (`docs/05-ui-design.md` §7.6 —
 * "Click the value to type it"). Precision matters at pixel-art sizes and
 * dragging cannot reliably hit an exact value, so every slider in the app
 * shares this rather than each panel inventing its own click-to-edit affordance.
 *
 * `onDragStart`, when given, fires once per discrete edit — a pointer-down on
 * the range or the start of a typed edit — so callers that coalesce a whole
 * drag into one undo step (`docs/03-data-model.md` §6, e.g. layer opacity)
 * have a single hook for "a new edit began" regardless of which control
 * produced it.
 */

import { useState } from 'react';

export interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Defaults to the raw number; pass e.g. `(v) => v.toFixed(2)` or add a unit. */
  format?: (v: number) => string;
  onChange(v: number): void;
  onDragStart?(): void;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  format,
  onChange,
  onDragStart,
}: SliderFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const display = format ? format(value) : String(value);

  const startEditing = () => {
    onDragStart?.();
    setDraft(display.replace(/[^-0-9.]/g, '')); // strip units like "°" before editing
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    if (!Number.isFinite(n)) return;
    onChange(Math.max(min, Math.min(max, n)));
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={onDragStart}
        onKeyDown={onDragStart}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {editing ? (
        <input
          type="number"
          className="value-input"
          autoFocus
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <output
          className="value"
          tabIndex={disabled ? -1 : 0}
          role="button"
          aria-label={`${label}, ${display} — click to type a value`}
          onClick={disabled ? undefined : startEditing}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              startEditing();
            }
          }}
        >
          {display}
        </output>
      )}
    </label>
  );
}
