/**
 * Global keyboard shortcuts — the Phase 0 subset of docs/05-ui-design.md §7.
 * Space-to-pan is handled in CanvasView since it needs press/release tracking.
 */

import { useEffect } from 'react';
import { useHistoryStore } from '../state/historyStore';
import { useToolStore } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';
import { openProject, saveCurrentProject } from './project';

export function useShortcuts(options: { onNewSprite?: () => void } = {}): void {
  const { onNewSprite } = options;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      // `Ctrl+Z` is global (docs/05-ui-design.md §7.7). Handled before the
      // modifier bail-out below.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          useHistoryStore.getState().undo();
          e.preventDefault();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          useHistoryStore.getState().redo();
          e.preventDefault();
          return;
        }
        if (key === 's') {
          void saveCurrentProject({ saveAs: e.shiftKey }).catch(() => {});
          e.preventDefault();
          return;
        }
        if (key === 'o') {
          void openProject().catch(() => {});
          e.preventDefault();
          return;
        }
        if (key === 'n') {
          onNewSprite?.();
          e.preventDefault();
          return;
        }
      }

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
        case 'g':
          tools.setTool('fill');
          break;
        case 'l':
          tools.setTool('line');
          break;
        case 'u':
          tools.setTool('rect');
          break;
        case 'o':
          tools.setTool('ellipse');
          break;
        case 'i':
          tools.setTool('eyedropper');
          break;
        case 'm':
          tools.setTool('select');
          break;
        case 'v':
          tools.setTool('move');
          break;
        case 'z':
          tools.setTool('zoom');
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
        case 'home':
          // Re-center the view on the sprite — the same fit CanvasView applies
          // on mount, callable again after panning away from it.
          ui.requestFit();
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNewSprite]);
}
