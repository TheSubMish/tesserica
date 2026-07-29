import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTag } from '../history/tagCommands';
import { getBuffer, setPixel } from '../model/pixelBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useUIStore } from '../state/uiStore';
import { TimelinePanel } from './TimelinePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = () => useDocumentStore.getState();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useHistoryStore.getState().clear();
  doc().newDocument(4, 4);
  useHistoryStore.getState().clear();
  useUIStore.setState({ onionSkinEnabled: false, onionSkinBefore: 1, onionSkinAfter: 1 });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<TimelinePanel />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const frameHeads = () => container.querySelectorAll('.timeline-frame-head');
const rowLabels = () => container.querySelectorAll('.timeline-row-label');
const cells = () => container.querySelectorAll('.timeline-cell');
const button = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

/**
 * A controlled input's own DOM node gets React's value-tracking wrapper
 * installed on its `value` property, so a plain `input.value = x` silently
 * fails to register a real change — React sees the tracker's stored value
 * already matching. Setting through the *prototype's* native setter, the way
 * `@testing-library/user-event` does, is what actually flips the tracker.
 */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
}

/** Same tracker-bypass trick as `setNativeInputValue`, for `<select>`. */
function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
}

describe('grid construction', () => {
  it('renders one column per frame and one row per layer', () => {
    expect(frameHeads()).toHaveLength(1);
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0].textContent).toBe('Layer 1');
  });

  it('shows a filled dot for a layer’s own cel on a frame', () => {
    const dot = container.querySelector('.timeline-dot');
    expect(dot).not.toBeNull();
    expect(container.querySelector('.timeline-link-btn-linked')).toBeNull();
  });

  it('gains a column when a frame is added', () => {
    act(() => button('Add frame').click());
    expect(frameHeads()).toHaveLength(2);
    expect(cells()).toHaveLength(2); // one cel-cell per frame, one layer
  });

  it('shows a chain icon instead of a dot for a linked cel', () => {
    act(() => button('Add frame').click());

    const layerId = doc().activeLayerId;
    const [f1, f2] = doc().sprite.frames.map((f) => f.id);
    const c2 = doc().sprite.cels.find((c) => c.layerId === layerId && c.frameId === f2)!;

    // Select frame 1 (the canonical target) then link frame 2's cel to it.
    act(() => doc().setActiveFrame(f1));
    act(() => root.render(<TimelinePanel />));
    const linkBtn = container.querySelector(
      `button[aria-label="Link Layer 1 to the active frame"]`,
    ) as HTMLButtonElement | null;
    expect(linkBtn).not.toBeNull();
    act(() => linkBtn!.click());

    expect(doc().sprite.cels.find((c) => c.id === c2.id)!.linkedTo).toBe(
      doc().sprite.cels.find((c) => c.layerId === layerId && c.frameId === f1)!.id,
    );
    expect(container.querySelector('.timeline-link-btn-linked')).not.toBeNull();
  });
});

