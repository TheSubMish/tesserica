/**
 * Colour-blindness simulation for the palette panel (`docs/05-ui-design.md`
 * §8 — "offer a simulation preview (protanopia/deuteranopia/tritanopia)...
 * meaningful for users choosing game palettes").
 *
 * The matrices are the commonly published Brettel/Viénot/Mollon-derived
 * approximations, applied directly to sRGB bytes rather than linear light.
 * That is a known simplification — a colorimetrically exact simulation needs
 * a linear-light round trip and, for protanopia/deuteranopia, a projection
 * that depends on the specific LMS cone response being modelled — but this is
 * a *preview*, not a proofing tool, and "cheap to implement" is what the doc
 * asks for. Good enough to catch "these two swatches are indistinguishable",
 * which is the actual product need.
 */

import type { RGBA } from '../model/types';

export type ColorBlindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export const COLOR_BLIND_MODES: ReadonlyArray<{ value: ColorBlindMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'protanopia', label: 'Protanopia' },
  { value: 'deuteranopia', label: 'Deuteranopia' },
  { value: 'tritanopia', label: 'Tritanopia' },
];

type Matrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

const MATRICES: Record<Exclude<ColorBlindMode, 'none'>, Matrix3> = {
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
};

/** Alpha passes through untouched — this simulates perception of colour, not transparency. */
export function simulateColorBlindness(c: RGBA, mode: ColorBlindMode): RGBA {
  if (mode === 'none') return c;
  const m = MATRICES[mode];
  const [r, g, b, a] = c;
  return [
    Math.round(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    Math.round(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    Math.round(m[2][0] * r + m[2][1] * g + m[2][2] * b),
    a,
  ];
}
