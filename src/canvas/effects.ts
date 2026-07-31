/**
 * Non-destructive layer effects (`docs/03-data-model.md` §5, roadmap Phase 7
 * "Non-destructive layer effects: outline, drop shadow, gradient map").
 *
 * Every function here is pure: `(pixels, width, height, effect) => new
 * Uint8ClampedArray`. They never touch a cel's stored buffer — a layer's own
 * pixels are read once by the caller (`canvas/flatten.ts`'s per-layer "own"
 * content, already placed at document scale), passed through whichever
 * enabled effects the layer has in order, and the *result* is what gets
 * composited with the layers below. Turning an effect off, or reordering the
 * stack, only changes what this module is asked to do next time — the
 * source pixels underneath are never mutated, which is what "non-destructive"
 * means here.
 *
 * Straight alpha throughout (`docs/02-architecture.md` §9); nearest-neighbour
 * spirit carried over as "no soft/anti-aliased edges" — every effect below
 * produces a hard 0/255-style boundary (or leaves alpha exactly as it was),
 * never a blurred one.
 */

import { srgb8ToOklab, oklabToSrgb8 } from '../pipeline/oklab.ts';
import type { Effect, RGBA } from '../model/types';
import { compositeOver } from './compositeOver.ts';

// ---------------------------------------------------------------------------
// Shared silhouette morphology — outline and outline-inner both grow/shrink a
// binary alpha silhouette one ring at a time, up to `thickness` rings, and
// paint whatever ring they land on.
// ---------------------------------------------------------------------------

function silhouette(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 3; p < mask.length; p++, i += 4) mask[p] = pixels[i] > 0 ? 1 : 0;
  return mask;
}

/**
 * One ring of outward growth. `corners` (docs/03-data-model.md §5's own
 * field, only present on `outline`) toggles 8-connected (diagonal neighbours
 * count) vs. 4-connected (orthogonal only) adjacency — the doc names the
 * field but not its meaning, so this is documented here rather than left
 * implicit: with `corners: false` a ring only grows straight out from a flat
 * edge, so a single opaque pixel's outward ring at distance 1 is a plain "+"
 * shape; with `corners: true` it also fills the diagonal neighbours, so the
 * same ring is a solid 3×3 minus the center.
 *
 * `corners` only changes *single-step* adjacency — at `thickness > 1`,
 * repeated 4-connected steps still compound into a diamond (Manhattan-
 * distance) shape rather than a strict plus, since a diagonal neighbour two
 * Manhattan-steps away is reached via an intermediate orthogonal pixel on a
 * later ring. Expected behaviour of iterated 4-connected dilation, not a bug
 * in `corners: false` (`effects.test.ts` pins this down explicitly).
 *
 * A missing (out-of-canvas) neighbour simply cannot dilate into — there is
 * nothing there to grow from, the same convention `mask_post_process.rs`'s
 * `dilateAlpha` already uses.
 */
function dilateOnce(mask: Uint8Array, width: number, height: number, corners: boolean): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p]) {
        out[p] = 1;
        continue;
      }
      let hit = false;
      if (x > 0 && mask[p - 1]) hit = true;
      else if (x + 1 < width && mask[p + 1]) hit = true;
      else if (y > 0 && mask[p - width]) hit = true;
      else if (y + 1 < height && mask[p + width]) hit = true;
      else if (corners) {
        if (x > 0 && y > 0 && mask[p - width - 1]) hit = true;
        else if (x + 1 < width && y > 0 && mask[p - width + 1]) hit = true;
        else if (x > 0 && y + 1 < height && mask[p + width - 1]) hit = true;
        else if (x + 1 < width && y + 1 < height && mask[p + width + 1]) hit = true;
      }
      out[p] = hit ? 1 : 0;
    }
  }
  return out;
}

