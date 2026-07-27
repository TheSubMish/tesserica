import { useEffect } from 'react';

import { buildSettings, useConvertStore } from '../state/convertStore';
import { ConvertCanvas } from './ConvertCanvas';
import { ConvertPanel } from './ConvertPanel';
import { previewRuntime } from './previewRuntime.ts';

/**
 * Convert mode (`docs/05-ui-design.md` §3, D6).
 *
 * The layout is the reference spine: comparison view on the left, four primary
 * controls on the right, `[ Export… ]` and `[ Edit → ]` at the bottom.
 *
 * Every settings change re-requests a preview. That is safe to do on every
 * pointer move because the scheduler coalesces — see
 * `preview/scheduler.ts`, which never allows more than one job outstanding.
 */
export interface ConvertModeProps {
  readonly onExport: () => void;
  readonly onEdit: () => void;
  readonly onNotice: (text: string, error: boolean) => void;
}

export function ConvertMode({ onExport, onEdit, onNotice }: ConvertModeProps) {
  const store = useConvertStore();

  useEffect(() => {
    previewRuntime.start({
      onMeta: (meta) => useConvertStore.getState().setPreview(meta),
      onError: (message) => useConvertStore.getState().setError(message),
      onBusyChange: (busy) => useConvertStore.getState().setBusy(busy),
    });
  }, []);

  // Re-request whenever anything the pipeline reads changes. Coalescing lives
  // in the scheduler, so this deliberately does not debounce: debouncing here
  // would add latency on top of a mechanism that already drops stale work.
  const source = store.source;
  const settingsKey = JSON.stringify(source ? buildSettings(store) : null);
  useEffect(() => {
    if (!source) return;
    useConvertStore.getState().setError(undefined);
    previewRuntime.request(buildSettings(useConvertStore.getState()));
  }, [source, settingsKey]);

  return (
    <div className="convert-mode">
      <div className="convert-stage">
        <ConvertCanvas />
        <div className="convert-viewswitch" role="group" aria-label="Comparison view">
          <button
            type="button"
            aria-pressed={store.viewMode === 'split'}
            onClick={() => store.setViewMode('split')}
          >
            ⇄ split
          </button>
          <button
            type="button"
            aria-pressed={store.viewMode === 'side'}
            onClick={() => store.setViewMode('side')}
          >
            ⬓ side
          </button>
        </div>
      </div>
      <ConvertPanel onExport={onExport} onEdit={onEdit} />
      {store.error && (
        <p className="convert-error" role="alert">
          {store.error}
        </p>
      )}
      <span className="visually-hidden" aria-live="polite">
        {store.busy ? 'Converting' : 'Preview ready'}
      </span>
      {/* Kept mounted so the notice callback is exercised from one place. */}
      <ConvertOpenBridge onNotice={onNotice} />
    </div>
  );
}

function ConvertOpenBridge({ onNotice }: { onNotice: (text: string, error: boolean) => void }) {
  useEffect(() => {
    // Nothing to do at mount; the bridge exists so `loadSourceImage` below has
    // a single owner for its error reporting.
    void onNotice;
  }, [onNotice]);
  return null;
}
