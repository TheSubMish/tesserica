/**
 * Layer blend modes (`docs/03-data-model.md` §2.1, Phase 3 roadmap item
 * "blend modes beyond normal").
 *
 * Formulas are the W3C Compositing and Blending Level 1 separable and
 * non-separable blend functions, verbatim — not reinvented, because these are
 * a real spec with a real reference implementation (browsers) to cross-check
 * against. Everything here operates on **straight**, 0..1-normalized RGB;
 * `compositeOver` in `sample.ts` is what folds a blended colour back into the
 * alpha-compositing maths (`docs/02-architecture.md` §9 — straight alpha,
 * never premultiplied).
 *
 * `normal` is not a case here: it never needs a blend function, since its
 * definition is simply `Cs` (the source colour, unmodified) — see
 * `compositeOver`.
 */

import type { BlendMode } from '../model/types';

type RGB = readonly [r: number, g: number, b: number];

function multiply(cb: number, cs: number): number {
  return cb * cs;
}

function screenF(cb: number, cs: number): number {
  return cb + cs - cb * cs;
}

/** `Overlay(Cb, Cs) = HardLight(Cs, Cb)` — the spec defines it in terms of hard light. */
function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? multiply(cb, 2 * cs) : screenF(cb, 2 * cs - 1);
}

function overlay(cb: number, cs: number): number {
  return hardLight(cs, cb);
}

function softLightD(x: number): number {
  return x <= 0.25 ? (16 * x - 12) * x * x + 4 * x : Math.sqrt(x);
}

function softLight(cb: number, cs: number): number {
  return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softLightD(cb) - cb);
}

function colorDodge(cb: number, cs: number): number {
  if (cb === 0) return 0;
  if (cs === 1) return 1;
  return Math.min(1, cb / (1 - cs));
}

function colorBurn(cb: number, cs: number): number {
  if (cb === 1) return 1;
  if (cs === 0) return 0;
  return 1 - Math.min(1, (1 - cb) / cs);
}

/** The twelve modes whose result at a channel depends only on that channel. */
const SEPARABLE: Record<string, (cb: number, cs: number) => number> = {
  multiply,
  screen: screenF,
  overlay,
  darken: Math.min,
  lighten: Math.max,
  'color-dodge': colorDodge,
  'color-burn': colorBurn,
  'hard-light': hardLight,
  'soft-light': softLight,
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
};

// ---- Non-separable modes (hue/saturation/color/luminosity) ---------------
// These need the whole RGB triple at once — "the saturation of the backdrop"
// is not a per-channel quantity — so they are kept apart from `SEPARABLE`
// rather than forced into its per-channel shape.

function lum(c: RGB): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: RGB): RGB {
  const l = lum(c);
  let [r, g, b] = c;
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    r = l + ((r - l) * l) / (l - n);
    g = l + ((g - l) * l) / (l - n);
    b = l + ((b - l) * l) / (l - n);
  }
  if (x > 1) {
    r = l + ((r - l) * (1 - l)) / (x - l);
    g = l + ((g - l) * (1 - l)) / (x - l);
    b = l + ((b - l) * (1 - l)) / (x - l);
  }
  return [r, g, b];
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: RGB): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: RGB, s: number): RGB {
  const order = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [minI, midI, maxI] = order;
  const out: [number, number, number] = [0, 0, 0];
  if (c[maxI] > c[minI]) {
    out[midI] = ((c[midI] - c[minI]) * s) / (c[maxI] - c[minI]);
    out[maxI] = s;
  }
  out[minI] = 0;
  return out;
}

const NON_SEPARABLE: Record<string, (cb: RGB, cs: RGB) => RGB> = {
  hue: (cb, cs) => setLum(setSat(cs, sat(cb)), lum(cb)),
  saturation: (cb, cs) => setLum(setSat(cb, sat(cs)), lum(cb)),
  color: (cb, cs) => setLum(cs, lum(cb)),
  luminosity: (cb, cs) => setLum(cb, lum(cs)),
};

/**
 * `B(Cb, Cs)` from the spec — the blended colour *before* it is folded back
 * into alpha compositing. `backdrop`/`source` and the result are all 0..1.
 * `mode === 'normal'` is unreachable in practice (`compositeOver` special-cases
 * it) but returns `source` if called, matching the spec's definition.
 */
export function blendFunction(mode: BlendMode, backdrop: RGB, source: RGB): RGB {
  if (mode === 'normal') return source;

  const nonSeparable = NON_SEPARABLE[mode];
  if (nonSeparable) return nonSeparable(backdrop, source);

  const perChannel = SEPARABLE[mode];
  return [
    perChannel(backdrop[0], source[0]),
    perChannel(backdrop[1], source[1]),
    perChannel(backdrop[2], source[2]),
  ];
}

/** Canvas2D `globalCompositeOperation` for the live preview (`docs/02` §7). */
export function canvasCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : (mode as GlobalCompositeOperation);
}
