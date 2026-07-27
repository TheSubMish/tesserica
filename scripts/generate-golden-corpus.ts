/**
 * Regenerates the golden corpus in `tests/golden/sources/`.
 *
 *     npm run golden:corpus
 *
 * The sources are committed (`docs/07-tech-stack.md` §4) but are *derived* —
 * every byte comes from the pure functions in `tests/golden/corpus.ts`, so this
 * script is reproducible and the corpus can never become a set of files nobody
 * can regenerate.
 *
 * Two files per source:
 *
 * - `<name>.rgba` — raw straight-alpha RGBA. Both implementations read this, so
 *   they start from identical bytes and a parity failure can only be a pipeline
 *   bug, never a PNG-decoder difference.
 * - `<name>.png`  — the same pixels, so a human can look at the corpus. The
 *   Rust runner asserts it decodes back to the `.rgba` byte for byte.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES } from '../tests/golden/corpus.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sourcesDir = join(here, '..', 'tests', 'golden', 'sources');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Minimal 8-bit RGBA PNG encoder — filter type 0 on every scanline.
 *
 * Hand-rolled rather than pulled in as a dependency: this runs once, offline,
 * to produce review copies of seven tiny images. A dependency would be a larger
 * commitment than the 30 lines it replaces.
 */
function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

mkdirSync(sourcesDir, { recursive: true });

const manifest = SOURCES.map((s) => {
  const rgba = s.render(s.width, s.height);
  if (rgba.length !== s.width * s.height * 4) {
    throw new Error(`${s.name}: renderer produced ${rgba.length} bytes`);
  }
  writeFileSync(join(sourcesDir, `${s.name}.rgba`), rgba);
  writeFileSync(join(sourcesDir, `${s.name}.png`), encodePng(s.width, s.height, rgba));
  process.stdout.write(`  ${s.name}  ${s.width}x${s.height}  ${s.exercises}\n`);
  return { name: s.name, width: s.width, height: s.height, exercises: s.exercises };
});

writeFileSync(
  join(sourcesDir, 'manifest.json'),
  `${JSON.stringify({ sources: manifest }, null, 2)}\n`,
);

process.stdout.write(`wrote ${manifest.length} sources to tests/golden/sources/\n`);
