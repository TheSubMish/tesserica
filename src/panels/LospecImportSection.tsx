/**
 * "Import from Lospec URL…" — Palette panel, next to the existing file
 * `⬇ Import` button (`docs/06-workflows.md` W8 step 4; parsing/fetch logic
 * in `lib/lospecImport.ts`).
 *
 * **The fetch only ever fires from an explicit "Fetch from lospec.com"
 * click**, never on paste, never on mount, mirroring
 * `segment/SegmentModelSection.tsx`'s consent pattern: opening the form only
 * reveals a text field, and the URL is validated locally (no network) as the
 * user types so a bad URL is caught before the confirm button is even
 * enabled — but nothing is fetched until that button is pressed.
 *
 * The actual GET happens in Rust (`ipc/commands.ts::fetchLospecPalette` →
 * `src-tauri/src/commands/lospec.rs`), not via a frontend `fetch()` like the
 * segmentation-model download — `lospec.com` sends no CORS header, so a
 * WebView-context `fetch()` to it fails outright (verified live; see that
 * Rust module's doc comment). This component only decides *when* to ask for
 * it, same as every other opt-in network affordance in this app.
 */

import { useState } from 'react';
import { fetchLospecPalette } from '../ipc/commands';
import { importLospecPalette, parseLospecUrl } from '../lib/lospecImport';
import { usePaletteStore } from '../state/paletteStore';

type Phase = 'idle' | 'fetching' | 'success' | 'error';

export function LospecImportSection() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>();
  const [importedName, setImportedName] = useState<string | undefined>();

  const validation = parseLospecUrl(url);

  const openForm = () => {
    setOpen(true);
    setPhase('idle');
    setMessage(undefined);
  };

  const closeForm = () => {
    setOpen(false);
    setUrl('');
    setPhase('idle');
    setMessage(undefined);
  };

  const confirmFetch = async () => {
    setPhase('fetching');
    setMessage(undefined);
    const outcome = await importLospecPalette(url, { fetchImpl: fetchLospecPalette });
    if (outcome.kind === 'success') {
      usePaletteStore.getState().addPalette(outcome.palette);
      setImportedName(outcome.palette.name);
      setPhase('success');
    } else {
      setPhase('error');
      setMessage(outcome.message);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="lospec-import-toggle"
        title="Fetch a palette directly from a lospec.com URL"
        onClick={openForm}
      >
        Import from Lospec URL…
      </button>
    );
  }

  return (
    <div className="lospec-import-section" role="group" aria-label="Import from Lospec URL">
      <label className="field">
        <span className="sr-only">Lospec palette URL</span>
        <input
          type="text"
          inputMode="url"
          placeholder="https://lospec.com/palette-list/..."
          aria-label="Lospec palette URL"
          value={url}
          disabled={phase === 'fetching'}
          onChange={(e) => {
            setUrl(e.target.value);
            setPhase('idle');
            setMessage(undefined);
          }}
        />
      </label>

      <p className="field-note">
        Fetches palette data directly from <strong>lospec.com</strong> over the network — only when
        you click Fetch below.
      </p>

      {url.trim() !== '' && validation.kind === 'error' && phase === 'idle' && (
        <p className="hint error" role="alert">
          {validation.message}
        </p>
      )}

      {(phase === 'idle' || phase === 'fetching') && (
        <div className="modal-actions">
          <button type="button" onClick={closeForm} disabled={phase === 'fetching'}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={validation.kind === 'error' || phase === 'fetching'}
            onClick={() => void confirmFetch()}
          >
            {phase === 'fetching' ? 'Fetching…' : 'Fetch from lospec.com'}
          </button>
        </div>
      )}

      {phase === 'success' && (
        <>
          <p className="field-note" role="status">
            Imported <strong>{importedName}</strong> — added to your palette library.
          </p>
          <div className="modal-actions">
            <button type="button" onClick={closeForm}>
              Close
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <div className="lospec-import-error">
          <p className="hint error" role="alert">
            {message}
          </p>
          <div className="modal-actions">
            <button type="button" onClick={closeForm}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={validation.kind === 'error'}
              onClick={() => void confirmFetch()}
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
