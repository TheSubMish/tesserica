/**
 * Test-only helper for driving tools without a canvas or a store.
 *
 * Not imported by any application module, so it never reaches the bundle. It
 * lives beside the tools rather than in the test files because every tool test
 * needs the same fully-populated `ToolContext`, including the snapshot-backed
 * `restore` / `restorePixel` that the canvas normally supplies.
 */

import type { Selection } from '../model/selection';
import type { RGBA } from '../model/types';
import type { ToolContext } from './Tool';

export interface Harness extends ToolContext {
  /** Colours handed to `setColor`, in call order. */
  picked: { color: RGBA; slot: 'primary' | 'secondary' }[];
  /** Take a fresh pointer-down snapshot, as the canvas does. */
  snapshot(): void;
  /** Sprite pixels the eyedropper sees; defaults to reading the cel. */
  sampleSource: ((x: number, y: number) => RGBA | null) | null;
}

export function harness(init: Partial<ToolContext> & { size?: number } = {}): Harness {
  const { size = 8, ...options } = init;
  const width = options.width ?? size;
  const height = options.height ?? size;
  const buffer = options.buffer ?? new Uint8ClampedArray(width * height * 4);
  let saved = new Uint8ClampedArray(buffer);

  const h: Harness = {
    buffer,
    width,
    height,
    primary: [255, 0, 0, 255],
    secondary: [0, 0, 255, 255],
    brushSize: 1,
    button: 0,
    pixelPerfect: false,
    shapeFill: false,
    fillContiguous: true,
    selectMode: 'rect',
    anchor: { x: 0, y: 0 },
    strokeState: {},
    selection: null,
    picked: [],
    sampleSource: null,

    setSelection(s: Selection | null) {
      h.selection = s;
    },
    snapshot() {
      saved = new Uint8ClampedArray(buffer);
      h.strokeState = {};
    },
    restore() {
      buffer.set(saved);
    },
    restorePixel(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      buffer.set(saved.subarray(i, i + 4), i);
    },
    sample(x, y) {
      if (h.sampleSource) return h.sampleSource(x, y);
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const i = (y * width + x) * 4;
      return [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]];
    },
    setColor(color, slot) {
      h.picked.push({ color, slot });
      if (slot === 'secondary') h.secondary = color;
      else h.primary = color;
    },
    ...options,
  };

  return h;
}

/** Set of `"x,y"` for every non-transparent pixel. */
export function litPixels(buf: Uint8ClampedArray, w: number, h: number): Set<string> {
  const lit = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] !== 0) lit.add(`${x},${y}`);
    }
  }
  return lit;
}
