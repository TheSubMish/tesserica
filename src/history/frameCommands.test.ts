import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { celBufferId } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import {
  addFrame,
  deleteFrame,
  duplicateFrame,
  linkCel,
  moveFrame,
  setFrameDuration,
  unlinkCel,
} from './frameCommands';
import { addGroup } from './layerCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const frameIds = () => doc().sprite.frames.map((f) => f.id);
const celAt = (layerId: string, frameId: string) =>
  doc().sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId)!;

/** Reset to a single blank frame/layer between tests, same pattern as `layerCommands.test.ts`. */
beforeEach(() => {
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  history().clear();
});

describe('addFrame', () => {
  it('inserts a new frame with one blank cel per non-group layer', () => {
    const layerId = doc().activeLayerId;
    doc().addLayer('two');
    addGroup('an empty group'); // groups have no pixels — must get no cel

    addFrame();

    const s = doc();
    expect(s.sprite.frames).toHaveLength(2);
    const newFrameId = s.sprite.frames[1].id;
    // One cel for "Layer 1", one for "two" — none for the group.
    expect(s.sprite.cels.filter((c) => c.frameId === newFrameId)).toHaveLength(2);
    expect(celAt(layerId, newFrameId)).toBeDefined();
    expect(getBuffer(celAt(layerId, newFrameId).id)).toBeDefined();
  });

  it('inserts after a given frame rather than always at the end', () => {
    addFrame(); // -> [f1, f2]
    const f1 = frameIds()[0];
    addFrame(f1); // -> [f1, f3, f2]

    const ids = frameIds();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(f1);
  });

  it('selects the new frame', () => {
    addFrame();
    expect(doc().activeFrameId).toBe(doc().sprite.frames[1].id);
  });

  it('undoes and redoes, keeping any pixels drawn on the new frame', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const frameId = doc().sprite.frames[1].id;
    const cel = celAt(layerId, frameId);
    setPixel(getBuffer(cel.id)!, cel.width, cel.height, 1, 1, [9, 9, 9, 255]);

    history().undo();
    expect(doc().sprite.frames).toHaveLength(1);
    expect(getBuffer(cel.id)).toBeUndefined();

    history().redo();
    expect(doc().sprite.frames).toHaveLength(2);
    expect(getPixel(getBuffer(cel.id)!, cel.width, cel.height, 1, 1)).toEqual([9, 9, 9, 255]);
  });
});

describe('deleteFrame', () => {
  it('removes the frame and its cels, restoring pixels on undo', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const frameId = doc().sprite.frames[1].id;
    const cel = celAt(layerId, frameId);
    setPixel(getBuffer(cel.id)!, cel.width, cel.height, 3, 3, [1, 2, 3, 255]);
    history().clear(); // isolate the delete step

    deleteFrame(frameId);
    expect(doc().sprite.frames).toHaveLength(1);
    expect(getBuffer(cel.id)).toBeUndefined();

    history().undo();
    expect(doc().sprite.frames).toHaveLength(2);
    expect(getPixel(getBuffer(cel.id)!, cel.width, cel.height, 3, 3)).toEqual([1, 2, 3, 255]);
  });

  it('refuses to leave the document with zero frames', () => {
    deleteFrame(doc().sprite.frames[0].id);
    expect(doc().sprite.frames).toHaveLength(1);
    expect(history().past).toHaveLength(0);
  });

  it('does not release a buffer a surviving linked cel still needs', () => {
    addFrame();
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2, f3] = frameIds();
    const c1 = celAt(layerId, f1);
    setPixel(getBuffer(c1.id)!, c1.width, c1.height, 0, 0, [5, 6, 7, 255]);

    const c2 = celAt(layerId, f2);
    linkCel(c2.id, c1.id); // f2's cel now shares f1's buffer
    history().clear();

    // Deleting the *frame that owns the buffer* must not blank out f2, which
    // still links to it.
    deleteFrame(f1);

    const survivingC2 = doc().sprite.cels.find((c) => c.id === c2.id)!;
    const buf = getBuffer(celBufferId(survivingC2));
    expect(buf).toBeDefined();
    expect(getPixel(buf!, c2.width, c2.height, 0, 0)).toEqual([5, 6, 7, 255]);

    // f3 (untouched) is unaffected either way.
    expect(frameIds()).toEqual([f2, f3]);
  });
});

describe('duplicateFrame', () => {
  it('copies pixel content into an independent cel, not a link', () => {
    const layerId = doc().activeLayerId;
    const f1 = doc().sprite.frames[0].id;
    const c1 = celAt(layerId, f1);
    setPixel(getBuffer(c1.id)!, c1.width, c1.height, 2, 2, [10, 20, 30, 255]);

    duplicateFrame(f1);

    const f2 = doc().sprite.frames[1].id;
    const c2 = celAt(layerId, f2);
    expect(c2.linkedTo).toBeUndefined();
    expect(getPixel(getBuffer(c2.id)!, c2.width, c2.height, 2, 2)).toEqual([10, 20, 30, 255]);

    // Independent: painting the duplicate must not touch the original.
    setPixel(getBuffer(c2.id)!, c2.width, c2.height, 2, 2, [0, 0, 0, 0]);
    expect(getPixel(getBuffer(c1.id)!, c1.width, c1.height, 2, 2)).toEqual([10, 20, 30, 255]);
  });

  it('inserts immediately after the source frame and undoes cleanly', () => {
    addFrame(); // [f1, f2]
    const f1 = frameIds()[0];
    duplicateFrame(f1); // [f1, dup, f2]

    const ids = frameIds();
    expect(ids[0]).toBe(f1);
    expect(ids).toHaveLength(3);

    history().undo();
    expect(frameIds()).toEqual([f1, ids[2]]);
  });
});