/**
 * One ring of inward shrinkage — the dual of {@link dilateOnce}. A pixel
 * survives only if it and every in-connectivity neighbour is set.
 *
 * Unlike `mask_post_process.rs`'s `erodeAlpha` (which treats a missing
 * neighbour as opaque, so a background-removal *closing* pass never eats
 * content that legitimately runs to the *source photo's* edge), a missing
 * neighbour here is treated as **background** (0): `outline-inner` is a
 * display effect on a *sprite canvas*, where the canvas edge is a real
 * boundary of the artwork, not an artifact of how the source photo happened
 * to be framed — a shape that runs up to the canvas edge has a real edge
 * there and should get the inner outline same as any other edge.
 *
 * `docs/03-data-model.md` §5 gives `outline-inner` no `corners` field (unlike
 * `outline`), so this is fixed at 4-connected — the same connectivity
 * `cleanup.ts`/`backgroundRemoval.ts`/`mask_post_process.rs` already default
 * to elsewhere in this codebase, and the smallest reasonable reading of the
 * doc's own omission.
 */
function erodeOnce(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) {
        out[p] = 0;
        continue;
      }
      const left = x > 0 && mask[p - 1];
      const right = x + 1 < width && mask[p + 1];
      const up = y > 0 && mask[p - width];
      const down = y + 1 < height && mask[p + width];
      out[p] = left && right && up && down ? 1 : 0;
    }
  }
  return out;
}

function writeColor(out: Uint8ClampedArray, p: number, color: RGBA): void {
  const i = p * 4;
  out[i] = color[0];
  out[i + 1] = color[1];
  out[i + 2] = color[2];
  out[i + 3] = color[3];
}

/**
 * A border of `effect.color` at `effect.thickness` pixels *outward* from the
 * layer's opaque silhouette (`docs/03-data-model.md` §5). Only ever paints
 * pixels that were transparent to begin with — the layer's own opaque pixels
 * are never touched, which is what keeps this reversible.
 */
export function outlineEffect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<Effect, { kind: 'outline' }>,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(pixels);
  const thickness = Math.max(0, Math.trunc(effect.thickness));
  if (thickness === 0) return out;

  let mask = silhouette(pixels, width, height);
  for (let step = 0; step < thickness; step++) {
    const next = dilateOnce(mask, width, height, effect.corners);
    for (let p = 0; p < next.length; p++) {
      if (next[p] && !mask[p]) writeColor(out, p, effect.color);
    }
    mask = next;
  }
  return out;
}

/**
 * A border of `effect.color` at `effect.thickness` pixels *inward* from the
 * layer's opaque silhouette — replaces the layer's own edge pixels instead of
 * adding new ones outside it. Never touches an already-transparent pixel.
 */
export function outlineInnerEffect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<Effect, { kind: 'outline-inner' }>,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(pixels);
  const thickness = Math.max(0, Math.trunc(effect.thickness));
  if (thickness === 0) return out;

  let mask = silhouette(pixels, width, height);
  for (let step = 0; step < thickness; step++) {
    const eroded = erodeOnce(mask, width, height);
    for (let p = 0; p < mask.length; p++) {
      // Still part of the shape but would not survive one more erosion —
      // exactly the ring `step` pixels in from the true edge. Recolour keeps
      // the pixel's own alpha (it was already opaque); only its RGB and, if
      // `effect.color` itself carries partial alpha, its alpha change.
      if (mask[p] && !eroded[p]) {
        const i = p * 4;
        out[i] = effect.color[0];
        out[i + 1] = effect.color[1];
        out[i + 2] = effect.color[2];
        out[i + 3] = Math.min(pixels[i + 3], effect.color[3]);
      }
    }
    mask = eroded;
  }
  return out;
}

/**
 * An offset (`dx`,`dy`) copy of the layer's own silhouette in `effect.color`,
 * composited *behind* the layer's own content (`docs/03-data-model.md` §5) —
 * so wherever the layer itself is opaque, its own pixel wins; the shadow only
 * shows where the layer is transparent but its shifted silhouette is not.
 *
 * Reuses `compositeOver` (straight alpha, `docs/02-architecture.md` §9) for
 * the "own content over shadow" merge, the same maths `flatten.ts`'s own
 * layer-over-layer compositing uses, rather than a bespoke alpha blend.
 */
