/**
 * Save and open `.tess` documents (`docs/03-data-model.md` §7).
 *
 * Rust owns the archive — it encodes the cel PNGs, builds the thumbnail and
 * writes the ZIP. This module's whole job is marshalling: pixels go over the
 * raw IPC body as staging handles, and the command itself carries only the
 * document metadata, exactly as `docs/02-architecture.md` §6.2 requires.
 *
 * `preserveFrom` is passed on every save of a previously-opened file. §7
 * promises that unknown entries survive a round trip, which is what stops this
 * build from silently deleting, say, a Phase 4 timeline it cannot read.
 */

import { open, save } from '@tauri-apps/plugin-dialog';
import { flattenSprite } from '../canvas/flatten';
import { invalidateRenderCache } from '../canvas/renderer';
import { getBuffer } from '../model/pixelBuffers';
import { getGrid } from '../model/tileGridBuffers';
import { getTileBuffer } from '../model/tileBuffers';
import { celBufferId, type Sprite } from '../model/types';
import {
  fetchStaged,
  hasBackend,
  loadProject,
  releaseStaged,
  saveProject,
  stageBytes,
  type CelUpload,
  type TileUpload,
} from '../ipc/commands';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';

export const TESS_FILTER = { name: 'Tesserica project', extensions: ['tess'] };

export class NoBackendError extends Error {
  constructor() {
    super('This needs the desktop app — the Rust backend is not available here.');
  }
}

