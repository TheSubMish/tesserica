import { create } from 'zustand';

/** Two modes, not three — animation is a panel inside Edit (docs/10-decisions.md D6, D7). */
export type Mode = 'convert' | 'edit';

interface UIState {
  mode: Mode;

  setMode(m: Mode): void;
}

export const useUIStore = create<UIState>((set) => ({
  mode: 'edit',

  setMode: (m) => set({ mode: m }),
}));
