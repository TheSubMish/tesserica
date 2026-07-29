/**
 * Canvas viewport: pan, zoom, and pointer routing to the active tool.
 *
 * Redraws are driven by `revision` from the document store rather than by React
 * re-rendering on pixel data — the pixels never enter React state
 * (docs/02-architecture.md §4).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { getBuffer } from '../model/pixelBuffers';
import { isEffectivelyLocked, isEffectivelyVisible } from '../model/layerTree';
import { celBufferId } from '../model/types';
import { onionSkinFrames } from '../model/onionSkin';
import {
  beginStroke,
  finishStroke,
  restoreStroke,
  type StrokeSnapshot,
} from '../history/strokeRecorder';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { useToolStore } from '../state/toolStore';
import { GRID_AUTO_ZOOM, useUIStore } from '../state/uiStore';
import { getTool } from '../tools/registry';
import type { ToolContext } from '../tools/Tool';
import { centerPan, fitZoom, screenToDoc } from './coords';
import { samplePixel } from './sample';
import {
  drawBorder,
  drawCheckerboard,
  drawCursorCell,
  drawGrid,
  drawOnionSkin,
  drawSelection,
  drawSprite,
} from './renderer';

/** One wheel notch of vertical/horizontal scroll, in screen pixels. */
const WHEEL_PAN_STEP = 48;
/**
 * Zoom step for both `Ctrl`+wheel (any tool) and the `Z` tool's click-to-zoom
 * (docs/05-ui-design.md §4.1, §7.2) — one constant so the two stay in lockstep.
 */
