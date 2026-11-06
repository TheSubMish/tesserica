import type { ToolId } from '../state/toolStore';
import type { IconName } from '../ui/icons';

/** Order, glyphs and shortcuts follow docs/05-ui-design.md §4.1. */
export const TOOLS: { id: ToolId; glyph: IconName; label: string; key: string }[] = [
  { id: 'pencil', glyph: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', glyph: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', glyph: 'fill', label: 'Fill', key: 'G' },
  { id: 'line', glyph: 'line', label: 'Line', key: 'L' },
  { id: 'rect', glyph: 'rect', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', glyph: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'eyedropper', glyph: 'eyedropper', label: 'Eyedropper', key: 'I' },
  { id: 'select', glyph: 'select', label: 'Select', key: 'M' },
  { id: 'move', glyph: 'move', label: 'Move', key: 'V' },
  { id: 'zoom', glyph: 'zoom', label: 'Zoom', key: 'Z' },
  { id: 'stamp', glyph: 'stamp', label: 'Stamp', key: 'S' },
  // Phase 7 — rotxel/cleanEdge rotate & scale (`docs/08-roadmap.md`), added
  // beyond the `05-ui-design.md` §4.1 v1 table the same way Stamp was.
  { id: 'transform', glyph: 'transform', label: 'Transform', key: 'R' },
];

export const toolLabel = (id: ToolId): string => TOOLS.find((t) => t.id === id)?.label ?? id;
