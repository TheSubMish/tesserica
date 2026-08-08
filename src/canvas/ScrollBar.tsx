/**
 * One canvas scrollbar axis — a custom widget, not a native `overflow:
 * scroll` element, because the canvas's content is never actually laid out
 * in the DOM at its full pixel size (`CanvasView` draws it into a viewport-
 * sized `<canvas>` using `panX`/`panY` as a draw offset, `docs/02-
 * architecture.md` §4). The geometry — thumb size and position — comes from
 * `canvas/coords.ts::scrollBarGeometry`/`panFromScrollOffset`; this
 * component is just the pointer handling and the two rendered `<div>`s.
 *
 * Dragging the thumb and clicking the bare track both end up here: a track
 * click first re-centers the thumb on the click point (`panFromScrollOffset`
 * with the click's own track-relative fraction), then falls straight into
 * the same drag session — one pointer-down handler covers both gestures.
 */

import { useCallback, useRef } from 'react';
import { panFromScrollOffset, scrollBarGeometry } from './coords';

interface ScrollBarProps {
  axis: 'x' | 'y';
  /** This axis' sprite pixel size × zoom. */
  content: number;
  /** This axis' `canvas-wrap` size in screen pixels. */
  viewport: number;
  pan: number;
  onPan: (pan: number) => void;
}

/** The one pointer coordinate that varies by axis — a pure module-level
    helper rather than a closure, so it never needs to be a hook dependency. */
function axisClient(axis: 'x' | 'y', e: { clientX: number; clientY: number }): number {
  return axis === 'x' ? e.clientX : e.clientY;
}

export function ScrollBar({ axis, content, viewport, pan, onPan }: ScrollBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { thumbRatio, thumbOffset } = scrollBarGeometry(content, viewport, pan);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const trackStart = axis === 'x' ? rect.left : rect.top;
      const length = axis === 'x' ? rect.width : rect.height;
      if (length <= 0) return;

      // A click that lands outside the current thumb jumps it to be centred
      // on the click point before the drag below takes over, so one gesture
      // covers both "click the bare track" and "drag the thumb".
      const clickFraction = (axisClient(axis, e) - trackStart) / length;
      const isOnThumb = clickFraction >= thumbOffset && clickFraction <= thumbOffset + thumbRatio;
      let dragStartOffset = thumbOffset;
      if (!isOnThumb) {
        dragStartOffset = Math.min(Math.max(0, clickFraction - thumbRatio / 2), 1 - thumbRatio);
        onPan(panFromScrollOffset(content, viewport, dragStartOffset));
      }

      const startClient = axisClient(axis, e);
      e.currentTarget.setPointerCapture(e.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const deltaFraction = (axisClient(axis, moveEvent) - startClient) / length;
        const nextOffset = Math.min(Math.max(0, dragStartOffset + deltaFraction), 1 - thumbRatio);
        onPan(panFromScrollOffset(content, viewport, nextOffset));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [axis, content, viewport, thumbOffset, thumbRatio, onPan],
  );

  return (
    <div
      ref={trackRef}
      className={`canvas-scrollbar canvas-scrollbar-${axis}`}
      role="scrollbar"
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(thumbOffset * 100)}
      aria-valuemin={0}
      aria-valuemax={Math.round((1 - thumbRatio) * 100)}
      onPointerDown={onPointerDown}
    >
      <div
        className="canvas-scrollbar-thumb"
        style={
          axis === 'x'
            ? { left: `${thumbOffset * 100}%`, width: `${thumbRatio * 100}%` }
            : { top: `${thumbOffset * 100}%`, height: `${thumbRatio * 100}%` }
        }
      />
    </div>
  );
}
