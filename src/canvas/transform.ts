/**
 * Pixel-art-aware rotate/scale (`docs/08-roadmap.md` Phase 7 — "rotxel,
 * cleanEdge (`04` §7)").
 *
 * `docs/04-image-pipeline.md` §7 names Pixelorama's `rotxel` and `cleanEdge`
 * as the references for rotation and non-integer scale and explicitly warns
 * against naive (bilinear) resampling — CLAUDE.md invariant 1 repeats the
 * same rule. Both algorithms here only ever emit a colour that already
 * exists in the source buffer (or fully-transparent, for the part of the
 * destination the source cannot cover); neither ever blends two colours into
 * a third.
 *
 * **rotxel** is a faithful, line-by-line port of Pixelorama's own CPU
 * implementation, `DrawingAlgos.gd::rotxel()` (MIT-licensed,
 * github.com/Orama-Interactive/Pixelorama, read 2026-08-01 at commit-head of
 * `master`). It treats every destination pixel as nine sub-samples arranged
 * in the source's own 3×3-subdivided space, inverse-rotates each sub-sample
 * to find the first (in a fixed search order) that lands inside the source,
 * then — unless that source pixel sits on the image border, where there is no
 * full neighbourhood to consult — resolves the exact sub-cell position
 * against the source's 3×3 neighbourhood using the same edge-priority rules
 * `scale_3x` (Pixelorama's own scale3x) uses for its own corner outputs. The
 * practical effect is a rotation whose diagonal edges look hand-cleaned
 * rather than a staircase of single-pixel notches, without ever inventing a
 * colour. Pixelorama special-cases exact 0°/90°/180°/270° to a plain
 * reversal or nearest-neighbour lookup instead of running the general
 * algorithm — not an arbitrary choice, but a real fix for a real problem:
 * `Math.cos`/`Math.sin` at exactly π/2 are off by ~6e-17, which the general
 * algorithm's `round()` calls can occasionally resolve to the wrong
 * neighbour. This port keeps that special-casing, but replaces Pixelorama's
 * own (still trig-based) fast path with exact integer arithmetic, since nine
 * lines of exact integer math cost nothing and remove the last trace of
 * floating-point ambiguity at exactly those four angles.
 *
 * **cleanEdge**, on inspection, is not what `docs/04`'s own one-line
 * description ("a post-process ... removes stray/isolated pixels") suggested
 * going in — the real thing (`src/Shaders/Effects/Rotation/cleanEdge.gdshader`,
 * torcado, MIT) is a from-scratch GPU resampling *algorithm* in its own
 * right, an alternative to rotxel rather than a pass that runs after it, and
 * it is GPU-shader-only: its neighbour lookups key off `ceil()` of a
 * continuous UV coordinate sampled through Godot's nearest-texture-filter
 * hardware path, and which physical texel a boundary-straddling UV resolves
 * to is a GPU sampler convention, not something the GLSL source pins down on
 * its own. Porting that specific tie-break to two CPU implementations without
 * a live GPU reference to diff against would mean guessing at the one detail
 * that decides correctness — exactly what CLAUDE.md says not to do. The
 * shader itself documents a simpler variant, `#undef SLOPE` / `#undef
 * CLEANUP` ("otherwise only uses 45 degree slopes"): with those off,
 * `sliceDist`'s logic reduces to "does a 45° diagonal run between this
 * pixel's two orthogonal neighbours, and if so, which side of it does the
 * sample point fall on" — a real, self-contained heuristic, still described
 * (not invented) by the source. `cleanEdgeSample` below implements exactly
 * that reduced heuristic against a plain nearest-pixel-plus-fractional-offset
 * CPU sample, including the shader's own guard against erasing a
 * single-pixel-wide diagonal line (`similar(c, df) && higher(c, f)`, "don't
 * flip"). It is an adaptation of a real, cited heuristic, not a byte-exact
 * port — unlike `rotxel`, which is.
 *
 * **Indexed-mode generalization** (gap-closure follow-up to
 * `docs/08-roadmap.md` Phase 7's indexed color mode: the Transform tool only
 * ever worked on RGBA cels, silently no-op'ing on an indexed one via
 * `canvas/applyTransform.ts`'s `getBuffer` returning `undefined`). Every
 * function below is generic over `bytesPerPixel` — 4 for a straight-alpha
 * RGBA quadruple (the original, still-default behaviour, byte-identical to
 * before), 1 for an indexed cel's raw palette-index byte
 * (`model/celStorage.ts`, `model/indexBuffers.ts`). Both algorithms only ever
 * *select* one of the source's own pixel values per destination pixel — they
 * never blend two values into a third — so the exact same selection logic
 * generalizes to indices for free, as long as "are these two pixels the same
 * colour" (`similarColors`, keyed on a tolerance because sRGB channels are
 * ordinal) is swapped for "are these two pixels the same index"
 * (`indexEquals`, exact — a palette index is a categorical label, not an
 * ordinate, so index 5 sitting one integer away from index 6 says nothing
 * about how close their actual colours are; a numeric tolerance would be
 * meaningless). `indexEquals`'s plain `===` already treats two
 * `TRANSPARENT_INDEX` (0) pixels as equal, for free — the same "both
 * transparent" case `similarColors` special-cases explicitly for RGBA's own
 * alpha channel.
 */

