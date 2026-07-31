/**
 * Transform — rotate/scale (`docs/08-roadmap.md` Phase 7). A read-only no-op
 * `Tool`: selecting it in the rail exists only to show the right panel in
 * `ToolOptions`. The actual edit is `canvas/applyTransform.ts`'s one-shot
 * "Apply" action, not a pointer gesture — clicking the canvas with this tool
 * active must not paint or select anything.
 */

import type { Tool } from './Tool';

export const transform: Tool = {
  id: 'transform',
  label: 'Transform',
  readOnly: true,
  onPointerDown() {},
  onPointerMove() {},
};
