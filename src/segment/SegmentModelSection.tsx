/**
 * "AI background removal" affordance in Convert mode's Background section
 * (`docs/08-roadmap.md` Phase 5 "on-demand download for larger models with
 * explicit consent"), next to the method radio group
 * (`src/convert/ConvertPanel.tsx`).
 *
 * **Scope, stated honestly rather than implied:** this component manages the
 * segmentation *model* — showing which one is installed and offering an
 * explicit, consent-gated download of a larger one. `ConvertPanel`'s "AI
 * segmentation" radio uses whichever model `segment::Segmenter` actually
 * loads (`commands::segment::resolve_model_path` prefers a downloaded larger
 * model over the bundled `u2netp` once present, since the whole point of
 * downloading it is better quality) — but only takes effect from the *next*
 * app start if a session was already loaded from the bundled model this run;
 * see that function's own doc comment.
 *
 * **The download only ever fires from an explicit confirm click.** Mounting
 * this component calls `segmentationModelInfo`/`segmentationModelStatus`
 * (both local, no network — see `docs/02-architecture.md` §6.2 and
 * `CLAUDE.md` "No network calls in the core"), never the download itself.
 */

import { useEffect, useState } from 'react';

import {
  hasBackend,
  segmentationModelInfo,
  segmentationModelStatus,
  downloadSegmentationModel,
  type SegmentationModelInfo,
  type SegmentationModelStatus,
} from '../ipc/commands.ts';
import { downloadConsentedFile, formatBytes, sourceHost } from './modelDownload.ts';

type Phase = 'idle' | 'confirming' | 'downloading' | 'success' | 'error';

export function SegmentModelSection() {
  const [info, setInfo] = useState<SegmentationModelInfo | undefined>();
  const [status, setStatus] = useState<SegmentationModelStatus | undefined>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    if (!hasBackend()) return;
    // Both calls below are local queries (static metadata, a filesystem
    // check) — not network activity, so it is fine to run them on mount.
    segmentationModelInfo()
      .then(setInfo)
      .catch(() => undefined);
    segmentationModelStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const startConfirm = () => {
    setMessage(undefined);
    setPhase('confirming');
  };

  const cancelConfirm = () => setPhase('idle');

  const confirmDownload = async () => {
    if (!info) return;
    setPhase('downloading');
    const outcome = await downloadConsentedFile({ download: downloadSegmentationModel });
    if (outcome.kind === 'success') {
      setPhase('success');
      setStatus({ present: true, path: outcome.path });
    } else {
      setPhase('error');
      setMessage(outcome.message);
    }
  };

  return (
    <div className="segment-model-section">
      <p className="field-note">
        <strong>AI background removal</strong> — uses the small bundled model by default. Model
        management only in this build; it does not yet change what background removal does to your
        image.
      </p>

      {status?.present && (
        <p className="field-note" data-testid="segment-model-installed">
          A larger model is already installed.
        </p>
      )}

      {phase === 'idle' && !status?.present && (
        <button type="button" onClick={startConfirm} disabled={!info}>
          Download larger model for better quality
        </button>
      )}

      {phase === 'confirming' && info && (
        <div className="segment-model-confirm" role="group" aria-label="Confirm model download">
          <p className="field-note">
            This will download <strong>{formatBytes(info.approxBytes)}</strong> from{' '}
            <strong>{sourceHost(info.sourceUrl)}</strong> ({info.license}). Continue?
          </p>
          <div className="modal-actions">
            <button type="button" onClick={cancelConfirm}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void confirmDownload()}>
              Download
            </button>
          </div>
        </div>
      )}

      {phase === 'downloading' && <p className="field-note">Downloading…</p>}

      {phase === 'success' && <p className="field-note">Downloaded and verified successfully.</p>}

      {phase === 'error' && (
        <div className="segment-model-error">
          <p className="field-note" role="alert">
            {message}
          </p>
          <button type="button" onClick={startConfirm}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
