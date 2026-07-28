import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuffer, getPixel } from '../model/pixelBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useToolStore } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';
import { App } from './App';

/**
 * The Phase 0 exit criterion, end to end: mount the real app, press and drag on
 * the real canvas element, and check that pixels landed in the active layer's
 * buffer — and that zooming does not move the pixel under the cursor.
 *
 * jsdom has no 2D context, no ImageData, no ResizeObserver and no pointer
 * capture, so those four are stubbed. Everything above them is the shipping
 * code path: React tree → pointer handler → screenToDoc → tool → cel buffer.
 */

const g = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  ImageData?: unknown;
  ResizeObserver?: unknown;
};

g.IS_REACT_ACT_ENVIRONMENT = true;

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
g.ImageData ??= FakeImageData;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver ??= FakeResizeObserver;

// jsdom implements no pointer capture at all, so these are defined rather than
// spied on.
const el = Element.prototype as unknown as Record<string, () => void>;
el.setPointerCapture ??= () => {};
el.releasePointerCapture ??= () => {};

const noopContext = () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'canvas') return undefined;
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(noopContext);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App />);
  });

  // jsdom reports a zero-sized viewport, so the mount-time fit-to-window lands
  // on a degenerate pan. Pin the viewport instead: 8x zoom, no pan.
  act(() => {
    useUIStore.setState({ zoom: 8, panX: 0, panY: 0 });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const canvas = () => container.querySelector('canvas')!;

function pointer(type: string, clientX: number, clientY: number, init: MouseEventInit = {}) {
  act(() => {
    canvas().dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, ...init }),
    );
  });
}

function activeBuffer() {
  const cel = useDocumentStore.getState().activeCel()!;
  return { buf: getBuffer(cel.id)!, w: cel.width, h: cel.height };
}

describe('drawing on the canvas', () => {
  it('renders two mode tabs — two, not three (D6, D7) — with Edit selected', () => {
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toBe('Convert');
    // Convert became live in Phase 2; it was inert through Phase 1.
    expect((tabs[0] as HTMLButtonElement).disabled).toBe(false);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });

  it('puts a pixel in the active layer where the pointer went down', () => {
    useToolStore.setState({ primary: [255, 0, 0, 255], brushSize: 1, activeTool: 'pencil' });

    // Screen (20, 36) at zoom 8 with no pan is document cell (2, 4).
    pointer('pointerdown', 20, 36, { button: 0, buttons: 1 });

    const { buf, w, h } = activeBuffer();
    expect(getPixel(buf, w, h, 2, 4)).toEqual([255, 0, 0, 255]);
  });

  it('draws a connected stroke across a drag', () => {
    useToolStore.setState({ primary: [0, 255, 0, 255], brushSize: 1, activeTool: 'pencil' });

    pointer('pointerdown', 4, 4, { button: 0, buttons: 1 });
    pointer('pointermove', 44, 4, { buttons: 1 });
    pointer('pointerup', 44, 4, {});

    const { buf, w, h } = activeBuffer();
    for (let x = 0; x <= 5; x++) {
      expect(getPixel(buf, w, h, x, 0)).toEqual([0, 255, 0, 255]);
    }
  });

  it('bumps the document revision so the canvas redraws', () => {
    const before = useDocumentStore.getState().revision;
    pointer('pointerdown', 12, 12, { button: 0, buttons: 1 });
    expect(useDocumentStore.getState().revision).toBeGreaterThan(before);
  });

  it('does not draw while space-panning', () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    });
    const before = useDocumentStore.getState().revision;
    pointer('pointerdown', 20, 20, { button: 0, buttons: 1 });
    pointer('pointermove', 60, 60, { buttons: 1 });

    expect(useDocumentStore.getState().revision).toBe(before);
    // ...it pans instead.
    expect(useUIStore.getState().panX).toBe(40);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    });
  });

  it('does not draw on a locked or hidden layer', () => {
    const id = useDocumentStore.getState().activeLayerId;
    act(() => useDocumentStore.getState().toggleLayerVisibility(id));

    const before = useDocumentStore.getState().revision;
    pointer('pointerdown', 20, 20, { button: 0, buttons: 1 });
    expect(useDocumentStore.getState().revision).toBe(before);

    act(() => useDocumentStore.getState().toggleLayerVisibility(id));
  });
});

describe('zooming', () => {
  it('zooms in on Ctrl+wheel and keeps the pixel under the cursor', () => {
    const before = useUIStore.getState().zoom;

    act(() => {
      canvas().dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -100,
          ctrlKey: true,
          clientX: 100,
          clientY: 100,
        }),
      );
    });

    const after = useUIStore.getState();
    expect(after.zoom).toBeGreaterThan(before);
    // The document point under (100, 100) must not have moved.
    expect((100 - after.panX) / after.zoom).toBeCloseTo((100 - 0) / before, 10);
  });

  it('scrolls rather than zooms on a plain wheel (docs/05-ui-design.md §7.2)', () => {
    const before = useUIStore.getState();

    act(() => {
      canvas().dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }),
      );
    });

    const after = useUIStore.getState();
    expect(after.zoom).toBe(before.zoom);
    expect(after.panY).toBeGreaterThan(before.panY);
  });

  it('Home re-centers the view on the picture after panning away', () => {
    act(() => {
      useUIStore.getState().panBy(400, -250);
    });
    expect(useUIStore.getState().panX).not.toBe(0);

    const before = useUIStore.getState().fitRequest;
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });

    expect(useUIStore.getState().fitRequest).toBeGreaterThan(before);
  });
});