type PixelBuf = Uint8ClampedArray | Uint8Array;

/** One pixel's raw stored values — 4 numbers for RGBA, 1 for a palette index. */
type Px = readonly number[];

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** A same-concrete-type, zero-filled output buffer — mirrors `history/pixelDelta.ts::extractRegion`'s own `T extends CelBuffer` pattern, so a `Uint8Array` caller gets a `Uint8Array` back, never the widened union. */
function sameTypeBuffer<T extends PixelBuf>(buf: T, length: number): T {
  return (
    buf instanceof Uint8ClampedArray ? new Uint8ClampedArray(length) : new Uint8Array(length)
  ) as T;
}

/** Out-of-bounds reads all-zero (transparent RGBA, or `TRANSPARENT_INDEX`) — there is nothing there to sample. */
function readPx(
  buf: PixelBuf,
  width: number,
  height: number,
  x: number,
  y: number,
  bpp: number,
): Px {
  if (x < 0 || y < 0 || x >= width || y >= height) return new Array(bpp).fill(0);
  const i = (y * width + x) * bpp;
  const out = new Array(bpp);
  for (let k = 0; k < bpp; k++) out[k] = buf[i + k];
  return out;
}

function writePx(buf: PixelBuf, width: number, x: number, y: number, c: Px, bpp: number): void {
  const i = (y * width + x) * bpp;
  for (let k = 0; k < bpp; k++) buf[i + k] = c[k];
}

type PixelEquals = (a: Px, b: Px) => boolean;

/**
 * `similar_colors()` from `DrawingAlgos.gd`, default tolerance (0.392157 on a
 * 0..1 channel). Two fully-transparent pixels are always similar regardless
 * of their (meaningless) RGB — the same convention the real `cleanEdge.gdshader`
 * uses in its own `similar()`.
 */
const DEFAULT_TOLERANCE_255 = 0.392157 * 255;

function rgbaSimilar(a: Px, b: Px, tol = DEFAULT_TOLERANCE_255): boolean {
  if (a[3] === 0 && b[3] === 0) return true;
  return (
    Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol &&
    Math.abs(a[3] - b[3]) <= tol
  );
}

/** Indexed storage's own "similarity": exact index equality — see the module doc comment's "Indexed-mode generalization" section for why a tolerance is meaningless here. */
function indexEquals(a: Px, b: Px): boolean {
  return a[0] === b[0];
}

function equalsFor(bytesPerPixel: number): PixelEquals {
  return bytesPerPixel === 1 ? indexEquals : rgbaSimilar;
}

function normalizeAngle(angleRad: number): number {
  const twoPi = Math.PI * 2;
  let a = angleRad % twoPi;
  if (a < 0) a += twoPi;
  return a;
}

const ANGLE_EPS = 1e-6;
function nearAngle(a: number, target: number): boolean {
  return Math.abs(a - target) < ANGLE_EPS || Math.abs(a - target - Math.PI * 2) < ANGLE_EPS;
}

