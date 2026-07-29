/**
 * Zoom — click to zoom in, `Alt`+click to zoom out (`docs/05-ui-design.md`
 * §4.1: "Zoom | Z | Ctrl+wheel from any tool").
 *
 * Unlike every other tool, Zoom never touches the cel buffer — it is a
 * viewport operation, not a document edit. `ToolContext` has no screen
 * coordinates or access to the UI store, and inventing them here would mean
 * a second zoom implementation next to `uiStore.zoomAt` (already used by
 * `Ctrl`+wheel in `CanvasView`). So this entry exists only so `zoom` is a
 * valid `ToolId` that the rail can render and the registry's
 * `Record<ToolId, Tool>` stays exhaustive — `CanvasView.onPointerDown`
 * special-cases `activeTool === 'zoom'` before it ever reaches tool dispatch,
 * the same way Space-drag panning bypasses it. This is why the handlers
 * below are unreachable no-ops rather than the real behaviour.
 */

import type { Tool } from './Tool';

export const zoom: Tool = {
  id: 'zoom',
  label: 'Zoom',
  readOnly: true,
  onPointerDown() {
    // Real behaviour lives in CanvasView.onPointerDown (see file comment).
  },
  onPointerMove() {
    // No drag gesture — Zoom is a discrete click, not a paint stroke.
  },
};
