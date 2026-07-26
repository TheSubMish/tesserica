import type { Tool } from './Tool';
import { eraser, pencil } from './pencil';
import type { ToolId } from '../state/toolStore';

export const tools: Record<ToolId, Tool> = {
  pencil,
  eraser,
};

export function getTool(id: ToolId): Tool {
  return tools[id];
}
