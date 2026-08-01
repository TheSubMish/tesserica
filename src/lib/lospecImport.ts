/**
 * "Import from Lospec URL…" (`docs/06-workflows.md` W8 step 4, "paste a
 * Lospec URL to fetch directly — network, so opt-in with a clear prompt").
 *
 * File-based import (`.hex`/`.gpl`/`.pal`/`.txt`) already covers the entire
 * Lospec catalogue and landed in Phase 1 (`lib/formats/palette.ts`). This
 * module is only the last mile: given a palette *page* URL the user pastes
 * in (e.g. `https://lospec.com/palette-list/pear36`), fetch the same bytes
 * a manual download would have produced and hand them to the *same* parser
 * — no new parsing logic.
 *
 * **URL shape, verified against the live site** (2026-08-01, several real
 * slugs): a palette page at `https://lospec.com/palette-list/<slug>` has a
 * documented, stable sibling download at
 * `https://lospec.com/palette-list/<slug>.hex` — same host and path, just an
 * extension appended, returned with `content-disposition: attachment`. No
 * HTML scraping needed; `.gpl`/`.pal`/`.txt` answer the same way, but `.hex`
 * is used here because it is the simplest format every palette on the site
 * offers and it round-trips through `parsePaletteFile` exactly like a
 * manually-downloaded `.hex` file would (same id/name derivation from the
 * filename), so behaviour matches the file-import path users already know.
 * `www.lospec.com` does not resolve at all — only the bare host is accepted.
 *
 * **A measured trap**: an unknown or mistyped slug does not 404 promptly.
 * Real timings against the live site: existing slugs answer in ~1–2s;
 * nonexistent ones (including simple case mismatches — slugs are
 * case-sensitive) can hang for 30s+ with no response at all. A client-side
 * timeout is therefore not optional polish here, it is required for the
 * "handle failure gracefully" requirement — see `FETCH_TIMEOUT_MS`.
 *
 * **This module never calls `fetch` on its own** — same invariant as
 * `segment/modelDownload.ts`. [`importLospecPalette`] only runs once a
 * component has shown the user an explicit confirm step naming lospec.com
 * and they have clicked through it; `fetchImpl` is injected so that
 * invariant and every failure path can be unit tested without a real
 * network call.
 */

import type { Palette } from '../model/types.ts';
import { PaletteParseError, parsePaletteFile } from './formats/palette.ts';

/** Real slugs answer in ~1-2s; this bounds the "bad slug hangs" failure mode
 * measured against the live site (see module doc) while leaving generous
 * margin for a slow connection. */
export const FETCH_TIMEOUT_MS = 20_000;

export type LospecFetchImpl = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type ParsedLospecUrl = { slug: string; downloadUrl: string };

export type LospecUrlResult =
  { kind: 'ok'; value: ParsedLospecUrl } | { kind: 'error'; message: string };

/**
 * Validate a pasted string as a Lospec palette-page (or direct download)
 * URL and derive the `.hex` download URL from it. Pure and synchronous —
 * safe to call on every keystroke for inline validation, since it never
 * touches the network.
 */
export function parseLospecUrl(input: string): LospecUrlResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'error', message: 'Paste a Lospec palette URL.' };

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { kind: 'error', message: 'That is not a valid URL.' };
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'lospec.com') {
    return { kind: 'error', message: `Expected a lospec.com URL, got "${url.hostname}".` };
  }

  const match = /^\/palette-list\/([^/]+)\/?$/i.exec(url.pathname);
  if (!match) {
    return {
      kind: 'error',
      message: 'Expected a palette page like https://lospec.com/palette-list/<name>.',
    };
  }

  // A pasted direct-download link (…/pear36.hex) is also accepted — strip
  // the extension back off so both forms produce the same slug. Lospec
  // slugs are dash-separated words with no dots of their own.
  const slug = match[1].replace(/\.(hex|gpl|pal|txt|png|ase)$/i, '');
  if (!slug) return { kind: 'error', message: 'That URL has no palette name in it.' };

  return {
    kind: 'ok',
    value: { slug, downloadUrl: `https://lospec.com/palette-list/${slug}.hex` },
  };
}

export type LospecImportOutcome =
  { kind: 'success'; palette: Palette } | { kind: 'error'; message: string };

/**
 * Fetch a Lospec palette page's `.hex` data and parse it with the existing
 * file-import parser. Every failure mode — bad URL, network error, timeout,
 * non-2xx response, unparseable body — resolves to `{ kind: 'error' }`
 * rather than throwing, so the calling component can show it inline and the
 * app stays fully usable regardless of network state.
 */
export async function importLospecPalette(
  input: string,
  deps: { fetchImpl: LospecFetchImpl },
): Promise<LospecImportOutcome> {
  const parsed = parseLospecUrl(input);
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message };
  const { slug, downloadUrl } = parsed.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Awaited<ReturnType<LospecFetchImpl>>;
  try {
    response = await deps.fetchImpl(downloadUrl, { signal: controller.signal });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'AbortError';
    return {
      kind: 'error',
      message: timedOut
        ? `Timed out waiting for lospec.com. Check the URL is an exact palette slug (they are case-sensitive).`
        : `Could not reach lospec.com — check your network connection. (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      kind: 'error',
      message:
        response.status === 404
          ? `No palette named "${slug}" found on Lospec.`
          : `Lospec returned an error: HTTP ${response.status}`,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    return {
      kind: 'error',
      message: `Download was interrupted before it finished. (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    };
  }

  try {
    const bytes = new TextEncoder().encode(text);
    const palette = parsePaletteFile(`${slug}.hex`, bytes);
    return { kind: 'success', palette };
  } catch (cause) {
    return {
      kind: 'error',
      message:
        cause instanceof PaletteParseError
          ? cause.message
          : `Could not parse the palette data from Lospec.`,
    };
  }
}
