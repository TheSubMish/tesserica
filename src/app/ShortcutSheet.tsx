import { useRef } from 'react';

import type { AppCommand } from './commands';
import { useModalFocusTrap } from './useModalFocusTrap';

const EXTRA: readonly { keys: string; label: string }[] = [
  { keys: 'Ctrl+K', label: 'Command palette' },
  { keys: 'Space + drag', label: 'Pan the canvas' },
  { keys: 'Ctrl + wheel', label: 'Zoom toward the cursor' },
  { keys: '[  ]', label: 'Smaller / larger brush' },
  { keys: '+  −', label: 'Zoom in / out' },
  { keys: 'Right-drag', label: 'Paint with the secondary colour' },
];

/** `?`: every shortcut on one page, generated from the command registry so it cannot drift. */
export function ShortcutSheet({
  commands,
  onClose,
}: {
  readonly commands: readonly AppCommand[];
  readonly onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const groups = new Map<string, { keys: string; label: string }[]>();
  for (const c of commands) {
    if (!c.keys) continue;
    const list = groups.get(c.group) ?? [];
    list.push({ keys: c.keys, label: c.label });
    groups.set(c.group, list);
  }
  groups.set('Canvas', [...EXTRA]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Keyboard shortcuts</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="shortcut-columns">
          {[...groups].map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {rows.map((r) => (
                  <div key={`${group}-${r.keys}-${r.label}`}>
                    <dt>{r.label}</dt>
                    <dd>
                      <kbd>{r.keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
