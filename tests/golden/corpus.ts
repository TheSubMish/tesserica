/**
 * The golden corpus — source images for the cross-implementation parity suite
 * (`docs/04-image-pipeline.md` §11).
 *
 * §11 asks for "photo (portrait), photo (landscape), flat illustration,
 * existing pixel art, image with alpha, high-contrast graphic, gradient". Real
 * photographs cannot be committed here — licensing, size, and the fact that a
 * corpus nobody can regenerate rots. So every source is **synthesized
 * deterministically by the pure functions below**, chosen to exercise the same
 * properties the real categories would: smooth tonal ramps, fine noise, hard
 * flat edges, an already-pixel-art grid, and a soft alpha edge.
 *
 * `npm run golden:corpus` writes them to `sources/` as:
 *
 * - `<name>.rgba` — raw straight-alpha RGBA, row-major. **This is what both
 *   implementations read.** Raw rather than PNG on purpose: it puts identical
 *   bytes into both pipelines, so a parity failure is a pipeline bug and never
 *   a difference between two PNG decoders.
 * - `<name>.png` — the same pixels, for humans to look at. The Rust runner
 *   asserts it decodes back to the `.rgba` byte for byte, so the two cannot
 *   drift.
 */

export interface GoldenSource {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** What this source is here to stress. */
  readonly exercises: string;
  readonly render: (width: number, height: number) => Uint8ClampedArray;
}

/**
 * mulberry32 — a tiny, fully specified PRNG.
 *
 * Deliberately not `Math.random()`: the corpus has to be byte-identical every
 * time it is regenerated, on any machine.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function alloc(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4);
}

function put(
  buf: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const i = (y * width + x) * 4;
  buf[i] = clamp8(r);
  buf[i + 1] = clamp8(g);
  buf[i + 2] = clamp8(b);
  buf[i + 3] = clamp8(a);
}

/** Smooth blobs plus fine grain — the tonal character of a portrait photo. */
function renderPhotoPortrait(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  const rand = mulberry32(0x504f5254);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      // A head-and-shoulders-ish falloff: warm subject, cool vignette.
      const dx = u - 0.5;
      const dy = v - 0.42;
      const d = Math.sqrt(dx * dx * 1.8 + dy * dy);
      const subject = Math.max(0, 1 - d * 2.4);
      const shade = 0.35 + 0.65 * Math.pow(subject, 0.7);
      const grain = (rand() - 0.5) * 14;
      put(
        buf,
        width,
        x,
        y,
        228 * shade + grain + 18 * (1 - shade),
        176 * shade + grain + 26 * (1 - shade),
        150 * shade + grain + 44 * (1 - shade),
        255,
      );
    }
  }
  return buf;
}

/** Sky gradient, hard horizon, textured ground — a landscape photo's structure. */
function renderPhotoLandscape(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  const rand = mulberry32(0x4c414e44);
  const horizon = Math.floor(height * 0.55);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < horizon) {
        const t = y / horizon;
        const sun = Math.max(0, 1 - Math.hypot(x / width - 0.72, y / horizon - 0.25) * 3.2);
        put(
          buf,
          width,
          x,
          y,
          60 + 150 * t + 190 * sun,
          110 + 110 * t + 160 * sun,
          200 - 30 * t + 90 * sun,
          255,
        );
      } else {
        const t = (y - horizon) / (height - horizon);
        const grain = (rand() - 0.5) * 34;
        put(buf, width, x, y, 70 + 60 * t + grain, 95 + 70 * t + grain, 48 + 30 * t + grain, 255);
      }
    }
  }
  return buf;
}

/** Flat fills and hard edges — vector illustration and logo territory. */
function renderFlatIllustration(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  const palette: ReadonlyArray<readonly [number, number, number]> = [
    [242, 240, 232],
    [34, 44, 64],
    [220, 78, 66],
    [246, 190, 62],
    [64, 148, 132],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let idx = 0;
      if (Math.hypot(u - 0.38, v - 0.4) < 0.26) idx = 2;
      else if (u + v > 1.35) idx = 4;
      else if (v > 0.72) idx = 1;
      else if (u > 0.7 && v < 0.3) idx = 3;
      const [r, g, b] = palette[idx];
      put(buf, width, x, y, r, g, b, 255);
    }
  }
  return buf;
}

/**
 * A 16×16 sprite scaled 8× with nearest neighbour.
 *
 * This is the "I have a pixel art PNG at the wrong size" case, and the one
 * where `downscaleMode: 'box'` is destructive and `nearest` is correct
 * (`docs/04` §3.1).
 */
