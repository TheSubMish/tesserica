/**
 * The command registry behind the `Ctrl+K` palette.
 *
 * Commands are data — an id, a label, an optional key hint and a `run` — so the
 * palette, the shortcut cheat sheet and the welcome screen all offer the same
 * actions. App-level actions (dialogs, file I/O) are injected as
 * {@link AppActions}; everything else talks to the stores directly.
 */

import { useHistoryStore } from '../state/historyStore';
import { useToolStore, type ToolId } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';

export interface AppCommand {
  readonly id: string;
  readonly label: string;
  readonly group: 'File' | 'Mode' | 'Tool' | 'Edit' | 'View' | 'Help';
  /** Display-only key hint, e.g. `Ctrl+Z`. */
  readonly keys?: string;
  readonly run: () => void;
}

export interface AppActions {
  newSprite(): void;
  openProject(): void;
  saveProject(): void;
  saveProjectAs(): void;
  openImage(): void;
  openSample(): void;
  exportImage(): void;
  batchConvert(): void;
  convertFormat(): void;
  showWelcome(): void;
  showShortcuts(): void;
}

const TOOL_COMMANDS: readonly { id: ToolId; label: string; key: string }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I' },
  { id: 'select', label: 'Select', key: 'M' },
  { id: 'move', label: 'Move', key: 'V' },
  { id: 'zoom', label: 'Zoom', key: 'Z' },
  { id: 'stamp', label: 'Stamp', key: 'S' },
  { id: 'transform', label: 'Transform', key: 'R' },
];

export function buildCommands(a: AppActions): AppCommand[] {
  const ui = () => useUIStore.getState();
  const tools = () => useToolStore.getState();

  return [
    { id: 'file.new', group: 'File', label: 'New sprite…', keys: 'Ctrl+N', run: a.newSprite },
    { id: 'file.open', group: 'File', label: 'Open project…', keys: 'Ctrl+O', run: a.openProject },
    { id: 'file.save', group: 'File', label: 'Save', keys: 'Ctrl+S', run: a.saveProject },
    {
      id: 'file.saveAs',
      group: 'File',
      label: 'Save as…',
      keys: 'Ctrl+Shift+S',
      run: a.saveProjectAs,
    },
    { id: 'file.image', group: 'File', label: 'Open photo to convert…', run: a.openImage },
    { id: 'file.sample', group: 'File', label: 'Convert the sample photo', run: a.openSample },
    { id: 'file.export', group: 'File', label: 'Export…', run: a.exportImage },
    { id: 'file.batch', group: 'File', label: 'Batch convert…', run: a.batchConvert },
    { id: 'file.format', group: 'File', label: 'Convert image format…', run: a.convertFormat },

    {
      id: 'mode.convert',
      group: 'Mode',
      label: 'Go to Convert',
      run: () => ui().setMode('convert'),
    },
    { id: 'mode.edit', group: 'Mode', label: 'Go to Edit', run: () => ui().setMode('edit') },

    ...TOOL_COMMANDS.map((t): AppCommand => ({
      id: `tool.${t.id}`,
      group: 'Tool',
      label: `${t.label} tool`,
      keys: t.key,
      run: () => {
        ui().setMode('edit');
        tools().setTool(t.id);
      },
    })),

    {
      id: 'edit.undo',
      group: 'Edit',
      label: 'Undo',
      keys: 'Ctrl+Z',
      run: () => useHistoryStore.getState().undo(),
    },
    {
      id: 'edit.redo',
      group: 'Edit',
      label: 'Redo',
      keys: 'Ctrl+Shift+Z',
      run: () => useHistoryStore.getState().redo(),
    },
    {
      id: 'edit.swap',
      group: 'Edit',
      label: 'Swap primary and secondary colour',
      keys: 'X',
      run: () => tools().swapColors(),
    },
    {
      id: 'edit.reset',
      group: 'Edit',
      label: 'Reset colours to black and white',
      keys: 'D',
      run: () => tools().resetColors(),
    },

    {
      id: 'view.grid',
      group: 'View',
      label: 'Toggle pixel grid',
      keys: "'",
      run: () => ui().toggleGrid(),
    },
    {
      id: 'view.timeline',
      group: 'View',
      label: 'Toggle timeline',
      keys: 'T',
      run: () => ui().toggleTimeline(),
    },
    {
      id: 'view.fit',
      group: 'View',
      label: 'Fit and centre the canvas',
      keys: 'Home',
      run: () => ui().requestFit(),
    },

    { id: 'help.welcome', group: 'Help', label: 'Show the welcome screen', run: a.showWelcome },
    {
      id: 'help.keys',
      group: 'Help',
      label: 'Keyboard shortcuts',
      keys: '?',
      run: a.showShortcuts,
    },
  ];
}

/**
 * Subsequence match with a small ranking: every query character must appear in
 * order; consecutive runs and word-start hits score higher. Returns `-1` for no
 * match. Cheap enough to run per keystroke over a few dozen commands.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    const wordStart = found === 0 || t[found - 1] === ' ';
    run = found === ti && ti > 0 ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(found - ti, 5) * 0.2;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

export function filterCommands(commands: readonly AppCommand[], query: string): AppCommand[] {
  if (query.trim() === '') return [...commands];
  return commands
    .map((c) => ({
      c,
      s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, `${c.group} ${c.label}`)),
    }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}