function asBytes(pixels: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

/**
 * A packed-tile-id grid's raw bytes — the `.tess` archive stores a tilemap
 * cel's content as raw bytes (`docs/03-data-model.md` §7's own "indexed/
 * tilemap cels as raw"), never RGBA, so this is `asBytes`'s `Uint32Array`
 * counterpart.
 */
function gridAsBytes(grid: Uint32Array): Uint8Array {
  return new Uint8Array(grid.buffer, grid.byteOffset, grid.byteLength);
}

/**
 * Write the current document. Returns the path written, or `null` when the
 * user dismissed the dialog.
 */
export async function saveCurrentProject(options: { saveAs: boolean }): Promise<string | null> {
  if (!hasBackend()) throw new NoBackendError();

  const doc = useDocumentStore.getState();
  const existing = doc.projectPath;

  let path = options.saveAs ? null : existing;
  if (!path) {
    path = await save({
      title: 'Save project',
      defaultPath: existing ?? 'sprite.tess',
      filters: [TESS_FILTER],
    });
    if (!path) return null;
  }

  const staged: number[] = [];
  try {
    const cels: CelUpload[] = [];
    for (const cel of doc.sprite.cels) {
      // A linked cel (`docs/03-data-model.md` §2.2) shares another cel's
      // buffer and therefore its PNG on disk — writing it again would be a
      // needless duplicate at best, and Rust never has to know: `linkedTo`
      // round-trips through `sprite.json` on its own.
      if (cel.linkedTo) continue;

      const layer = doc.sprite.layers.find((l) => l.id === cel.layerId);
      if (layer?.kind === 'tilemap') {
        // Roadmap Phase 6: a tilemap cel's content is a grid of packed tile
        // ids, not RGBA — staged and written raw (`commands::project` writes
        // it to `cels/<id>.bin`, never through `encode_png`).
        const grid = getGrid(celBufferId(cel));
        if (!grid) continue;
        const stageId = await stageBytes(gridAsBytes(grid));
        staged.push(stageId);
        cels.push({ celId: cel.id, stageId, width: cel.width, height: cel.height });
        continue;
      }

      const buf = getBuffer(cel.id);
      if (!buf) continue;
      const stageId = await stageBytes(asBytes(buf));
      staged.push(stageId);
      cels.push({ celId: cel.id, stageId, width: cel.width, height: cel.height });
    }

    const tileEntries: TileUpload[] = [];
    for (const tileset of doc.sprite.tilesets) {
      for (const entry of tileset.tiles) {
        const buf = getTileBuffer(entry.id);
        if (!buf) continue;
        const stageId = await stageBytes(asBytes(buf));
        staged.push(stageId);
        tileEntries.push({
          tilesetId: tileset.id,
          tileId: entry.id,
          stageId,
          width: tileset.tileWidth,
          height: tileset.tileHeight,
        });
      }
    }

    const flat = flattenSprite(doc.sprite, doc.activeFrameId);
    const thumbStage = await stageBytes(asBytes(flat));
    staged.push(thumbStage);

    await saveProject({
      path,
      sprite: doc.sprite,
      cels,
      thumbnail: {
        celId: 'thumbnail',
        stageId: thumbStage,
        width: doc.sprite.width,
        height: doc.sprite.height,
      },
      tileEntries,
      // Only meaningful when re-saving something we opened.
      preserveFrom: existing,
    });

    // The command consumed every handle it was given.
    staged.length = 0;
    useDocumentStore.getState().setProjectPath(path);
    return path;
  } finally {
    // A failure must not leave megabytes parked in the Rust staging area.
    for (const id of staged) await releaseStaged(id).catch(() => {});
  }
}

/** Open a `.tess`, replacing the current document. Returns warnings, if any. */
export async function openProject(): Promise<{ path: string; warnings: string[] } | null> {
  if (!hasBackend()) throw new NoBackendError();

  const picked = await open({
    title: 'Open project',
    multiple: false,
    directory: false,
    filters: [TESS_FILTER],
  });
  if (!picked || typeof picked !== 'string') return null;

  const result = await loadProject(picked);

  // Roadmap Phase 6: a tilemap layer's cel arrives as the same shape as a
  // raster cel's staged bytes (`ipc/commands.ts::LoadedCel`) — which map it
  // belongs in is decided the same way the save path decided how to write
  // it, by looking up the cel's owning layer.
  const tilemapLayerIds = new Set(
    (result.sprite.layers as Array<{ id: string; kind: string }>)
      .filter((l) => l.kind === 'tilemap')
      .map((l) => l.id),
  );
  const celLayerId = new Map(
    (result.sprite.cels as Array<{ id: string; layerId: string }>).map((c) => [c.id, c.layerId]),
  );

  const pixels = new Map<string, Uint8ClampedArray>();
  const grids = new Map<string, Uint32Array>();
  for (const cel of result.cels) {
    const bytes = await fetchStaged(cel.stageId);
    const layerId = celLayerId.get(cel.celId);
    if (layerId && tilemapLayerIds.has(layerId)) {
      grids.set(cel.celId, new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    } else {
      pixels.set(
        cel.celId,
        new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
    }
  }

  const tileBuffers = new Map<string, Uint8ClampedArray>();
  for (const tile of result.tileEntries) {
    const bytes = await fetchStaged(tile.stageId);
    tileBuffers.set(
      tile.tileId,
      new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
  }

  // Rust mirrors the TS types exactly (docs/03 §8), so this is the same shape
  // the store already holds — no translation layer.
  useDocumentStore
    .getState()
    .replaceDocument(result.sprite as unknown as Sprite, pixels, grids, tileBuffers);
  useDocumentStore.getState().setProjectPath(result.path);

  // The new document has no shared history with the old one, and every cached
  // composite belongs to a document that no longer exists.
  useHistoryStore.getState().clear();
  invalidateRenderCache();

  return { path: result.path, warnings: result.warnings };
}

/**
 * Pick a source image for Convert mode.
 *
 * Returns the *path*, not the bytes: Rust opens the file and keeps the pixels
 * (`docs/02-architecture.md` §6.2), so the frontend never reads it at all.
 */
export async function pickImage(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [
      // Uppercase variants are listed explicitly: GTK's file-chooser globs are
      // case-sensitive, so `*.png` alone hides `PHOTO.PNG`.
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'PNG', 'JPG', 'JPEG'],
      },
      // Always offer an unfiltered view. Which filter a Linux file chooser
      // applies by default depends on the desktop portal in use, and a filter
      // that silently hides every file in a directory is indistinguishable from
      // an empty directory. This gives the user a way out that does not depend
      // on which portal is installed.
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return typeof picked === 'string' ? picked : null;
}
