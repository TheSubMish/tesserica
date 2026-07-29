import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalFocusTrap } from './useModalFocusTrap';

/**
 * docs/05-ui-design.md §8 — "Full keyboard access ... visible focus rings".
 * `ExportDialog` and `NewSpriteDialog` both delegate to this hook rather than
 * duplicating focus-trap logic, so it is worth testing once here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocusTrap(ref, onClose);
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button id="first">First</button>
      <button id="second">Second</button>
    </div>
  );
}

/**
 * Mirrors real usage: `App.tsx` conditionally renders `{exporting &&
 * <ExportDialog .../>}`, so opening/closing is a mount/unmount of the whole
 * dialog subtree, not an internal open flag.
 */
function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <Dialog onClose={onClose} /> : null;
}

function keydown(target: Element, key: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

describe('useModalFocusTrap', () => {
  it('moves focus to the first focusable element on mount', () => {
    // `createRoot(container).render(...)` claims exclusive ownership of
    // `container` and wipes any content added to it directly, so the
    // pre-existing focus target has to live outside the managed subtree —
    // exactly like the real app, where the dialog mounts into a sibling of
    // whatever had focus, never as a replacement of it.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    act(() => root.render(<Harness open onClose={() => {}} />));

    expect(document.activeElement?.id).toBe('first');
    outside.remove();
  });

  it('wraps Tab from the last element back to the first', () => {
    act(() => root.render(<Harness open onClose={() => {}} />));
    const second = container.querySelector('#second') as HTMLElement;
    act(() => second.focus());
    act(() => keydown(second, 'Tab'));
    expect(document.activeElement?.id).toBe('first');
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    act(() => root.render(<Harness open onClose={() => {}} />));
    const first = container.querySelector('#first') as HTMLElement;
    act(() => first.focus());
    act(() => keydown(first, 'Tab', true));
    expect(document.activeElement?.id).toBe('second');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    act(() => root.render(<Harness open onClose={onClose} />));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    act(() => keydown(dialog, 'Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the previously focused element on unmount', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    act(() => root.render(<Harness open onClose={() => {}} />));
    expect(document.activeElement?.id).toBe('first');

    act(() => root.render(<Harness open={false} onClose={() => {}} />));
    expect(document.activeElement?.id).toBe('outside');
    outside.remove();
  });
});
