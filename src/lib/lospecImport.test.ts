import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_TIMEOUT_MS,
  importLospecPalette,
  parseLospecUrl,
  type LospecFetchImpl,
} from './lospecImport';

const PEAR36_HEX = ['5e315b', '8c3f5d', 'ba6156', 'f2a65e', 'ffe478'].join('\n') + '\n';

function okFetch(body: string): LospecFetchImpl {
  return vi.fn(async () => ({ ok: true, status: 200, body }));
}

describe('parseLospecUrl', () => {
  it('accepts a real palette-page URL and extracts the slug', () => {
    expect(parseLospecUrl('https://lospec.com/palette-list/pear36')).toEqual({
      kind: 'ok',
      value: { slug: 'pear36' },
    });
  });

  it('accepts a slug with hyphens', () => {
    expect(parseLospecUrl('https://lospec.com/palette-list/sweetie-16')).toEqual({
      kind: 'ok',
      value: { slug: 'sweetie-16' },
    });
  });

  it('accepts a pasted direct-download link and strips the extension back off', () => {
    expect(parseLospecUrl('https://lospec.com/palette-list/pear36.gpl')).toEqual({
      kind: 'ok',
      value: { slug: 'pear36' },
    });
  });

  it('accepts a bare host+path without a scheme, defaulting to https', () => {
    expect(parseLospecUrl('lospec.com/palette-list/pear36').kind).toBe('ok');
  });

  it('tolerates a trailing slash and surrounding whitespace', () => {
    expect(parseLospecUrl('  https://lospec.com/palette-list/pear36/  ')).toEqual({
      kind: 'ok',
      value: { slug: 'pear36' },
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
  it('never calls fetchImpl for an invalid URL', async () => {
    const fetchImpl = vi.fn();
    const outcome = await importLospecPalette('not a url', { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('error');
  });

  it('calls fetchImpl with the extracted slug and parses the body with the real palette parser', async () => {
    const fetchImpl = okFetch(PEAR36_HEX);
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('pear36');
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.palette.id).toBe('pear36');
      expect(outcome.palette.colors).toHaveLength(5);
      expect(outcome.palette.colors[0]).toEqual([94, 49, 91, 255]);
    }
  });

  it('accepts a pasted direct-download URL the same way as a page URL', async () => {
    const fetchImpl = okFetch(PEAR36_HEX);
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36.hex', {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith('pear36');
    expect(outcome.kind).toBe('success');
  });

  it('reports a 404 with a message naming the slug', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => ({ ok: false, status: 404, body: '' }));
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
    const fetchImpl: LospecFetchImpl = vi.fn(async () => ({ ok: false, status: 500, body: '' }));
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/500/);
  });

  it('reports a rejected fetchImpl (network/transport failure) as an error, without throwing', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => {
      throw new Error('could not reach lospec.com: connection refused');
    });
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/could not reach lospec\.com/i);
  });

  it('propagates a timeout-shaped rejection message from fetchImpl (the real Rust command reports its own timeout this way)', async () => {
    const fetchImpl: LospecFetchImpl = vi.fn(async () => {
      throw new Error('timed out waiting for lospec.com (after 20s) — check the slug is exact');
    });
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/timed out/i);
  });

  it('times out on the JS side if fetchImpl never settles, rather than hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: LospecFetchImpl = vi.fn(
        () => new Promise<{ ok: boolean; status: number; body: string }>(() => undefined),
      );
      const outcomePromise = importLospecPalette('https://lospec.com/palette-list/pear36', {
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS + 1);
      const outcome = await outcomePromise;
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') expect(outcome.message).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unparseable body as an error', async () => {
    const fetchImpl = okFetch('this is not palette data\nnot hex either\n');
    const outcome = await importLospecPalette('https://lospec.com/palette-list/pear36', {
      fetchImpl,
    });
    expect(outcome.kind).toBe('error');
  });

  it('exposes a client-side backstop timeout above the Rust command’s own 20s bound', () => {
    expect(CLIENT_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
