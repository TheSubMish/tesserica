import { create } from 'zustand';

import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import type {
  ConvertSettings,
  DitherMode,
  DownscaleMode,
  PaletteSpec,
  Rgba,
} from '../pipeline/settings.ts';
import { defaultSettings, targetSizeForPixelSize } from '../pipeline/settings.ts';

/**
 * Convert mode's state (`docs/05-ui-design.md` §3).
 *
 * **No pixels live here.** The store holds the source's *dimensions* and the
 * settings; the source proxy and the preview result are `ArrayBuffer`s owned by
 * `src/convert/previewRuntime.ts`, outside React entirely
 * (`docs/03-data-model.md`, "keep pixel data out of React state"). What is
 * reactive is what a control needs to re-render: numbers and enums.
 *
 * The user-facing control is **pixel size**, not output dimensions (`docs/04`
 * §3.2) — "how big are the blocks" is the question people actually have. Target
 * width and height are derived.
 */

export type ViewMode = 'split' | 'side';

export interface SourceMeta {
  readonly sourceId: number;
  readonly width: number;
  readonly height: number;
  readonly path: string;
  /** True when preview runs on a downscaled proxy (`docs/02` §3.1). */
  readonly isProxy: boolean;
}

export interface PreviewMeta {
  readonly width: number;
  readonly height: number;
  readonly colorsUsed: number;
  readonly elapsedMs: number;
}

interface ConvertState {
  source: SourceMeta | undefined;

  // --- the four primary controls (`docs/05` §3) ---
  pixelSize: number;
  paletteId: string;
  dither: DitherMode;
  ditherStrength: number;

  // --- behind collapsed sections ---
  downscaleMode: DownscaleMode;
  brightness: number;
  contrast: number;
  saturation: number;
  hueShift: number;
  despeckle: number;
  alphaThreshold: number;

  // --- view ---
  viewMode: ViewMode;
  /** 0..1 position of the split handle. */
  splitAt: number;

  // --- live status ---
  busy: boolean;
  error: string | undefined;
  preview: PreviewMeta | undefined;

  setSource(source: SourceMeta | undefined): void;
  setPixelSize(size: number): void;
  setPaletteId(id: string): void;
  setDither(mode: DitherMode): void;
  setDitherStrength(strength: number): void;
  setAdvanced(patch: Partial<AdvancedSettings>): void;
  setViewMode(mode: ViewMode): void;
  setSplitAt(at: number): void;
  setBusy(busy: boolean): void;
  setError(error: string | undefined): void;
  setPreview(preview: PreviewMeta | undefined): void;
}

export type AdvancedSettings = Pick<
  ConvertState,
  | 'downscaleMode'
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hueShift'
  | 'despeckle'
  | 'alphaThreshold'
>;

/** Pixel size is a block edge in source pixels; 1 means no downscale at all. */
export const MIN_PIXEL_SIZE = 1;
export const MAX_PIXEL_SIZE = 64;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const useConvertStore = create<ConvertState>((set) => ({
  source: undefined,

  pixelSize: 12,
  paletteId: BUILTIN_PALETTES[0].id,
  dither: 'none',
  ditherStrength: 0.8,

  downscaleMode: 'box',
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hueShift: 0,
  despeckle: 0,
  alphaThreshold: 128,

  viewMode: 'split',
  splitAt: 0.5,

  busy: false,
  error: undefined,
  preview: undefined,

  setSource: (source) => set({ source, preview: undefined, error: undefined }),
  setPixelSize: (size) =>
    set({ pixelSize: clamp(Math.round(size), MIN_PIXEL_SIZE, MAX_PIXEL_SIZE) }),
  setPaletteId: (paletteId) => set({ paletteId }),
  setDither: (dither) => set({ dither }),
  setDitherStrength: (ditherStrength) => set({ ditherStrength: clamp(ditherStrength, 0, 1) }),
  setAdvanced: (patch) => set(patch),
  setViewMode: (viewMode) => set({ viewMode }),
  setSplitAt: (at) => set({ splitAt: clamp(at, 0, 1) }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setPreview: (preview) => set({ preview }),
}));

/** The palette the id refers to, falling back to the first bundled one. */
export function paletteColors(paletteId: string): readonly Rgba[] {
  const palette = BUILTIN_PALETTES.find((p) => p.id === paletteId) ?? BUILTIN_PALETTES[0];
  return palette.colors as readonly Rgba[];
}

/** Output dimensions implied by the current pixel size (`docs/04` §3.2). */
export function targetSize(state: ConvertState): { width: number; height: number } {
  if (!state.source) return { width: 0, height: 0 };
  return targetSizeForPixelSize(state.source.width, state.source.height, state.pixelSize);
}

/**
 * Assemble the pipeline's parameter struct from the UI state.
 *
 * The single place the two vocabularies meet: the UI thinks in "pixel size" and
 * a palette id, the pipeline thinks in target dimensions and a colour list.
 */
export function buildSettings(state: ConvertState): ConvertSettings {
  const { width, height } = targetSize(state);
  const palette: PaletteSpec = { kind: 'fixed', colors: paletteColors(state.paletteId) };

  return {
    ...defaultSettings(Math.max(1, width), Math.max(1, height), palette),
    downscaleMode: state.downscaleMode,
    dither: state.dither,
    ditherStrength: state.ditherStrength,
    brightness: state.brightness,
    contrast: state.contrast,
    saturation: state.saturation,
    hueShift: state.hueShift,
    despeckle: state.despeckle,
    alphaThreshold: state.alphaThreshold,
  };
}
