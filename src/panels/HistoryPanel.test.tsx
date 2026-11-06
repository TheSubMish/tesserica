import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Command } from '../history/command';
import { useHistoryStore } from '../state/historyStore';
import { useUIStore } from '../state/uiStore';
import { HistoryPanel } from './HistoryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A command that just records what happened to it. */
function fake(label: string, log: string[]): Command {
  return {
    label,
    memoryCost: 0,
    apply: () => void log.push(`+${label}`),
    invert: () => void log.push(`-${label}`),
  };
}

let container: HTMLDivElement;
let root: Root;
let log: string[];

beforeEach(() => {
  log = [];
  useHistoryStore.getState().clear();
  useUIStore.setState({ foldedPanels: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const h = useHistoryStore.getState();
  h.push(fake('A', log));
  h.push(fake('B', log));
  h.push(fake('C', log));
  act(() => root.render(<HistoryPanel />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.history-step')];

describe('jumpTo', () => {
  it('undoes back to an earlier step, then redoes forward', () => {
    useHistoryStore.getState().jumpTo(1);
    expect(log).toEqual(['-C', '-B']);
    expect(useHistoryStore.getState().past).toHaveLength(1);
    expect(useHistoryStore.getState().future).toHaveLength(2);

    log.length = 0;
    useHistoryStore.getState().jumpTo(3);
    expect(log).toEqual(['+B', '+C']);
  });

  it('0 is the original document, and out-of-range targets clamp', () => {
    useHistoryStore.getState().jumpTo(0);
    expect(useHistoryStore.getState().past).toHaveLength(0);
    useHistoryStore.getState().jumpTo(99);
    expect(useHistoryStore.getState().past).toHaveLength(3);
    useHistoryStore.getState().jumpTo(-4);
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });

  it('keeps the redo branch until a new edit replaces it', () => {
    useHistoryStore.getState().jumpTo(1);
    expect(useHistoryStore.getState().future).toHaveLength(2);
    useHistoryStore.getState().push(fake('D', log));
    expect(useHistoryStore.getState().future).toHaveLength(0);
  });
});

describe('HistoryPanel', () => {
  it('lists Original plus every step, marking the current one', () => {
    expect(rows().map((r) => r.textContent)).toEqual(['0Original', '1A', '2B', '3C']);
    expect(rows()[3].getAttribute('aria-current')).toBe('step');
  });

  it('shows undone steps dimmed and keeps them clickable', () => {
    act(() => useHistoryStore.getState().jumpTo(1));
    expect(rows().map((r) => r.classList.contains('undone'))).toEqual([false, false, true, true]);
    expect(rows()[1].getAttribute('aria-current')).toBe('step');
  });

  it('clicking a step travels there', () => {
    act(() => rows()[1].click());
    expect(useHistoryStore.getState().past).toHaveLength(1);
    act(() => rows()[3].click());
    expect(useHistoryStore.getState().past).toHaveLength(3);
  });
});
