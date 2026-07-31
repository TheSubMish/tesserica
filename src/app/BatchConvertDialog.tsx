/**
 * File → Batch Convert… (`docs/08-roadmap.md` Phase 7 "Batch conversion + CLI
 * headless mode", `docs/06-workflows.md` W5).
 *
 * The five W5 steps in one dialog: pick a source folder, configure once
 * (pixel size, palette, dither, strength — the same four primary controls
 * Convert mode itself exposes, `05-ui-design.md` §3), optionally pull the
 * rest of the settings from an existing conversion layer in the current
 * document, run with a live per-file progress list, and cancel mid-batch.
 *
 * Deliberately **not** wired to the live `useConvertStore` singleton: that
 * store is Convert mode's own interactive session, and this dialog can be
 * open at the same time (or run against a completely different folder than
 * whatever is currently loaded there) without the two fighting over one
 * global's fields. State here is local to the dialog.
 */

import { useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { DITHER_LABELS } from '../convert/ditherLabels';
import {
  batchConvert,
  cancelBatchConvert,
  EXPORT_SCALES,
  hasBackend,
  type BatchConvertEvent,
  type BatchConvertSummary,
  type ExportScale,
} from '../ipc/commands';
import type { ConvertSettings, DitherMode, PaletteSpec } from '../pipeline/settings';
import { defaultSettings } from '../pipeline/settings';
import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import type { Layer } from '../model/types';
import {
  MAX_PIXEL_SIZE,
  MIN_PIXEL_SIZE,
  paletteColors as builtinPaletteColors,
} from '../state/convertStore';
import { useDocumentStore } from '../state/documentStore';
import { SliderField } from './SliderField';
import { useModalFocusTrap } from './useModalFocusTrap';

function isConversionLayer(l: Layer): l is Layer & { kind: 'conversion' } {
  return l.kind === 'conversion';
}

type RowStatus = 'running' | 'ok' | 'fail';

interface Row {
  file: string;
  status: RowStatus;
  detail?: string;
}

const NEUTRAL_PALETTE: PaletteSpec = {
  kind: 'fixed',
  colors: builtinPaletteColors(BUILTIN_PALETTES[0].id),
};

export function BatchConvertDialog({ onClose }: { onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const conversionLayer = useDocumentStore((s) => s.sprite.layers.find(isConversionLayer));

  const [sourceFolder, setSourceFolder] = useState('');
  const [outFolder, setOutFolder] = useState('');

  // --- the four primary controls, same vocabulary as Convert mode's own
  // panel (`docs/05-ui-design.md` §3) ---
  const [pixelSize, setPixelSize] = useState(12);
  const [paletteId, setPaletteId] = useState<string>(BUILTIN_PALETTES[0].id);
  const [palette, setPalette] = useState<PaletteSpec>(NEUTRAL_PALETTE);
  const [dither, setDither] = useState<DitherMode>('none');
  const [ditherStrength, setDitherStrength] = useState(0.8);
  const [scale, setScale] = useState<ExportScale>(1);

  // Everything else (adjustments, background removal, cleanup…) — neutral
  // until "Use these settings" pulls a whole `ConvertSettings` in.
  const [baseSettings, setBaseSettings] = useState<ConvertSettings>(() =>
    defaultSettings(1, 1, NEUTRAL_PALETTE),
  );
  const [loadedFromLayer, setLoadedFromLayer] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [summary, setSummary] = useState<BatchConvertSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickSourceFolder = async () => {
    const picked = await open({ title: 'Source folder', directory: true, multiple: false });
    if (typeof picked === 'string') setSourceFolder(picked);
  };
  const pickOutFolder = async () => {
    const picked = await open({ title: 'Output folder', directory: true, multiple: false });
    if (typeof picked === 'string') setOutFolder(picked);
  };

  const useLayerSettings = () => {
    if (!conversionLayer) return;
    const s = conversionLayer.source.settings;
    setBaseSettings(s);
    setPalette(s.palette);
    setDither(s.dither);
    setDitherStrength(s.ditherStrength);
    setPaletteId('custom');
    setLoadedFromLayer(conversionLayer.name);
  };

  const choosePalette = (id: string) => {
    setPaletteId(id);
    setPalette({ kind: 'fixed', colors: builtinPaletteColors(id) });
    setLoadedFromLayer(null);
  };

  const run = async () => {
    setError(null);
    setSummary(null);
    setRows({});
    setTotal(0);

    if (!hasBackend()) {
      setError('Batch conversion needs the desktop app — the Rust backend is not available here.');
      return;
    }
    if (!sourceFolder || !outFolder) {
      setError('Choose a source folder and an output folder first.');
      return;
    }

    const settings: ConvertSettings = { ...baseSettings, palette, dither, ditherStrength };

    setRunning(true);
    try {
      const result = await batchConvert(
        { folder: sourceFolder, outFolder, pixelSize, settings, scale },
        (event: BatchConvertEvent) => {
          switch (event.kind) {
            case 'started':
              setJobId(event.jobId);
              setTotal(event.total);
              break;
            case 'fileStarted':
              setRows((r) => ({ ...r, [event.index]: { file: event.file, status: 'running' } }));
              break;
            case 'fileSucceeded':
              setRows((r) => ({
                ...r,
                [event.index]: {
                  file: event.file,
                  status: 'ok',
                  detail: `${event.width}×${event.height}, ${event.colorsUsed} colour${event.colorsUsed === 1 ? '' : 's'}`,
                },
              }));
              break;
            case 'fileFailed':
              setRows((r) => ({
                ...r,
                [event.index]: { file: event.file, status: 'fail', detail: event.error },
              }));
              break;
            case 'finished':
              break;
          }
        },
      );
      setSummary(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setJobId(null);
    }
  };

  const cancel = () => {
    if (jobId !== null) void cancelBatchConvert(jobId);
  };

  const orderedRows = Object.entries(rows)
    .map(([index, row]) => ({ index: Number(index), ...row }))
    .sort((a, b) => a.index - b.index);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Batch Convert"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Batch Convert</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field">
          <span>Source folder</span>
          <div className="dims-row">
            <span className="field-note">{sourceFolder || 'Not selected'}</span>
            <button type="button" disabled={running} onClick={() => void pickSourceFolder()}>
              Choose…
            </button>
          </div>
        </label>

        <label className="field">
          <span>Output folder</span>
          <div className="dims-row">
            <span className="field-note">{outFolder || 'Not selected'}</span>
            <button type="button" disabled={running} onClick={() => void pickOutFolder()}>
              Choose…
            </button>
          </div>
        </label>

        {conversionLayer && (
          <button type="button" disabled={running} onClick={useLayerSettings}>
            Use settings from “{conversionLayer.name}”
          </button>
        )}
        {loadedFromLayer && (
          <p className="field-note" role="status">
            Palette, dither and every other setting loaded from “{loadedFromLayer}” — still editable
            below.
          </p>
        )}

        <SliderField
          label="Pixel size"
          min={MIN_PIXEL_SIZE}
          max={MAX_PIXEL_SIZE}
          value={pixelSize}
          disabled={running}
          onChange={(v) => setPixelSize(Math.round(v))}
        />

        <label className="field">
          <span>Palette</span>
          <select
            value={paletteId}
            disabled={running}
            onChange={(e) => choosePalette(e.target.value)}
          >
            {BUILTIN_PALETTES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.colors.length})
              </option>
            ))}
            {paletteId === 'custom' && (
              <option value="custom" disabled>
                Custom (from layer)
              </option>
            )}
          </select>
        </label>

        <label className="field">
          <span>Dither</span>
          <select
            value={dither}
            disabled={running}
            onChange={(e) => setDither(e.target.value as DitherMode)}
          >
            {DITHER_LABELS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <SliderField
          label="Strength"
          min={0}
          max={1}
          step={0.05}
          value={ditherStrength}
          disabled={running || dither === 'none'}
          format={(v) => v.toFixed(2)}
          onChange={setDitherStrength}
        />

        <fieldset className="scale-row">
          <legend className="sr-only">Export scale</legend>
          {EXPORT_SCALES.map((s) => (
            <button
              key={s}
              type="button"
              className="scale-btn"
              aria-pressed={scale === s}
              disabled={running}
              onClick={() => setScale(s)}
            >
              {s}×
            </button>
          ))}
        </fieldset>

        {(running || total > 0) && (
          <div className="field-note" role="status">
            <p>
              {total > 0 ? `${orderedRows.length} / ${total} processed` : 'Starting…'}
              {summary &&
                ` — ${summary.succeeded} succeeded, ${summary.failed} failed${summary.cancelled ? ' (cancelled)' : ''}`}
            </p>
            <ul className="batch-progress-list">
              {orderedRows.map((row) => (
                <li key={row.index} className={`batch-row batch-row-${row.status}`}>
                  <span aria-hidden="true">
                    {row.status === 'running' ? '…' : row.status === 'ok' ? '✓' : '✗'}
                  </span>{' '}
                  {row.file}
                  {row.detail ? ` — ${row.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="hint error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          {running && (
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          )}
          <button
            className="primary"
            disabled={running || !sourceFolder || !outFolder}
            onClick={() => void run()}
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
