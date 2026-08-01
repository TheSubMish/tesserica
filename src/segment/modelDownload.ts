/**
 * Consent-gated wrapper around a single Rust download command — the larger
 * segmentation model (`docs/08-roadmap.md` Phase 5 "on-demand download for
 * larger models with explicit consent") and, since `docs/10-decisions.md`
 * D16, the ONNX Runtime native library itself (`src/segment/
 * OnnxRuntimeSection.tsx`). Both share this one implementation rather than
 * two parallel ones.
 *
 * **The network fetch itself now happens in Rust, not here.** This module
 * originally called `fetch()` directly, on the assumption that an unset CSP
 * meant the WebView had unrestricted network access. That assumption missed
 * CORS: GitHub's release-asset URLs redirect to
 * `release-assets.githubusercontent.com`, which sends no
 * `Access-Control-Allow-Origin` header, so a same-origin `fetch()` from
 * inside the WebView is rejected by CORS before the request ever leaves the
 * browser engine — confirmed live by driving the real Vite dev bundle in a
 * real headless browser over CDP: `fetch()` to the real model/runtime URLs
 * failed with `TypeError: Failed to fetch`, while the identical request from
 * plain Node (which does not enforce CORS) succeeded. This is the same
 * failure `commands::lospec` found for `lospec.com`. The fix mirrors that
 * one: `commands::segment::download_segmentation_model` and
 * `commands::onnx_runtime::download_onnx_runtime` now do the fetch,
 * checksum-verify and persist entirely on the Rust side
 * (`src-tauri/src/commands/segment.rs`, `.../onnx_runtime.rs`).
 *
 * **This module never calls the download command on its own.**
 * [`downloadConsentedFile`] only runs when a component calls it, which only
 * happens after the user has seen a confirm dialog stating the size and
 * source and clicked an explicit "Download" button — never on mount, mode
 * switch, or app startup. `download` is injected so that invariant, and the
 * success/failure paths, can be unit tested without a real network call.
 */

export type DownloadOutcome =
  { kind: 'success'; path: string; bytes: number } | { kind: 'error'; message: string };

/** The one thing a caller injects: a function that invokes the Rust command
 * which does the real fetch, checksum-verify and persist. Takes no
 * arguments — the URL and checksum are constants known only to Rust. */
export type DownloadImpl<TSaved extends { path: string; bytes: number }> = () => Promise<TSaved>;

/**
 * Run `deps.download()` (a Rust IPC call that fetches, verifies and persists
 * a file) and translate its outcome into a `DownloadOutcome`. Every failure
 * mode — network unreachable, non-2xx response, a checksum rejected on the
 * Rust side — resolves to `{ kind: 'error' }` with a readable message rather
 * than throwing, since this is a nice-to-have feature and the caller (a
 * React component) should be able to show it inline and let the user retry,
 * not crash anything.
 */
export async function downloadConsentedFile<TSaved extends { path: string; bytes: number }>(deps: {
  download: DownloadImpl<TSaved>;
}): Promise<DownloadOutcome> {
  try {
    const saved = await deps.download();
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
