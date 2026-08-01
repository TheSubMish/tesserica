import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { rectSelection } from '../model/selection';
import { applyTransform, canApplyTransform } from './applyTransform';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

beforeEach(() => {
  history().clear();
  useSelectionStore.getState().clear();
  doc().newDocument(8, 8);
  doc().setActiveLayer(doc().sprite.layers[0].id);
});

function activeBuffer(): Uint8ClampedArray {
  const cel = doc().activeCel();
  if (!cel) throw new Error('no active cel');
  const buf = getBuffer(cel.id);
  if (!buf) throw new Error('no buffer');
  return buf;
}

describe('canApplyTransform', () => {
  it('is true once a document exists with an active raster cel', () => {
    expect(canApplyTransform()).toBe(true);
  });

  it('is false once the active layer is locked', () => {
    doc().updateLayer(doc().activeLayerId, { locked: true });
    expect(canApplyTransform()).toBe(false);
  });
});

describe('applyTransform', () => {
  it('rotates the whole cel when nothing is selected, and is undoable/redoable', () => {
    const buf = activeBuffer();
    setPixel(buf, 8, 8, 0, 0, [255, 0, 0, 255]);
    doc().touch(doc().activeCel()!.id);

    const before = new Uint8ClampedArray(buf);
    applyTransform({ algorithm: 'rotxel', angleDegrees: 90, scalePercent: 100 });

    const after = activeBuffer();
    expect([...after]).not.toEqual([...before]);
    expect(history().past).toHaveLength(1);
    expect(history().past[0].label).toBe('Transform');

    history().undo();
    expect([...activeBuffer()]).toEqual([...before]);

    history().redo();
    expect([...activeBuffer()]).toEqual([...after]);
  });

  it('only touches the selection bounds, leaving pixels outside it untouched', () => {
    const buf = activeBuffer();
    // A marker well outside the selection bounds below.
    setPixel(buf, 8, 8, 7, 7, [0, 255, 0, 255]);
    doc().touch(doc().activeCel()!.id);

    useSelectionStore.getState().setSelection(rectSelection({ x: 0, y: 0, width: 4, height: 4 }));
    applyTransform({ algorithm: 'rotxel', angleDegrees: 90, scalePercent: 100 });

    const after = activeBuffer();
    expect(getPixel(after, 8, 8, 7, 7)).toEqual([0, 255, 0, 255]);
  });

  it('does nothing when there is no active cel to act on', () => {
    // Simulate "nothing to transform" by clearing history and checking a
    // no-op does not push an undo step.
    useSelectionStore.getState().setSelection(rectSelection({ x: 0, y: 0, width: 0, height: 0 }));
    applyTransform({ algorithm: 'rotxel', angleDegrees: 45, scalePercent: 100 });
    expect(history().past).toHaveLength(0);
  });

  it('cleanEdge honours a non-integer scale and stays undoable', () => {
    const buf = activeBuffer();
    setPixel(buf, 8, 8, 2, 2, [0, 0, 255, 255]);
    setPixel(buf, 8, 8, 3, 2, [0, 0, 255, 255]);
    doc().touch(doc().activeCel()!.id);
    const before = new Uint8ClampedArray(buf);

    applyTransform({ algorithm: 'cleanEdge', angleDegrees: 15, scalePercent: 150 });
    expect(history().past).toHaveLength(1);

    history().undo();
    expect([...activeBuffer()]).toEqual([...before]);
  });
});

describe('applyTransform — indexed cel (docs/08-roadmap.md Phase 7 follow-up)', () => {
  const palette: Palette = {
    id: 'p',
    name: 'P',
    colors: [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  beforeEach(() => {
    history().clear();
    useSelectionStore.getState().clear();
    doc().newDocument(8, 8, 'indexed', palette);
    doc().setActiveLayer(doc().sprite.layers[0].id);
  });

  function activeIndexBuffer(): Uint8Array {
    const cel = doc().activeCel();
    if (!cel) throw new Error('no active cel');
    const buf = getIndexBuffer(cel.id);
    if (!buf) throw new Error('no index buffer');
    return buf;
  }

  it('canApplyTransform is true for an indexed cel (it used to be false — getBuffer(RGBA) always missed)', () => {
    expect(canApplyTransform()).toBe(true);
    expect(getBuffer(doc().activeCel()!.id)).toBeUndefined(); // sanity: really is index storage
  });

  it('rotates palette-index bytes, never introducing an index absent from the source, and is undoable/redoable', () => {
    const buf = activeIndexBuffer();
    setPixel(buf, 8, 8, 0, 0, [1]); // raw index 1 (palette.colors[0], RED)
    setPixel(buf, 8, 8, 1, 0, [2]); // raw index 2 (palette.colors[1], GREEN)
    doc().touch(doc().activeCel()!.id);

    const before = new Uint8Array(buf);
    applyTransform({ algorithm: 'rotxel', angleDegrees: 37, scalePercent: 100 });

    const after = activeIndexBuffer();
    expect([...after]).not.toEqual([...before]);
    for (const v of after) expect([0, 1, 2]).toContain(v); // 0 = TRANSPARENT_INDEX
    expect(history().past).toHaveLength(1);
    expect(history().past[0].label).toBe('Transform');

    history().undo();
    expect([...activeIndexBuffer()]).toEqual([...before]);
    expect(getIndexBuffer(doc().activeCel()!.id)).toBeDefined(); // still indexed storage after undo

    history().redo();
    expect([...activeIndexBuffer()]).toEqual([...after]);
  });

  it('cleanEdge also stays within the source indices at a non-integer scale', () => {
    const buf = activeIndexBuffer();
    setPixel(buf, 8, 8, 2, 2, [2]);
    setPixel(buf, 8, 8, 3, 2, [2]);
    doc().touch(doc().activeCel()!.id);

    applyTransform({ algorithm: 'cleanEdge', angleDegrees: 15, scalePercent: 150 });
    for (const v of activeIndexBuffer()) expect([0, 2]).toContain(v);
    expect(history().past).toHaveLength(1);
  });

  it('only touches the selection bounds, leaving indices outside it untouched', () => {
    const buf = activeIndexBuffer();
    setPixel(buf, 8, 8, 7, 7, [2]);
    doc().touch(doc().activeCel()!.id);

    useSelectionStore.getState().setSelection(rectSelection({ x: 0, y: 0, width: 4, height: 4 }));
    applyTransform({ algorithm: 'rotxel', angleDegrees: 90, scalePercent: 100 });

    expect(getPixel(activeIndexBuffer(), 8, 8, 7, 7, 1)).toEqual([2]);
  });
});
