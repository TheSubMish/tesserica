import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import {
  HARMONIES,
  MAX_CHROMA,
  harmonyColors,
  hsvToRgb,
  maxChromaFor,
  oklchToRgb,
  rgbToHsv,
  rgbToOklch,
  type HarmonyId,
  type Hsv,
  type Oklch,
} from '../lib/colorSpaces';
import { fromHex, sameRgb, toHex } from '../lib/color';
import type { RGBA } from '../model/types';

type Mode = 'hsv' | 'oklch' | 'rgb';

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'hsv', label: 'HSV wheel', hint: 'Classic artist wheel: hue around, saturation outward' },
  { id: 'oklch', label: 'Perceptual', hint: 'Oklch wheel: equal steps look equally different' },
  { id: 'rgb', label: 'RGB', hint: 'Red, green and blue sliders' },
];

const SIZE = 168;
const R = SIZE / 2;

export interface ColorPickerProps {
  readonly color: RGBA;
  readonly onChange: (color: RGBA) => void;
}

/**
 * A colour picker with two wheels (HSV and perceptual Oklch), RGB sliders, a
 * hex field and one-click harmony schemes. It replaces the native
 * `<input type="color">`, which on Linux opens a separate GTK dialog.
 *
 * Hue/saturation are kept in local state: a grey has no hue, so deriving them
 * from the RGB on every render would snap the marker to red as you drag
 * through the centre.
 */
export function ColorPicker({ color, onChange }: ColorPickerProps) {
  const [mode, setMode] = useState<Mode>('hsv');
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(color));
  const [lch, setLch] = useState<Oklch>(() => rgbToOklch(color));
  const [hexDraft, setHexDraft] = useState<string | undefined>(undefined);
  const emitted = useRef<RGBA>(color);

  // An outside change (eyedropper, swap, palette click) re-seeds the local axes.
  useEffect(() => {
    if (!sameRgb(color, emitted.current)) {
      emitted.current = color;
      setHsv(rgbToHsv(color));
      setLch(rgbToOklch(color));
    }
  }, [color]);

  const emit = useCallback(
    (rgb: readonly [number, number, number]) => {
      const next: RGBA = [rgb[0], rgb[1], rgb[2], color[3]];
      emitted.current = next;
      onChange(next);
    },
    [color, onChange],
  );

  const pickHsv = (next: Hsv): void => {
    setHsv(next);
    const rgb = hsvToRgb(next);
    setLch(rgbToOklch(rgb));
    emit(rgb);
  };

  const pickLch = (next: Oklch): void => {
    setLch(next);
    const { rgb } = oklchToRgb(next);
    setHsv(rgbToHsv(rgb));
    emit(rgb);
  };

  const pickRgb = (channel: 0 | 1 | 2, value: number): void => {
    const rgb: [number, number, number] = [color[0], color[1], color[2]];
    rgb[channel] = Math.max(0, Math.min(255, Math.round(value)));
    setHsv(rgbToHsv(rgb));
    setLch(rgbToOklch(rgb));
    emit(rgb);
  };

  const commitHex = (text: string): void => {
    setHexDraft(undefined);
    if (!/^#?[0-9a-f]{6}$/i.test(text.trim())) return;
    const c = fromHex(text, color[3]);
    setHsv(rgbToHsv(c));
    setLch(rgbToOklch(c));
    emit([c[0], c[1], c[2]]);
  };

  const harmonyBase = mode === 'oklch' ? rgbToHsv(oklchToRgb(lch).rgb) : hsv;

  return (
    <div className="color-picker">
      <div className="color-picker-modes" role="tablist" aria-label="Colour picker type">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            title={m.hint}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'hsv' && (
        <>
          <Wheel kind="hsv" hsv={hsv} lch={lch} onHsv={pickHsv} onLch={pickLch} />
          <label className="color-picker-slider">
            <span>Value</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(hsv.v * 100)}
              style={{
                background: `linear-gradient(90deg, #000, ${toHex([...hsvToRgb({ ...hsv, v: 1 }), 255])})`,
              }}
              onChange={(e) => pickHsv({ ...hsv, v: Number(e.target.value) / 100 })}
            />
          </label>
        </>
      )}

      {mode === 'oklch' && (
        <>
          <Wheel kind="oklch" hsv={hsv} lch={lch} onHsv={pickHsv} onLch={pickLch} />
          <label className="color-picker-slider">
            <span>Light</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(lch.l * 100)}
              style={{ background: 'linear-gradient(90deg, #000, #fff)' }}
              onChange={(e) => {
                const l = Number(e.target.value) / 100;
                pickLch({ ...lch, l, c: Math.min(lch.c, maxChromaFor(l, lch.h)) });
              }}
            />
          </label>
        </>
      )}

      {mode === 'rgb' &&
        (['R', 'G', 'B'] as const).map((name, i) => {
          const ch = i as 0 | 1 | 2;
          const lo: [number, number, number] = [color[0], color[1], color[2]];
          const hi: [number, number, number] = [color[0], color[1], color[2]];
          lo[ch] = 0;
          hi[ch] = 255;
          return (
            <label key={name} className="color-picker-slider">
              <span>{name}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={color[ch]}
                style={{
                  background: `linear-gradient(90deg, ${toHex([...lo, 255])}, ${toHex([...hi, 255])})`,
                }}
                onChange={(e) => pickRgb(ch, Number(e.target.value))}
              />
              <output>{color[ch]}</output>
            </label>
          );
        })}

      <label className="color-picker-hex">
        <span>Hex</span>
        <input
          type="text"
          spellCheck={false}
          maxLength={7}
          value={hexDraft ?? toHex(color)}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHex(e.currentTarget.value);
            if (e.key === 'Escape') setHexDraft(undefined);
            e.stopPropagation(); // typing a hex digit must not trigger a tool shortcut
          }}
        />
      </label>

      <Harmonies base={harmonyBase} alpha={color[3]} onPick={(rgb) => pickHsv(rgbToHsv(rgb))} />
    </div>
  );
}

