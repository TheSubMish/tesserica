import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
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
