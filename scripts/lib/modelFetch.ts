/**
 * Pure(ish) logic behind `scripts/fetch-model.ts` — the build-time step that
 * fetches `u2netp.onnx` into the gitignored `assets/models/` directory
 * (`docs/07-tech-stack.md` §3.1/§8, `docs/04-image-pipeline.md` §8.1,
 * `docs/08-roadmap.md` Phase 5 "Bundle `u2netp`; on-demand download for
 * larger models with explicit consent").
 *
 * Split out from the CLI entry point so the idempotency/checksum decisions
 * can be unit tested against fixtures without ever touching the network
 * (`fetchImpl` is injected rather than importing the global `fetch`).
 *
 * **This is a developer/build-time action, not a runtime one** — unlike
 * everything inside the shipped app, it is fine for this to require network
 * access, and it fails loudly rather than silently if there isn't any.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModelSpec {
  /** Stable identifier, used only in log messages. */
  readonly id: string;
  /** Destination filename inside the models directory. */
  readonly filename: string;
  /** Official distribution URL. */
  readonly url: string;
  /** Lowercase hex MD5 the source itself publishes for this exact file. */
  readonly expectedMd5: string;
  /** Approximate size, for a sanity-check log line only — not enforced. */
  readonly approxBytes: number;
  /** License of the model weights themselves (not this project's MIT). */
  readonly license: string;
}

/**
 * `u2netp` — the small U-2-Net variant, bundled by default (`04` §8.1).
 *
 * Sourced from the `rembg` project's own GitHub Releases, which is where
 * `rembg`'s `U2netpSession.download_models` fetches it from too
 * (`rembg/rembg/sessions/u2netp.py`, checked 2026-07-30) — a maintained, real
 * precedent rather than a guessed URL. The weights are the original U-2-Net
 * project's (`xuebinqin/U-2-Net`), which is Apache-2.0
 * (`docs/07-tech-stack.md` §8's own claim, re-verified here against the
 * upstream repository's license file before bundling).
 */
export const U2NETP_SPEC: ModelSpec = {
  id: 'u2netp',
  filename: 'u2netp.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  expectedMd5: '8e83ca70e441ab06c318d82300c84806',
  approxBytes: 4_574_861,
  license: 'Apache-2.0',
};

export function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

export type FetchImpl = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type FetchOutcome =
  | { kind: 'skipped-already-present'; path: string }
  | { kind: 'downloaded'; path: string; bytes: number };

export class ModelFetchError extends Error {}

/**
 * Idempotent fetch-and-verify: if `destDir/spec.filename` already exists and
 * its MD5 matches, does nothing and reports `skipped-already-present`.
 * Otherwise downloads, verifies the checksum against `spec.expectedMd5`, and
 * only replaces the destination file once the downloaded bytes have already
 * checked out — a failed or corrupt download can never leave a partial or
 * wrong file at the final path.
 *
 * Every failure (network unreachable, non-2xx response, checksum mismatch)
 * throws a `ModelFetchError` with an actionable message rather than leaving
 * the caller to guess.
 */
export async function ensureModelFetched(
  spec: ModelSpec,
  destDir: string,
  fetchImpl: FetchImpl,
): Promise<FetchOutcome> {
  const destPath = join(destDir, spec.filename);

  if (existsSync(destPath)) {
    const existing = await readFile(destPath);
    if (md5Hex(existing) === spec.expectedMd5) {
      return { kind: 'skipped-already-present', path: destPath };
    }
    // Present but wrong — re-fetch rather than trusting a stale/corrupt file.
  }

  let response: Awaited<ReturnType<FetchImpl>>;
  try {
    response = await fetchImpl(spec.url);
  } catch (cause) {
    throw new ModelFetchError(
      `could not reach ${spec.url} — this step needs network access. ` +
        `Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new ModelFetchError(
      `fetching ${spec.url} failed with HTTP ${response.status}. ` +
        `If the release moved, update the URL in scripts/lib/modelFetch.ts.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualMd5 = md5Hex(bytes);
  if (actualMd5 !== spec.expectedMd5) {
    throw new ModelFetchError(
      `downloaded ${spec.filename} but its MD5 (${actualMd5}) does not match ` +
        `the expected ${spec.expectedMd5}. Refusing to install a file that doesn't ` +
        `match the checksum the source published — try again, and if it keeps ` +
        `failing the upstream file may have changed.`,
    );
  }

  await mkdir(destDir, { recursive: true });
  // Write to a temp path first and rename into place: a process killed
  // mid-write leaves only the `.download` temp file, never a truncated file
  // sitting at destPath that a later run's existsSync() check might trust.
  const tmpPath = `${destPath}.download`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, destPath);

  return { kind: 'downloaded', path: destPath, bytes: bytes.byteLength };
}

export function assetsModelsDir(projectRoot: string): string {
  return join(projectRoot, 'assets', 'models');
}
