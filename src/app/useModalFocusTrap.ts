import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessibility pass (`docs/05-ui-design.md` §8 — "Full keyboard access to
 * tools, layers, and menus; visible focus rings").
 *
 * `ExportDialog` and `NewSpriteDialog` both render `role="dialog"
 * aria-modal="true"` but, before this, did nothing to back that up: focus
 * stayed wherever it was when the dialog opened, `Tab` could walk straight
 * out into the tool rail and canvas behind the backdrop, and closing the
 * dialog left focus nowhere in particular. `aria-modal="true"` tells
 * assistive tech everything outside is inert — a sighted keyboard user
 * tabbing into "inert" content behind a modal is the same bug with a
 * different symptom.
 *
 * This hook moves focus into the dialog on mount, traps `Tab`/`Shift+Tab`
 * within its focusable elements, closes on `Escape` (a dialog, not "the
 * document" that `05` §7.8 protects — closing a transient dialog on Escape
 * is the universal convention this app otherwise follows), and restores
 * focus to whatever had it beforehand on unmount.
 */
export function useModalFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const first = focusables()[0] ?? container;
    first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = els[0];
      const lastEl = els[els.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
    // `onClose` identity is expected to be stable enough per mount; re-running
    // this on every render would re-steal focus from whatever the user just
    // tabbed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);
}
