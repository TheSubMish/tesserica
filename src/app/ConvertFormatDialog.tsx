/**
 * File → Convert Image Format… — a standalone "open a file, re-encode it as
 * a different image format" utility (`src-tauri/src/commands/format_convert.rs`).
 *
 * Deliberately outside both app modes (`docs/10-decisions.md` D6/D7 lock
 * `Convert | Edit` to the *pixel-art* pipeline — this is a plain file-format
 * transcode, no pixel size, no palette, no dither): picking a source photo
 * here never touches `useConvertStore` or the open document, the same
 * "local to the dialog" reasoning `BatchConvertDialog` already uses for its
 * own folder-of-files job.
 */

import { useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { convertImageFormat, hasBackend } from '../ipc/commands';
import {
  ALL_CONVERTIBLE_EXTENSIONS,
  IMAGE_FORMAT_OPTIONS,
  withFormatExtension,
  type ImageFormatOption,
} from './imageFormats';
import { useModalFocusTrap } from './useModalFocusTrap';

export function ConvertFormatDialog({ onClose }: { onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const [inputPath, setInputPath] = useState('');
  const [format, setFormat] = useState<ImageFormatOption>(IMAGE_FORMAT_OPTIONS[0]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same try/catch-around-`open()` shape as `BatchConvertDialog`'s own
  // folder pickers: outside the Tauri shell (or a platform picker error)
  // `open()` rejects rather than resolving `null`.
  const pickInput = async () => {
    try {
      const picked = await open({
        title: 'Choose an image',
        multiple: false,
        filters: [
          { name: 'Images', extensions: ALL_CONVERTIBLE_EXTENSIONS },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (typeof picked === 'string') {
        setInputPath(picked);
        setStatus(null);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    setError(null);
    setStatus(null);

    if (!hasBackend()) {
      setError('Converting needs the desktop app — the Rust backend is not available here.');
      return;
    }
    if (!inputPath) {
      setError('Choose an image first.');
      return;
    }

    try {
      const outputPath = await save({
        title: `Save as ${format.label}`,
        defaultPath: withFormatExtension(inputPath, format),
        filters: [{ name: format.label, extensions: format.extensions }],
      });
      if (!outputPath) return;

      setBusy(true);
      const result = await convertImageFormat({ inputPath, outputPath, format: format.id });
      setStatus(`Wrote ${result.width}×${result.height} to ${result.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Convert Image Format"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Convert Image Format</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field">
          <span>Image</span>
          <div className="dims-row">
            <span className="field-note">
              {inputPath ? inputPath.split('/').pop() : 'Not selected'}
            </span>
            <button type="button" disabled={busy} onClick={() => void pickInput()}>
              Choose…
            </button>
          </div>
        </label>

        <label className="field">
          <span>Convert to</span>
          <select
            value={format.id}
            disabled={busy}
            onChange={(e) => {
              const next = IMAGE_FORMAT_OPTIONS.find((f) => f.id === e.target.value);
              if (next) setFormat(next);
            }}
          >
            {IMAGE_FORMAT_OPTIONS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        {status && (
          <p className="hint" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="hint error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !inputPath} onClick={() => void run()}>
            {busy ? 'Converting…' : 'Convert…'}
          </button>
        </div>
      </div>
    </div>
  );
}
