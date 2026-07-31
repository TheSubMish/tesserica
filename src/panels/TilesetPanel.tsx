/**
 * Tileset management + tile picker for the Stamp tool
 * (`docs/03-data-model.md` §4, `docs/08-roadmap.md` Phase 6).
 *
 * Three things live here, the same one-panel-per-concern shape
 * `PalettePanel`/`LayerPanel` already use:
 *
 * - **Create a tileset** (name + tile size) — an inline form, the same idiom
 *   `TimelinePanel`'s "+ Tag" form uses, not a modal.
 * - **Add a tile** by capturing the active rectangular selection from a
 *   raster (or conversion) layer — reusing Phase 3's selection tools rather
 *   than inventing an import dialog. The selection's bounding box must equal
 *   the tileset's own tile size exactly; nearest-neighbour resampling a
 *   selection to fit would be a second, undocumented pipeline
 *   (`docs/04-image-pipeline.md` is normative and says nothing about this),
 *   so a size mismatch is a plain, actionable error instead.
 * - **Pick a tile** to stamp, with flip/rotate toggles
 *   (`state/tilesetStore.ts`) that feed straight into `model/tileIds.ts`'s
 *   packed tile id — the Stamp tool (`tools/stampSession.ts`) reads the same
 *   store.
 *
 * Renders unconditionally (not gated on the active layer being a tilemap
 * layer) because tileset *management* — creating one, stocking it with tiles
 * — is meaningful before any tilemap layer exists to consume it, the same way
 * `PalettePanel` is not gated on any particular tool being active.
 */

import { useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { celBufferId, type GridSpec } from '../model/types';
import { getBuffer } from '../model/pixelBuffers';
import { getTileBuffer } from '../model/tileBuffers';
import { extractTilePixels } from '../model/tilesets';
import {
  concatTilePixels,
  DEFAULT_TILESET_SHEET_COLUMNS,
  tilemapExportSelection,
} from '../export/tilemapExport';
import { exportTilemap, hasBackend, releaseStaged, stageBytes } from '../ipc/commands';
import { addTileset, addTileToTileset, addTilemapLayer } from '../history/tilesetCommands';
import { useDocumentStore } from '../state/documentStore';
import { useSelectionStore } from '../state/selectionStore';
import { useTilesetStore } from '../state/tilesetStore';

/** One tile's thumbnail — a real `<canvas>`, nearest-neighbour scaled via CSS. */
function TileThumb({
  tileWidth,
  tileHeight,
  tileEntryId,
}: {
  tileWidth: number;
  tileHeight: number;
  tileEntryId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draw = (canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (!canvas) return;
    canvas.width = tileWidth;
    canvas.height = tileHeight;
    const ctx = canvas.getContext('2d');
    const buf = getTileBuffer(tileEntryId);
    if (!ctx || !buf) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), tileWidth, tileHeight), 0, 0);
  };
  return <canvas ref={draw} className="tile-thumb-canvas" aria-hidden="true" />;
}

