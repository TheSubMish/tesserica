import { describe, expect, it, vi } from 'vitest';

import {
  FETCH_TIMEOUT_MS,
  importLospecPalette,
  parseLospecUrl,
  type LospecFetchImpl,
} from './lospecImport';

const PEAR36_HEX = ['5e315b', '8c3f5d', 'ba6156', 'f2a65e', 'ffe478'].join('\n') + '\n';

function okFetch(text: string): LospecFetchImpl {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => text }));
}

describe('parseLospecUrl', () => {
  it('accepts a real palette-page URL and derives the .hex download URL', () => {
    const result = parseLospecUrl('https://lospec.com/palette-list/pear36');
    expect(result).toEqual({
      kind: 'ok',
      value: { slug: 'pear36', downloadUrl: 'https://lospec.com/palette-list/pear36.hex' },
    });
  });

  it('accepts a slug with hyphens', () => {
    const result = parseLospecUrl('https://lospec.com/palette-list/sweetie-16');
    expect(result).toEqual({
      kind: 'ok',
      value: { slug: 'sweetie-16', downloadUrl: 'https://lospec.com/palette-list/sweetie-16.hex' },
    });
  });

  it('accepts a pasted direct-download link and strips the extension back off', () => {
    const result = parseLospecUrl('https://lospec.com/palette-list/pear36.gpl');
    expect(result).toEqual({
      kind: 'ok',
      value: { slug: 'pear36', downloadUrl: 'https://lospec.com/palette-list/pear36.hex' },
    });
  });

  it('accepts a bare host+path without a scheme, defaulting to https', () => {
    const result = parseLospecUrl('lospec.com/palette-list/pear36');
    expect(result.kind).toBe('ok');
  });

  it('tolerates a trailing slash and surrounding whitespace', () => {
    const result = parseLospecUrl('  https://lospec.com/palette-list/pear36/  ');
    expect(result).toEqual({
      kind: 'ok',
      value: { slug: 'pear36', downloadUrl: 'https://lospec.com/palette-list/pear36.hex' },
    });
  });

  it('rejects an empty string', () => {
    expect(parseLospecUrl('').kind).toBe('error');
    expect(parseLospecUrl('   ').kind).toBe('error');
  });

  it('rejects a non-URL string', () => {
    expect(parseLospecUrl('not a url at all').kind).toBe('error');
  });

  it('rejects a URL on a different host', () => {
    const result = parseLospecUrl('https://example.com/palette-list/pear36');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/lospec\.com/);
  });

  it('rejects www.lospec.com — the real site does not resolve that host', () => {
    expect(parseLospecUrl('https://www.lospec.com/palette-list/pear36').kind).toBe('error');
  });

  it('rejects a lospec.com URL that is not a palette-list page', () => {
    expect(parseLospecUrl('https://lospec.com/palette-list').kind).toBe('error');
    expect(parseLospecUrl('https://lospec.com/gallery/pear36').kind).toBe('error');
    expect(parseLospecUrl('https://lospec.com/').kind).toBe('error');
  });
});

describe('importLospecPalette', () => {
  it('never calls fetch for an invalid URL', async () => {
    const fetchImpl = vi.fn();
    const outcome = await importLospecPalette('not a url', { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('error');
  });

  it('fetches the derived .hex URL and parses it with the real palette parser', async () => {
    const fetchImpl = okFetch(PEAR36_HEX);
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://lospec.com/palette-list/pear36.hex',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.palette.id).toBe('pear36');
      expect(outcome.palette.colors).toHaveLength(5);
      expect(outcome.palette.colors[0]).toEqual([94, 49, 91, 255]);
    }
  });

  it('reports a 404 with a message naming the slug', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    }));
    const outcome = await importLospecPalette(
      'https://lospec.com/palette-list/nope-does-not-exist',
      {
        fetchImpl,
      },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/nope-does-not-exist/);
  });

  it('reports a non-404 HTTP error', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => '',
    }));
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/500/);
  });

  it('reports a network failure (offline) as an error, without throwing', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => {
      throw new Error('NetworkError: Failed to fetch');
    });
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/network connection/i);
  });

  it('reports an abort (timeout) with a message about the timeout, not a generic network error', async () => {
    // Simulates what really happens once `FETCH_TIMEOUT_MS` elapses on a
    // hanging Lospec request, without waiting out the real timer in a test.
    const fetchImpl: LospecFetchImpl = vi.fn(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    });
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/timed out/i);
      expect(outcome.message).not.toMatch(/network connection/i);
    }
  });

  it('reports an unparseable body as an error', async () => {
    const fetchImpl = okFetch('this is not palette data\nnot hex either\n');
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
  });

  it('exposes a sane, real-timing-informed timeout', () => {
    // Measured live: real slugs answer in ~1-2s, bad ones can hang 30s+.
    // 20s leaves real requests generous margin while still bounding a bad
    // paste to a finite, user-visible failure.
    expect(FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