// ---------------------------------------------------------------------------
// rotxel
// ---------------------------------------------------------------------------

/** Exact 180°: reversing both axes never needs rounding or a pivot. */
function flip180<T extends PixelBuf>(buf: T, width: number, height: number, bpp: number): T {
  const out = sameTypeBuffer(buf, buf.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      writePx(
        out,
        width,
        x,
        y,
        readPx(buf, width, height, width - 1 - x, height - 1 - y, bpp),
        bpp,
      );
    }
  }
  return out;
}

/**
 * Exact ±90°, about the true pixel-grid centre `((width-1)/2, (height-1)/2)`
 * — not the caller's pivot, the same deliberate choice Pixelorama's own
 * `Image.rotate_180()` fast path makes for 180°, generalised to 90°/270°.
 * `sign` is `+1` for 90°, `-1` for 270°.
 */
function rotateExact90<T extends PixelBuf>(
  buf: T,
  width: number,
  height: number,
  sign: 1 | -1,
  bpp: number,
): T {
  const out = sameTypeBuffer(buf, buf.length);
  const px2 = width - 1; // 2 × pivot.x, kept as an integer
  const py2 = height - 1; // 2 × pivot.y
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // cos = 0, sin = sign: ox = px - sign*(y - py); oy = py + sign*(x - px)
      const ox = Math.round((px2 - sign * (2 * y - py2)) / 2);
      const oy = Math.round((py2 + sign * (2 * x - px2)) / 2);
      writePx(out, width, x, y, readPx(buf, width, height, ox, oy, bpp), bpp);
    }
  }
  return out;
}

/**
 * The nine `scale3x`-style edge-priority rules `rotxel()` resolves each
 * sub-cell against, ported one-for-one from the GDScript `match index:`
 * block. `index = col + 3*fil` where `col`/`fil` are the sub-cell's column/row
 * (0/1/2) inside the source pixel's 3×3 subdivision — 4 is always the centre
 * and returns `e` unconditionally.
 */
function pickBySubcell(
  index: number,
  a: Px,
  b: Px,
  c: Px,
  d: Px,
  e: Px,
  f: Px,
  g: Px,
  h: Px,
  i: Px,
  equals: PixelEquals,
): Px {
  const s = equals;
  switch (index) {
    case 0:
      return s(d, b) && !s(d, h) && !s(b, f) ? d : e;
    case 1:
      return (s(d, b) && !s(d, h) && !s(b, f) && !s(e, c)) ||
        (s(b, f) && !s(d, b) && !s(f, h) && !s(e, a))
        ? b
        : e;
    case 2:
      return s(b, f) && !s(d, b) && !s(f, h) ? f : e;
    case 3:
      return (s(d, h) && !s(f, h) && !s(d, b) && !s(e, a)) ||
        (s(d, b) && !s(d, h) && !s(b, f) && !s(e, g))
        ? d
        : e;
    case 4:
      return e;
    case 5:
      return (s(b, f) && !s(d, b) && !s(f, h) && !s(e, i)) ||
        (s(f, h) && !s(b, f) && !s(d, h) && !s(e, c))
        ? f
        : e;
    case 6:
      return s(d, h) && !s(f, h) && !s(d, b) ? d : e;
    case 7:
      return (s(f, h) && !s(f, b) && !s(d, h) && !s(e, g)) ||
        (s(d, h) && !s(f, h) && !s(d, b) && !s(e, i))
        ? h
        : e;
    case 8:
      return s(f, h) && !s(f, b) && !s(d, h) ? f : e;
    default:
      return e;
  }
}

/**
 * `rotxel()` for an arbitrary angle — no fast path applies. Faithful port of
 * `DrawingAlgos.gd::rotxel`'s general branch, including its search order (a
 * plain linear scan over the nine sub-cell offsets, taking the *first* one
 * that lands inside the source rather than the closest) and its odd-width
 * correction (`+1` to both `ox` and `oy`, checked against *width* only —
 * that is what the original does, not a transcription slip).
 */
