import { useState } from 'react';

import { SliderField } from '../app/SliderField';
import { reconvertLayer } from '../convert/editHandoff.ts';
import { previewRuntime } from '../convert/previewRuntime.ts';
import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import { bufferFrom } from '../pipeline/buffer.ts';
import type { DitherMode, Rgba } from '../pipeline/settings.ts';
import { useDocumentStore } from '../state/documentStore';

/**
 * Live re-editing of a conversion layer, inside Edit mode.
 *
 * This is the second half of the product thesis: `[ Edit → ]` gets the
 * conversion into the editor, and this panel is what makes it *stay* a
 * conversion — change the palette or the dither here and the layer re-renders
 * from the source Rust still holds, weeks later, without going back to the
 * photo (`docs/03-data-model.md` §2.1).
 *
 * Renders nothing when the active layer is an ordinary raster layer, so it costs
 * a user who never converted anything exactly one hidden component.
 */
export function ConversionPanel() {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const revision = useDocumentStore((s) => s.revision);
  const [error, setError] = useState<string | undefined>(undefined);

  const layer = sprite.layers.find((l) => l.id === activeLayerId);
  if (!layer || layer.kind !== 'conversion') return null;

  const settings = layer.source.settings;
  const proxy = previewRuntime.current.source;

  const apply = (patch: Parameters<typeof reconvertLayer>[1]): void => {
    if (!proxy) {
      // The source proxy lives in the preview runtime, which is torn down when
      // a document is loaded from disk. Saying so is better than a silent
      // no-op that looks like a broken control.
      setError('re-open the source image to re-render this layer');
      return;
    }
    try {
      reconvertLayer(layer.id, patch, bufferFrom(proxy.width, proxy.height, proxy.data));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel" aria-label="Conversion layer" data-revision={revision}>
      <h2>Conversion</h2>
      <p className="field-note">
        Live — re-renders from the original image, not from these pixels.
      </p>

      <label className="field">
        <span>Palette</span>
        <select
          value={paletteIdFor(settings.palette)}
          onChange={(e) => {
            const palette = BUILTIN_PALETTES.find((p) => p.id === e.target.value);
            if (palette) {
              apply({ palette: { kind: 'fixed', colors: palette.colors as readonly Rgba[] } });
            }
          }}
        >
          {BUILTIN_PALETTES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.colors.length})
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Dither</span>
        <select
          value={settings.dither}
          onChange={(e) => apply({ dither: e.target.value as DitherMode })}
        >
          {(
            ['none', 'floyd-steinberg', 'atkinson', 'bayer2', 'bayer4', 'bayer8'] as DitherMode[]
          ).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <SliderField
        label="Brightness"
        min={-1}
        max={1}
        step={0.05}
        value={settings.brightness}
        format={(v) => v.toFixed(2)}
        onChange={(brightness) => apply({ brightness })}
      />

      {error && (
        <p className="field-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Which bundled palette a fixed colour list corresponds to, if any. */
function paletteIdFor(spec: { kind: 'fixed' | 'auto'; colors?: readonly Rgba[] }): string {
  if (spec.kind !== 'fixed' || !spec.colors) return BUILTIN_PALETTES[0].id;
  const match = BUILTIN_PALETTES.find(
    (p) =>
      p.colors.length === spec.colors?.length &&
      p.colors.every((c, i) => {
        const other = spec.colors?.[i];
        return other !== undefined && c[0] === other[0] && c[1] === other[1] && c[2] === other[2];
      }),
  );
  return match?.id ?? BUILTIN_PALETTES[0].id;
}
