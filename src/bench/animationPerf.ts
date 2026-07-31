/**
 * Phase 4 — "Performance: sustain target fps; decide on WebGL2 here if
 * Canvas2D falls short" (`docs/08-roadmap.md`), resolving Q8
 * (`docs/09-open-questions.md`).
 *
 * Measures the actual cost of the worst realistic frame the current
 * Canvas2D renderer has to draw during animation playback: a full redraw of
 * `CanvasView`'s effect (`canvas/CanvasView.tsx`) — checkerboard, onion-skin
 * ghosts, the active frame's own composite, grid, border — for a sprite with
 * several layers *including a group* (`canvas/renderer.ts::compositeScope`,
 * the most expensive path: it is what a group's children *and* every
 * onion-skin ghost run through, bypassing `compositeSprite`'s single-slot
 * cache) at the maximum onion-skin range (`state/uiStore.ts::
 * MAX_ONION_SKIN_RANGE = 8` each side, so 16 full-sprite composites *plus*
 * the active frame's own, every tick).
 *
 * Runs inside a real browser (a real `<canvas>` 2D context, real
 * `performance.now()`) rather than under Vitest/jsdom, which has no native
 * canvas backing and would only be able to time stubbed calls — see
 * `canvas/renderer.test.ts`'s own comment on why it stubs the context at all.
 * Reproduce with:
 *
 * ```bash
 * npm run dev   # serves at http://localhost:1420
 * # then, from any same-origin page loaded from that dev server (no Tauri
 * # needed — this harness never touches IPC):
 * const m = await import('/src/bench/animationPerf.ts');
 * console.log(await m.runAnimationPerf());
 * ```
 *
 * This module allocates its own cel buffers under ids namespaced
 * `bench-anim-*` and releases them again at the end — it never touches
 * `clearAllBuffers()`, so it is safe to run inside a page that already has a
 * live document mounted.
 */

import { allocateBuffer, releaseBuffer } from '../model/pixelBuffers';
import type { Cel, Frame, Layer, LayerBase, Sprite } from '../model/types';
import { onionSkinFrames } from '../model/onionSkin';
import {
  compositeSprite,
  drawBorder,
  drawCheckerboard,
  drawGrid,
  drawOnionSkin,
  invalidateRenderCache,
} from '../canvas/renderer';
import type { Viewport } from '../canvas/coords';

export interface SpriteShape {
  size: number;
  frameCount: number;
  /** Top-level raster layers outside the group. */
  topLayers: number;
  /** Raster layers nested inside one group. */
  groupLayers: number;
}

export interface TickStats {
  /** ms per tick, sorted ascending. */
  sorted: number[];
  p50: number;
  p95: number;
  max: number;
  mean: number;
  fpsP95: number;
  fpsMean: number;
}

export interface AnimationPerfResult {
  shape: SpriteShape;
  ticks: number;
  onionOff: TickStats;
  onionOn: TickStats;
}

const BLEND_CYCLE: LayerBase['blendMode'][] = ['normal', 'multiply', 'overlay', 'screen'];

function makeLayerBase(id: string, i: number, over: Partial<LayerBase> = {}): LayerBase {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: BLEND_CYCLE[i % BLEND_CYCLE.length],
    parentId: null,
    clippingMask: false,
    effects: [],
    ...over,
  };
}

/** Deterministic pseudo-random fill so every run stresses the same pixels. */
function fillBuffer(buf: Uint8ClampedArray, w: number, h: number, seed: number): void {
  let x = seed || 1;
  for (let i = 0; i < w * h; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const o = i * 4;
    buf[o] = x & 0xff;
    buf[o + 1] = (x >> 6) & 0xff;
    buf[o + 2] = (x >> 12) & 0xff;
    // Mostly opaque with some translucent/transparent pixels, so alpha
    // compositing and clipping both do real work rather than a no-op.
    buf[o + 3] = i % 7 === 0 ? 0 : i % 5 === 0 ? 128 : 255;
  }
}

/**
 * Build a synthetic worst-case-shaped sprite: `shape.topLayers` raster
 * layers, one group holding `shape.groupLayers` more (per Phase 3's layer
 * groups work, the most expensive composite path), one clipping-mask layer
 * inside the group, `shape.frameCount` frames each with a fully independent
 * cel per non-group layer (no linked cels — the worst case for cel-cache
 * warmup cost, and realistic since every frame usually differs in a walk
 * cycle).
 */
