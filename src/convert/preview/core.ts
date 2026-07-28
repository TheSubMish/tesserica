/**
 * The worker's actual logic, with no `self` and no `postMessage` in sight.
 *
 * Separated from `worker.ts` so it can be tested directly. A Web Worker is
 * awkward to drive from a test runner, and the interesting behaviour — proxy
 * lifetime, error handling, what a result contains — has nothing to do with
 * being in a worker.
 */

import { bufferFrom, type PixelBuffer } from '../../pipeline/buffer.ts';
import { convert } from '../../pipeline/convert.ts';
import { TRANSPARENT_INDEX } from '../../pipeline/quantize.ts';
import type { PreviewRequest, PreviewResponse, ProxyId } from './protocol.ts';

/** What a handled request wants sent back, and what should be transferred. */
export interface Outgoing {
  readonly response: PreviewResponse;
  readonly transfer: readonly ArrayBuffer[];
}

export class PreviewCore {
  private readonly proxies = new Map<ProxyId, PixelBuffer>();

  get proxyCount(): number {
    return this.proxies.size;
  }

  /**
   * Handle one request.
   *
   * Returns `undefined` for requests that produce no reply — holding a proxy and
   * releasing one are both silent, because a round trip for them would only add
   * latency to the next slider tick.
   */
  handle(request: PreviewRequest): Outgoing | undefined {
    switch (request.type) {
      case 'setProxy':
        this.proxies.set(
          request.proxyId,
          bufferFrom(request.width, request.height, new Uint8ClampedArray(request.data)),
        );
        return undefined;

      case 'releaseProxy':
        this.proxies.delete(request.proxyId);
        return undefined;

      case 'convert':
        return this.convert(request.jobId, request.proxyId, request);
    }
  }

  private convert(
    jobId: number,
    proxyId: ProxyId,
    request: Extract<PreviewRequest, { type: 'convert' }>,
  ): Outgoing {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) {
      return {
        response: {
          type: 'error',
          jobId,
          message: `no proxy ${proxyId} in this worker`,
          reason: 'missing-proxy',
        },
        transfer: [],
      };
    }

    const started = performance.now();
    try {
      const result = convert(proxy, request.settings);
      const elapsedMs = performance.now() - started;

      const used = new Set<number>();
      for (const i of result.indices) if (i !== TRANSPARENT_INDEX) used.add(i);

      // The buffers are freshly allocated by the pipeline, so transferring them
      // is safe: nothing on this side keeps a reference.
      const data = toArrayBuffer(result.image.data);
      const indices = result.indices.buffer as ArrayBuffer;

      return {
        response: {
          type: 'result',
          jobId,
          width: result.image.width,
          height: result.image.height,
          data,
          indices,
          colorsUsed: used.size,
          elapsedMs,
        },
        transfer: [data, indices],
      };
    } catch (err) {
      // A settings combination the pipeline refuses — an unresolved `auto`
      // palette, a crop that misses — is a message for the user, not a dead
      // worker. Reporting it against the job id keeps it attributable.
      return {
        response: {
          type: 'error',
          jobId,
          message: err instanceof Error ? err.message : String(err),
        },
        transfer: [],
      };
    }
  }
}

function toArrayBuffer(view: Uint8ClampedArray): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : (view.slice().buffer as ArrayBuffer);
}
