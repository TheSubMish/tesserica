/**
 * Export PNG at an integer scale.
 *
 * The scale choices are 1× / 2× / 4× / 8× and nothing else. Non-integer
 * scaling gives some output pixels three source pixels of width and others
 * four, which at pixel-art sizes is the first thing anyone notices
 * (`docs/02-architecture.md` §9).
 *
 * The document is flattened here and the bytes go to Rust over the raw IPC
 * body; Rust does the upscale and the PNG encode, because Rust owns what the
 * user ships.
 */

import { useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { flattenSprite } from '../canvas/flatten';
import {
  EXPORT_SCALES,
  exportPng,
  hasBackend,
  releaseStaged,
  stageBytes,
  type ExportScale,
} from '../ipc/commands';
import { useDocumentStore } from '../state/documentStore';
import { useModalFocusTrap } from './useModalFocusTrap';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const [scale, setScale] = useState<ExportScale>(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setStatus(null);

    if (!hasBackend()) {
      setError('Export needs the desktop app — the Rust backend is not available here.');
      return;
    }

    let stageId: number | null = null;
    try {
      setBusy(true);
      const path = await save({
        title: 'Export PNG',
        defaultPath: 'sprite.png',
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (!path) return;

      const pixels = flattenSprite(sprite, activeFrameId);
      stageId = await stageBytes(new Uint8Array(pixels.buffer, 0, pixels.byteLength));

      const result = await exportPng({
        stageId,
        width: sprite.width,
        height: sprite.height,
        scale,
        path,
      });
      stageId = null; // the command consumed it
      setStatus(`Wrote ${result.width}×${result.height} to ${result.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // A failed export must not leak the staged megabytes on the Rust side.
      if (stageId !== null) await releaseStaged(stageId).catch(() => {});
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export PNG"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Export PNG</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <fieldset className="scale-row">
          <legend className="sr-only">Scale</legend>
          {EXPORT_SCALES.map((s) => (
            <button
              key={s}
              className="scale-btn"
              aria-pressed={scale === s}
              onClick={() => setScale(s)}
            >
              {s}×
            </button>
          ))}
        </fieldset>

        <p className="hint">
          {sprite.width}×{sprite.height} → {sprite.width * scale}×{sprite.height * scale} ·
          nearest-neighbour
        </p>

        {status && <p className="hint">{status}</p>}
        {error && (
          <p className="hint error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </div>
    </div>
  );
}
