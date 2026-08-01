/**
 * "AI background removal" runtime affordance in Convert mode's Background
 * section, next to `SegmentModelSection` (`docs/10-decisions.md` D16,
 * `docs/07-tech-stack.md` §6). D15's `load-dynamic` build already made
 * "download the runtime on first use" possible structurally; this component
 * is the actual consent-gated fetch that D16 identifies as the remaining
 * gap — mirroring `SegmentModelSection.tsx` almost exactly and reusing the
 * same generic `downloadConsentedFile` (`modelDownload.ts`) rather than a
 * parallel download mechanism.
 *
 * **Scope, stated honestly rather than implied:** this component downloads
 * and verifies the ONNX Runtime *native library* only. It does not wire the
 * extracted library into `segment::Segmenter` or the conversion pipeline —
 * that is separate, later work, exactly like `SegmentModelSection`'s own
 * disclosed scope for the model file.
 *
 * **The download only ever fires from an explicit confirm click.** Mounting
 * this component calls `onnxRuntimeInfo`/`onnxRuntimeStatus` (both local, no
 * network), never the download itself.
 */

import { useEffect, useState } from 'react';

import {
  hasBackend,
  onnxRuntimeInfo,
  onnxRuntimeStatus,
  downloadOnnxRuntime,
  type OnnxRuntimeInfo,
  type OnnxRuntimeStatus,
} from '../ipc/commands.ts';
import { downloadConsentedFile, formatBytes, sourceHost } from './modelDownload.ts';

type Phase = 'idle' | 'confirming' | 'downloading' | 'success' | 'error';

export function OnnxRuntimeSection() {
  const [info, setInfo] = useState<OnnxRuntimeInfo | undefined>();
  const [status, setStatus] = useState<OnnxRuntimeStatus | undefined>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    if (!hasBackend()) return;
    // Both calls below are local queries (static metadata, a filesystem
    // check) — not network activity, so it is fine to run them on mount.
    onnxRuntimeInfo()
      .then(setInfo)
      .catch(() => undefined);
    onnxRuntimeStatus()
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
    const outcome = await downloadConsentedFile({ download: downloadOnnxRuntime });
    if (outcome.kind === 'success') {
      setPhase('success');
      setStatus({ present: true, path: outcome.path });
    } else {
      setPhase('error');
      setMessage(outcome.message);
    }
  };

  return (
    <div className="onnx-runtime-section">
      <p className="field-note">
        <strong>AI background removal engine</strong> — not bundled with the app, to keep the
        installer small; download it once, on this machine, only if you want AI-based background
        removal.
      </p>

      {status?.present && (
        <p className="field-note" data-testid="onnx-runtime-installed">
          The ONNX Runtime engine is already installed.
        </p>
      )}

      {phase === 'idle' && !status?.present && (
        <button type="button" onClick={startConfirm} disabled={!info}>
          Download AI background-removal engine
        </button>
      )}

      {phase === 'confirming' && info && (
        <div className="onnx-runtime-confirm" role="group" aria-label="Confirm engine download">
          <p className="field-note">
            This will download <strong>{formatBytes(info.approxBytes)}</strong> (about{' '}
            {formatBytes(info.extractedApproxBytes)} once installed) from{' '}
            <strong>{sourceHost(info.sourceUrl)}</strong> ({info.license}, ONNX Runtime{' '}
            {info.version}). Continue?
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
        <div className="onnx-runtime-error">
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