export function TilesetPanel() {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);
  const selection = useSelectionStore((s) => s.selection);

  const selectedTilesetId = useTilesetStore((s) => s.selectedTilesetId);
  const selectedTileIndex = useTilesetStore((s) => s.selectedTileIndex);
  const flipH = useTilesetStore((s) => s.flipH);
  const flipV = useTilesetStore((s) => s.flipV);
  const transpose = useTilesetStore((s) => s.transpose);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('Tileset');
  const [tileWidth, setTileWidth] = useState(16);
  const [tileHeight, setTileHeight] = useState(16);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ text: string; error: boolean } | null>(null);

  const tilesets = sprite.tilesets;
  const tileset = tilesets.find((t) => t.id === selectedTilesetId) ?? tilesets[0];

  const createTileset = () => {
    const id = addTileset(
      name.trim() || 'Tileset',
      Math.max(1, tileWidth),
      Math.max(1, tileHeight),
    );
    useTilesetStore.getState().setSelectedTileset(id);
    setCreating(false);
    setNotice(null);
  };

  const captureFromSelection = () => {
    if (!tileset) return;
    setNotice(null);
    const doc = useDocumentStore.getState();
    const layer = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);
    if (!layer || layer.kind === 'tilemap' || layer.kind === 'group') {
      setNotice({
        text: 'Select a raster (or conversion) layer to capture a tile from.',
        error: true,
      });
      return;
    }
    const sel = useSelectionStore.getState().selection;
    if (!sel) {
      setNotice({ text: 'Make a rectangular selection first.', error: true });
      return;
    }
    if (sel.bounds.width !== tileset.tileWidth || sel.bounds.height !== tileset.tileHeight) {
      setNotice({
        text: `Selection is ${sel.bounds.width}×${sel.bounds.height} — this tileset's tiles are ${tileset.tileWidth}×${tileset.tileHeight}.`,
        error: true,
      });
      return;
    }
    const cel = doc.activeCel();
    if (!cel) return;
    const buffer = getBuffer(celBufferId(cel));
    if (!buffer) return;
    const pixels = extractTilePixels(buffer, cel.width, cel.height, {
      x: sel.bounds.x - cel.x,
      y: sel.bounds.y - cel.y,
      width: sel.bounds.width,
      height: sel.bounds.height,
    });
    if (!pixels) {
      setNotice({ text: 'Selection falls outside the layer.', error: true });
      return;
    }
    const outcome = addTileToTileset(tileset.id, pixels);
    if (!outcome) {
      setNotice({ text: 'Could not add tile.', error: true });
      return;
    }
    useTilesetStore.getState().selectTile(tileset.id, outcome.index);
    useTilesetStore.getState().setFlipH(outcome.flipH);
    useTilesetStore.getState().setFlipV(outcome.flipV);
    setNotice({
      text: outcome.reused
        ? `Reused tile #${outcome.index}${outcome.flipH || outcome.flipV ? ' (flipped)' : ''} — identical pixels already existed.`
        : `Added tile #${outcome.index}.`,
      error: false,
    });
  };

  const createTilemapLayer = () => {
    if (!tileset) return;
    const grid: GridSpec = {
      shape: 'rect',
      tileWidth: tileset.tileWidth,
      tileHeight: tileset.tileHeight,
      offsetX: 0,
      offsetY: 0,
    };
    const layerId = addTilemapLayer(tileset.id, grid);
    if (layerId) useDocumentStore.getState().setActiveLayer(layerId);
  };

  const activeLayer = sprite.layers.find((l) => l.id === activeLayerId);
  const isTilemapLayer = activeLayer?.kind === 'tilemap';

  const runExport = async () => {
    setExportNotice(null);
    if (!activeLayer || activeLayer.kind !== 'tilemap') return;
    if (!hasBackend()) {
      setExportNotice({
        text: 'Export needs the desktop app — the Rust backend is not available here.',
        error: true,
      });
      return;
    }

    const selectionForExport = tilemapExportSelection(sprite, activeLayer.id, activeFrameId);
    if (!selectionForExport) {
      setExportNotice({ text: 'This layer has no tilemap grid to export yet.', error: true });
      return;
    }
    const atlas = concatTilePixels(selectionForExport.tileset);
    if (!atlas) {
      setExportNotice({
        text: 'Could not read every tile — one is missing its pixels.',
        error: true,
      });
      return;
    }
    if (atlas.count === 0) {
      setExportNotice({ text: 'Add at least one real tile before exporting.', error: true });
      return;
    }

    try {
      setExporting(true);
      const path = await save({
        title: 'Export tileset + tilemap',
        defaultPath: `${selectionForExport.tileset.name || 'tileset'}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (!path) return;

      const stageId = await stageBytes(
        new Uint8Array(atlas.pixels.buffer, 0, atlas.pixels.byteLength),
      );
      try {
        const result = await exportTilemap({
          stageId,
          tileWidth: selectionForExport.tileset.tileWidth,
          tileHeight: selectionForExport.tileset.tileHeight,
          tileCount: atlas.count,
          columns: Math.max(1, Math.min(DEFAULT_TILESET_SHEET_COLUMNS, atlas.count)),
          scale: 1,
          tilesetName: selectionForExport.tileset.name,
          layerName: activeLayer.name,
          gridCols: selectionForExport.cols,
          gridRows: selectionForExport.rows,
          tileIds: selectionForExport.tileIds,
          path,
        });
        setExportNotice({
          text: `Wrote ${result.width}×${result.height} tileset to ${result.path}, map JSON to ${result.jsonPath}`,
          error: false,
        });
      } catch (e) {
        await releaseStaged(stageId).catch(() => {});
        throw e;
      }
    } catch (e) {
      setExportNotice({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setExporting(false);
    }
  };

  const canCapture =
    !!tileset &&
    !!selection &&
    selection.bounds.width === tileset.tileWidth &&
    selection.bounds.height === tileset.tileHeight;

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Tileset</span>
        <span>
          <button
            title="New tileset"
            aria-label="New tileset"
            aria-pressed={creating}
            onClick={() => setCreating((v) => !v)}
          >
            +
          </button>
          <button
            title="Add tilemap layer from this tileset"
            aria-label="Add tilemap layer"
            disabled={!tileset}
            onClick={createTilemapLayer}
          >
            ▦
          </button>
        </span>
      </div>

      {creating && (
        <div className="tileset-create-form">
          <label className="field">
            <span className="sr-only">Tileset name</span>
            <input
              type="text"
              aria-label="Tileset name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field dims-row">
            <label>
              <span className="sr-only">Tile width</span>
              <input
                type="number"
                className="dim-input"
                aria-label="Tile width"
                min={1}
                value={tileWidth}
                onChange={(e) => setTileWidth(e.target.valueAsNumber)}
              />
            </label>
            <span aria-hidden="true">×</span>
            <label>
              <span className="sr-only">Tile height</span>
              <input
                type="number"
                className="dim-input"
                aria-label="Tile height"
                min={1}
                value={tileHeight}
                onChange={(e) => setTileHeight(e.target.valueAsNumber)}
              />
            </label>
          </div>
          <div className="modal-actions">
            <button onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" onClick={createTileset}>
              Create
            </button>
          </div>
        </div>
      )}

      {!tileset ? (
        <p className="hint">No tilesets yet — create one to start a tile layer.</p>
      ) : (
        <>
          <label className="field">
            <span className="sr-only">Tileset</span>
            <select
              aria-label="Tileset"
              value={tileset.id}
              onChange={(e) => useTilesetStore.getState().setSelectedTileset(e.target.value)}
            >
              {tilesets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.tileWidth}×{t.tileHeight})
                </option>
              ))}
            </select>
          </label>

          <div className="tile-grid" role="group" aria-label={`${tileset.name} tiles`}>
            {tileset.tiles.map((entry, index) => (
              <button
                key={entry.id}
                className="tile-swatch"
                aria-label={index === 0 ? 'Empty tile' : `Tile ${index}`}
                aria-pressed={tileset.id === selectedTilesetId && index === selectedTileIndex}
                title={index === 0 ? 'Empty (clears a cell)' : `Tile ${index}`}
                onClick={() => useTilesetStore.getState().selectTile(tileset.id, index)}
              >
                <TileThumb
                  tileWidth={tileset.tileWidth}
                  tileHeight={tileset.tileHeight}
                  tileEntryId={entry.id}
                />
              </button>
            ))}
          </div>

          <div className="stamp-flags" role="group" aria-label="Stamp orientation">
            <button
              className="flag-btn"
              aria-pressed={flipH}
              title="Flip horizontal"
              aria-label="Flip horizontal"
              onClick={() => useTilesetStore.getState().toggleFlipH()}
            >
              ↔
            </button>
            <button
              className="flag-btn"
              aria-pressed={flipV}
              title="Flip vertical"
              aria-label="Flip vertical"
              onClick={() => useTilesetStore.getState().toggleFlipV()}
            >
              ↕
            </button>
            <button
              className="flag-btn"
              aria-pressed={transpose}
              title="Transpose (diagonal flip)"
              aria-label="Transpose"
              onClick={() => useTilesetStore.getState().toggleTranspose()}
            >
              ⤢
            </button>
          </div>

          <button
            className="capture-tile-btn"
            disabled={
              !canCapture || activeLayer?.kind === 'tilemap' || activeLayer?.kind === 'group'
            }
            onClick={captureFromSelection}
          >
            + Add tile from selection
          </button>
          <p className="hint">
            {selection
              ? `Selection ${selection.bounds.width}×${selection.bounds.height}`
              : `Select a ${tileset.tileWidth}×${tileset.tileHeight} region to capture a tile.`}
          </p>

          {isTilemapLayer && (
            <>
              <button
                className="export-tilemap-btn"
                disabled={exporting}
                onClick={() => void runExport()}
              >
                {exporting ? 'Exporting…' : 'Export tileset + tilemap…'}
              </button>
              <p className="hint">PNG atlas + Tiled-shaped `.json` map for this layer's grid.</p>
            </>
          )}
        </>
      )}

      {notice && (
        <p
          className={notice.error ? 'hint error' : 'hint'}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {exportNotice && (
        <p
          className={exportNotice.error ? 'hint error' : 'hint'}
          role={exportNotice.error ? 'alert' : 'status'}
        >
          {exportNotice.text}
        </p>
      )}
    </section>
  );
}
