/**
 * Focused on the roadmap Phase 7 "Isometric and hexagonal tile grids" UI
 * requirement: a grid-shape selector for a brand-new tilemap layer, not rect
 * assumed silently (`createTilemapLayer` used to hardcode `shape: 'rect'`).
 * Full tileset/tile-capture/export coverage is exercised live (see this
 * item's roadmap entry) rather than duplicated here.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { useTilesetStore } from '../state/tilesetStore';
import { addTileset } from '../history/tilesetCommands';
import { TilesetPanel } from './TilesetPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<TilesetPanel />));
}

beforeEach(() => {
  history().clear();
  doc().newDocument(64, 64);
  history().clear();
  useSelectionStore.setState({ selection: null });
  useTilesetStore.setState({
    selectedTilesetId: null,
    selectedTileIndex: null,
    flipH: false,
    flipV: false,
    transpose: false,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const shapeSelect = () =>
  container.querySelector(
    'select[aria-label="New tilemap layer\'s grid shape"]',
  ) as HTMLSelectElement;
const addLayerButton = () =>
  container.querySelector('button[aria-label="Add tilemap layer"]') as HTMLButtonElement;

describe('TilesetPanel — grid shape selector', () => {
  it('defaults to rect and offers isometric/hexagonal options', () => {
    const select = shapeSelect();
    expect(select.value).toBe('rect');
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(['rect', 'isometric', 'hexagonal']);
  });

  it('creates a rect tilemap layer by default, offset at the canvas origin', () => {
    act(() => {
      addTileset('Ground', 16, 16);
    });
    render();
    act(() => addLayerButton().click());

    const layer = doc().sprite.layers.find((l) => l.kind === 'tilemap');
    expect(layer?.kind).toBe('tilemap');
    if (layer?.kind === 'tilemap') {
      expect(layer.grid.shape).toBe('rect');
      expect(layer.grid.offsetX).toBe(0);
      expect(layer.grid.offsetY).toBe(0);
    }
  });

  it('creates an isometric tilemap layer, horizontally centred on the canvas, when selected', () => {
    act(() => {
      addTileset('Ground', 16, 16);
    });
    render();
    act(() => setNativeSelectValue(shapeSelect(), 'isometric'));
    render();
    act(() => addLayerButton().click());

    const layer = doc().sprite.layers.find((l) => l.kind === 'tilemap');
    expect(layer?.kind).toBe('tilemap');
    if (layer?.kind === 'tilemap') {
      expect(layer.grid.shape).toBe('isometric');
      // Centred: canvasWidth/2 - tileWidth/2 = 64/2 - 16/2 = 24.
      expect(layer.grid.offsetX).toBe(24);
      expect(layer.grid.offsetY).toBe(0);
    }
  });

  it('creates a hexagonal tilemap layer, at the canvas origin, when selected', () => {
    act(() => {
      addTileset('Ground', 16, 16);
    });
    render();
    act(() => setNativeSelectValue(shapeSelect(), 'hexagonal'));
    render();
    act(() => addLayerButton().click());

    const layer = doc().sprite.layers.find((l) => l.kind === 'tilemap');
    expect(layer?.kind).toBe('tilemap');
    if (layer?.kind === 'tilemap') {
      expect(layer.grid.shape).toBe('hexagonal');
      expect(layer.grid.offsetX).toBe(0);
      expect(layer.grid.offsetY).toBe(0);
    }
  });
});
