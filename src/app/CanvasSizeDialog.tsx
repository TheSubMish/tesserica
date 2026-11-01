import { useRef, useState } from 'react';

import { resizeCanvas } from '../history/spriteCommands';
import { ANCHORS, type Anchor } from '../model/spriteTransform';
import { useDocumentStore } from '../state/documentStore';
import { MAX_SPRITE_SIZE, MIN_SPRITE_SIZE } from './newSprite';
import { useModalFocusTrap } from './useModalFocusTrap';

const ARROWS: Record<Anchor, string> = {
  tl: '↖',
  t: '↑',
  tr: '↗',
  l: '←',
  c: '•',
  r: '→',
  bl: '↙',
  b: '↓',
  br: '↘',
};

/**
 * Canvas Size: new dimensions plus a 3×3 anchor saying where the existing pixels
 * sit. Growing pads with transparency; shrinking crops the side away from the
 * anchor (`docs/03-data-model.md` §6.1). Undoable as one step.
 */
export function CanvasSizeDialog({ onClose }: { onClose: () => void }) {
  const sprite = useDocumentStore((s) => s.sprite);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);

  const [width, setWidth] = useState(sprite.width);
  const [height, setHeight] = useState(sprite.height);
  const [anchor, setAnchor] = useState<Anchor>('c');
  const [error, setError] = useState<string | null>(null);

  const apply = (): void => {
    const result = resizeCanvas(width, height, anchor);
    if (result.ok) onClose();
    else setError(result.message);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Canvas size"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <span>Canvas Size</span>
          <button aria-label="Close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="hint">
          Currently {sprite.width} × {sprite.height}.
        </p>

        <div className="field dims-row">
          <label>
            <span className="sr-only">Width</span>
            <input
              type="number"
              className="dim-input"
              aria-label="Width"
              min={MIN_SPRITE_SIZE}
              max={MAX_SPRITE_SIZE}
              value={Number.isNaN(width) ? '' : width}
              onChange={(e) => setWidth(e.target.valueAsNumber)}
            />
          </label>
          <span aria-hidden="true">×</span>
          <label>
            <span className="sr-only">Height</span>
            <input
              type="number"
              className="dim-input"
              aria-label="Height"
              min={MIN_SPRITE_SIZE}
              max={MAX_SPRITE_SIZE}
              value={Number.isNaN(height) ? '' : height}
              onChange={(e) => setHeight(e.target.valueAsNumber)}
            />
          </label>
        </div>

        <fieldset className="anchor-grid">
          <legend>Anchor</legend>
          {ANCHORS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={anchor === a}
              aria-label={`Anchor ${a}`}
              onClick={() => setAnchor(a)}
            >
              {ARROWS[a]}
            </button>
          ))}
        </fieldset>

        {error && (
          <p className="hint error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