const ZOOM_STEP_FACTOR = 1.25;

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Interaction state kept in refs — it changes per pointer event and must not
  // trigger React renders.
  const drawing = useRef(false);
  const panning = useRef(false);
  const spaceHeld = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const lastScreen = useRef({ x: 0, y: 0 });
  /** Pointer-down copy of the active cel; becomes one undo step on release. */
  const stroke = useRef<StrokeSnapshot | null>(null);
  const strokeLabel = useRef('Edit');
  /** Where the gesture started — shape tools drag out from here. */
  const anchor = useRef({ x: 0, y: 0 });
  /** Per-gesture tool scratch (the pencil's pixel-perfect trail). */
  const strokeState = useRef<Record<string, unknown>>({});

  const sprite = useDocumentStore((s) => s.sprite);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);
  const revision = useDocumentStore((s) => s.revision);

  const zoom = useUIStore((s) => s.zoom);
  const panX = useUIStore((s) => s.panX);
  const panY = useUIStore((s) => s.panY);
  const showGrid = useUIStore((s) => s.showGrid);
  const cursor = useUIStore((s) => s.cursor);
  const fitRequest = useUIStore((s) => s.fitRequest);
  const onionSkinEnabled = useUIStore((s) => s.onionSkinEnabled);
  const onionSkinBefore = useUIStore((s) => s.onionSkinBefore);
  const onionSkinAfter = useUIStore((s) => s.onionSkinAfter);
  const selection = useSelectionStore((s) => s.selection);

  /**
   * Which nearby frames to ghost, if any — view-only (`docs/08-roadmap.md`
   * Phase 4 "Onion skinning"), computed here rather than inside the redraw
   * effect so it participates in the effect's own dependency list without
   * hand-rolling the equality check.
   */
  const onionSkinGhosts = useMemo(
    () =>
      onionSkinEnabled
        ? onionSkinFrames(
            sprite.frames,
            sprite.frames.findIndex((f) => f.id === activeFrameId),
            onionSkinBefore,
            onionSkinAfter,
          )
        : [],
    [onionSkinEnabled, sprite.frames, activeFrameId, onionSkinBefore, onionSkinAfter],
  );

  const brushSize = useToolStore((s) => s.brushSize);

  /**
   * Center the sprite on first mount, and again whenever something asks for a
   * re-fit — `Ctrl+N` (`docs/06-workflows.md` W2 step 2) replaces the document
   * without unmounting this component, so `fitRequest` is the only signal that
   * fires in both cases.
   */
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
    // `sprite` deliberately excluded: every pixel edit touches the store too,
    // and this must not re-center the view on every stroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

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
    // Ghosts of nearby frames are drawn *underneath* the active frame's own
    // content — tinted and translucent, view-only, never paintable or
    // exported (`canvas/renderer.ts::drawOnionSkin`).
    if (onionSkinGhosts.length > 0) drawOnionSkin(ctx, sprite, vp, onionSkinGhosts);
    drawSprite(ctx, sprite, activeFrameId, vp);
    if (showGrid && zoom >= GRID_AUTO_ZOOM) drawGrid(ctx, sprite, vp);
    drawBorder(ctx, sprite, vp);
    if (selection) drawSelection(ctx, vp, selection);
    if (cursor && !panning.current) {
      drawCursorCell(ctx, vp, cursor.x, cursor.y, brushSize);
    }
  }, [
    sprite,
    activeFrameId,
    revision,
    zoom,
    panX,
    panY,
    showGrid,
    cursor,
    brushSize,
    selection,
    onionSkinGhosts,
  ]);

  /**
   * Apply the active tool to the active cel.
   *
   * `phase` covers all three pointer events a gesture can produce. `'up'`
   * exists so Select and Move can finalize a selection
   * (`docs/08-roadmap.md` Phase 3) — every other tool leaves `onPointerUp`
   * unimplemented, so this is a no-op for them.
   */
  const dispatch = useCallback(
    (
      phase: 'down' | 'move' | 'up',
      x: number,
      y: number,
      prevX: number,
      prevY: number,
      button: number,
      alt: boolean,
    ) => {
      const doc = useDocumentStore.getState();
      const layer = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);

      const toolState = useToolStore.getState();
      // `Alt` picks a colour from any painting tool (docs/05-ui-design.md
      // §7.3). Releasing it returns to the tool the user was on, which falls
      // out of resolving it per event rather than switching `activeTool`.
      const tool = getTool(alt ? 'eyedropper' : toolState.activeTool);

      // A read-only tool has nothing to write to and must still work on a
      // locked or hidden layer. "Locked"/"hidden" are inherited from an
      // ancestor group (roadmap Phase 3, "Layer groups, clipping masks") —
      // a raster layer inside a hidden group must not be paintable just
      // because its own `visible` flag still says true.
      if (
        !tool.readOnly &&
        (!layer ||
          isEffectivelyLocked(doc.sprite.layers, layer.id) ||
          !isEffectivelyVisible(doc.sprite.layers, layer.id))
      )
        return;

      const cel = doc.activeCel();
      if (!cel) return;
      // A linked cel (`docs/03-data-model.md` §2.2) has no buffer of its
      // own — drawing on it must edit the buffer it shares, so every frame
      // linked to it sees the stroke too.
      const bufferId = celBufferId(cel);
      const buffer = getBuffer(bufferId);
      if (!buffer) return;

      if (phase === 'down' && !tool.readOnly) {
        // One copy per gesture. The dirty rect is diffed out of it on release
        // (docs/03-data-model.md §6).
        stroke.current = beginStroke(bufferId, buffer, cel.width, cel.height);
        strokeLabel.current = tool.label;
        strokeState.current = {};
      }
      const snapshot = stroke.current;

      const ctx: ToolContext = {
        buffer,
        width: cel.width,
        height: cel.height,
        primary: toolState.primary,
        secondary: toolState.secondary,
        brushSize: toolState.brushSize,
        button,
        pixelPerfect: toolState.pixelPerfect,
        shapeFill: toolState.shapeFill,
        fillContiguous: toolState.fillContiguous,
        selectMode: toolState.selectMode,
        anchor: anchor.current,
        strokeState: strokeState.current,
        selection: useSelectionStore.getState().selection,
        setSelection: (s) => useSelectionStore.getState().setSelection(s),
        restore: () => {
          if (snapshot) restoreStroke(snapshot, buffer);
        },
        restorePixel: (px, py) => {
          if (!snapshot) return;
          if (px < 0 || py < 0 || px >= cel.width || py >= cel.height) return;
          const i = (py * cel.width + px) * 4;
          buffer.set(snapshot.pixels.subarray(i, i + 4), i);
        },
        sample: (sx, sy) => samplePixel(doc.sprite, doc.activeFrameId, sx, sy),
        setColor: (c, slot) => {
          if (slot === 'secondary') useToolStore.getState().setSecondary(c);
          else useToolStore.getState().setPrimary(c);
        },
      };

      if (phase === 'down') tool.onPointerDown(ctx, x, y);
      else if (phase === 'move') tool.onPointerMove(ctx, x, y, prevX, prevY);
      else tool.onPointerUp?.(ctx, x, y);

      if (!tool.readOnly) doc.touch(bufferId);
    },
    [],
  );

  const paint = useCallback(
    (
      x: number,
      y: number,
      prevX: number,
      prevY: number,
      down: boolean,
      button: number,
      alt: boolean,
    ) => dispatch(down ? 'down' : 'move', x, y, prevX, prevY, button, alt),
    [dispatch],
  );

  /** Close the gesture and record it as a single undo step. */
  const commitStroke = useCallback(() => {
    const snapshot = stroke.current;
    stroke.current = null;
    if (!snapshot) return;
    const buffer = getBuffer(snapshot.celId);
    if (!buffer) return;
    const cmd = finishStroke(snapshot, buffer, strokeLabel.current);
    if (cmd) useHistoryStore.getState().push(cmd);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      lastScreen.current = { x: sx, y: sy };

      // Middle-drag or space-drag pans from any tool (docs/05-ui-design.md §7.1).
      if (e.button === 1 || spaceHeld.current) {
        panning.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }

      // Zoom tool: click zooms in toward the cursor, `Alt`+click zooms out,
      // reusing the exact step `Ctrl`+wheel uses (docs/05-ui-design.md §4.1)
      // so the two stay consistent. This is a viewport operation, not a
      // document edit, so — like Space-drag panning above — it bypasses tool
      // dispatch and the undo machinery entirely (see `tools/zoom.ts`).
      if (useToolStore.getState().activeTool === 'zoom') {
        const factor = e.altKey ? 1 / ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR;
        useUIStore.getState().zoomAt(factor, sx, sy);
        return;
      }

      const { x, y } = screenToDoc(useUIStore.getState(), sx, sy);
      drawing.current = true;
      last.current = { x, y };
      anchor.current = { x, y };
      e.currentTarget.setPointerCapture(e.pointerId);
      paint(x, y, x, y, true, e.button, e.altKey);
    },
    [paint],
  );

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

      if (drawing.current) {
        // Pointer events fire every few milliseconds, so a fast drag reports
        // positions many pixels apart; the tool interpolates between them.
        const prev = last.current;
        if (prev.x !== x || prev.y !== y) {
          paint(x, y, prev.x, prev.y, false, e.buttons === 2 ? 2 : 0, e.altKey);
          last.current = { x, y };
        }
      }
    },
    [paint, sprite.width, sprite.height],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (drawing.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        const { x, y } = screenToDoc(
          useUIStore.getState(),
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
        // Select/Move finalize their gesture here (`docs/08-roadmap.md` Phase
        // 3); every other tool leaves `onPointerUp` unimplemented.
        dispatch('up', x, y, x, y, e.button, e.altKey);
        commitStroke();
      }
      drawing.current = false;
      panning.current = false;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    [commitStroke, dispatch],
  );

  /**
   * Escape abandons the in-progress gesture, never the document
   * (docs/05-ui-design.md §7.8). Because the snapshot *is* the pre-gesture
   * state, cancelling is a straight restore and leaves no undo step.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drawing.current) return;
      const snapshot = stroke.current;
      if (snapshot) {
        const buffer = getBuffer(snapshot.celId);
        if (buffer) restoreStroke(snapshot, buffer);
        useDocumentStore.getState().touch(snapshot.celId);
      }
      stroke.current = null;
      drawing.current = false;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * `Ctrl`+wheel zooms toward the cursor, plain wheel scrolls vertically,
   * `Shift`+wheel horizontally (docs/05-ui-design.md §7.2).
   */
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const ui = useUIStore.getState();

    if (e.ctrlKey || e.metaKey) {
      const rect = e.currentTarget.getBoundingClientRect();
      const factor = e.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR;
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
