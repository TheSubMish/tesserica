import type { Tool } from './Tool';
import { pencil } from './pencil';
import { eraser } from './eraser';
import { bucket } from './bucket';
import { ellipse, line, rectangle } from './line';
import { move } from './move';
import { picker } from './picker';
import { select } from './select';
import type { ToolId } from '../state/toolStore';

export const tools: Record<ToolId, Tool> = {
  pencil,
  eraser,
  fill: bucket,
  line,
  rect: rectangle,
  ellipse,
  eyedropper: picker,
  select,
  move,
};

export function getTool(id: ToolId): Tool {
  return tools[id];
}