function renderPixelArt(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  const cell = 16;
  const scale = Math.floor(width / cell);
  const swatches: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 0, 0],
    [24, 20, 37, 255],
    [229, 179, 107, 255],
    [176, 48, 60, 255],
    [72, 120, 168, 255],
    [255, 255, 255, 255],
  ];
  // A tiny deterministic "sprite": border, body, two eyes, a mouth.
  const sprite: number[][] = [];
  for (let y = 0; y < cell; y++) {
    const row: number[] = [];
    for (let x = 0; x < cell; x++) {
      const inHead = x >= 3 && x <= 12 && y >= 2 && y <= 11;
      const onEdge = inHead && (x === 3 || x === 12 || y === 2 || y === 11);
      let s = 0;
      if (onEdge) s = 1;
      else if (inHead) s = 2;
      if (inHead && (y === 5 || y === 6) && (x === 6 || x === 9)) s = 1;
      if (inHead && y === 9 && x >= 6 && x <= 9) s = 3;
      if (!inHead && y >= 12 && x >= 4 && x <= 11) s = 4;
      if (inHead && y === 3 && x >= 5 && x <= 10) s = 5;
      row.push(s);
    }
    sprite.push(row);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = swatches[sprite[Math.floor(y / scale)][Math.floor(x / scale)]];
      put(buf, width, x, y, r, g, b, a);
    }
  }
  return buf;
}

/**
 * A coloured disc with a soft alpha edge on a fully transparent field.
 *
 * The one source that catches the most common bug in naive converters: box
 * downscaling that averages a transparent pixel's RGB and bleeds a dark fringe
 * into every edge (`docs/04` §4.4). The transparent field here is transparent
 * *green*, so an unweighted average is instantly visible rather than subtle.
 */
function renderAlpha(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x / width - 0.5, y / height - 0.5);
      const edge = (0.36 - d) / 0.08;
      const a = Math.max(0, Math.min(1, edge)) * 255;
      if (a <= 0) {
        put(buf, width, x, y, 0, 255, 0, 0);
      } else {
        put(buf, width, x, y, 245, 120, 40, a);
      }
    }
  }
  return buf;
}

/** Pure black and white at high spatial frequency — worst case for dithering. */
function renderHighContrast(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0;
      const bar = y > height * 0.7 && Math.floor(x / 2) % 2 === 0;
      const on = y > height * 0.7 ? bar : checker;
      const v = on ? 255 : 0;
      put(buf, width, x, y, v, v, v, 255);
    }
  }
  return buf;
}

/** A smooth two-axis ramp — the banding and dithering reference. */
function renderGradient(width: number, height: number): Uint8ClampedArray {
  const buf = alloc(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      put(buf, width, x, y, 255 * u, 255 * v, 255 * (1 - u * v), 255);
    }
  }
  return buf;
}

/**
 * Sizes are small on purpose. The corpus is committed and runs on every parity
 * check; the properties being tested are per-pixel, so a 128px source proves
 * exactly what a 4000px one would and costs a thousandth as much.
 */
export const SOURCES: readonly GoldenSource[] = [
  {
    name: 'photo-portrait',
    width: 96,
    height: 128,
    exercises: 'smooth tonal falloff plus fine grain, portrait aspect',
    render: renderPhotoPortrait,
  },
  {
    name: 'photo-landscape',
    width: 128,
    height: 96,
    exercises: 'sky ramp, a hard horizon, textured ground, landscape aspect',
    render: renderPhotoLandscape,
  },
  {
    name: 'flat-illustration',
    width: 96,
    height: 96,
    exercises: 'large flat fills with hard edges',
    render: renderFlatIllustration,
  },
  {
    name: 'pixel-art',
    width: 128,
    height: 128,
    exercises: 'an existing 16x16 sprite upscaled 8x — nearest vs box downscale',
    render: renderPixelArt,
  },
  {
    name: 'alpha',
    width: 96,
    height: 96,
    exercises: 'a soft alpha edge over transparent green — alpha-weighted downscale',
    render: renderAlpha,
  },
  {
    name: 'high-contrast',
    width: 96,
    height: 96,
    exercises: 'pure black/white at high spatial frequency',
    render: renderHighContrast,
  },
  {
    name: 'gradient',
    width: 128,
    height: 64,
    exercises: 'a smooth two-axis ramp — banding and dither reference',
    render: renderGradient,
  },
];

export function sourceByName(name: string): GoldenSource {
  const s = SOURCES.find((c) => c.name === name);
  if (!s) throw new Error(`unknown golden source: ${name}`);
  return s;
}
