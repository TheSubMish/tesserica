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
 * Q7 is **settled** (D13): measured in the real app, the raw invoke body moves
 * 10 MB at 403 MB/s and a custom URI protocol at 388 MB/s — indistinguishable —
 * while a JSON command argument manages 4 MB/s, 97x slower. The raw body stays,
 * because a second transport would buy nothing.
 */

import { invoke } from '@tauri-apps/api/core';

import type { ConvertSettings } from '../pipeline/settings.ts';

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

// ---------------------------------------------------------------------------
// `.tess` (docs/03-data-model.md §7)
// ---------------------------------------------------------------------------

export interface CelUpload {
  celId: string;
  stageId: StageId;
  width: number;
  height: number;
}

export interface SaveResult {
  path: string;
  bytes: number;
  /** Entries carried over from an archive written by a newer build. */
  preserved: string[];
}

export interface LoadedCel {
  celId: string;
  stageId: StageId;
  width: number;
  height: number;
}

export interface LoadResult {
  path: string;
  formatVersion: number;
  /** Shaped exactly like the TS `Sprite`; Rust mirrors it with serde. */
  sprite: {
    width: number;
    height: number;
    colorMode: string;
    layers: unknown[];
    frames: unknown[];
    cels: unknown[];
  };
  cels: LoadedCel[];
  warnings: string[];
}

export async function saveProject(request: {
  path: string;
  sprite: unknown;
  cels: CelUpload[];
  thumbnail?: CelUpload;
  /**
   * Path this document was opened from. Rust copies across every entry it does
   * not itself write, so an older build cannot silently delete what a newer
   * one stored (`docs/03-data-model.md` §7).
   */
  preserveFrom?: string | null;
}): Promise<SaveResult> {
  return invoke<SaveResult>('save_project', { request });
}

export async function loadProject(path: string): Promise<LoadResult> {
  return invoke<LoadResult>('load_project', { path });
}

// ---------------------------------------------------------------------------
// Source handle model (`docs/02-architecture.md` §6.2)
//
// Source images are opened by Rust and **stay in Rust**. The frontend holds a
// `SourceId` and a small proxy for preview; the full-resolution pixels never
// enter the WebView, and export sends settings rather than pixels.
// ---------------------------------------------------------------------------

export type SourceId = number;

export interface SourceInfo {
  sourceId: SourceId;
  width: number;
  height: number;
  path: string;
}

/** Decode an image in Rust and keep it there. Returns metadata only. */
export async function openSource(path: string): Promise<SourceInfo> {
  return invoke<SourceInfo>('open_source', { path });
}

export async function releaseSource(sourceId: SourceId): Promise<void> {
  await invoke('release_source', { sourceId });
}

export interface SourceProxy {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Fetch the preview proxy as raw bytes.
 *
 * The payload is a `u32` width, a `u32` height and then RGBA — the same
 * self-describing convention the golden harness uses, so a size disagreement is
 * caught here rather than as a confusing image later.
 */
export async function fetchSourceProxy(sourceId: SourceId, maxEdge: number): Promise<SourceProxy> {
  const buffer = await invoke<ArrayBuffer>('source_proxy', { sourceId, maxEdge });
  return decodeSourceProxy(buffer);
}

/** Exported for tests: the wire format is worth asserting without a backend. */
export function decodeSourceProxy(buffer: ArrayBuffer): SourceProxy {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const expected = 8 + width * height * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `proxy payload is ${buffer.byteLength} bytes, expected ${expected} for ${width}x${height}`,
    );
  }
  return { width, height, data: new Uint8ClampedArray(buffer, 8) };
}

export interface ExportConversionResult {
  path: string;
  width: number;
  height: number;
  scaledWidth: number;
  scaledHeight: number;
  bytes: number;
  colorsUsed: number;
}

/**
 * Convert at full source resolution and write a PNG.
 *
 * **No pixels cross in either direction.** Rust already holds the source, and
 * the result goes straight to disk — `docs/02` §6.2 rule 4 in one call.
 */
export async function exportConversion(request: {
  sourceId: SourceId;
  settings: ConvertSettings;
  scale: ExportScale;
  path: string;
}): Promise<ExportConversionResult> {
  return invoke<ExportConversionResult>('export_conversion', { request });
}
