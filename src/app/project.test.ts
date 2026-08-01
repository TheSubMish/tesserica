/**
 * `.tess` open/save and `.ase` import (`docs/08-roadmap.md` Phase 6 "`.ase`
 * import", `docs/10-decisions.md` D17) share the same "fetch every staged
 * cel, replace the document" plumbing (`applyLoadResult`) — these tests pin
 * down the one place their behaviour is supposed to differ (what
 * `projectPath` ends up as) and that the shared plumbing actually runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

const loadProjectMock = vi.fn();
const importAseMock = vi.fn();
const fetchStagedMock = vi.fn();
const stageBytesMock = vi.fn();
const saveProjectMock = vi.fn();
const releaseStagedMock = vi.fn();
vi.mock('../ipc/commands', () => ({
  hasBackend: () => true,
  loadProject: (...args: unknown[]) => loadProjectMock(...args),
  importAse: (...args: unknown[]) => importAseMock(...args),
  fetchStaged: (...args: unknown[]) => fetchStagedMock(...args),
  releaseStaged: (...args: unknown[]) => releaseStagedMock(...args),
  stageBytes: (...args: unknown[]) => stageBytesMock(...args),
  saveProject: (...args: unknown[]) => saveProjectMock(...args),
}));

import { getBuffer, setPixel } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import { convertSpriteToIndexed } from '../history/colorModeCommands';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { importAseFile, openProject, saveCurrentProject } from './project';

function minimalSprite() {
  return {
    width: 2,
    height: 2,
    colorMode: 'rgba',
    layers: [
      {
        kind: 'raster',
        id: 'l1',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        parentId: null,
        clippingMask: false,
      },
    ],
    frames: [{ id: 'f1', durationMs: 100 }],
    cels: [{ id: 'c1', layerId: 'l1', frameId: 'f1', x: 0, y: 0, width: 2, height: 2 }],
    tags: [],
    tilesets: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchStagedMock.mockResolvedValue(new ArrayBuffer(2 * 2 * 4));
  useHistoryStore.getState().clear();
});

describe('openProject', () => {
  it('loads a .tess, replaces the document, and sets projectPath to the opened path', async () => {
    openMock.mockResolvedValue('/tmp/sprite.tess');
    loadProjectMock.mockResolvedValue({
      path: '/tmp/sprite.tess',
      formatVersion: 1,
      sprite: minimalSprite(),
      cels: [{ celId: 'c1', stageId: 1, width: 2, height: 2 }],
      tileEntries: [],
      warnings: [],
    });

    const result = await openProject();

    expect(result?.path).toBe('/tmp/sprite.tess');
    expect(loadProjectMock).toHaveBeenCalledWith('/tmp/sprite.tess');
    expect(fetchStagedMock).toHaveBeenCalledWith(1);
    expect(useDocumentStore.getState().sprite.layers).toHaveLength(1);
    expect(useDocumentStore.getState().projectPath).toBe('/tmp/sprite.tess');
  });

  it('returns null without touching the backend when the dialog is dismissed', async () => {
    openMock.mockResolvedValue(null);
    const result = await openProject();
    expect(result).toBeNull();
    expect(loadProjectMock).not.toHaveBeenCalled();
  });
});

describe('importAseFile', () => {
  it('imports a .ase through the same plumbing as openProject, but leaves projectPath unset', async () => {
    useDocumentStore.getState().setProjectPath('/tmp/previous.tess');

    openMock.mockResolvedValue('/tmp/character.aseprite');
    importAseMock.mockResolvedValue({
      path: '/tmp/character.aseprite',
      formatVersion: 1,
      sprite: minimalSprite(),
      cels: [{ celId: 'c1', stageId: 7, width: 2, height: 2 }],
      tileEntries: [],
      warnings: [
        "layer 'Ground' is an Aseprite tilemap layer; .ase tilemap import is not yet supported, skipped",
      ],
    });

    const result = await importAseFile();

    expect(result?.path).toBe('/tmp/character.aseprite');
    expect(result?.warnings).toHaveLength(1);
    expect(importAseMock).toHaveBeenCalledWith('/tmp/character.aseprite');
    expect(fetchStagedMock).toHaveBeenCalledWith(7);
    expect(useDocumentStore.getState().sprite.layers).toHaveLength(1);
    // An imported .ase is a source, not this project's own save file — the
    // next Ctrl+S must prompt for a location rather than silently
    // overwriting the .ase, or the previously-opened .tess.
    expect(useDocumentStore.getState().projectPath).toBeNull();
  });

  it('offers only .ase/.aseprite in the file picker filter', async () => {
    openMock.mockResolvedValue(null);
    await importAseFile();
    const options = openMock.mock.calls[0][0] as { filters: Array<{ extensions: string[] }> };
    expect(options.filters[0].extensions).toEqual(['ase', 'aseprite']);
  });

  it('returns null without touching the backend when the dialog is dismissed', async () => {
    openMock.mockResolvedValue(null);
    const result = await importAseFile();
    expect(result).toBeNull();
    expect(importAseMock).not.toHaveBeenCalled();
  });
});

describe('openProject — indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  function minimalIndexedSprite() {
    return {
      ...minimalSprite(),
      colorMode: 'indexed',
      palette: { id: 'p1', name: 'P', colors: [[255, 0, 0, 255]] },
    };
  }

  it('routes a raster cel to the index store, not the RGBA one, when the sprite is indexed', async () => {
    openMock.mockResolvedValue('/tmp/indexed.tess');
    // One index byte per pixel — 4 bytes for a 2x2 cel, not 16. `fetchStaged`
    // really does resolve a `Uint8Array` (`ipc/commands.ts`), not a plain
    // `ArrayBuffer` — that distinction matters here because this test checks
    // actual byte content, not just that *something* loaded.
    fetchStagedMock.mockResolvedValueOnce(new Uint8Array([1, 0, 0, 1]));
    loadProjectMock.mockResolvedValue({
      path: '/tmp/indexed.tess',
      formatVersion: 1,
      sprite: minimalIndexedSprite(),
      cels: [{ celId: 'c1', stageId: 1, width: 2, height: 2 }],
      tileEntries: [],
      warnings: [],
    });

    await openProject();

    const s = useDocumentStore.getState().sprite;
    expect(s.colorMode).toBe('indexed');
    expect(s.palette).toEqual({ id: 'p1', name: 'P', colors: [[255, 0, 0, 255]] });
    expect(getIndexBuffer(s.cels[0].id)).toEqual(new Uint8Array([1, 0, 0, 1]));
    expect(getBuffer(s.cels[0].id)).toBeUndefined();
  });
});

describe('.tess round trip of a sprite converted RGBA -> indexed (colorModeCommands.ts gap-closure)', () => {
  const palette: Palette = {
    id: 'p',
    name: 'P',
    colors: [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  /**
   * A minimal in-memory stand-in for the Rust staging area `saveCurrentProject`/
   * `openProject` talk to over IPC: `stageBytes` hands out an id and remembers
   * the bytes, `fetchStaged` looks them up. Real enough to exercise the actual
   * `saveCurrentProject` -> `saveProject` -> (this test, standing in for the
   * archive) -> `loadProject` -> `applyLoadResult` path end to end, without a
   * real Tauri backend.
   */
  function wireFakeStagingArea() {
    const area = new Map<number, Uint8Array>();
    let nextId = 1;
    stageBytesMock.mockImplementation((bytes: Uint8Array) => {
      const id = nextId++;
      area.set(id, new Uint8Array(bytes));
      return Promise.resolve(id);
    });
    fetchStagedMock.mockImplementation((id: number) => {
      const bytes = area.get(id);
      if (!bytes) throw new Error(`no staged bytes for id ${id}`);
      return Promise.resolve(bytes);
    });
    return area;
  }

  it('preserves colorMode, palette, and converted pixel indices through save + reopen', async () => {
    wireFakeStagingArea();
    saveMock.mockResolvedValue('/tmp/converted.tess');

    const doc = () => useDocumentStore.getState();
    doc().newDocument(2, 2);
    doc().setActiveLayer(doc().sprite.layers[0].id);
    const cel = doc().activeCel()!;
    const buf = getBuffer(cel.id)!;
    setPixel(buf, 2, 2, 0, 0, [255, 0, 0, 255]); // exact RED -> index 1
    setPixel(buf, 2, 2, 1, 0, [0, 255, 0, 255]); // exact GREEN -> index 2
    setPixel(buf, 2, 2, 0, 1, [250, 3, 3, 255]); // near-RED, out of palette -> index 1
    doc().touch(cel.id);

    expect(convertSpriteToIndexed(palette)).toEqual({ ok: true });
    const indicesBeforeSave = new Uint8Array(getIndexBuffer(cel.id)!);

    // Capture exactly what `saveProject` was asked to persist, and hand that
    // same shape back out of `loadProject` — the real archive's job, stood in
    // for here by this test.
    let saved: { sprite: unknown; cels: Array<{ celId: string; stageId: number }> } | undefined;
    saveProjectMock.mockImplementation((args: typeof saved) => {
      saved = args;
      return Promise.resolve();
    });

    const savedPath = await saveCurrentProject({ saveAs: true });
    expect(savedPath).toBe('/tmp/converted.tess');
    expect(saved).toBeDefined();

    loadProjectMock.mockResolvedValue({
      path: '/tmp/converted.tess',
      formatVersion: 1,
      sprite: saved!.sprite,
      cels: saved!.cels.map((c) => ({ ...c, width: 2, height: 2 })),
      tileEntries: [],
      warnings: [],
    });
    openMock.mockResolvedValue('/tmp/converted.tess');

    await openProject();

    const reloaded = useDocumentStore.getState().sprite;
    expect(reloaded.colorMode).toBe('indexed');
    expect(reloaded.palette?.colors).toEqual(palette.colors);
    const reloadedCelId = reloaded.cels[0].id;
    expect([...getIndexBuffer(reloadedCelId)!]).toEqual([...indicesBeforeSave]);
    expect(getBuffer(reloadedCelId)).toBeUndefined(); // still routed to index storage, not RGBA
  });
});
