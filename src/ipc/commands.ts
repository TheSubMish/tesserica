/**
 * Typed wrappers over Tauri `invoke` (`docs/02-architecture.md` §6.1).
 *
 * **The rule: no pixel buffers through a JSON command** (§6.2). Tauri
 * serializes command arguments to JSON, so a byte array arrives as a list of
 * decimal numbers — several times the size, with a parse cost that dwarfs the
 * image work. Pixels therefore travel over the *raw* invoke body, which Tauri
 * sends as `application/octet-stream` with no serialization at all, and
 * commands afterwards refer to them by a small integer handle.
 *
 * Q7 (`docs/09-open-questions.md`) — custom protocol vs Channel vs temp file
 * for hand-drawn editor layers — is still open and is scheduled for a Phase 2
 * benchmark. Everything transport-shaped is confined to `stageBytes` /
 * `fetchStaged` so changing the answer touches this file and nothing else.
 */

import { invoke } from '@tauri-apps/api/core';

export type StageId = number;

/** Integer export scales. Non-integer scaling produces uneven block sizes. */
export const EXPORT_SCALES = [1, 2, 4, 8] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

export interface ExportResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

/** True when running inside the Tauri shell rather than a bare browser. */
export function hasBackend(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Hand raw bytes to Rust over the binary IPC body and get a handle back.
 *
 * `bytes.buffer` is passed rather than the view: Tauri recognises an
 * `ArrayBuffer` argument as a raw body. A `Uint8Array` that is a *view* into a
 * larger buffer would send the whole backing store, so it is copied first when
 * it does not cover its buffer exactly.
 */
export async function stageBytes(bytes: Uint8Array): Promise<StageId> {
  const exact =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : new Uint8Array(bytes);
  return invoke<StageId>('stage_bytes', exact.buffer as ArrayBuffer);
}

/** Retrieve staged bytes as a raw `ArrayBuffer`. Consumes the handle. */
export async function fetchStaged(id: StageId): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('fetch_staged', { id });
  return new Uint8Array(buffer);
}

export async function releaseStaged(id: StageId): Promise<void> {
  await invoke('release_staged', { id });
}

export async function exportPng(request: {
  stageId: StageId;
  width: number;
  height: number;
  scale: ExportScale;
  path: string;
}): Promise<ExportResult> {
  return invoke<ExportResult>('export_png', { request });
}
