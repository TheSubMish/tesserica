/**
 * `.tess` open/save and `.ase` import (`docs/08-roadmap.md` Phase 6 "`.ase`
 * import", `docs/10-decisions.md` D17) share the same "fetch every staged
 * cel, replace the document" plumbing (`applyLoadResult`) — these tests pin
 * down the one place their behaviour is supposed to differ (what
 * `projectPath` ends up as) and that the shared plumbing actually runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: vi.fn(),
}));

const loadProjectMock = vi.fn();
const importAseMock = vi.fn();
const fetchStagedMock = vi.fn();
vi.mock('../ipc/commands', () => ({
  hasBackend: () => true,
  loadProject: (...args: unknown[]) => loadProjectMock(...args),
  importAse: (...args: unknown[]) => importAseMock(...args),
  fetchStaged: (...args: unknown[]) => fetchStagedMock(...args),
  releaseStaged: vi.fn(),
  stageBytes: vi.fn(),
  saveProject: vi.fn(),
}));

import { getBuffer } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { importAseFile, openProject } from './project';

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
