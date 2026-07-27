/**
 * The pixel buffer every pipeline stage passes to the next.
 *
 * Mirrors `src-tauri/src/pipeline/buffer.rs`.
 *
 * **Straight alpha, never premultiplied** — the invariant that stops palette
 * quantization from fringing transparent edges (`docs/02-architecture.md` §9).
 * Nothing in the pipeline may premultiply, not even temporarily, without
 * un-premultiplying before the next stage sees it.
 */

export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, straight alpha, `width * height * 4` bytes. */
  readonly data: Uint8ClampedArray;
}

export function createBuffer(width: number, height: number): PixelBuffer {
  assertPositive(width, height);
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function bufferFrom(width: number, height: number, data: Uint8ClampedArray): PixelBuffer {
  assertPositive(width, height);
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(`buffer is ${data.length} bytes, expected ${expected} for ${width}x${height}`);
  }
  return { width, height, data };
}

function assertPositive(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`buffer dimensions must be positive integers, got ${width}x${height}`);
  }
}

/** Byte offset of pixel (x, y). No bounds check — callers loop in range. */
export function offset(buf: PixelBuffer, x: number, y: number): number {
  return (y * buf.width + x) * 4;
}
