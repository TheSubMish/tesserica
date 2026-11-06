import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useUIStore } from '../state/uiStore';
import { Foldable } from './Foldable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ foldedPanels: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const mount = () => {
  const root = createRoot(container);
  act(() =>
    root.render(
      <Foldable id="demo" title="Demo" actions={<button id="action">act</button>}>
        <p id="body">content</p>
      </Foldable>,
    ),
  );
};

describe('Foldable', () => {
  it('shows its content, and folds it away on click while keeping its actions', () => {
    mount();
    const toggle = container.querySelector<HTMLButtonElement>('.fold-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#body')).not.toBeNull();

    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#body')).toBeNull();
    expect(container.querySelector('#action')).not.toBeNull();
  });

  it('remembers the choice', () => {
    mount();
    act(() => container.querySelector<HTMLButtonElement>('.fold-toggle')!.click());
    expect(JSON.parse(localStorage.getItem('tesserica.folded.v1')!)).toEqual({ demo: true });
  });
});
