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

import { Channel, invoke } from '@tauri-apps/api/core';

import type { ConvertSettings } from '../pipeline/settings.ts';
import type { GridShape } from '../model/types.ts';

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
// Spritesheet + animated GIF export (`docs/08-roadmap.md` Phase 4 "Export:
// spritesheet (+ metadata JSON), animated GIF").
//
// Same shape as `exportPng`: the frontend flattens and concatenates every
// frame it wants exported (`export/animationExport.ts`) and stages the whole
// buffer once; Rust never receives per-layer pixels, only the already-
// composited RGBA plus metadata (durations, tag ranges).
// ---------------------------------------------------------------------------

export interface SpritesheetFrameInput {
  durationMs: number;
}

export interface SpritesheetTagInput {
  name: string;
  from: number;
  to: number;
  direction: string;
}

export interface ExportSpritesheetResult {
  path: string;
  jsonPath: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  bytes: number;
  jsonBytes: number;
}

export async function exportSpritesheet(request: {
  stageId: StageId;
  frameWidth: number;
  frameHeight: number;
  scale: ExportScale;
  columns: number;
  frames: SpritesheetFrameInput[];
  tags: SpritesheetTagInput[];
  path: string;
}): Promise<ExportSpritesheetResult> {
  return invoke<ExportSpritesheetResult>('export_spritesheet', { request });
}

export interface ExportGifResult {
  path: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
}

export async function exportGif(request: {
  stageId: StageId;
  frameWidth: number;
  frameHeight: number;
  scale: ExportScale;
  durationsMs: number[];
  path: string;
}): Promise<ExportGifResult> {
  return invoke<ExportGifResult>('export_gif', { request });
}

// ---------------------------------------------------------------------------
// Tileset + tilemap JSON export (`docs/08-roadmap.md` Phase 6 "Tileset +
// tilemap JSON export", `src-tauri/src/commands/tilemap_export.rs`).
//
// Same shape as `exportSpritesheet`: the frontend stages every real tile's
// own pixels once (`export/tilemapExport.ts::concatTilePixels`) and sends the
// grid's packed tile ids as plain JSON metadata — small enough that it is not
// the "pixel buffer" this file's own rule is about. Rust assembles the
// tileset atlas, scales it, and writes a Tiled-shaped map JSON alongside it.
// ---------------------------------------------------------------------------

export interface ExportTilemapResult {
  path: string;
  jsonPath: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  tileCount: number;
  bytes: number;
  jsonBytes: number;
}

export async function exportTilemap(request: {
  stageId: StageId;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  columns: number;
  scale: ExportScale;
  tilesetName: string;
  layerName: string;
  /**
   * The tilemap layer's `GridSpec.shape` — drives which Tiled `orientation`
   * (and, for `hexagonal`, `hexsidelength`/`staggeraxis`/`staggerindex`) the
   * exported map JSON declares (`src-tauri/src/commands/tilemap_export.rs`'s
   * `tiled_orientation_fields`, gap-closure follow-up to Phase 7).
   */
  gridShape: GridShape;
  gridCols: number;
  gridRows: number;
  tileIds: number[];
  path: string;
}): Promise<ExportTilemapResult> {
  return invoke<ExportTilemapResult>('export_tilemap', { request });
}

// ---------------------------------------------------------------------------
// Bead / cross-stitch pattern chart export (`docs/08-roadmap.md` Phase 7
// "Bead / cross-stitch chart export (W9)",
// `src-tauri/src/commands/pattern_chart.rs`).
//
// `src/model/patternChart.ts::buildPatternChart` does the color-key/grid
// derivation client-side; only that small indexed grid plus its legend
// travels here as plain JSON, the same "not a pixel buffer" reasoning
// `exportTilemap`'s `tileIds` already rests on. Rust renders the
// full-resolution printable PNG.
// ---------------------------------------------------------------------------

export interface PatternChartLegendInput {
  color: readonly [number, number, number, number];
  count: number;
}

export interface ExportPatternChartResult {
  path: string;
  width: number;
  height: number;
  colors: number;
  bytes: number;
}

export async function exportPatternChart(request: {
  width: number;
  height: number;
  grid: number[];
  legend: PatternChartLegendInput[];
  cellSize: number;
  path: string;
}): Promise<ExportPatternChartResult> {
  return invoke<ExportPatternChartResult>('export_pattern_chart', { request });
}

// ---------------------------------------------------------------------------
// `.tess` (docs/03-data-model.md §7)
// ---------------------------------------------------------------------------

/**
 * One cel's raw bytes, referenced by a staging handle rather than inlined.
 *
 * `width`/`height` are pixel dimensions for a raster/conversion cel. For a
 * tilemap cel (`docs/03-data-model.md` §4, roadmap Phase 6) the staged bytes
 * are a raw `Uint32Array` (packed tile ids, `model/tileGridBuffers.ts`), not
 * RGBA — Rust decides which per cel from `sprite.layers` alone (`Layer.kind
 * === 'tilemap'`), so nothing here has to say which kind it is.
 */
