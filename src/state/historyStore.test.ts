import { beforeEach, describe, expect, it } from 'vitest';
import { allocateBuffer, getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { PixelDeltaCommand } from '../history/commands';
import type { Command } from '../history/command';
import { beginStroke, finishStroke, restoreStroke } from '../history/strokeRecorder';
import { MAX_STEPS, useHistoryStore } from './historyStore';
import { useDocumentStore } from './documentStore';

const W = 8;
const H = 8;

function freshCel(id: string): Uint8ClampedArray {
  return allocateBuffer(id, W, H);
}

beforeEach(() => {
  useHistoryStore.getState().clear();
});

/** A command that only counts, for exercising the store's bookkeeping. */
function counterCommand(label: string, log: string[], memoryCost = 0): Command {
  return {
    label,
    memoryCost,
    apply: () => log.push(`+${label}`),
    invert: () => log.push(`-${label}`),
  };
}

describe('undo / redo', () => {
  it('restores the pixels a stroke changed and puts them back on redo', () => {
    const buf = freshCel('h1');
    const snapshot = beginStroke('h1', buf, W, H);
    setPixel(buf, W, H, 3, 3, [255, 0, 0, 255]);
    setPixel(buf, W, H, 4, 3, [255, 0, 0, 255]);

    const cmd = finishStroke(snapshot, buf, 'Pencil')!;
    useHistoryStore.getState().push(cmd);

    expect(getPixel(buf, W, H, 3, 3)).toEqual([255, 0, 0, 255]);

    useHistoryStore.getState().undo();
    expect(getPixel(buf, W, H, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(getPixel(buf, W, H, 4, 3)).toEqual([0, 0, 0, 0]);

    useHistoryStore.getState().redo();
    expect(getPixel(buf, W, H, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('bumps the document revision so the canvas redraws', () => {
    const buf = freshCel('h2');
    const snapshot = beginStroke('h2', buf, W, H);
    setPixel(buf, W, H, 1, 1, [1, 2, 3, 255]);
    useHistoryStore.getState().push(finishStroke(snapshot, buf, 'Pencil')!);

    const before = useDocumentStore.getState().revision;
    useHistoryStore.getState().undo();
    expect(useDocumentStore.getState().revision).toBeGreaterThan(before);
  });

  it('is a no-op at either end of the stack', () => {
    expect(() => useHistoryStore.getState().undo()).not.toThrow();
    expect(() => useHistoryStore.getState().redo()).not.toThrow();
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });

  it('discards the redo branch when a new edit lands', () => {
    const log: string[] = [];
    const h = useHistoryStore.getState();
    h.push(counterCommand('a', log));
    h.push(counterCommand('b', log));
    h.undo();
    expect(useHistoryStore.getState().future).toHaveLength(1);

    h.push(counterCommand('c', log));
    expect(useHistoryStore.getState().future).toHaveLength(0);
    expect(useHistoryStore.getState().past.map((c) => c.label)).toEqual(['a', 'c']);
  });

  it('run() applies as well as records', () => {
    const log: string[] = [];
    useHistoryStore.getState().run(counterCommand('a', log));
    expect(log).toEqual(['+a']);
  });

  it('reports labels for the menu', () => {
    const log: string[] = [];
    useHistoryStore.getState().push(counterCommand('Pencil', log));
    expect(useHistoryStore.getState().undoLabel()).toBe('Pencil');
    expect(useHistoryStore.getState().redoLabel()).toBeNull();
    useHistoryStore.getState().undo();
    expect(useHistoryStore.getState().redoLabel()).toBe('Pencil');
  });
});

describe('one gesture is one undo step', () => {
  it('records a whole drag as a single entry', () => {
    const buf = freshCel('h3');
    const snapshot = beginStroke('h3', buf, W, H);
    // 200 pointer moves.
    for (let i = 0; i < 200; i++) setPixel(buf, W, H, i % W, (i / W) | 0, [0, 0, 255, 255]);
    useHistoryStore.getState().push(finishStroke(snapshot, buf, 'Pencil')!);

    expect(useHistoryStore.getState().past).toHaveLength(1);
    useHistoryStore.getState().undo();
    expect(buf.every((v) => v === 0)).toBe(true);
  });

  it('records nothing when the gesture changed no pixels', () => {
    const buf = freshCel('h4');
    setPixel(buf, W, H, 2, 2, [7, 7, 7, 255]);
    const snapshot = beginStroke('h4', buf, W, H);
    setPixel(buf, W, H, 2, 2, [7, 7, 7, 255]); // repaints the same value
    expect(finishStroke(snapshot, buf, 'Pencil')).toBeNull();
  });
});

describe('coalescing', () => {
  it('merges two pixel commands that share a coalesce key', () => {
    const buf = freshCel('h5');
    const h = useHistoryStore.getState();

    const s1 = beginStroke('h5', buf, W, H);
    setPixel(buf, W, H, 1, 1, [255, 0, 0, 255]);
    const d1 = finishStroke(s1, buf, 'Line')!;
    h.push(new PixelDeltaCommand('Line', d1.delta, W, 'gesture-1'));

    const s2 = beginStroke('h5', buf, W, H);
    setPixel(buf, W, H, 5, 5, [0, 255, 0, 255]);
    const d2 = finishStroke(s2, buf, 'Line')!;
    h.push(new PixelDeltaCommand('Line', d2.delta, W, 'gesture-1'));

    expect(useHistoryStore.getState().past).toHaveLength(1);
    useHistoryStore.getState().undo();
    expect(getBuffer('h5')!.every((v) => v === 0)).toBe(true);
  });

  it('keeps unkeyed pixel commands separate', () => {
    const buf = freshCel('h6');
    const h = useHistoryStore.getState();

    for (const [x, y] of [
      [1, 1],
      [2, 2],
    ]) {
      const s = beginStroke('h6', buf, W, H);
      setPixel(buf, W, H, x, y, [255, 255, 255, 255]);
      h.push(finishStroke(s, buf, 'Pencil')!);
    }
    expect(useHistoryStore.getState().past).toHaveLength(2);
  });

  it('does not merge across different keys', () => {
    const buf = freshCel('h7');
    const h = useHistoryStore.getState();

    const s1 = beginStroke('h7', buf, W, H);
    setPixel(buf, W, H, 1, 1, [255, 0, 0, 255]);
    h.push(new PixelDeltaCommand('Line', finishStroke(s1, buf, 'Line')!.delta, W, 'g1'));

    const s2 = beginStroke('h7', buf, W, H);
    setPixel(buf, W, H, 2, 2, [255, 0, 0, 255]);
    h.push(new PixelDeltaCommand('Line', finishStroke(s2, buf, 'Line')!.delta, W, 'g2'));

    expect(useHistoryStore.getState().past).toHaveLength(2);
  });
});

describe('restoreStroke', () => {
  it('puts the cel back so shape tools can re-preview from a clean slate', () => {
    const buf = freshCel('h8');
    setPixel(buf, W, H, 0, 0, [1, 1, 1, 255]);
    const snapshot = beginStroke('h8', buf, W, H);
    setPixel(buf, W, H, 4, 4, [2, 2, 2, 255]);
    restoreStroke(snapshot, buf);
    expect(getPixel(buf, W, H, 4, 4)).toEqual([0, 0, 0, 0]);
    expect(getPixel(buf, W, H, 0, 0)).toEqual([1, 1, 1, 255]);
  });
});

describe('budget', () => {
  it('evicts the oldest steps past the step cap', () => {
    const log: string[] = [];
    const h = useHistoryStore.getState();
    for (let i = 0; i < MAX_STEPS + 10; i++) h.push(counterCommand(`c${i}`, log));

    const past = useHistoryStore.getState().past;
    expect(past).toHaveLength(MAX_STEPS);
    expect(past[0].label).toBe('c10');
    expect(past[past.length - 1].label).toBe(`c${MAX_STEPS + 9}`);
  });

  it('tracks retained bytes', () => {
    const h = useHistoryStore.getState();
    h.push(counterCommand('a', [], 1000));
    h.push(counterCommand('b', [], 2000));
    expect(useHistoryStore.getState().memoryUsed).toBe(3000);
    useHistoryStore.getState().undo();
    // Still retained — it moved to the redo branch, it did not evaporate.
    expect(useHistoryStore.getState().memoryUsed).toBe(3000);
  });
});
