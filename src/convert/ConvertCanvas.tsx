import { useCallback, useEffect, useRef, useState } from 'react';

import { useConvertStore } from '../state/convertStore';
import { fitRect, type Size } from './fit.ts';
import { previewRuntime, type PreviewFrames } from './previewRuntime.ts';

/**
 * Before/after comparison (`docs/05-ui-design.md` §3).
 *
 * "Before/after is the default view. Users judge conversion by comparison."
 * Both offered modes are here: a draggable **split** slider and **side-by-side**.
 *
 * The result is drawn with `imageSmoothingEnabled = false` — nearest-neighbour
 * on every pixel-art path, no exceptions. Drawing a 64×48 result into a 600px
 * box with smoothing on would show the user a blurred image and then export
 * sharp blocks.
 */
export function ConvertCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [frames, setFrames] = useState<PreviewFrames>(previewRuntime.current);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const viewMode = useConvertStore((s) => s.viewMode);
  const splitAt = useConvertStore((s) => s.splitAt);
  const setSplitAt = useConvertStore((s) => s.setSplitAt);

  useEffect(() => previewRuntime.subscribe(setFrames), []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(1, Math.floor(entry.contentRect.width)),
        height: Math.max(1, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 1) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = size.width;
    canvas.height = size.height;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = false;

    if (viewMode === 'side') drawSideBySide(ctx, frames, size);
    else drawSplit(ctx, frames, size, splitAt);
  }, [frames, size, viewMode, splitAt]);

  const onPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (viewMode !== 'split' || event.buttons === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setSplitAt((event.clientX - rect.left) / rect.width);
    },
    [viewMode, setSplitAt],
  );

  const empty = !frames.source;

  return (
    <div
      className="convert-canvas"
      ref={boxRef}
      onPointerDown={onPointer}
      onPointerMove={onPointer}
    >
      <canvas ref={canvasRef} />
      {viewMode === 'split' && !empty && (
        <div
          className="convert-split-handle"
          style={{ left: `${splitAt * 100}%` }}
          role="separator"
          aria-label="Before/after split"
          aria-valuenow={Math.round(splitAt * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSplitAt(splitAt - 0.02);
            if (e.key === 'ArrowRight') setSplitAt(splitAt + 0.02);
          }}
        />
      )}
      {empty && <p className="convert-empty">Drop an image here, or use File ▸ Open image…</p>}
    </div>
  );
}

function toBitmapCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas;
}

function drawSplit(
  ctx: CanvasRenderingContext2D,
  frames: PreviewFrames,
  box: Size,
  splitAt: number,
): void {
  const { source, result } = frames;
  if (!source) return;

  const rect = fitRect(source, box);
  ctx.drawImage(toBitmapCanvas(source), rect.x, rect.y, rect.w, rect.h);

  if (!result) return;
  const cut = box.width * splitAt;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cut, 0, box.width - cut, box.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  // Deliberately drawn into the *source's* rect, so the two images line up and
  // the split compares the same region rather than two different framings.
  ctx.drawImage(toBitmapCanvas(result), rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawSideBySide(ctx: CanvasRenderingContext2D, frames: PreviewFrames, box: Size): void {
  const { source, result } = frames;
  if (!source) return;

  const half = { width: box.width / 2 - 8, height: box.height };

  const left = fitRect(source, half);
  ctx.drawImage(toBitmapCanvas(source), left.x, left.y, left.w, left.h);

  if (!result) return;
  const right = fitRect(result, half);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(toBitmapCanvas(result), box.width / 2 + 8 + right.x, right.y, right.w, right.h);
}
