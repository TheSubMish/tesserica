/**
 * On-demand download of a larger segmentation model, gated on explicit user
 * consent (`docs/08-roadmap.md` Phase 5 "on-demand download for larger
 * models with explicit consent", `CLAUDE.md` "No network calls in the
 * core").
 *
 * **This module never calls `fetch` on its own.** `downloadLargerSegmentationModel`
 * only runs when `SegmentModelSection.tsx` calls it, which only happens after
 * the user has seen a confirm dialog stating the size and source and clicked
 * an explicit "Download" button — never on mount, mode switch, or app
 * startup. `fetchImpl`/`save` are injected so that invariant, and the
 * success/failure/offline paths, can be unit tested without a real network
 * call (`scripts/lib/modelFetch.ts` uses the same dependency-injection shape
 * for the same reason, on the build-time side of this feature).
 */

import type { SegmentationModelInfo, SavedSegmentationModel } from '../ipc/commands.ts';

export type DownloadFetchImpl = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type SaveImpl = (bytes: ArrayBuffer) => Promise<SavedSegmentationModel>;

export type DownloadOutcome =
  { kind: 'success'; path: string; bytes: number } | { kind: 'error'; message: string };

/**
 * Fetch `info.sourceUrl` and, if it succeeds, hand the bytes to `save` (which
 * verifies the checksum and writes to disk on the Rust side). Every failure
 * mode — network unreachable, non-2xx response, a checksum rejected by
 * `save` — resolves to `{ kind: 'error' }` with a readable message rather
 * than throwing, since this is a nice-to-have feature and the caller (a
 * React component) should be able to show it inline and let the user retry,
 * not crash anything.
 */
export async function downloadLargerSegmentationModel(
  info: SegmentationModelInfo,
  deps: { fetchImpl: DownloadFetchImpl; save: SaveImpl },
): Promise<DownloadOutcome> {
  let response: Awaited<ReturnType<DownloadFetchImpl>>;
  try {
    response = await deps.fetchImpl(info.sourceUrl);
  } catch (cause) {
    return {
      kind: 'error',
      message: `could not reach ${info.sourceUrl} — check your network connection. (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    };
  }

  if (!response.ok) {
    return { kind: 'error', message: `download failed: HTTP ${response.status}` };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (cause) {
    return {
      kind: 'error',
      message: `download was interrupted before it finished. (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    };
  }

  try {
    const saved = await deps.save(bytes);
    return { kind: 'success', path: saved.path, bytes: saved.bytes };
  } catch (cause) {
    return {
      kind: 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** `178_648_008` → `"170.4 MB"` — for the confirm dialog's size line. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/** `"https://github.com/..."` → `"github.com"` — for the confirm dialog's source line. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
