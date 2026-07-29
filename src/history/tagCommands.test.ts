import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { addFrame, deleteFrame } from './frameCommands';
import { addTag, deleteTag, renameTag, setTagDirection, setTagRange } from './tagCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const tags = () => doc().sprite.tags;

/** Reset to a single blank frame/layer between tests, same pattern as `frameCommands.test.ts`. */
beforeEach(() => {
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  history().clear();
});

function fourFrames(): void {
  addFrame();
  addFrame();
  addFrame(); // -> 4 frames total
  history().clear();
}

describe('addTag', () => {
  it('creates a tag over the given frame range with a forward default direction', () => {
    fourFrames();
    addTag('walk', 1, 2);

    expect(tags()).toHaveLength(1);
    expect(tags()[0]).toMatchObject({ name: 'walk', from: 1, to: 2, direction: 'forward' });
    expect(tags()[0].id).toBeTruthy();
    expect(tags()[0].color).toBeTruthy();
  });

  it('normalizes a reversed from/to pair', () => {
    fourFrames();
    addTag('run', 3, 1);
    expect(tags()[0]).toMatchObject({ from: 1, to: 3 });
  });

  it('clamps a range outside the current frame count', () => {
    fourFrames();
    addTag('attack', 2, 99);
    expect(tags()[0]).toMatchObject({ from: 2, to: 3 });
  });

  it('accepts a custom name exactly as well as a preset one', () => {
    fourFrames();
    addTag('my custom name', 0, 1);
    expect(tags()[0].name).toBe('my custom name');
  });

  it('refuses a blank name', () => {
    fourFrames();
    addTag('   ', 0, 1);
    expect(tags()).toHaveLength(0);
    expect(history().past).toHaveLength(0);
  });

  it('assigns distinct colors to successive tags', () => {
    fourFrames();
    addTag('idle', 0, 0);
    addTag('walk', 1, 2);
    expect(tags()[0].color).not.toBe(tags()[1].color);
  });

  it('undoes and redoes', () => {
    fourFrames();
    addTag('walk', 1, 2);
    history().undo();
    expect(tags()).toHaveLength(0);
    history().redo();
    expect(tags()).toHaveLength(1);
  });
});

describe('deleteTag', () => {
  it('removes the tag and restores it on undo', () => {
    fourFrames();
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    history().clear();

    deleteTag(id);
    expect(tags()).toHaveLength(0);

    history().undo();
    expect(tags()).toHaveLength(1);
    expect(tags()[0]).toMatchObject({ id, name: 'walk', from: 1, to: 2 });
  });

  it('does nothing for an unknown id', () => {
    deleteTag('nope');
    expect(history().past).toHaveLength(0);
  });
});

describe('renameTag', () => {
  it('renames and undoes', () => {
    fourFrames();
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    history().clear();

    renameTag(id, 'run');
    expect(tags()[0].name).toBe('run');

    history().undo();
    expect(tags()[0].name).toBe('walk');
  });

  it('is a no-op for an unchanged or blank name', () => {
    fourFrames();
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    history().clear();

    renameTag(id, 'walk');
    renameTag(id, '   ');
    expect(history().past).toHaveLength(0);
  });
});

describe('setTagRange', () => {
  it('updates the range and coalesces same-session edits into one undo step', () => {
    fourFrames();
    addTag('walk', 0, 1);
    const id = tags()[0].id;
    history().clear();

    setTagRange(id, 1, 2, 1);
    setTagRange(id, 1, 3, 1);
    expect(tags()[0]).toMatchObject({ from: 1, to: 3 });
    expect(history().past).toHaveLength(1);

    history().undo();
    expect(tags()[0]).toMatchObject({ from: 0, to: 1 });
  });

  it('keeps a new session as a separate undo step', () => {
    fourFrames();
    addTag('walk', 0, 1);
    const id = tags()[0].id;
    history().clear();

    setTagRange(id, 1, 2, 1);
    setTagRange(id, 1, 3, 2);
    expect(history().past).toHaveLength(2);
  });
});

describe('setTagDirection', () => {
  it('changes direction and undoes', () => {
    fourFrames();
    addTag('walk', 0, 1);
    const id = tags()[0].id;
    history().clear();

    setTagDirection(id, 'pingpong');
    expect(tags()[0].direction).toBe('pingpong');

    history().undo();
    expect(tags()[0].direction).toBe('forward');
  });
});

// Tags reference frame *indices*, so frame lifecycle commands elsewhere in
// the app must keep them meaningful — the actual wiring lives in
// `documentStore.ts::insertFrame`/`removeFrameMetadata`, exercised here
// through the real `addFrame`/`deleteFrame` actions rather than the
// lower-level shift functions directly (those have their own unit tests in
// `model/tags.test.ts`).
describe('tag ranges survive frame lifecycle operations', () => {
  it('shifts a tag forward when a frame is inserted before it', () => {
    fourFrames(); // [f0,f1,f2,f3]
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    const f0 = doc().sprite.frames[0].id;

    addFrame(f0); // inserts right after f0, i.e. at index 1 — before the tag
    expect(tags().find((t) => t.id === id)).toMatchObject({ from: 2, to: 3 });
  });

  it('shrinks a tag when one of its own frames is deleted', () => {
    fourFrames();
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    const f2 = doc().sprite.frames[2].id; // inside the tag's range

    deleteFrame(f2);
    expect(tags().find((t) => t.id === id)).toMatchObject({ from: 1, to: 1 });
  });

  it('undoing the frame delete restores the tag’s original range', () => {
    fourFrames();
    addTag('walk', 1, 2);
    const id = tags()[0].id;
    const f2 = doc().sprite.frames[2].id;
    history().clear();

    deleteFrame(f2);
    history().undo();
    expect(tags().find((t) => t.id === id)).toMatchObject({ from: 1, to: 2 });
  });
});
