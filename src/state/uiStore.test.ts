import { beforeEach, describe, expect, it } from 'vitest';
import { docToScreen, screenToDoc } from '../canvas/coords';
import { MAX_ONION_SKIN_RANGE, MAX_ZOOM, MIN_ZOOM, useUIStore } from './uiStore';

beforeEach(() => {
  useUIStore.setState({ zoom: 8, panX: 0, panY: 0, showGrid: true, cursor: null });
});

describe('setZoom', () => {
  it('clamps to the supported range', () => {
    useUIStore.getState().setZoom(1000);
    expect(useUIStore.getState().zoom).toBe(MAX_ZOOM);
    useUIStore.getState().setZoom(0.01);
    expect(useUIStore.getState().zoom).toBe(MIN_ZOOM);
  });
});

describe('zoomAt', () => {
  it('keeps the document point under the cursor fixed', () => {
    // This is the whole contract of zoom-to-cursor: whatever pixel you are
    // pointing at must not slide out from under the pointer.
    useUIStore.setState({ zoom: 4, panX: 130, panY: 70 });
    const [sx, sy] = [400, 300];

    const before = screenToDoc(useUIStore.getState(), sx, sy);
    useUIStore.getState().zoomAt(2, sx, sy);
    const after = useUIStore.getState();

    // Compare in continuous space — the doc cell is a floor of it, so an exact
    // integer match can hide a half-pixel drift that accumulates over scrolls.
    const exactBefore = (sx - 130) / 4;
    const exactAfter = (sx - after.panX) / after.zoom;
    expect(exactAfter).toBeCloseTo(exactBefore, 10);
    expect(screenToDoc(after, sx, sy)).toEqual(before);
  });

  it('holds the anchor across a zoom-in / zoom-out round trip', () => {
    useUIStore.setState({ zoom: 8, panX: 33, panY: -17 });
    const [sx, sy] = [512, 384];

    useUIStore.getState().zoomAt(1.25, sx, sy);
    useUIStore.getState().zoomAt(1 / 1.25, sx, sy);

    const s = useUIStore.getState();
    expect(s.zoom).toBeCloseTo(8, 10);
    expect(s.panX).toBeCloseTo(33, 10);
    expect(s.panY).toBeCloseTo(-17, 10);
  });

  it('does not move the pan when already clamped at max zoom', () => {
    // Clamping the zoom without clamping the pan would drift the canvas
    // sideways on every further scroll at the limit.
    useUIStore.setState({ zoom: MAX_ZOOM, panX: 50, panY: 60 });
    useUIStore.getState().zoomAt(2, 400, 300);
    const s = useUIStore.getState();
    expect(s.zoom).toBe(MAX_ZOOM);
    expect(s.panX).toBe(50);
    expect(s.panY).toBe(60);
  });
});

describe('requestFit', () => {
  it('bumps a counter CanvasView watches to re-center the sprite', () => {
    // The store holds no geometry itself — `fitZoom`/`centerPan` live in
    // `canvas/coords.ts` and CanvasView applies them when this changes
    // (`Home`, the "center view" status-bar button, `Ctrl+N`).
    const before = useUIStore.getState().fitRequest;
    useUIStore.getState().requestFit();
    expect(useUIStore.getState().fitRequest).toBe(before + 1);
  });
});

describe('pan', () => {
  it('accumulates deltas', () => {
    useUIStore.getState().panBy(10, -5);
    useUIStore.getState().panBy(3, 2);
    expect(useUIStore.getState().panX).toBe(13);
    expect(useUIStore.getState().panY).toBe(-3);
  });

  it('round-trips a document point through docToScreen after panning', () => {
    useUIStore.getState().panBy(17, 23);
    const s = useUIStore.getState();
    const screen = docToScreen(s, 12, 9);
    expect(screenToDoc(s, screen.x, screen.y)).toEqual({ x: 12, y: 9 });
  });
});

describe('onion skin', () => {
  beforeEach(() => {
    useUIStore.setState({ onionSkinEnabled: false, onionSkinBefore: 1, onionSkinAfter: 1 });
  });

  it('is off by default so a single-frame sprite never shows a ghost of itself', () => {
    // Fresh module state, not the beforeEach override above.
    expect(useUIStore.getInitialState().onionSkinEnabled).toBe(false);
  });

  it('toggles independently of any other view state', () => {
    useUIStore.getState().toggleOnionSkin();
    expect(useUIStore.getState().onionSkinEnabled).toBe(true);
    useUIStore.getState().toggleOnionSkin();
    expect(useUIStore.getState().onionSkinEnabled).toBe(false);
  });

  it('sets before/after ranges independently', () => {
    useUIStore.getState().setOnionSkinBefore(3);
    useUIStore.getState().setOnionSkinAfter(0);
    expect(useUIStore.getState().onionSkinBefore).toBe(3);
    expect(useUIStore.getState().onionSkinAfter).toBe(0);
  });

  it('clamps range to [0, MAX_ONION_SKIN_RANGE]', () => {
    useUIStore.getState().setOnionSkinBefore(-5);
    expect(useUIStore.getState().onionSkinBefore).toBe(0);
    useUIStore.getState().setOnionSkinAfter(999);
    expect(useUIStore.getState().onionSkinAfter).toBe(MAX_ONION_SKIN_RANGE);
  });

  it('rounds a fractional range to the nearest integer', () => {
    useUIStore.getState().setOnionSkinBefore(2.6);
    expect(useUIStore.getState().onionSkinBefore).toBe(3);
  });
});
