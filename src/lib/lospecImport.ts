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
 * case-sensitive) can hang for 30s+ with no response at all. A timeout is
 * therefore not optional polish, it is required for "handle failure
 * gracefully" — see `src-tauri/src/commands/lospec.rs::TIMEOUT_SECS` for the
 * authoritative bound and `CLIENT_TIMEOUT_MS` below for a JS-side backstop.
 *
 * **The actual network fetch happens in Rust, not here** — see
 * `ipc/commands.ts::fetchLospecPalette` and
 * `src-tauri/src/commands/lospec.rs` for why: `lospec.com` sends no
 * `Access-Control-Allow-Origin` header, so a WebView-context `fetch()` is
 * rejected by CORS before it ever reaches the network (confirmed live —
 * that module's doc comment has the reproduction). This module still owns
 * everything that does *not* need to be in Rust: URL validation/slug
 * extraction (pure, synchronous, no network) and parsing the returned text
 * with the existing file-import parser.
 *
 * **This module never calls `fetchImpl` on its own.**
 * [`importLospecPalette`] only runs once a component has shown the user an
 * explicit confirm step naming lospec.com and they have clicked through it;
 * `fetchImpl` is injected so that invariant and every failure path can be
 * unit tested without a real network call.
 */

import type { Palette } from '../model/types.ts';
import { PaletteParseError, parsePaletteFile } from './formats/palette.ts';

/** A JS-side backstop above the Rust command's own 20s bound
 * (`src-tauri/src/commands/lospec.rs::TIMEOUT_SECS`) — the authoritative
 * timeout lives there now, this only guarantees the UI itself never hangs
 * even if `invoke()` somehow never settles. */
export const CLIENT_TIMEOUT_MS = 25_000;

/** Matches `ipc/commands.ts::LospecFetchResult` without importing it
 * directly, so this module (and its tests) stay free of any Tauri
 * dependency — the same separation `segment/modelDownload.ts` keeps from
 * `ipc/commands.ts`'s concrete types where it can. */
export type LospecFetchImpl = (
  slug: string,
) => Promise<{ ok: boolean; status: number; body: string }>;

export type ParsedLospecUrl = { slug: string };

export type LospecUrlResult =
  { kind: 'ok'; value: ParsedLospecUrl } | { kind: 'error'; message: string };

/**
 * Validate a pasted string as a Lospec palette-page (or direct download)
 * URL and extract its slug. Pure and synchronous — safe to call on every
 * keystroke for inline validation, since it never touches the network.
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

  return { kind: 'ok', value: { slug } };
}

export type LospecImportOutcome =
  { kind: 'success'; palette: Palette } | { kind: 'error'; message: string };

function withClientTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for a response (after ${CLIENT_TIMEOUT_MS / 1000}s).`));
    }, CLIENT_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * Fetch a Lospec palette page's `.hex` data (via the injected `fetchImpl` —
 * in production, `ipc/commands.ts::fetchLospecPalette`, which runs the
 * actual GET in Rust) and parse it with the existing file-import parser.
 * Every failure mode — bad URL, network error, timeout, non-2xx response,
 * unparseable body — resolves to `{ kind: 'error' }` rather than throwing,
 * so the calling component can show it inline and the app stays fully
 * usable regardless of network state.
 */
export async function importLospecPalette(
  input: string,
  deps: { fetchImpl: LospecFetchImpl },
): Promise<LospecImportOutcome> {
  const parsed = parseLospecUrl(input);
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message };
  const { slug } = parsed.value;

  let response: { ok: boolean; status: number; body: string };
  try {
    response = await withClientTimeout(deps.fetchImpl(slug));
  } catch (cause) {
    return {
      kind: 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    };
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

  try {
    const bytes = new TextEncoder().encode(response.body);
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