interface WheelProps {
  readonly kind: 'hsv' | 'oklch';
  readonly hsv: Hsv;
  readonly lch: Oklch;
  readonly onHsv: (h: Hsv) => void;
  readonly onLch: (l: Oklch) => void;
}

function Wheel({ kind, hsv, lch, onHsv, onLch }: WheelProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The wheel only repaints when its third axis changes, not on every drag.
  const axis = kind === 'hsv' ? hsv.v : lch.l;

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x + 0.5 - R;
        const dy = y + 0.5 - R;
        const dist = Math.hypot(dx, dy);
        if (dist > R) continue;
        const h = (Math.atan2(dy, dx) * 180) / Math.PI;
        const t = dist / R;
        const o = (y * SIZE + x) * 4;
        let rgb: [number, number, number];
        if (kind === 'hsv') {
          rgb = hsvToRgb({ h, s: t, v: axis });
        } else {
          const res = oklchToRgb({ l: axis, c: t * MAX_CHROMA, h });
          if (!res.inGamut) continue; // leave unpaintable colours empty
          rgb = res.rgb;
        }
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [kind, axis]);

  const pick = (e: PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width) * SIZE - R;
    const dy = ((e.clientY - rect.top) / rect.height) * SIZE - R;
    const t = Math.min(1, Math.hypot(dx, dy) / R);
    const h = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    if (kind === 'hsv') onHsv({ h, s: t, v: hsv.v });
    else onLch({ l: lch.l, c: Math.min(t * MAX_CHROMA, maxChromaFor(lch.l, h)), h });
  };

  const angle = ((kind === 'hsv' ? hsv.h : lch.h) * Math.PI) / 180;
  const radius = kind === 'hsv' ? hsv.s : Math.min(1, lch.c / MAX_CHROMA);

  return (
    <div className="color-wheel" style={{ width: SIZE, height: SIZE }}>
      <canvas
        ref={canvas}
        width={SIZE}
        height={SIZE}
        aria-label={kind === 'hsv' ? 'HSV colour wheel' : 'Perceptual colour wheel'}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) pick(e);
        }}
      />
      <span
        className="color-wheel-marker"
        style={{
          left: R + Math.cos(angle) * radius * R,
          top: R + Math.sin(angle) * radius * R,
        }}
      />
    </div>
  );
}

function Harmonies({
  base,
  alpha,
  onPick,
}: {
  readonly base: Hsv;
  readonly alpha: number;
  readonly onPick: (rgb: [number, number, number]) => void;
}) {
  const [id, setId] = useState<HarmonyId>('complementary');
  const colors = harmonyColors(base, id);
  return (
    <div className="color-harmony">
      <select
        value={id}
        aria-label="Colour harmony"
        onChange={(e) => setId(e.target.value as HarmonyId)}
      >
        {HARMONIES.map((h) => (
          <option key={h.id} value={h.id}>
            {h.label}
          </option>
        ))}
      </select>
      <div className="color-harmony-swatches">
        {colors.map((rgb, i) => (
          <button
            key={`${id}-${i}`}
            type="button"
            className="color-harmony-swatch"
            style={{ background: toHex([...rgb, alpha]) }}
            title={toHex([...rgb, alpha])}
            aria-label={`Use ${toHex([...rgb, alpha])}`}
            onClick={() => onPick(rgb)}
          />
        ))}
      </div>
    </div>
  );
}