describe('duration editing', () => {
  it('updates the frame’s durationMs through setFrameDuration, undoably', () => {
    const input = container.querySelector('.timeline-duration') as HTMLInputElement;
    const frameId = doc().sprite.frames[0].id;

    act(() => {
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    });
    act(() => {
      setNativeInputValue(input, '250');
      // React's `onChange` is wired to the native `input` event, not `change`.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(doc().sprite.frames.find((f) => f.id === frameId)!.durationMs).toBe(250);
    expect(useHistoryStore.getState().past).toHaveLength(1);

    act(() => useHistoryStore.getState().undo());
    expect(doc().sprite.frames.find((f) => f.id === frameId)!.durationMs).toBe(100);
  });
});

describe('frame lifecycle controls', () => {
  it('add/duplicate/delete are wired to the frame commands and are undoable', () => {
    act(() => button('Add frame').click());
    expect(doc().sprite.frames).toHaveLength(2);

    act(() => useHistoryStore.getState().undo());
    expect(doc().sprite.frames).toHaveLength(1);
    act(() => useHistoryStore.getState().redo());
    expect(doc().sprite.frames).toHaveLength(2);

    act(() => button('Duplicate frame').click());
    expect(doc().sprite.frames).toHaveLength(3);

    act(() => root.render(<TimelinePanel />));
    act(() => button('Delete frame').click());
    expect(doc().sprite.frames).toHaveLength(2);
  });
});

describe('playback', () => {
  beforeEach(() => vi.useFakeTimers());

  it('play advances the active frame at each frame’s own duration and loops', () => {
    act(() => button('Add frame').click());
    act(() => root.render(<TimelinePanel />));
    const f1 = doc().sprite.frames[0].id;

    act(() => doc().setActiveFrame(f1));
    act(() => root.render(<TimelinePanel />));

    act(() => button('Play').click());
    expect(doc().activeFrameId).toBe(f1);

    act(() => vi.advanceTimersByTime(100));
    expect(doc().activeFrameId).not.toBe(f1);

    act(() => vi.advanceTimersByTime(100));
    expect(doc().activeFrameId).toBe(f1); // looped back
  });

  it('stop halts playback and returns to the first frame', () => {
    act(() => button('Add frame').click());
    const f1 = doc().sprite.frames[0].id;
    act(() => doc().setActiveFrame(f1)); // `addFrame` leaves the new frame active
    act(() => root.render(<TimelinePanel />));

    act(() => button('Play').click());
    act(() => vi.advanceTimersByTime(100));
    expect(doc().activeFrameId).not.toBe(f1);

    act(() => button('Stop').click());
    expect(doc().activeFrameId).toBe(doc().sprite.frames[0].id);

    const before = doc().activeFrameId;
    act(() => vi.advanceTimersByTime(10_000));
    expect(doc().activeFrameId).toBe(before); // no longer ticking
  });
});

// Sanity that pixel edits on a cel resolved through the grid actually reach
// the same buffer the renderer/tools use — the grid must not be showing a
// detached copy of the document.
describe('editing through the grid selects the real cel', () => {
  it('clicking a cell selects that layer+frame as active, ready for drawing', () => {
    act(() => button('Add frame').click());
    act(() => root.render(<TimelinePanel />));
    const f2 = doc().sprite.frames[1].id;

    const cellButtons = container.querySelectorAll('.timeline-cell');
    // Second cell corresponds to frame 2 for the only layer.
    act(() => (cellButtons[1] as HTMLElement).click());

    expect(doc().activeFrameId).toBe(f2);
    const cel = doc().activeCel();
    expect(cel).toBeDefined();
    expect(getBuffer(cel!.id)).toBeDefined();
    setPixel(getBuffer(cel!.id)!, cel!.width, cel!.height, 0, 0, [1, 2, 3, 255]);
  });
});

describe('onion skinning', () => {
  const onionToggle = () => button('Toggle onion skinning');
  const beforeInput = () =>
    container.querySelector('input[aria-label="Frames before to ghost"]') as HTMLInputElement;
  const afterInput = () =>
    container.querySelector('input[aria-label="Frames after to ghost"]') as HTMLInputElement;

  it('is off by default and disabled with only one frame', () => {
    expect(onionToggle().getAttribute('aria-pressed')).toBe('false');
    expect(onionToggle().disabled).toBe(true);
  });

  it('toggles the shared view-state store, which is what CanvasView reads', () => {
    act(() => button('Add frame').click());
    act(() => root.render(<TimelinePanel />));

    expect(onionToggle().disabled).toBe(false);
    act(() => onionToggle().click());

    expect(useUIStore.getState().onionSkinEnabled).toBe(true);
    act(() => root.render(<TimelinePanel />));
    expect(onionToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('range inputs start disabled until onion skinning is enabled', () => {
    expect(beforeInput().disabled).toBe(true);
    expect(afterInput().disabled).toBe(true);

    act(() => useUIStore.getState().toggleOnionSkin());
    act(() => root.render(<TimelinePanel />));

    expect(beforeInput().disabled).toBe(false);
    expect(afterInput().disabled).toBe(false);
  });

  it('editing the before/after fields updates the store independently', () => {
    act(() => useUIStore.getState().toggleOnionSkin());
    act(() => root.render(<TimelinePanel />));

    act(() => {
      setNativeInputValue(beforeInput(), '3');
      beforeInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useUIStore.getState().onionSkinBefore).toBe(3);
    expect(useUIStore.getState().onionSkinAfter).toBe(1);

    act(() => root.render(<TimelinePanel />));
    act(() => {
      setNativeInputValue(afterInput(), '0');
      afterInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useUIStore.getState().onionSkinAfter).toBe(0);
    expect(useUIStore.getState().onionSkinBefore).toBe(3); // untouched by the other field
  });
});

describe('tags', () => {
  const tagSpans = () =>
    container.querySelectorAll('.timeline-tag-cell:not(.timeline-tag-cell-empty)');
  const formButton = (text: string) =>
    [...container.querySelectorAll('.timeline-tag-form button')].find(
      (b) => b.textContent === text,
    ) as HTMLButtonElement;

  /** 4 frames total, ready for a multi-frame tag range. */
  function fourFrames(): void {
    act(() => button('Add frame').click());
    act(() => button('Add frame').click());
    act(() => button('Add frame').click());
    act(() => root.render(<TimelinePanel />));
  }

  it('opens a creation form offering the six preset names plus custom', () => {
    fourFrames();
    act(() => button('Add tag').click());

    const select = container.querySelector(
      'select[aria-label="Tag preset name"]',
    ) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    expect(options).toEqual(['idle', 'walk', 'run', 'attack', 'hurt', 'death', 'custom']);
  });

  it('creates a tag with the selected preset over the chosen frame range', () => {
    fourFrames();
    act(() => button('Add tag').click());
    act(() => root.render(<TimelinePanel />));

    const fromInput = container.querySelector(
      'input[aria-label="Tag start frame"]',
    ) as HTMLInputElement;
    const toInput = container.querySelector(
      'input[aria-label="Tag end frame"]',
    ) as HTMLInputElement;
    act(() => {
      setNativeInputValue(fromInput, '2');
      fromInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      setNativeInputValue(toInput, '3');
      toInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => root.render(<TimelinePanel />));
    act(() => formButton('Create').click());

    expect(doc().sprite.tags).toHaveLength(1);
    expect(doc().sprite.tags[0]).toMatchObject({ name: 'idle', from: 1, to: 2 });
  });

  it('reveals a custom-name field only when "custom" is selected, and uses it', () => {
    fourFrames();
    act(() => button('Add tag').click());
    act(() => root.render(<TimelinePanel />));
    expect(container.querySelector('input[aria-label="Custom tag name"]')).toBeNull();

    const select = container.querySelector(
      'select[aria-label="Tag preset name"]',
    ) as HTMLSelectElement;
    act(() => {
      setNativeSelectValue(select, 'custom');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => root.render(<TimelinePanel />));

    const customInput = container.querySelector(
      'input[aria-label="Custom tag name"]',
    ) as HTMLInputElement;
    expect(customInput).not.toBeNull();
    act(() => {
      setNativeInputValue(customInput, 'boss intro');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => root.render(<TimelinePanel />));
    act(() => formButton('Create').click());

    expect(doc().sprite.tags[0].name).toBe('boss intro');
  });

  it('shows the tag as a colored span over its frame range in the grid', () => {
    fourFrames();
    act(() => addTag('walk', 1, 2));
    act(() => root.render(<TimelinePanel />));

    expect(tagSpans()).toHaveLength(2); // frames 2 and 3 (0-indexed 1..2)
    expect(container.querySelector('.timeline-tag-name')?.textContent).toBe('walk');
  });

  it('selecting a tag opens its editor with rename/range/direction/delete', () => {
    fourFrames();
    act(() => addTag('walk', 1, 2));
    act(() => root.render(<TimelinePanel />));

    act(() => (tagSpans()[0] as HTMLElement).click());
    act(() => root.render(<TimelinePanel />));

    expect(container.querySelector('input[aria-label="Tag name"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Tag playback direction"]')).not.toBeNull();
  });

  it('renames a tag through the editor', () => {
    fourFrames();
    act(() => addTag('walk', 1, 2));
    act(() => root.render(<TimelinePanel />));
    act(() => (tagSpans()[0] as HTMLElement).click());
    act(() => root.render(<TimelinePanel />));

    const nameInput = container.querySelector('input[aria-label="Tag name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(nameInput, 'run');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(doc().sprite.tags[0].name).toBe('run');
  });

  it('deletes a tag through the editor and closes it', () => {
    fourFrames();
    act(() => addTag('walk', 1, 2));
    act(() => root.render(<TimelinePanel />));
    act(() => (tagSpans()[0] as HTMLElement).click());
    act(() => root.render(<TimelinePanel />));

    act(() => button('Delete tag walk').click());
    act(() => root.render(<TimelinePanel />));

    expect(doc().sprite.tags).toHaveLength(0);
    expect(container.querySelector('input[aria-label="Tag name"]')).toBeNull();
  });

  it('plays back scoped to just the tag’s own frame range', () => {
    vi.useFakeTimers();
    fourFrames(); // frames 1..4, each defaulting to 100ms
    act(() => addTag('walk', 1, 2)); // frames 2 and 3 (0-indexed 1,2)
    act(() => root.render(<TimelinePanel />));
    act(() => (tagSpans()[0] as HTMLElement).click());
    act(() => root.render(<TimelinePanel />));

    const [, f2, f3] = doc().sprite.frames;

    act(() => button('Play walk').click());
    // Playback jumps to the tag's first frame immediately.
    expect(doc().activeFrameId).toBe(f2.id);

    act(() => vi.advanceTimersByTime(100));
    expect(doc().activeFrameId).toBe(f3.id);

    act(() => vi.advanceTimersByTime(100));
    expect(doc().activeFrameId).toBe(f2.id); // looped back within the tag's own range only

    act(() => button('Pause walk').click());
  });
});