describe('moveFrame', () => {
  it('reorders and reverses cleanly', () => {
    addFrame();
    addFrame();
    const [a] = frameIds();

    moveFrame(a, 1);
    expect(frameIds()[1]).toBe(a);

    history().undo();
    expect(frameIds()[0]).toBe(a);
  });

  it('does nothing at either end of the timeline', () => {
    addFrame();
    history().clear();
    moveFrame(frameIds()[0], -1);
    moveFrame(frameIds()[1], 1);
    expect(history().past).toHaveLength(0);
  });
});

describe('setFrameDuration', () => {
  it('changes durationMs and coalesces same-session edits into one undo step', () => {
    const id = doc().sprite.frames[0].id;
    setFrameDuration(id, 200, 1);
    setFrameDuration(id, 300, 1);
    expect(doc().sprite.frames[0].durationMs).toBe(300);
    expect(history().past).toHaveLength(1);

    history().undo();
    expect(doc().sprite.frames[0].durationMs).toBe(100);
  });

  it('keeps a new session as a separate undo step', () => {
    const id = doc().sprite.frames[0].id;
    setFrameDuration(id, 200, 1);
    setFrameDuration(id, 300, 2);
    expect(history().past).toHaveLength(2);
  });
});

describe('linkCel / unlinkCel', () => {
  it('shares one buffer across two frames of the same layer', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2] = frameIds();
    const c1 = celAt(layerId, f1);
    const c2 = celAt(layerId, f2);

    linkCel(c2.id, c1.id);

    setPixel(getBuffer(c1.id)!, c1.width, c1.height, 4, 4, [1, 1, 1, 255]);
    const linked = doc().sprite.cels.find((c) => c.id === c2.id)!;
    expect(linked.linkedTo).toBe(c1.id);
    expect(getPixel(getBuffer(celBufferId(linked))!, c2.width, c2.height, 4, 4)).toEqual([
      1, 1, 1, 255,
    ]);
    // The link's own former buffer id is gone — it has no pixels of its own.
    expect(getBuffer(c2.id)).toBeUndefined();
  });

  it('refuses to link cels on different layers', () => {
    addFrame();
    doc().addLayer('two');
    const otherLayerId = doc().activeLayerId;
    const layerId = doc().sprite.layers[0].id;
    const [f1, f2] = frameIds();
    const target = celAt(layerId, f1);
    const cel = celAt(otherLayerId, f2);

    linkCel(cel.id, target.id);
    expect(doc().sprite.cels.find((c) => c.id === cel.id)!.linkedTo).toBeUndefined();
  });

  it('refuses to link to a cel that is itself already a link', () => {
    addFrame();
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2, f3] = frameIds();
    linkCel(celAt(layerId, f2).id, celAt(layerId, f1).id);

    linkCel(celAt(layerId, f3).id, celAt(layerId, f2).id);
    expect(doc().sprite.cels.find((c) => c.frameId === f3)!.linkedTo).toBeUndefined();
  });

  it('undoes back to the independent cel it replaced, pixels intact', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2] = frameIds();
    const c1 = celAt(layerId, f1);
    const c2 = celAt(layerId, f2);
    setPixel(getBuffer(c2.id)!, c2.width, c2.height, 6, 6, [8, 8, 8, 255]);

    linkCel(c2.id, c1.id);
    history().undo();

    const restored = doc().sprite.cels.find((c) => c.id === c2.id)!;
    expect(restored.linkedTo).toBeUndefined();
    expect(getPixel(getBuffer(c2.id)!, c2.width, c2.height, 6, 6)).toEqual([8, 8, 8, 255]);
  });

  it('unlink makes an independent copy that no longer tracks the shared buffer', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2] = frameIds();
    const c1 = celAt(layerId, f1);
    const c2 = celAt(layerId, f2);
    linkCel(c2.id, c1.id);
    setPixel(getBuffer(c1.id)!, c1.width, c1.height, 7, 7, [3, 3, 3, 255]);

    unlinkCel(c2.id);
    const unlinked = doc().sprite.cels.find((c) => c.id === c2.id)!;
    expect(unlinked.linkedTo).toBeUndefined();
    // Carried the shared content at the moment of unlinking...
    expect(getPixel(getBuffer(c2.id)!, c2.width, c2.height, 7, 7)).toEqual([3, 3, 3, 255]);

    // ...but is independent from then on.
    setPixel(getBuffer(c1.id)!, c1.width, c1.height, 7, 7, [0, 0, 0, 0]);
    expect(getPixel(getBuffer(c2.id)!, c2.width, c2.height, 7, 7)).toEqual([3, 3, 3, 255]);
  });

  it('unlink undoes back to a link, redo restores the independent copy', () => {
    addFrame();
    const layerId = doc().activeLayerId;
    const [f1, f2] = frameIds();
    const c1 = celAt(layerId, f1);
    const c2 = celAt(layerId, f2);
    linkCel(c2.id, c1.id);
    history().clear();

    unlinkCel(c2.id);
    expect(doc().sprite.cels.find((c) => c.id === c2.id)!.linkedTo).toBeUndefined();

    history().undo();
    expect(doc().sprite.cels.find((c) => c.id === c2.id)!.linkedTo).toBe(c1.id);

    history().redo();
    expect(doc().sprite.cels.find((c) => c.id === c2.id)!.linkedTo).toBeUndefined();
  });
});
