import { describe, expect, it } from 'vitest';
import {
  centerPan,
  docToScreen,
  fitZoom,
  panFromScrollOffset,
  screenToDoc,
  scrollBarGeometry,
} from './coords';

const vp = (zoom: number, panX = 0, panY = 0) => ({ zoom, panX, panY });

describe('screenToDoc', () => {
  it('maps a cell to itself at zoom 1 with no pan', () => {
    expect(screenToDoc(vp(1), 7, 3)).toEqual({ x: 7, y: 3 });
  });

  it('returns the containing cell, not the nearest one', () => {
    // Anywhere inside the 8px cell at doc (2,2) must resolve to (2,2).
    expect(screenToDoc(vp(8), 16, 16)).toEqual({ x: 2, y: 2 });
    expect(screenToDoc(vp(8), 23, 23)).toEqual({ x: 2, y: 2 });
    expect(screenToDoc(vp(8), 24, 24)).toEqual({ x: 3, y: 3 });
  });

  it('floors toward negative infinity so off-canvas reads as out of bounds', () => {
    // Truncation instead of flooring would map -1px to doc 0 and paint a pixel
    // one row inside the canvas when the pointer is outside it.
    expect(screenToDoc(vp(8), -1, -1)).toEqual({ x: -1, y: -1 });
    expect(screenToDoc(vp(8), -8, -8)).toEqual({ x: -1, y: -1 });
    expect(screenToDoc(vp(8), -9, -9)).toEqual({ x: -2, y: -2 });
  });

  it('accounts for pan', () => {
    expect(screenToDoc(vp(4, 100, 50), 108, 58)).toEqual({ x: 2, y: 2 });
  });
});

describe('docToScreen', () => {
  it('round-trips with screenToDoc for the cell origin', () => {
    const v = vp(8, 37, -14);
    for (const [x, y] of [
      [0, 0],
      [3, 9],
      [63, 63],
    ]) {
      const s = docToScreen(v, x, y);
      expect(screenToDoc(v, s.x, s.y)).toEqual({ x, y });
    }
  });
});

describe('centerPan', () => {
  it('centers the sprite in the viewport', () => {
    // 64 * 8 = 512 wide in a 1024 viewport → 256px of margin each side.
    expect(centerPan(8, 64, 64, 1024, 768)).toEqual({ panX: 256, panY: 128 });
  });

  it('returns integer pan so the sprite lands on whole screen pixels', () => {
    const { panX, panY } = centerPan(8, 64, 64, 1025, 769);
    expect(Number.isInteger(panX)).toBe(true);
    expect(Number.isInteger(panY)).toBe(true);
  });
});

describe('fitZoom', () => {
  it('returns an integer zoom — non-integer scaling gives uneven pixel sizes', () => {
    // (800-48)/64 = 11.75 → must floor to 11, not round to 12.
    expect(fitZoom(64, 64, 800, 800)).toBe(11);
  });

  it('is constrained by the tighter axis', () => {
    expect(fitZoom(64, 32, 800, 400)).toBe(11);
    expect(fitZoom(32, 64, 800, 400)).toBe(5);
  });

  it('never returns less than 1, however small the viewport', () => {
    expect(fitZoom(1024, 1024, 100, 100)).toBe(1);
    expect(fitZoom(64, 64, 10, 10)).toBe(1);
  });
});

describe('scrollBarGeometry / panFromScrollOffset', () => {
  // content 800 (a 100px sprite at 8x zoom), viewport 1000 — margin 1000,
  // virtual track length 2800, thumbRatio 1000/2800, maxScroll 1800.
  const content = 800;
  const viewport = 1000;

  it('centered pan (matching centerPan when content fits) puts the thumb mid-track', () => {
    // pan = (viewport - content) / 2 = 100 here.
    const { thumbRatio, thumbOffset } = scrollBarGeometry(content, viewport, 100);
    expect(thumbRatio).toBeCloseTo(1000 / 2800);
    // scroll = margin - pan = 900; usableTrack = 1 - thumbRatio.
    const usableTrack = 1 - thumbRatio;
    expect(thumbOffset).toBeCloseTo((900 / 1800) * usableTrack);
  });

  it('pan = margin (content pushed fully into its right-side overscroll) puts the thumb at track start', () => {
    expect(scrollBarGeometry(content, viewport, viewport).thumbOffset).toBeCloseTo(0);
  });

  it('pan at the other extreme puts the thumb flush with track end', () => {
    const margin = viewport;
    const maxScroll = content + 2 * margin - viewport;
    const { thumbRatio, thumbOffset } = scrollBarGeometry(content, viewport, margin - maxScroll);
    expect(thumbOffset).toBeCloseTo(1 - thumbRatio);
  });

  it('clamps pan beyond either extreme to the track ends rather than escaping [0, 1]', () => {
    expect(scrollBarGeometry(content, viewport, viewport * 10).thumbOffset).toBeCloseTo(0);
    const { thumbRatio, thumbOffset } = scrollBarGeometry(content, viewport, -viewport * 10);
    expect(thumbOffset).toBeCloseTo(1 - thumbRatio);
  });

  it('a sprite much smaller than the viewport still gets a meaningfully-sized, movable thumb', () => {
    const { thumbRatio } = scrollBarGeometry(8, viewport, 0);
    // Bare content-only track would give thumbRatio ~1 (fills the bar); the
    // viewport-sized overscroll margin keeps it well short of that.
    expect(thumbRatio).toBeLessThan(0.5);
    expect(thumbRatio).toBeGreaterThan(0);
  });

  it('panFromScrollOffset round-trips scrollBarGeometry at both track ends and the middle', () => {
    for (const offset of [0, 0.25, 0.5]) {
      const pan = panFromScrollOffset(content, viewport, offset);
      const back = scrollBarGeometry(content, viewport, pan).thumbOffset;
      expect(back).toBeCloseTo(offset, 5);
    }
  });

  it('degenerates to a full-track, immovable thumb for a zero-size viewport', () => {
    expect(scrollBarGeometry(content, 0, 0)).toEqual({ thumbRatio: 1, thumbOffset: 0 });
    expect(panFromScrollOffset(content, 0, 0.5)).toBe(0);
  });
});
