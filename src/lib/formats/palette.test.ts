import { describe, expect, it } from 'vitest';
import {
  PaletteParseError,
  parseGpl,
  parseHexPalette,
  parseJascPal,
  parsePaintNetTxt,
  parsePaletteFile,
  parseRiffPal,
} from './palette';

// Real files from `tests/fixtures/palettes/`, pulled in as text by the
// bundler. Committed fixtures rather than inline strings so the parsers are
// exercised against bytes that came off disk, CRLF and all — but imported
// rather than read with `fs`, which keeps Node types out of a browser-only
// source tree.
import hexFixture from '../../../tests/fixtures/palettes/sample.hex?raw';
import gplFixture from '../../../tests/fixtures/palettes/sample.gpl?raw';
import jascFixture from '../../../tests/fixtures/palettes/sample-jasc.pal?raw';
import paintNetFixture from '../../../tests/fixtures/palettes/sample-paintnet.txt?raw';

const encode = (s: string) => new TextEncoder().encode(s);

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];

/** A minimal Microsoft RIFF `PAL data` chunk, built rather than committed. */
function riffPal(entries: [number, number, number][]): Uint8Array {
  const dataSize = 4 + entries.length * 4;
  const bytes = new Uint8Array(20 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };

  write(0, 'RIFF');
  view.setUint32(4, 12 + dataSize, true);
  write(8, 'PAL ');
  write(12, 'data');
  view.setUint32(16, dataSize, true);
  view.setUint16(20, 0x0300, true); // palette version
  view.setUint16(22, entries.length, true);
  entries.forEach(([r, g, b], i) => {
    const at = 24 + i * 4;
    bytes[at] = r;
    bytes[at + 1] = g;
    bytes[at + 2] = b;
    bytes[at + 3] = 0; // flags, not alpha
  });
  return bytes;
}

describe('.hex', () => {
  it('reads one RRGGBB per line, ignoring blanks, comments and a leading #', () => {
    expect(parseHexPalette(hexFixture)).toEqual([RED, GREEN, BLUE]);
  });

  it('reads RRGGBBAA with alpha last', () => {
    expect(parseHexPalette('FF000080')).toEqual([[255, 0, 0, 128]]);
  });

  it('skips lines that are not colours instead of throwing', () => {
    expect(parseHexPalette('not a colour\nFF0000\nzzz')).toEqual([RED]);
  });
});

describe('.gpl', () => {
  it('reads the header name and the R G B rows', () => {
    const parsed = parseGpl(gplFixture);
    expect(parsed.name).toBe('Fixture Three');
    expect(parsed.colors).toEqual([RED, GREEN, BLUE]);
  });

  it('tolerates swatch names containing spaces', () => {
    expect(parseGpl('GIMP Palette\n17 34 51\tDark Slate Grey').colors).toEqual([[17, 34, 51, 255]]);
  });

  it('rejects a file without the header', () => {
    expect(() => parseGpl('255 0 0')).toThrow(PaletteParseError);
  });
});

describe('.pal — JASC', () => {
  it('reads the fixture, CRLF and all', () => {
    expect(parseJascPal(jascFixture.replace(/\r\n?/g, '\n'))).toEqual([RED, GREEN, BLUE]);
  });

  it('trusts the body over a wrong declared count', () => {
    // Files in the wild disagree with their own header; the body is what the
    // user can see.
    expect(parseJascPal('JASC-PAL\n0100\n99\n1 2 3\n4 5 6')).toHaveLength(2);
  });

  it('rejects a file without the header', () => {
    expect(() => parseJascPal('0100\n1\n0 0 0')).toThrow(PaletteParseError);
  });
});

describe('.pal — RIFF', () => {
  it('reads BGR-order entries and ignores the flags byte', () => {
    expect(
      parseRiffPal(
        riffPal([
          [255, 0, 0],
          [0, 255, 0],
        ]),
      ),
    ).toEqual([RED, GREEN]);
  });

  it('rejects text that is not RIFF', () => {
    expect(() => parseRiffPal(encode('JASC-PAL\n'))).toThrow(PaletteParseError);
  });
});

describe('Paint.NET .txt', () => {
  it('reads AARRGGBB with alpha FIRST', () => {
    // The exact inverse of `.hex`. Getting this backwards yields a palette of
    // nearly-transparent colours and no error at all, so it is pinned here.
    expect(parsePaintNetTxt(paintNetFixture)).toEqual([RED, GREEN, [0, 0, 255, 128]]);
  });

  it('does not confuse the two orderings', () => {
    expect(parsePaintNetTxt('80FF0000')).toEqual([[255, 0, 0, 128]]);
    expect(parseHexPalette('80FF0000')).toEqual([[128, 255, 0, 0]]);
  });

  it('accepts 6-digit lines from tools that drop the alpha pair', () => {
    expect(parsePaintNetTxt('; c\nFF0000')).toEqual([RED]);
  });
});

describe('parsePaletteFile', () => {
  it('dispatches on extension', () => {
    expect(parsePaletteFile('x.hex', encode(hexFixture)).colors).toEqual([RED, GREEN, BLUE]);
    expect(parsePaletteFile('x.gpl', encode(gplFixture)).colors).toEqual([RED, GREEN, BLUE]);
    expect(parsePaletteFile('x.pal', encode(jascFixture)).colors).toEqual([RED, GREEN, BLUE]);
    expect(parsePaletteFile('x.txt', encode(paintNetFixture)).colors).toHaveLength(3);
  });

  it('sniffs RIFF, because .pal is two unrelated formats sharing an extension', () => {
    expect(parsePaletteFile('x.pal', riffPal([[1, 2, 3]])).colors).toEqual([[1, 2, 3, 255]]);
  });

  it('sniffs a GIMP palette that was renamed to .txt', () => {
    const bytes = encode('GIMP Palette\nName: Renamed\n1 2 3\n');
    const p = parsePaletteFile('whatever.txt', bytes);
    expect(p.name).toBe('Renamed');
    expect(p.colors).toEqual([[1, 2, 3, 255]]);
  });

  it('names the palette from the file when the format carries no name', () => {
    const p = parsePaletteFile('/tmp/My Palette.hex', encode(hexFixture));
    expect(p.name).toBe('My Palette');
    expect(p.id).toBe('my-palette');
    expect(p.source).toEqual({ kind: 'file', ref: '/tmp/My Palette.hex' });
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = encode('﻿FF0000\n');
    expect(parsePaletteFile('x.hex', bytes).colors).toEqual([RED]);
  });

  it('refuses an empty result rather than adding a blank palette', () => {
    expect(() => parsePaletteFile('x.hex', encode('; nothing\n'))).toThrow(PaletteParseError);
  });

  it('refuses an unknown extension', () => {
    expect(() => parsePaletteFile('x.png', new Uint8Array([1, 2, 3, 4]))).toThrow(
      PaletteParseError,
    );
  });
});
