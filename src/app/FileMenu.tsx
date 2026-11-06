/**
 * File menu in the title bar (`docs/05-ui-design.md` §2 — the `≡` affordance).
 *
 * A plain popover rather than a native menu: Tauri's native menus are a
 * separate API per platform, and the target is Linux only for now (D5), so
 * there is nothing to gain from the extra surface yet.
 */

import { useEffect, useRef, useState } from 'react';

export interface FileMenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
}

export function FileMenu({
  items,
  label = 'File',
  glyph = '≡',
}: {
  items: FileMenuItem[];
  /** Names the menu for assistive tech and the tooltip. */
  label?: string;
  glyph?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="file-menu" ref={root}>
      <button
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} menu`}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </button>

      {open && (
        <div className="menu-popover" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="menu-key">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
