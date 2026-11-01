import type { ReactNode } from 'react';

import { useUIStore } from '../state/uiStore';

/**
 * A panel section that folds away. The title is a real button
 * (`aria-expanded`), the head's own actions stay visible while folded, and the
 * open/closed choice is remembered between sessions (`uiStore.foldedPanels`).
 *
 * Why: the Edit side panel stacked six sections permanently. Rarely-used ones —
 * effects, tilesets — pushed the palette off-screen on a laptop.
 */
export function Foldable({
  id,
  title,
  actions,
  className = 'panel',
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const folded = useUIStore((s) => s.foldedPanels[id] === true);
  return (
    <section className={className} data-folded={folded ? 'true' : 'false'}>
      <div className="panel-head">
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={!folded}
          onClick={() => useUIStore.getState().togglePanelFold(id)}
        >
          <span className="fold-chevron" aria-hidden="true">
            {folded ? '▸' : '▾'}
          </span>
          {title}
        </button>
        {actions}
      </div>
      {!folded && children}
    </section>
  );
}
