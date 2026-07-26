/**
 * Global keyboard shortcuts — the Phase 0 subset of docs/05-ui-design.md §7.
 * Space-to-pan is handled in CanvasView since it needs press/release tracking.
 */

import { useEffect } from 'react';
import { useToolStore } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const tools = useToolStore.getState();
      const ui = useUIStore.getState();

      switch (e.key.toLowerCase()) {
        case 'b':
          tools.setTool('pencil');
          break;
        case 'e':
          tools.setTool('eraser');
          break;
        case 'x':
          tools.swapColors();
          break;
        case 'd':
          tools.resetColors();
          break;
        case '[':
          tools.setBrushSize(tools.brushSize - 1);
          break;
        case ']':
          tools.setBrushSize(tools.brushSize + 1);
          break;
        case "'":
          ui.toggleGrid();
          break;
        case '+':
        case '=':
          ui.setZoom(ui.zoom * 2);
          break;
        case '-':
          ui.setZoom(ui.zoom / 2);
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