function rotxelGeneral<T extends PixelBuf>(
  buf: T,
  width: number,
  height: number,
  angleRad: number,
  pivotX: number,
  pivotY: number,
  bpp: number,
  equals: PixelEquals,
): T {
  const out = sameTypeBuffer(buf, buf.length);
  const w3 = width * 3;
  const h3 = height * 3;
  const oddWidth = width % 2 !== 0;

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const dx = 3 * (x - pivotX);
      const dy = 3 * (y - pivotY);
      let ox = 0;
      let oy = 0;
      let found = false;

      for (let k = 0; k < 9 && !found; k++) {
        const modk = -1 + (k % 3);
        const divk = -1 + Math.floor(k / 3);
        let dir = Math.atan2(dy + divk, dx + modk);
        const mag = Math.sqrt((dx + modk) ** 2 + (dy + divk) ** 2);
        dir += angleRad;
        ox = Math.round(pivotX * 3 + 1 + mag * Math.cos(dir));
        oy = Math.round(pivotY * 3 + 1 + mag * Math.sin(dir));

        if (oddWidth) {
          ox += 1;
          oy += 1;
        }

        if (ox >= 0 && ox < w3 && oy >= 0 && oy < h3) found = true;
      }

      if (!found) {
        writePx(out, width, x, y, new Array(bpp).fill(0), bpp);
        continue;
      }

      const fil = oy % 3;
      const col = ox % 3;
      const index = col + 3 * fil;

      const sx = Math.round((ox - 1) / 3);
      const sy = Math.round((oy - 1) / 3);

      if (sx === 0 || sx === width - 1 || sy === 0 || sy === height - 1) {
        writePx(out, width, x, y, readPx(buf, width, height, sx, sy, bpp), bpp);
        continue;
      }

      const a = readPx(buf, width, height, sx - 1, sy - 1, bpp);
      const b = readPx(buf, width, height, sx, sy - 1, bpp);
      const c = readPx(buf, width, height, sx + 1, sy - 1, bpp);
      const d = readPx(buf, width, height, sx - 1, sy, bpp);
      const e = readPx(buf, width, height, sx, sy, bpp);
      const f = readPx(buf, width, height, sx + 1, sy, bpp);
      const g = readPx(buf, width, height, sx - 1, sy + 1, bpp);
      const h = readPx(buf, width, height, sx, sy + 1, bpp);
      const i = readPx(buf, width, height, sx + 1, sy + 1, bpp);

      writePx(out, width, x, y, pickBySubcell(index, a, b, c, d, e, f, g, h, i, equals), bpp);
    }
  }

  return out;
}

/**
 * Rotate `buf` (`width`×`height`) by `angleRad` about `(pivotX, pivotY)`
 * (defaults to the buffer's own centre), staying inside the same
 * `width`×`height` footprint — content that rotates outside it is clipped,
 * exactly as Pixelorama's own CPU `rotxel()` does (it mutates the cel's
 * `Image` in place rather than growing the canvas). Every output pixel is
 * either fully transparent/`TRANSPARENT_INDEX` or a value that already
 * existed somewhere in `buf`.
 *
 * `bytesPerPixel` defaults to 4 (straight-alpha RGBA) — every pre-indexed-mode
 * call site is unaffected; an indexed cel (`model/celStorage.ts`) passes 1.
 * `T` is inferred from `buf`, so a `Uint8ClampedArray` in gets a
 * `Uint8ClampedArray` out and a `Uint8Array` in gets a `Uint8Array` out.
 */
export function rotxelRotate<T extends PixelBuf>(
  buf: T,
  width: number,
  height: number,
  angleRad: number,
  pivotX = width / 2,
  pivotY = height / 2,
  bytesPerPixel = 4,
): T {
  const angle = normalizeAngle(angleRad);
  if (nearAngle(angle, 0)) {
    const out = sameTypeBuffer(buf, buf.length);
    out.set(buf);
    return out;
  }
  if (nearAngle(angle, Math.PI)) return flip180(buf, width, height, bytesPerPixel);
  if (nearAngle(angle, Math.PI / 2)) return rotateExact90(buf, width, height, 1, bytesPerPixel);
  if (nearAngle(angle, (3 * Math.PI) / 2))
    return rotateExact90(buf, width, height, -1, bytesPerPixel);
  return rotxelGeneral(
    buf,
    width,
    height,
    angleRad,
    pivotX,
    pivotY,
    bytesPerPixel,
    equalsFor(bytesPerPixel),
  );
}

