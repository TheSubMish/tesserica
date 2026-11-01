import { useMemo, useRef, useState } from 'react';

import { Icon } from '../ui/icons';
import { filterCommands, type AppCommand } from './commands';
import { useModalFocusTrap } from './useModalFocusTrap';

/** `Ctrl+K`: type to find any command; `↑`/`↓` to move, `Enter` to run, `Esc` to close. */
export function CommandPalette({
  commands,
  onClose,
}: {
  readonly commands: readonly AppCommand[];
  readonly onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const index = Math.min(active, Math.max(0, results.length - 1));

  const run = (c: AppCommand | undefined): void => {
    if (!c) return;
    onClose();
    // After the dialog unmounts, so a command that opens another dialog keeps focus there.
    window.setTimeout(c.run, 0);
  };

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette-input">
          <Icon name="search" />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            placeholder="Type a command…"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(Math.min(index + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(Math.max(index - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[index]);
              }
            }}
          />
        </div>
        <ul className="command-list" id="command-list" role="listbox" aria-label="Commands">
          {results.length === 0 && <li className="command-empty">No matching command</li>}
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === index}
              className="command-item"
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="command-group">{c.group}</span>
              <span className="command-label">{c.label}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
