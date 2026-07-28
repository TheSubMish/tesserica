import { describe, expect, it } from 'vitest';
import { useSelectionStore } from './selectionStore';

describe('selectionStore', () => {
  it('starts with nothing selected', () => {
    expect(useSelectionStore.getState().rect).toBeNull();
  });

  it('sets and clears the rect', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    useSelectionStore.getState().setRect(rect);
    expect(useSelectionStore.getState().rect).toEqual(rect);

    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().rect).toBeNull();
  });
});