// ---------------------------------------------------------------------------
// cleanEdge (adapted — see module doc comment)
// ---------------------------------------------------------------------------

/**
 * Sample `buf` at a continuous position `(sx, sy)` in pixel-centre space
 * (integers are exact pixel centres). Falls back to plain nearest-neighbour
 * whenever there is no 45° diagonal edge to reason about — the adapted
 * heuristic only ever changes the answer when one is genuinely present.
 *
 * `bytesPerPixel` defaults to 4 (RGBA); an indexed cel passes 1 — see the
 * module doc comment's "Indexed-mode generalization" section.
 */
export function cleanEdgeSample(
  buf: PixelBuf,
  width: number,
  height: number,
  sx: number,
  sy: number,
  bytesPerPixel = 4,
): Px {
  const bpp = bytesPerPixel;
  const equals = equalsFor(bpp);
  const nx = Math.round(sx);
  const ny = Math.round(sy);
  const c = readPx(buf, width, height, nx, ny, bpp);

  const lx = sx - nx;
  const ly = sy - ny;
  if (lx === 0 && ly === 0) return c;

  const dirX = lx >= 0 ? 1 : -1;
  const dirY = ly >= 0 ? 1 : -1;
  const f = readPx(buf, width, height, nx + dirX, ny, bpp); // orthogonal neighbour toward the quadrant
  const d = readPx(buf, width, height, nx, ny + dirY, bpp);
  const corner = readPx(buf, width, height, nx + dirX, ny + dirY, bpp);

  // No same-colour diagonal run between the two orthogonal neighbours: no
  // edge to slice through, so this degrades to nearest-neighbour exactly.
  if (!equals(f, d)) return c;

  // `similar(c, df) && higher(c, f)` in the source — protects a single-pixel-
  // wide diagonal line from being eaten by its own neighbours' agreement.
  if (!equals(c, f) && !equals(c, d) && equals(c, corner)) return c;

  const ax = Math.abs(lx);
  const ay = Math.abs(ly);
  if (ax === ay) return c; // exact tie: keep the centre, deterministically
  return ax > ay ? f : d;
}

export type TransformAlgorithm = 'rotxel' | 'cleanEdge';

/**
 * Combined rotate + non-integer scale, staying inside the same `width`×
 * `height` footprint (mirrors `rotxelRotate`'s own contract). Every output
 * pixel is `cleanEdgeSample`'s answer for that destination's inverse-mapped
 * source position, so — same as `rotxelRotate` — the result is always either
 * transparent/`TRANSPARENT_INDEX` or a value that already existed in `buf`.
 *
 * `bytesPerPixel` defaults to 4 (RGBA); an indexed cel passes 1, same
 * `T`-inferred-from-`buf` shape `rotxelRotate` uses.
 */
export function cleanEdgeTransform<T extends PixelBuf>(
  buf: T,
  width: number,
  height: number,
  angleRad: number,
  scale: number,
  pivotX = width / 2,
  pivotY = height / 2,
  bytesPerPixel = 4,
): T {
  const bpp = bytesPerPixel;
  const out = sameTypeBuffer(buf, width * height * bpp);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - pivotX;
      const dy = y - pivotY;
      // Inverse of "rotate by angleRad then scale by `scale` about the
      // pivot" — same R(angle) convention `rotxelGeneral`/`nn_rotate` use, so
      // switching algorithms at scale = 1 rotates the same visual direction.
      const sxr = (dx * cos - dy * sin) / scale;
      const syr = (dx * sin + dy * cos) / scale;
      const sx = pivotX + sxr;
      const sy = pivotY + syr;
      writePx(out, width, x, y, cleanEdgeSample(buf, width, height, sx, sy, bpp), bpp);
    }
  }

  return out;
}
