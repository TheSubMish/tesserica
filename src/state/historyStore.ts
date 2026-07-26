/**
 * Undo/redo (`docs/03-data-model.md` §6).
 *
 * Commands arrive **already applied** — tools mutate the buffer as the user
 * drags, and the command is the record of what happened, not the thing that
 * makes it happen. `push` therefore does not call `apply`; `redo` does.
 *
 * Budget: ~256 MB or 200 steps, whichever comes first, evicting oldest.
 */

import { create } from 'zustand';
import type { Command } from '../history/command';
import { useDocumentStore } from './documentStore';

export const MAX_STEPS = 200;
export const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

interface HistoryState {
  past: Command[];
  future: Command[];
  /** Retained bytes across `past` + `future`. */
  memoryUsed: number;

  /** Record an edit that has already been applied to the document. */
  push(cmd: Command): void;
  /** Apply an edit and record it. */
  run(cmd: Command): void;
  undo(): void;
  redo(): void;
  clear(): void;
  undoLabel(): string | null;
  redoLabel(): string | null;
}

function cost(cmds: Command[]): number {
  return cmds.reduce((n, c) => n + c.memoryCost, 0);
}

/**
 * Drop oldest steps until the history fits the budget. Never drops the newest
 * step even if it alone exceeds the budget — losing the edit the user just
 * made would be worse than briefly overshooting.
 */
function evict(past: Command[], future: Command[]): { past: Command[]; memoryUsed: number } {
  let kept = past;
  let used = cost(kept) + cost(future);
  while (kept.length > 1 && (kept.length > MAX_STEPS || used > MAX_MEMORY_BYTES)) {
    used -= kept[0].memoryCost;
    kept = kept.slice(1);
  }
  return { past: kept, memoryUsed: used };
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  memoryUsed: 0,

  push: (cmd) =>
    set((s) => {
      const top = s.past[s.past.length - 1];
      const merged = top?.coalesceWith?.(cmd) ?? null;
      const past = merged ? [...s.past.slice(0, -1), merged] : [...s.past, cmd];
      // A new edit invalidates the redo branch.
      return { future: [], ...evict(past, []) };
    }),

  run: (cmd) => {
    cmd.apply(useDocumentStore.getState());
    get().push(cmd);
  },

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const cmd = s.past[s.past.length - 1];
      cmd.invert(useDocumentStore.getState());
      const past = s.past.slice(0, -1);
      const future = [cmd, ...s.future];
      return { past, future, memoryUsed: cost(past) + cost(future) };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const cmd = s.future[0];
      cmd.apply(useDocumentStore.getState());
      const past = [...s.past, cmd];
      const future = s.future.slice(1);
      return { past, future, memoryUsed: cost(past) + cost(future) };
    }),

  clear: () => set({ past: [], future: [], memoryUsed: 0 }),

  undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
  redoLabel: () => get().future[0]?.label ?? null,
}));
