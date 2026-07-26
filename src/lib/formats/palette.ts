/**
 * Palette import (`docs/03-data-model.md` §3).
 *
 * Four formats, because between them they unlock the ~4,400-palette Lospec
 * catalogue — which is exactly how users get artist-made palettes that the
 * project may not bundle itself (`docs/07-tech-stack.md` §8).
 *
 * | Format    | Ext    | Shape                                        |
 * |-----------|--------|----------------------------------------------|
 * | Plain hex | `.hex` | one `RRGGBB` per line                        |
 * | GIMP      | `.gpl` | `GIMP Palette` header, then `R G B  Name`    |
 * | JASC      | `.pal` | `JASC-PAL` / `0100` / count, then `R G B`    |
 * | RIFF      | `.pal` | binary `RIFF….PAL data` with BGR0 entries    |
 * | Paint.NET | `.txt` | `AARRGGBB` per line, `;` comments            |
 *
 * **Byte order is the trap.** `.hex` puts alpha last when it carries alpha at
 * all; Paint.NET puts it *first*. Getting that backwards silently produces a
 * palette of nearly-transparent colours rather than an error, so both
 * orderings are pinned by tests.
 *
 * Input arrives as bytes, not text, because the RIFF variant of `.pal` is
 * binary and has to be sniffed before any decoding is attempted.
 */

import type { Palette, RGBA } from '../../model/types';

export class PaletteParseError extends Error {}

const decoder = new TextDecoder('utf-8');

/** Strip a UTF-8 BOM and normalise line endings — CRLF is common in `.pal`. */
function toText(bytes: Uint8Array): string {
  let text = decoder.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

function hexToRgba(token: string): RGBA | null {
  const t = token.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(t)) {
    const n = parseInt(t, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
  }
  if (/^[0-9a-fA-F]{8}$/.test(t)) {
    // `.hex` with alpha puts it last: RRGGBBAA.
    const n = parseInt(t, 16);
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  return null;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

// ---------------------------------------------------------------------------

export function parseHexPalette(text: string): RGBA[] {
  const colors: RGBA[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const color = hexToRgba(line.split(/\s+/)[0]);
    if (color) colors.push(color);
  }
  return colors;
}

export function parseGpl(text: string): { name?: string; colors: RGBA[] } {
  const lines = text.split('\n');
  if (!/^GIMP Palette/i.test(lines[0]?.trim() ?? '')) {
    throw new PaletteParseError('Not a GIMP palette: missing "GIMP Palette" header');
  }

  let name: string | undefined;
  const colors: RGBA[] = [];

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = /^(Name|Columns):\s*(.*)$/i.exec(line);
    if (header) {
      if (header[1].toLowerCase() === 'name') name = header[2].trim() || undefined;
      continue;
    }

    // `R G B` followed by an optional swatch name, which may contain spaces.
    const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (m) colors.push([clampByte(+m[1]), clampByte(+m[2]), clampByte(+m[3]), 255]);
  }

  return { name, colors };
}

export function parseJascPal(text: string): RGBA[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!/^JASC-PAL$/i.test(lines[0] ?? '')) {
    throw new PaletteParseError('Not a JASC palette: missing "JASC-PAL" header');
  }

  // lines[1] is the format version ("0100"), lines[2] the declared count. The
  // count is advisory: files in the wild disagree with their own body, and the
  // body is the thing the user can see.
  const colors: RGBA[] = [];
  for (const line of lines.slice(3)) {
    const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (m) colors.push([clampByte(+m[1]), clampByte(+m[2]), clampByte(+m[3]), 255]);
  }
  return colors;
}

/** Microsoft RIFF `PAL data` — the binary flavour of `.pal`. */
export function parseRiffPal(bytes: Uint8Array): RGBA[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

  if (bytes.byteLength < 24 || tag(0) !== 'RIFF' || tag(8) !== 'PAL ') {
    throw new PaletteParseError('Not a RIFF palette');
  }
  if (tag(12) !== 'data') {
    throw new PaletteParseError('RIFF palette has no "data" chunk');
  }

  const count = view.getUint16(22, true);
  const colors: RGBA[] = [];
  for (let i = 0; i < count; i++) {
    const at = 24 + i * 4;
    if (at + 4 > bytes.byteLength) break;
    // Entries are R, G, B, flags — the last byte is not alpha.
    colors.push([bytes[at], bytes[at + 1], bytes[at + 2], 255]);
  }
  return colors;
}

/** Paint.NET `.txt` — `AARRGGBB`, alpha **first**. */
export function parsePaintNetTxt(text: string): RGBA[] {
  const colors: RGBA[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;

    const token = line.split(/\s+/)[0].replace(/^#/, '');
    if (/^[0-9a-fA-F]{8}$/.test(token)) {
      const n = parseInt(token, 16);
      colors.push([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, (n >>> 24) & 0xff]);
    } else if (/^[0-9a-fA-F]{6}$/.test(token)) {
      // Files exported by other tools sometimes drop the alpha pair.
      const c = hexToRgba(token);
      if (c) colors.push(c);
    }
  }
  return colors;
}

// ---------------------------------------------------------------------------

function baseName(fileName: string): string {
  const file = fileName.split(/[\\/]/).pop() ?? fileName;
  return file.replace(/\.[^.]+$/, '') || 'Imported';
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'imported'
  );
}

/**
 * Parse by extension, with two content sniffs that matter in practice:
 * `.pal` is two unrelated formats sharing an extension, and `.txt` is the
 * extension people rename anything to.
 */
export function parsePaletteFile(fileName: string, bytes: Uint8Array): Palette {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const isRiff = bytes.byteLength >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';

  let colors: RGBA[];
  let name = baseName(fileName);

  if (isRiff) {
    colors = parseRiffPal(bytes);
  } else {
    const text = toText(bytes);
    const looksGpl = /^GIMP Palette/i.test(text.trimStart());
    const looksJasc = /^JASC-PAL/i.test(text.trimStart());

    if (ext === 'gpl' || looksGpl) {
      const parsed = parseGpl(text);
      colors = parsed.colors;
      if (parsed.name) name = parsed.name;
    } else if (ext === 'pal' || looksJasc) {
      colors = parseJascPal(text);
    } else if (ext === 'txt') {
      colors = parsePaintNetTxt(text);
    } else if (ext === 'hex') {
      colors = parseHexPalette(text);
    } else {
      throw new PaletteParseError(`Unsupported palette format: .${ext}`);
    }
  }

  if (colors.length === 0) {
    throw new PaletteParseError(`No colors found in ${fileName}`);
  }

  return { id: slug(name), name, colors, source: { kind: 'file', ref: fileName } };
}
