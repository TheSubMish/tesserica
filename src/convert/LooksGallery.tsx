import { useEffect, useRef, useState } from 'react';

import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import { bufferFrom } from '../pipeline/buffer.ts';
import { convert } from '../pipeline/convert.ts';
import { downscale } from '../pipeline/downscale.ts';
import { defaultSettings, type PaletteSpec, type Rgba } from '../pipeline/settings.ts';
import { useConvertStore } from '../state/convertStore';
import { LOOKS, isLookActive, type Look } from './looks.ts';
import { previewRuntime } from './previewRuntime.ts';

const THUMB_W = 48;
/** Thumbnails come from a small copy of the proxy, so nine auto-palettes stay cheap. */
const THUMB_SOURCE_EDGE = 160;

interface Thumb {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

function paletteFor(look: Look): PaletteSpec {
  if (look.paletteId === 'auto') return { kind: 'auto', maxColors: look.autoMaxColors ?? 16 };
  const p = BUILTIN_PALETTES.find((x) => x.id === look.paletteId) ?? BUILTIN_PALETTES[0];
  return { kind: 'fixed', colors: p.colors as readonly Rgba[] };
}

/** The user's own image rendered through each look, one at a time so the UI never stalls. */
export function LooksGallery() {
  const [source, setSource] = useState(previewRuntime.current.source);
  // Tagged with the source it was rendered from, so a new image never shows the old one's looks.
  const [rendered, setRendered] = useState<{
    readonly owner: ImageData | undefined;
    readonly map: Readonly<Record<string, Thumb>>;
  }>({ owner: undefined, map: {} });
  const thumbs = rendered.owner === source ? rendered.map : {};
  const paletteId = useConvertStore((s) => s.paletteId);
  const autoMaxColors = useConvertStore((s) => s.autoMaxColors);
  const dither = useConvertStore((s) => s.dither);

  useEffect(() => previewRuntime.subscribe((f) => setSource(f.source)), []);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const full = bufferFrom(source.width, source.height, source.data);
    const scale = Math.min(1, THUMB_SOURCE_EDGE / Math.max(source.width, source.height));
    const small =
      scale < 1
        ? downscale(
            full,
            Math.max(1, Math.round(source.width * scale)),
            Math.max(1, Math.round(source.height * scale)),
            'box',
          )
        : full;
    const h = Math.max(1, Math.round((THUMB_W * source.height) / source.width));

    let i = 0;
    const next = (): void => {
      if (cancelled || i >= LOOKS.length) return;
      const look = LOOKS[i++];
      try {
        const out = convert(small, {
          ...defaultSettings(THUMB_W, h, paletteFor(look)),
          dither: look.dither,
        }).image;
        setRendered((prev) => ({
          owner: source,
          map: {
            ...(prev.owner === source ? prev.map : {}),
            [look.id]: { width: out.width, height: out.height, data: out.data },
          },
        }));
      } catch {
        /* a look that fails simply shows no preview */
      }
      window.setTimeout(next, 0);
    };
    window.setTimeout(next, 0);
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (!source) return null;

  return (
    <section className="panel looks" aria-label="Looks">
      <div className="panel-head">
        <span>Looks</span>
      </div>
      <ul className="looks-grid">
        {LOOKS.map((look) => {
          const active = isLookActive(look, { paletteId, autoMaxColors, dither });
          return (
            <li key={look.id}>
              <button
                type="button"
                className="look"
                aria-pressed={active}
                title={`${look.label} — ${look.paletteId === 'auto' ? `${look.autoMaxColors} colours from your image` : look.paletteId}`}
                onClick={() => {
                  const st = useConvertStore.getState();
                  st.setPaletteId(look.paletteId);
                  if (look.autoMaxColors) st.setAutoMaxColors(look.autoMaxColors);
                  st.setDither(look.dither);
                }}
              >
                <ThumbCanvas thumb={thumbs[look.id]} />
                <span>{look.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ThumbCanvas({ thumb }: { readonly thumb: Thumb | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !thumb) return;
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(thumb.data), thumb.width, thumb.height),
      0,
      0,
    );
  }, [thumb]);
  return (
    <canvas
      ref={ref}
      className="look-thumb"
      aria-hidden="true"
      data-ready={thumb ? 'true' : 'false'}
    />
  );
}
