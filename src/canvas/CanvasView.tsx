/**
 * Canvas viewport: pan and zoom over the document.
 *
 * Redraws are driven by `revision` from the document store rather than by React
 * re-rendering on pixel data — the pixels never enter React state
 * (docs/02-architecture.md §4).
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useDocumentStore } from '../state/documentStore';
import { GRID_AUTO_ZOOM, useUIStore } from '../state/uiStore';
import { centerPan, fitZoom, screenToDoc } from './coords';
import { drawBorder, drawCheckerboard, drawCursorCell, drawGrid, drawSprite } from './renderer';

/** One wheel notch of vertical/horizontal scroll, in screen pixels. */
const WHEEL_PAN_STEP = 48;

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Interaction state kept in refs — it changes per pointer event and must not
  // trigger React renders.
  const panning = useRef(false);
  const spaceHeld = useRef(false);
  const lastScreen = useRef({ x: 0, y: 0 });

  const sprite = useDocumentStore((s) => s.sprite);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);
  const revision = useDocumentStore((s) => s.revision);

  const zoom = useUIStore((s) => s.zoom);
  const panX = useUIStore((s) => s.panX);
  const panY = useUIStore((s) => s.panY);
  const showGrid = useUIStore((s) => s.showGrid);
  const cursor = useUIStore((s) => s.cursor);

  /** Center the sprite on first mount. */
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { clientWidth, clientHeight } = wrap;
    const z = Math.min(16, fitZoom(sprite.width, sprite.height, clientWidth, clientHeight));
    const { panX: px, panY: py } = centerPan(
      z,
      sprite.width,
      sprite.height,
      clientWidth,
      clientHeight,
    );
    useUIStore.getState().setZoom(z);
    useUIStore.getState().setPan(px, py);
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keep the backing store sized to the element, accounting for HiDPI. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(wrap.clientWidth * dpr);
    canvas.height = Math.floor(wrap.clientHeight * dpr);
    canvas.style.width = `${wrap.clientWidth}px`;
    canvas.style.height = `${wrap.clientHeight}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  useEffect(() => {
    resize();
    const ro = new ResizeObserver(resize);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [resize]);

  /** Redraw. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const vp = { zoom, panX, panY };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#141417';
    ctx.fillRect(0, 0, w, h);

    drawCheckerboard(ctx, panX, panY, sprite.width * zoom, sprite.height * zoom);
    drawSprite(ctx, sprite, activeFrameId, vp);
    if (showGrid && zoom >= GRID_AUTO_ZOOM) drawGrid(ctx, sprite, vp);
    drawBorder(ctx, sprite, vp);
    if (cursor && !panning.current) {
      drawCursorCell(ctx, vp, cursor.x, cursor.y, 1);
    }
  }, [sprite, activeFrameId, revision, zoom, panX, panY, showGrid, cursor]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    lastScreen.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Middle-drag or space-drag pans from any tool (docs/05-ui-design.md §7.1).
    if (e.button === 1 || spaceHeld.current) {
      panning.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (panning.current) {
        const dx = sx - lastScreen.current.x;
        const dy = sy - lastScreen.current.y;
        useUIStore.getState().panBy(dx, dy);
        lastScreen.current = { x: sx, y: sy };
        return;
      }
      lastScreen.current = { x: sx, y: sy };

      const { x, y } = screenToDoc(useUIStore.getState(), sx, sy);
      const inBounds = x >= 0 && y >= 0 && x < sprite.width && y < sprite.height;
      useUIStore.getState().setCursor(inBounds ? { x, y } : null);
    },
    [sprite.width, sprite.height],
  );

  const endStroke = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    panning.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  /**
   * `Ctrl`+wheel zooms toward the cursor, plain wheel scrolls vertically,
   * `Shift`+wheel horizontally (docs/05-ui-design.md §7.2).
   */
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const ui = useUIStore.getState();

    if (e.ctrlKey || e.metaKey) {
      const rect = e.currentTarget.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      ui.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
      return;
    }

    const step = e.deltaY < 0 ? WHEEL_PAN_STEP : -WHEEL_PAN_STEP;
    if (e.shiftKey) ui.panBy(step, 0);
    else ui.panBy(0, step);
  }, []);

  /** Space-to-pan needs window-level key tracking. */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        spaceHeld.current = true;
        if (wrapRef.current) wrapRef.current.style.cursor = 'grab';
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld.current = false;
        panning.current = false;
        if (wrapRef.current) wrapRef.current.style.cursor = '';
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={() => useUIStore.getState().setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
