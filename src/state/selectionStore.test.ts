import { describe, expect, it } from 'vitest';
import { useSelectionStore } from './selectionStore';

describe('selectionStore', () => {
  it('starts with nothing selected', () => {
    expect(useSelectionStore.getState().selection).toBeNull();
  });

  it('sets and clears the selection', () => {
    const selection = { bounds: { x: 1, y: 2, width: 3, height: 4 } };
    useSelectionStore.getState().setSelection(selection);
    expect(useSelectionStore.getState().selection).toEqual(selection);

    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().selection).toBeNull();
  });
});
