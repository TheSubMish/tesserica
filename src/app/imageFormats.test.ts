import { describe, expect, it } from 'vitest';
import {
  ALL_CONVERTIBLE_EXTENSIONS,
  formatById,
  IMAGE_FORMAT_OPTIONS,
  withFormatExtension,
} from './imageFormats';

describe('IMAGE_FORMAT_OPTIONS', () => {
  it('has one entry per id `format_convert::SUPPORTED_FORMATS` supports, no duplicates', () => {
    const ids = IMAGE_FORMAT_OPTIONS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'png',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'ico',
      'tiff',
      'tga',
      'pnm',
      'qoi',
      'ff',
      'hdr',
      'exr',
    ]);
  });

  it('every option has at least one extension', () => {
    for (const f of IMAGE_FORMAT_OPTIONS) {
      expect(f.extensions.length).toBeGreaterThan(0);
    }
  });
});

describe('formatById', () => {
  it('finds an existing format', () => {
    expect(formatById('webp')?.label).toBe('WebP');
  });

  it('returns undefined for an unknown id', () => {
    expect(formatById('avif')).toBeUndefined();
  });
});

describe('ALL_CONVERTIBLE_EXTENSIONS', () => {
  it('includes both lowercase and uppercase variants (case-sensitive GTK globs)', () => {
    expect(ALL_CONVERTIBLE_EXTENSIONS).toContain('png');
    expect(ALL_CONVERTIBLE_EXTENSIONS).toContain('PNG');
  });
});

describe('withFormatExtension', () => {
  it('swaps the extension and drops the directory', () => {
    const webp = formatById('webp')!;
    expect(withFormatExtension('/home/user/photo.png', webp)).toBe('photo.webp');
  });

  it('uses the format’s first extension when it has several', () => {
    const jpeg = formatById('jpeg')!;
    expect(withFormatExtension('photo.png', jpeg)).toBe('photo.jpg');
  });

  it('handles a filename with no existing extension', () => {
    const png = formatById('png')!;
    expect(withFormatExtension('photo', png)).toBe('photo.png');
  });
});
