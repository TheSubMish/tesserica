/**
 * The Stamp tool's real behaviour, called directly from `CanvasView` (see
 * `tools/stamp.ts` for why it cannot go through generic tool dispatch).
 *
 * Mirrors the shape every other tool gets for free from
 * `CanvasView`/`history/strokeRecorder.ts`: snapshot the grid at pointer-down,
 * mutate it live (straight through `documentStore.setTilemapCell`, exactly
 * the primitive `history/tilesetCommands.ts::paintTilemapCell` already uses)
 * so the drag paints as the user drags, then diff at pointer-up into one
 * `PaintTileCellsCommand` — one drag, one undo step.
 */

import { celBufferId, type Cel, type CelId, type GridSpec, type TilesetId } from '../model/types';
import { bumpGridRevision, getGrid } from '../model/tileGridBuffers';
import { docPixelToCell, packTileId, tileGridDims } from '../model/tileIds';
import { linePoints } from './raster';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useTilesetStore } from '../state/tilesetStore';
import {
  beginTileStroke,
  finishTileStroke,
  restoreTileStroke,
  type TileStrokeSnapshot,
} from '../history/tileStrokeRecorder';

interface StampTarget {
  /** The real `Cel.id` — what `setTilemapCell`/`PaintTileCellsCommand` key on. */
  celId: CelId;
  /** Where the grid array and its revision counter actually live (linked cels differ). */
  bufferId: CelId;
  cel: Cel;
  grid: GridSpec;
  tilesetId: TilesetId;
  cols: number;
  rows: number;
  gridBuffer: Uint32Array;
}

/** The active tilemap layer's paintable target, or `null` when it isn't one. */
function activeTilemapTarget(): StampTarget | null {
  const doc = useDocumentStore.getState();
  const layer = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);
  if (layer?.kind !== 'tilemap') return null;
  const cel = doc.activeCel();
  if (!cel) return null;
  const bufferId = celBufferId(cel);
  const gridBuffer = getGrid(bufferId);
  if (!gridBuffer) return null;
  const { cols, rows } = tileGridDims(cel, layer.grid);
  return {
    celId: cel.id,
    bufferId,
    cel,
    grid: layer.grid,
    tilesetId: layer.tilesetId,
    cols,
    rows,
    gridBuffer,
  };
}

/** The picker's current selection, packed with its flip/rotate flags, or `null`. */
function selectedPackedTileId(tilesetId: TilesetId): number | null {
  const s = useTilesetStore.getState();
  if (s.selectedTilesetId !== tilesetId || s.selectedTileIndex === null) return null;
  return packTileId(s.selectedTileIndex, {
    flipH: s.flipH,
    flipV: s.flipV,
    transpose: s.transpose,
  });
}

function paintCell(target: StampTarget, col: number, row: number, tileId: number): void {
  if (col < 0 || row < 0 || col >= target.cols || row >= target.rows) return;
  useDocumentStore.getState().setTilemapCell(target.celId, col, row, tileId);
}

let session: TileStrokeSnapshot | null = null;
let lastCell: { col: number; row: number } | null = null;

/** Pointer-down: begin a gesture and stamp the first cell. Returns whether one started. */
export function beginStamp(docX: number, docY: number): boolean {
  const target = activeTilemapTarget();
  if (!target) return false;
  const tileId = selectedPackedTileId(target.tilesetId);
  if (tileId === null) return false;

  session = beginTileStroke(target.celId, target.gridBuffer, target.cols, target.rows);
  const { col, row } = docPixelToCell(docX, docY, target.cel, target.grid);
  lastCell = { col, row };
  paintCell(target, col, row, tileId);
  return true;
}

/** Pointer-move during a stamp drag — interpolates cells the same way a brush stroke does. */
export function continueStamp(docX: number, docY: number): void {
  if (!session) return;
  const target = activeTilemapTarget();
  if (!target) return;
  const tileId = selectedPackedTileId(target.tilesetId);
  if (tileId === null) return;

  const { col, row } = docPixelToCell(docX, docY, target.cel, target.grid);
  const prev = lastCell ?? { col, row };
  for (const p of linePoints(prev.col, prev.row, col, row)) paintCell(target, p.x, p.y, tileId);
  lastCell = { col, row };
}

/** Pointer-up — close the gesture into one undo step (or none, if it was a no-op). */
export function endStamp(): void {
  if (!session) return;
  const target = activeTilemapTarget();
  const cmd = target ? finishTileStroke(session, target.gridBuffer) : null;
  if (cmd) useHistoryStore.getState().push(cmd);
  session = null;
  lastCell = null;
}

/** Escape abandons the in-progress gesture, never the document (`docs/05-ui-design.md` §7.8). */
export function abortStamp(): void {
  if (!session) return;
  const target = activeTilemapTarget();
  if (target) {
    restoreTileStroke(session, target.gridBuffer);
    bumpGridRevision(target.bufferId);
    useDocumentStore.getState().touch(target.bufferId);
  }
  session = null;
  lastCell = null;
}

/** True while a stamp gesture is in progress — lets `CanvasView` route Escape correctly. */
export function isStamping(): boolean {
  return session !== null;
}