export function dropShadowEffect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<Effect, { kind: 'drop-shadow' }>,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  const dx = Math.trunc(effect.dx);
  const dy = Math.trunc(effect.dy);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const sx = x - dx;
      const sy = y - dy;
      let shadow: RGBA = [0, 0, 0, 0];
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const sp = (sy * width + sx) * 4;
        if (pixels[sp + 3] > 0) shadow = effect.color;
      }

      const ownAlpha = pixels[p + 3];
      let merged: RGBA;
      if (ownAlpha === 0) {
        merged = shadow;
      } else {
        const own: RGBA = [pixels[p], pixels[p + 1], pixels[p + 2], ownAlpha];
        merged = compositeOver(own, 1, shadow, 'normal');
      }
      out[p] = merged[0];
      out[p + 1] = merged[1];
      out[p + 2] = merged[2];
      out[p + 3] = merged[3];
    }
  }
  return out;
}

/**
 * Sample an ordered palette gradient at `t` (0..1), interpolating between the
 * two nearest stops in Oklab — see {@link gradientMapEffect}'s own comment for
 * why Oklab, not sRGB.
 */
function sampleGradient(palette: readonly RGBA[], t: number): RGBA {
  if (palette.length === 1) return palette[0];
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (palette.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, palette.length - 1);
  const frac = pos - i0;

  const c0 = palette[i0];
  const c1 = palette[i1];
  if (frac === 0) return c0;

  const ok0 = srgb8ToOklab(c0[0] / 255, c0[1] / 255, c0[2] / 255);
  const ok1 = srgb8ToOklab(c1[0] / 255, c1[1] / 255, c1[2] / 255);
  const [r, g, b] = oklabToSrgb8({
    l: ok0.l + (ok1.l - ok0.l) * frac,
    a: ok0.a + (ok1.a - ok0.a) * frac,
    b: ok0.b + (ok1.b - ok0.b) * frac,
  });
  const alpha = Math.round(c0[3] + (c1[3] - c0[3]) * frac);
  return [r, g, b, alpha];
}

/**
 * Remaps each opaque pixel's own luminance to a gradient built from
 * `effect.palette` (`docs/03-data-model.md` §5): the *darkest opaque pixel in
 * this layer* maps to `palette[0]`, the *brightest* to `palette[last]`,
 * everything else interpolated by where its own luminance falls in between —
 * an auto-stretched tone-to-gradient remap (Photoshop's "Gradient Map"
 * adjustment), not a fixed black-to-white mapping. Transparent pixels are
 * left alone (both colour and alpha) since they contribute nothing to see.
 *
 * **Oklab vs. sRGB, decided explicitly rather than left implicit**: CLAUDE.md
 * invariant 5 ("all colour distance and error diffusion happen in Oklab") is
 * scoped to the conversion *pipeline*'s palette quantization and dithering,
 * where Rust and TS must agree to identical palette indices (D12) — a
 * cross-language parity concern that does not exist here, since effects have
 * no Rust mirror at all (Rust never composites layers, `docs/02-architecture.md`
 * §6.2) and nothing about this function's output is compared bit-for-bit
 * against another implementation. That said, Oklab's `l` is a much better
 * "how bright does this actually look" measure than naive gamma-encoded sRGB
 * luma, and the project already has it hand-rolled and cheap
 * (`pipeline/oklab.ts::srgb8ToOklab`) — so this uses Oklab `l` for the
 * luminance ordering, and interpolates the gradient's own stops in Oklab too,
 * for the same "colour math belongs in a perceptual space" reasoning this
 * project applies everywhere else it touches colour, even though this
 * specific function is not the one D12/invariant 5 was written to constrain.
 */