export function buildBenchSprite(shape: SpriteShape): { sprite: Sprite; bufferIds: string[] } {
  const { size, frameCount, topLayers, groupLayers } = shape;
  const bufferIds: string[] = [];
  const layers: Layer[] = [];

  for (let i = 0; i < topLayers; i++) {
    layers.push({ ...makeLayerBase(`top-${i}`, i), kind: 'raster' });
  }
  const groupId = 'group-0';
  layers.push({
    ...makeLayerBase(groupId, topLayers, { opacity: 0.9 }),
    kind: 'group',
    collapsed: false,
  });
  for (let i = 0; i < groupLayers; i++) {
    layers.push({
      ...makeLayerBase(`grp-${i}`, topLayers + i, {
        parentId: groupId,
        // Exercise "clip to layer below" for one of the nested layers, per
        // Phase 3 — the group-scoped clip path in `compositeScope`.
        clippingMask: i === groupLayers - 1,
      }),
      kind: 'raster',
    });
  }

  const rasterLayers = layers.filter((l) => l.kind !== 'group');

  const frames: Frame[] = [];
  const cels: Cel[] = [];
  let seed = 1;
  for (let f = 0; f < frameCount; f++) {
    const frameId = `f${f}`;
    frames.push({ id: frameId, durationMs: 100 });
    for (const layer of rasterLayers) {
      const celId = `bench-anim-${layer.id}-${frameId}`;
      cels.push({ id: celId, layerId: layer.id, frameId, x: 0, y: 0, width: size, height: size });
      const buf = allocateBuffer(celId, size, size);
      fillBuffer(buf, size, size, seed++);
      bufferIds.push(celId);
    }
  }

  const sprite: Sprite = {
    width: size,
    height: size,
    layers,
    frames,
    cels,
    tags: [],
    tilesets: [],
  };
  return { sprite, bufferIds };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function summarize(runs: number[]): TickStats {
  const sorted = [...runs].sort((a, b) => a - b);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1];
  return { sorted, p50, p95, max, mean, fpsP95: 1000 / p95, fpsMean: 1000 / mean };
}

const vp: Viewport = { zoom: 1, panX: 0, panY: 0 };

/**
 * One full `CanvasView` redraw-effect tick for `frameId`, optionally with
 * onion-skin ghosts composited too (the worst-case combination this item is
 * about). Draws to a real 2D context so the cost is genuine rasterization,
 * not a stubbed call count.
 */
function tick(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  frameId: string,
  onion: boolean,
  before: number,
  after: number,
): void {
  const { width, height } = sprite;
  ctx.clearRect(0, 0, width, height);
  drawCheckerboard(ctx, 0, 0, width, height);
  if (onion) {
    const idx = sprite.frames.findIndex((f) => f.id === frameId);
    const ghosts = onionSkinFrames(sprite.frames, idx, before, after);
    if (ghosts.length > 0) drawOnionSkin(ctx, sprite, vp, ghosts);
  }
  const composited = compositeSprite(sprite, frameId);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(composited, 0, 0);
  drawGrid(ctx, sprite, vp);
  drawBorder(ctx, sprite, vp);
}

/**
 * Play through every frame once so per-cel canvases are warm
 * (`canvas/renderer.ts`'s cel cache) — steady-state playback re-uses these
 * uploads; only the composite step differs per tick since the active frame
 * changes. Timing the cold pass too would conflate "first paint" cost with
 * "sustained playback" cost, which is what this item is actually about.
 */
function warmUp(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  onion: boolean,
  before: number,
  after: number,
): void {
  for (const frame of sprite.frames) tick(ctx, sprite, frame.id, onion, before, after);
}

function runTimed(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  ticks: number,
  onion: boolean,
  before: number,
  after: number,
): number[] {
  const runs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const frame = sprite.frames[i % sprite.frames.length];
    const t0 = performance.now();
    tick(ctx, sprite, frame.id, onion, before, after);
    runs.push(performance.now() - t0);
  }
  return runs;
}

export async function runAnimationPerf(
  shape: SpriteShape = { size: 512, frameCount: 24, topLayers: 8, groupLayers: 4 },
  ticks = 240,
  /** `state/uiStore.ts::MAX_ONION_SKIN_RANGE` each side — the worst case. */
  onionBefore = 8,
  onionAfter = 8,
): Promise<AnimationPerfResult> {
  invalidateRenderCache();
  const { sprite, bufferIds } = buildBenchSprite(shape);

  const canvas = document.createElement('canvas');
  canvas.width = shape.size;
  canvas.height = shape.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable — cannot benchmark in this environment');

  try {
    // Onion off, steady state.
    warmUp(ctx, sprite, false, onionBefore, onionAfter);
    const off = runTimed(ctx, sprite, ticks, false, onionBefore, onionAfter);

    // Onion on, at the requested range — worst case at the default 8/8.
    invalidateRenderCache();
    warmUp(ctx, sprite, true, onionBefore, onionAfter);
    const on = runTimed(ctx, sprite, ticks, true, onionBefore, onionAfter);

    return {
      shape,
      ticks,
      onionOff: summarize(off),
      onionOn: summarize(on),
    };
  } finally {
    for (const id of bufferIds) releaseBuffer(id);
    invalidateRenderCache();
  }
}
