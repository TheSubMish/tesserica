/**
 * Source-over compositing of straight-alpha colours (`docs/02-architecture.md`
 * §9 — never premultiplied).
 *
 * Its own module rather than living in `sample.ts` (where it used to be) so
 * that `canvas/effects.ts` can use it (`drop-shadow` composites the layer's
 * own content back over its shifted shadow) without `sample.ts` and
 * `effects.ts` importing each other — `sample.ts` needs `effects.ts` for its
 * own effects-aware eyedropper sampling, so the shared primitive has to sit
 * below both.
 */

import type { BlendMode, RGBA } from '../model/types';
import { blendFunction } from './blend';

/**
 * `blendMode` folds in via the W3C Compositing formula
 * `Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)`, then `Cs'` takes the place `Cs` occupied
 * in plain source-over — the alpha maths (`outA`, the mix weights) is
 * completely unchanged by blend mode, only the colour being mixed in is
 * (`blend.ts`). `'normal'` skips the extra work: `B(Cb, Cs) = Cs` there, which
 * makes `Cs' = Cs` identically, so this must stay behaviourally identical to
 * the pre-blend-mode function for every existing caller.
 */
export function compositeOver(
  src: RGBA,
  srcAlpha: number,
  dst: RGBA,
  blendMode: BlendMode = 'normal',
): RGBA {
  const sa = (src[3] / 255) * srcAlpha;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];

  let blended: readonly [number, number, number] = [src[0], src[1], src[2]];
  if (blendMode !== 'normal' && da > 0) {
    const backdrop: readonly [number, number, number] = [dst[0] / 255, dst[1] / 255, dst[2] / 255];
    const source: readonly [number, number, number] = [src[0] / 255, src[1] / 255, src[2] / 255];
    const b = blendFunction(blendMode, backdrop, source);
    blended = [
      ((1 - da) * source[0] + da * b[0]) * 255,
      ((1 - da) * source[1] + da * b[1]) * 255,
      ((1 - da) * source[2] + da * b[2]) * 255,
    ];
  }

  const mix = (s: number, d: number) => (s * sa + d * da * (1 - sa)) / outA;
  return [
    Math.round(mix(blended[0], dst[0])),
    Math.round(mix(blended[1], dst[1])),
    Math.round(mix(blended[2], dst[2])),
    Math.round(outA * 255),
  ];
}