export function gradientMapEffect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<Effect, { kind: 'gradient-map' }>,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(pixels);
  if (effect.palette.length === 0) return out; // nothing to map to — no-op

  const n = width * height;
  const lums = new Float64Array(n);
  let lMin = Infinity;
  let lMax = -Infinity;
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    if (pixels[i] === 0) continue; // transparent — excluded from the range and left alone
    const { l } = srgb8ToOklab(pixels[i - 3] / 255, pixels[i - 2] / 255, pixels[i - 1] / 255);
    lums[p] = l;
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
  }
  const range = lMax - lMin;

  for (let p = 0, i = 3; p < n; p++, i += 4) {
    if (pixels[i] === 0) continue;
    const t = range > 0 ? (lums[p] - lMin) / range : 0;
    const [r, g, b] = sampleGradient(effect.palette, t);
    out[i - 3] = r;
    out[i - 2] = g;
    out[i - 1] = b;
    // Colour only — this effect remaps hue/lightness, not opacity.
  }
  return out;
}

// ---------------------------------------------------------------------------
// HSV shift
// ---------------------------------------------------------------------------

function rgbToHsv(r: number, g: number, b: number): [h: number, s: number, v: number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [r: number, g: number, b: number] {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1]: [number, number, number] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  const to8 = (n: number) => Math.max(0, Math.min(255, Math.round((n + m) * 255)));
  return [to8(r1), to8(g1), to8(b1)];
}

/**
 * Shift each opaque pixel's hue/saturation/value by `effect.h`/`.s`/`.v`
 * (`docs/03-data-model.md` §5). The doc names the three fields but not their
 * units, so this fixes a convention explicitly: `h` is degrees, added and
 * wrapped into 0..360 (matches hue's own natural period); `s` and `v` are
 * percentage points (-100..100) added to the pixel's own 0..100 saturation/
 * value and clamped back to that range — the common "Hue/Saturation" slider
 * convention most image editors already use, rather than a multiplicative
 * scale.
 */
export function hsvShiftEffect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<Effect, { kind: 'hsv-shift' }>,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(pixels);
  const n = width * height;
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    if (pixels[i] === 0) continue;
    const [h, s, v] = rgbToHsv(pixels[i - 3], pixels[i - 2], pixels[i - 1]);
    let h2 = (h + effect.h) % 360;
    if (h2 < 0) h2 += 360;
    const s2 = Math.max(0, Math.min(1, s + effect.s / 100));
    const v2 = Math.max(0, Math.min(1, v + effect.v / 100));
    const [r, g, b] = hsvToRgb(h2, s2, v2);
    out[i - 3] = r;
    out[i - 2] = g;
    out[i - 1] = b;
  }
  return out;
}

/**
 * Apply a layer's whole effect stack, in order — each entry composites onto
 * the *previous* entry's output, so `[outline, gradient-map]` and
 * `[gradient-map, outline]` are genuinely different results (the outline's
 * own colour either does or does not get remapped by the gradient afterwards).
 * Disabled entries are skipped entirely. An effect-less or all-disabled stack
 * returns the same reference, not a copy — the common case allocates nothing.
 */
export function applyEffects(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effects: readonly Effect[],
): Uint8ClampedArray {
  let out = pixels;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    switch (effect.kind) {
      case 'outline':
        out = outlineEffect(out, width, height, effect);
        break;
      case 'outline-inner':
        out = outlineInnerEffect(out, width, height, effect);
        break;
      case 'drop-shadow':
        out = dropShadowEffect(out, width, height, effect);
        break;
      case 'gradient-map':
        out = gradientMapEffect(out, width, height, effect);
        break;
      case 'hsv-shift':
        out = hsvShiftEffect(out, width, height, effect);
        break;
    }
  }
  return out;
}

/** A cache key fragment capturing everything about a layer's effect stack that can change its output. */
export function effectsFingerprint(effects: readonly Effect[]): string {
  if (effects.length === 0) return '';
  return effects.map((e) => JSON.stringify(e)).join('|');
}

export function hasEnabledEffects(effects: readonly Effect[]): boolean {
  return effects.some((e) => e.enabled);
}