export interface CelUpload {
  celId: string;
  stageId: StageId;
  width: number;
  height: number;
}

/** One tile entry's own RGBA pixels — the tileset-level sibling of `CelUpload`. */
export interface TileUpload {
  tilesetId: string;
  tileId: string;
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

export interface LoadedTile {
  tilesetId: string;
  tileId: string;
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
    tilesets?: unknown[];
  };
  cels: LoadedCel[];
  tileEntries: LoadedTile[];
  warnings: string[];
}

export async function saveProject(request: {
  path: string;
  sprite: unknown;
  cels: CelUpload[];
  thumbnail?: CelUpload;
  /** Every tile entry's own pixels, across every tileset in `sprite`. */
  tileEntries?: TileUpload[];
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
// `.ase`/`.aseprite` import (`docs/08-roadmap.md` Phase 6 "`.ase` import",
// `docs/10-decisions.md` D17, `src-tauri/src/commands/ase_import.rs`).
//
// Same wire shape as `loadProject` — Rust converts the Aseprite file onto
// this project's own `Sprite`/`Layer`/`Frame`/`Cel`/`Tag`/`Palette` model
// and returns the identical `LoadResult` shape, so the frontend's existing
// staged-cel-fetch + `replaceDocument` plumbing (`app/project.ts`) needs no
// new code, just a new command to call.
// ---------------------------------------------------------------------------

export async function importAse(path: string): Promise<LoadResult> {
  return invoke<LoadResult>('import_ase', { path });
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

// ---------------------------------------------------------------------------
// Batch conversion (`docs/08-roadmap.md` Phase 7 "Batch conversion + CLI
// headless mode", `docs/06-workflows.md` W5, `src-tauri/src/commands/
// batch_convert.rs`).
//
// Reuses `ConvertSettings` unchanged — no parallel settings type. Progress
// streams back over a Tauri **Channel** (`docs/02-architecture.md` §6.2,
// D13), never accumulated into the command's own return value, which is
// this project's established reason for that pattern. Cancellation is a
// separate command against a job id the `started` event carries.
// ---------------------------------------------------------------------------

export type BatchConvertEvent =
  | { kind: 'started'; jobId: number; total: number }
  | { kind: 'fileStarted'; index: number; file: string }
  | {
      kind: 'fileSucceeded';
      index: number;
      file: string;
      outputPath: string;
      width: number;
      height: number;
      colorsUsed: number;
    }
  | { kind: 'fileFailed'; index: number; file: string; error: string }
  | { kind: 'finished'; succeeded: number; failed: number; cancelled: boolean };

export interface BatchConvertSummary {
  jobId: number;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

/**
 * Run a batch conversion, reporting per-file progress to `onProgress` as it
 * streams in over the Channel. Resolves once the batch (or its cancellation)
 * has fully finished, with the same summary the `finished` event itself
 * carries in aggregate.
 */
export async function batchConvert(
  request: {
    folder: string;
    outFolder: string;
    pixelSize: number;
    settings: ConvertSettings;
    scale: ExportScale;
  },
  onProgress: (event: BatchConvertEvent) => void,
): Promise<BatchConvertSummary> {
  const progress = new Channel<BatchConvertEvent>();
  progress.onmessage = onProgress;
  return invoke<BatchConvertSummary>('batch_convert', { request, progress });
}

/** Cooperative cancellation: already-converting files still finish. */
export async function cancelBatchConvert(jobId: number): Promise<void> {
  await invoke('cancel_batch_convert', { jobId });
}

// ---------------------------------------------------------------------------
// On-demand segmentation model download (`docs/08-roadmap.md` Phase 5
// "on-demand download for larger models with explicit consent",
// `src/segment/modelDownload.ts`).
//
// **The network fetch happens in Rust, not the frontend** — like
// `fetchLospecPalette` below, and for the same reason: GitHub's release-asset
// URL redirects to `release-assets.githubusercontent.com`, which sends no
// `Access-Control-Allow-Origin` header, so a WebView `fetch()` to it is
// rejected by CORS before it reaches the network (confirmed live the same
// way as the Lospec case — a real headless-browser `fetch()` to the real
// model URL failed with `TypeError: Failed to fetch`, while plain Node and
// `commands::segment::download_segmentation_model`'s own `ureq` call both
// succeeded). `downloadSegmentationModel` below is gated on an explicit user
// confirmation exactly as the old frontend `fetch()` was — only *where* the
// network call happens changed.
// ---------------------------------------------------------------------------

export interface SegmentationModelInfo {
  id: string;
  filename: string;
  sourceUrl: string;
  approxBytes: number;
  license: string;
}

/** Static metadata for the confirm dialog. Not a network call. */
export async function segmentationModelInfo(): Promise<SegmentationModelInfo> {
  return invoke<SegmentationModelInfo>('segmentation_model_info');
}

export interface SegmentationModelStatus {
  present: boolean;
  path: string;
}

/** A local file-existence check only — not a network call. */
export async function segmentationModelStatus(): Promise<SegmentationModelStatus> {
  return invoke<SegmentationModelStatus>('segmentation_model_status');
}

export interface SavedSegmentationModel {
  path: string;
  bytes: number;
}

/**
 * Fetch the larger segmentation model, verify its checksum and persist it —
 * entirely in Rust (see the module-level comment above for why). Call only
 * after the user has explicitly confirmed the download in the UI; this is
 * itself the network call, gated the same way the old frontend `fetch()`
 * was.
 */
export async function downloadSegmentationModel(): Promise<SavedSegmentationModel> {
  return invoke<SavedSegmentationModel>('download_segmentation_model');
}

export interface SegmentationAvailability {
  available: boolean;
  /** A human-readable reason ML segmentation is unavailable — set iff `!available`. */
  reason?: string;
}

/**
 * Whether ML background removal can actually run right now (a model *and*
 * the ONNX Runtime library are both on disk) — and, if so, preloads the
 * session on the Rust side so the first real conversion does not pay that
 * cost. A local filesystem check plus a local model load, never a network
 * call — safe to call on mount, the same as `segmentationModelStatus`/
 * `onnxRuntimeStatus` above.
 */
export async function segmentationAvailability(): Promise<SegmentationAvailability> {
  return invoke<SegmentationAvailability>('segmentation_availability');
}

// ---------------------------------------------------------------------------
// On-demand ONNX Runtime native library download (`docs/10-decisions.md`
// D16, `src/segment/OnnxRuntimeSection.tsx`). Same shape as the segmentation
// model wrappers above, and reusing the same generic
// `src/segment/modelDownload.ts::downloadConsentedFile` — the size question
// `07-tech-stack.md` §6 raised was "download the runtime on first use", and
// this is the "fetch" half of that; `segment::Segmenter` still needs a
// caller to actually load the extracted library (separate, later work).
//
// **The network fetch happens in Rust**, for the same CORS reason as the
// segmentation model above — see that section's comment.
// ---------------------------------------------------------------------------

export interface OnnxRuntimeInfo {
  version: string;
  filename: string;
  sourceUrl: string;
  approxBytes: number;
  extractedApproxBytes: number;
  license: string;
}

/** Static metadata for the confirm dialog. Not a network call. */
export async function onnxRuntimeInfo(): Promise<OnnxRuntimeInfo> {
  return invoke<OnnxRuntimeInfo>('onnx_runtime_info');
}

export interface OnnxRuntimeStatus {
  present: boolean;
  path: string;
}

/** A local file-existence check only — not a network call. */
export async function onnxRuntimeStatus(): Promise<OnnxRuntimeStatus> {
  return invoke<OnnxRuntimeStatus>('onnx_runtime_status');
}

export interface SavedOnnxRuntime {
  path: string;
  bytes: number;
}

/**
 * Fetch the ONNX Runtime `.tar.gz` archive, verify its checksum, extract the
 * single shared-object entry it needs, and persist it — entirely in Rust.
 * Call only after the user has explicitly confirmed the download in the UI;
 * this is itself the network call.
 */
export async function downloadOnnxRuntime(): Promise<SavedOnnxRuntime> {
  return invoke<SavedOnnxRuntime>('download_onnx_runtime');
}

// ---------------------------------------------------------------------------
// Lospec URL import (`docs/08-roadmap.md` Phase 7 "Lospec URL import
// (opt-in network)", `src/lib/lospecImport.ts`). Like the segmentation-model
// and ONNX-runtime downloads above, the fetch itself happens in Rust, not
// the frontend — measured directly: `lospec.com` sends no
// `Access-Control-Allow-Origin` header, so a WebView `fetch()` to it is
// rejected by CORS before any request leaves the browser engine (reproduced
// live: a real headless-browser `fetch()` to a real Lospec URL failed with
// `TypeError: Failed to fetch`, while the identical request from Node, which
// does not enforce CORS, succeeded). `commands::lospec::fetch_lospec_palette`
// has no such restriction. This call **is** the network activity — it is
// still only ever reachable from `lib/lospecImport.ts::importLospecPalette`,
// itself only ever reachable from an explicit user click
// (`panels/LospecImportSection.tsx`), preserving the same "opt-in, explicit
// consent" contract every other network feature here has.
// ---------------------------------------------------------------------------

export interface LospecFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export async function fetchLospecPalette(slug: string): Promise<LospecFetchResult> {
  return invoke<LospecFetchResult>('fetch_lospec_palette', { slug });
}
