import { useHistoryStore } from '../state/historyStore';
import { Foldable } from '../ui/Foldable';

/**
 * Every undoable step, oldest first, with the current position marked. Click a
 * step to travel there — undone steps (dimmed) stay available to redo until a
 * new edit replaces them, exactly like repeated `Ctrl+Z`/`Ctrl+Shift+Z`.
 */
export function HistoryPanel() {
  const past = useHistoryStore((s) => s.past);
  const future = useHistoryStore((s) => s.future);
  const jumpTo = useHistoryStore((s) => s.jumpTo);

  const steps = [...past.map((c) => c.label), ...future.map((c) => c.label)];

  return (
    <Foldable id="history" title="History">
      <ol className="history-list" aria-label="Undo history">
        <HistoryRow
          label="Original"
          index={0}
          current={past.length === 0}
          undone={false}
          onJump={jumpTo}
        />
        {steps.map((label, i) => (
          <HistoryRow
            key={i}
            label={label}
            index={i + 1}
            current={past.length === i + 1}
            undone={i >= past.length}
            onJump={jumpTo}
          />
        ))}
      </ol>
    </Foldable>
  );
}

function HistoryRow({
  label,
  index,
  current,
  undone,
  onJump,
}: {
  readonly label: string;
  readonly index: number;
  readonly current: boolean;
  readonly undone: boolean;
  readonly onJump: (pastLength: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={undone ? 'history-step undone' : 'history-step'}
        aria-current={current ? 'step' : undefined}
        title={undone ? 'Redo to here' : 'Go back to here'}
        onClick={() => onJump(index)}
      >
        <span className="history-index">{index}</span>
        {label}
      </button>
    </li>
  );
}
