import { describe, expect, it } from 'vitest';

import { SUPPORTED_IMAGE_EXTENSIONS, firstImagePath, isSupportedImage } from './dropTarget.ts';

/**
 * The Tauri listener itself needs a WebView, but the decisions it makes do not —
 * and the decisions are where the bugs live: which of several dropped files to
 * open, and whether to accept something the Rust decoder cannot read.
 */

describe('isSupportedImage', () => {
  it('accepts the formats the Rust decoder is built for', () => {
    for (const extension of SUPPORTED_IMAGE_EXTENSIONS) {
      expect(isSupportedImage(`/tmp/photo.${extension}`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    // The reason the file dialog needed an uppercase filter too: `PHOTO.PNG` is
    // the same file as `photo.png`, and refusing it would be arbitrary.
    expect(isSupportedImage('/tmp/PHOTO.PNG')).toBe(true);
    expect(isSupportedImage('/tmp/Photo.JpeG')).toBe(true);
  });

  it('rejects formats the decoder would fail on', () => {
    // Refusing here is an honest message; accepting would surface as a decode
    // error from Rust after the file had apparently been accepted.
    for (const path of ['/tmp/art.webp', '/tmp/art.gif', '/tmp/art.svg', '/tmp/sprite.ase']) {
      expect(isSupportedImage(path)).toBe(false);
    }
  });

  it('rejects paths with no extension at all', () => {
    expect(isSupportedImage('/tmp/README')).toBe(false);
    expect(isSupportedImage('')).toBe(false);
  });

  it('does not mistake a dot in a directory name for an extension', () => {
    expect(isSupportedImage('/home/me/my.assets/README')).toBe(false);
    expect(isSupportedImage('/home/me/my.assets/house.png')).toBe(true);
  });

  it('accepts a Godot-style sibling name without being fooled by it', () => {
    // The directory that started this: `house1.png` next to `house1.png.import`.
    expect(isSupportedImage('/a/house1.png')).toBe(true);
    expect(isSupportedImage('/a/house1.png.import')).toBe(false);
  });
});

describe('firstImagePath', () => {
  it('takes the first supported image in the drop', () => {
    expect(firstImagePath(['/a/one.png', '/a/two.jpg'])).toBe('/a/one.png');
  });

  it('skips unsupported files rather than giving up on the drop', () => {
    // Dropping a folder selection should not fail just because a `.import` or a
    // `.txt` happened to sort first.
    expect(firstImagePath(['/a/notes.txt', '/a/house1.png.import', '/a/house1.png'])).toBe(
      '/a/house1.png',
    );
  });

  it('returns undefined when nothing can be opened', () => {
    // The caller uses this to say *why* nothing happened.
    expect(firstImagePath(['/a/notes.txt', '/a/clip.mp4'])).toBeUndefined();
  });

  it('returns undefined for an empty drop', () => {
    expect(firstImagePath([])).toBeUndefined();
  });
});
