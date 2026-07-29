/**
 * Export dialog — PNG, spritesheet (+ metadata JSON), or animated GIF, all at
 * an integer scale (`docs/08-roadmap.md` Phase 3/4).
 *
 * The scale choices are 1× / 2× / 4× / 8× and nothing else, for every format.
 * Non-integer scaling gives some output pixels three source pixels of width
 * and others four, which at pixel-art sizes is the first thing anyone
 * notices (`docs/02-architecture.md` §9).
 *
 * Every format is flattened here (`canvas/flatten.ts` — export never asks
 * Rust to composite layers) and the bytes go to Rust over the raw IPC body;
 * Rust does the upscale and the encode, because Rust owns what the user
 * ships. Spritesheet/GIF add one more step over single-frame PNG export:
 * picking *which* frames and in *what* order (`export/animationExport.ts`),
 * then concatenating their flattened bytes into one staged buffer instead of
 * one stage call per frame.
 */

import { useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { flattenSprite } from '../canvas/flatten';
import {
  concatFlattenedFrames,
  DEFAULT_SPRITESHEET_COLUMNS,
  gifFrameSequence,
  spritesheetSelection,
} from '../export/animationExport';
import {
  EXPORT_SCALES,
  exportGif,
  exportPng,
  exportSpritesheet,
  hasBackend,
  releaseStaged,
  stageBytes,
  type ExportScale,
} from '../ipc/commands';
import type { TagId } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useModalFocusTrap } from './useModalFocusTrap';

type ExportFormat = 'png' | 'spritesheet' | 'gif';

const FORMAT_LABELS: Record<ExportFormat, string> = {
  png: 'PNG',
  spritesheet: 'Spritesheet',
  gif: 'GIF',
};

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const [format, setFormat] = useState<ExportFormat>('png');
  const [scale, setScale] = useState<ExportScale>(1);
  const [tagId, setTagId] = useState<TagId | null>(null);
  const [columns, setColumns] = useState(DEFAULT_SPRITESHEET_COLUMNS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const multiFrame = format !== 'png';
  const hasTags = sprite.tags.length > 0;

  // Frame count for the current format + scope — used to clamp the columns
  // field and to preview the output dimensions before exporting.
  const previewFrameCount =
    format === 'gif'
      ? gifFrameSequence(sprite, tagId).length
      : spritesheetSelection(sprite, tagId).frames.length;
  const clampedColumns = Math.max(1, Math.min(columns, Math.max(1, previewFrameCount)));

  const runPng = async (path: string) => {
    const pixels = flattenSprite(sprite, activeFrameId);
    const stageId = await stageBytes(new Uint8Array(pixels.buffer, 0, pixels.byteLength));
    try {
      const result = await exportPng({
        stageId,
        width: sprite.width,
        height: sprite.height,
        scale,
        path,
      });
      setStatus(`Wrote ${result.width}×${result.height} to ${result.path}`);
    } catch (e) {
      await releaseStaged(stageId).catch(() => {});
      throw e;
    }
  };

  const runSpritesheet = async (path: string) => {
    const selection = spritesheetSelection(sprite, tagId);
    if (selection.frames.length === 0) throw new Error('No frames to export.');
    const pixels = concatFlattenedFrames(sprite, selection.frames);
    const stageId = await stageBytes(new Uint8Array(pixels.buffer, 0, pixels.byteLength));
    try {
      const result = await exportSpritesheet({
        stageId,
        frameWidth: sprite.width,
        frameHeight: sprite.height,
        scale,
        columns: clampedColumns,
        frames: selection.frames.map((f) => ({ durationMs: f.durationMs })),
        tags: selection.tags,
        path,
      });
      setStatus(
        `Wrote ${result.width}×${result.height} spritesheet (${result.columns}×${result.rows} frames) ` +
          `to ${result.path}, metadata to ${result.jsonPath}`,
      );
    } catch (e) {
      await releaseStaged(stageId).catch(() => {});
      throw e;
    }
  };

  const runGif = async (path: string) => {
    const frames = gifFrameSequence(sprite, tagId);
    if (frames.length === 0) throw new Error('No frames to export.');
    const pixels = concatFlattenedFrames(sprite, frames);
    const stageId = await stageBytes(new Uint8Array(pixels.buffer, 0, pixels.byteLength));
    try {
      const result = await exportGif({
        stageId,
        frameWidth: sprite.width,
        frameHeight: sprite.height,
        scale,
        durationsMs: frames.map((f) => f.durationMs),
        path,
      });
      setStatus(
        `Wrote a ${result.frames}-frame, ${result.width}×${result.height} GIF to ${result.path}`,
      );
    } catch (e) {
      await releaseStaged(stageId).catch(() => {});
      throw e;
    }
  };

  const run = async () => {
    setError(null);
    setStatus(null);

    if (!hasBackend()) {
      setError('Export needs the desktop app — the Rust backend is not available here.');
      return;
    }

    try {
      setBusy(true);
      const path = await save({
        title: `Export ${FORMAT_LABELS[format]}`,
        defaultPath: format === 'gif' ? 'sprite.gif' : 'sprite.png',
        filters: [
          format === 'gif'
            ? { name: 'GIF image', extensions: ['gif'] }
            : { name: 'PNG image', extensions: ['png'] },
        ],
      });
      if (!path) return;

      if (format === 'png') await runPng(path);
      else if (format === 'spritesheet') await runSpritesheet(path);
      else await runGif(path);
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
        aria-label="Export"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Export</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <fieldset className="scale-row">
          <legend className="sr-only">Format</legend>
          {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
            <button
              key={f}
              className="scale-btn"
              aria-pressed={format === f}
              onClick={() => setFormat(f)}
            >
              {FORMAT_LABELS[f]}
            </button>
          ))}
        </fieldset>

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

        {multiFrame && hasTags && (
          <label className="field">
            <span>Frames</span>
            <select
              aria-label="Frame range"
              value={tagId ?? ''}
              onChange={(e) => setTagId(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">All frames ({sprite.frames.length})</option>
              {sprite.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.to - t.from + 1})
                </option>
              ))}
            </select>
          </label>
        )}

        {format === 'spritesheet' && (
          <label className="field">
            <span>Columns</span>
            <input
              type="number"
              className="dim-input"
              aria-label="Columns"
              min={1}
              max={Math.max(1, previewFrameCount)}
              // Shows the *effective* (clamped) value, not the raw stored one
              // — otherwise the field could read "4" while the hint below it
              // (and the actual export) uses 3, which reads as a bug rather
              // than a deliberate clamp.
              value={clampedColumns}
              onChange={(e) => setColumns(Math.round(e.target.valueAsNumber) || 1)}
            />
          </label>
        )}

        <p className="hint">
          {format === 'png' &&
            `${sprite.width}×${sprite.height} → ${sprite.width * scale}×${sprite.height * scale} · nearest-neighbour`}
          {format === 'spritesheet' &&
            `${previewFrameCount} frame${previewFrameCount === 1 ? '' : 's'} · ` +
              `${clampedColumns}×${Math.ceil(previewFrameCount / clampedColumns)} grid · ` +
              `${sprite.width * scale}×${sprite.height * scale} per frame`}
          {format === 'gif' &&
            `${previewFrameCount} frame${previewFrameCount === 1 ? '' : 's'} · ` +
              `${sprite.width * scale}×${sprite.height * scale} · loops`}
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
