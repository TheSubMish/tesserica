/**
 * Latest-wins scheduling for conversion previews (`docs/02-architecture.md` §8).
 *
 * The problem: dragging a slider fires settings changes far faster than a
 * conversion completes. Sending each one queues stale work, and by the time the
 * queue drains the user has moved on.
 *
 * The rule: **at most one job is ever outstanding.** A request that arrives
 * while one is in flight replaces any other waiting request rather than joining
 * a queue, and is dispatched when the in-flight result lands. Superseded
 * requests are never sent, so the worker never spends a millisecond on settings
 * nobody is looking at any more.
 *
 * **Why not truly abort the running job?** JavaScript cannot preempt a worker
 * mid-computation. The alternatives are terminating the worker (which throws
 * away the proxy it holds, making the next preview slower than the one being
 * cancelled) or chunking the pipeline with yield points (which costs more, in
 * both complexity and per-pixel overhead, than one whole proxy-resolution
 * conversion). Coalescing to one outstanding job gets the same user-visible
 * behaviour: at most one stale frame, never a backlog.
 *
 * Deliberately free of `Worker` and of React: it takes a `post` function and
 * hands results to a callback, so pixel buffers stay out of React state
 * entirely.
 */

import type { PixelBuffer } from '../../pipeline/buffer.ts';
import type { ConvertSettings } from '../../pipeline/settings.ts';
import type {
  JobId,
  PreviewRequest,
  PreviewResponse,
  PreviewResultMessage,
  ProxyId,
} from './protocol.ts';

export interface PreviewResult {
  readonly jobId: JobId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly indices: Uint16Array;
  readonly colorsUsed: number;
  readonly elapsedMs: number;
}

export interface SchedulerHooks {
  readonly post: (request: PreviewRequest, transfer: ArrayBuffer[]) => void;
  readonly onResult: (result: PreviewResult) => void;
  readonly onError?: (message: string, jobId: JobId) => void;
  /** Fires when the busy state changes, for a spinner or a status line. */
  readonly onBusyChange?: (busy: boolean) => void;
}

export interface SchedulerStats {
  /** Requests made by the caller. */
  readonly requested: number;
  /** Requests actually sent to the worker. */
  readonly dispatched: number;
  /** Requests replaced before they were ever sent — the point of the design. */
  readonly superseded: number;
  /** Results discarded because a newer job had already been dispatched. */
  readonly staleResults: number;
}

export class PreviewScheduler {
  private nextProxyId: ProxyId = 1;
  private nextJobId: JobId = 1;
  private proxyId: ProxyId | undefined;

  private inFlight: JobId | undefined;
  private pending: ConvertSettings | undefined;
  /**
   * Last value handed to `onBusyChange`.
   *
   * Tracked separately from `inFlight` because chaining a pending job clears
   * `inFlight` for an instant before setting it again — without this, every
   * chained job would emit a spurious busy → busy notification and make a
   * spinner flicker for the whole drag.
   */
  private notifiedBusy = false;

  private requested = 0;
  private dispatched = 0;
  private superseded = 0;
  private staleResults = 0;

  constructor(private readonly hooks: SchedulerHooks) {}

  get stats(): SchedulerStats {
    return {
      requested: this.requested,
      dispatched: this.dispatched,
      superseded: this.superseded,
      staleResults: this.staleResults,
    };
  }

  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  /**
   * Give the worker a proxy to convert against.
   *
   * The buffer is **transferred**, so `proxy.data` is detached afterwards and
   * the caller must not touch it again. That is the point — a copy per source
   * would be fine, but this makes the contract explicit at the call site.
   *
   * A previously held proxy is released, so switching images does not leak.
   */
  setProxy(proxy: PixelBuffer): ProxyId {
    if (this.proxyId !== undefined) {
      this.hooks.post({ type: 'releaseProxy', proxyId: this.proxyId }, []);
    }

    const proxyId = this.nextProxyId++;
    this.proxyId = proxyId;

    const data = proxy.data.buffer as ArrayBuffer;
    this.hooks.post({ type: 'setProxy', proxyId, width: proxy.width, height: proxy.height, data }, [
      data,
    ]);
    return proxyId;
  }

  /** Ask for a preview. Cheap to call on every pointer move. */
  request(settings: ConvertSettings): void {
    if (this.proxyId === undefined) {
      throw new Error('PreviewScheduler.request called before setProxy');
    }
    this.requested++;

    if (this.inFlight !== undefined) {
      // Latest wins: whatever was waiting is now obsolete and is dropped
      // without ever having been sent.
      if (this.pending !== undefined) this.superseded++;
      this.pending = settings;
      return;
    }

    this.dispatch(settings);
  }

  /** Feed the worker's replies in. */
  handleMessage(response: PreviewResponse): void {
    if (response.jobId !== this.inFlight) {
      // Can only happen if a job outlived a `reset`; count it rather than
      // delivering settings the caller has already abandoned.
      this.staleResults++;
      return;
    }

    this.inFlight = undefined;

    if (response.type === 'result') {
      this.hooks.onResult(toResult(response));
    } else {
      this.hooks.onError?.(response.message, response.jobId);
    }

    const next = this.pending;
    this.pending = undefined;
    if (next !== undefined) {
      this.dispatch(next);
    } else {
      this.setBusy(false);
    }
  }

  /**
   * Forget the in-flight and pending jobs.
   *
   * For switching source image or leaving Convert mode: a result that arrives
   * afterwards is counted as stale and dropped rather than painted over the new
   * image.
   */
  reset(): void {
    this.inFlight = undefined;
    this.pending = undefined;
    this.setBusy(false);
  }

  private dispatch(settings: ConvertSettings): void {
    const jobId = this.nextJobId++;
    this.inFlight = jobId;
    this.dispatched++;
    this.setBusy(true);
    this.hooks.post({ type: 'convert', jobId, proxyId: this.proxyId as ProxyId, settings }, []);
  }

  private setBusy(busy: boolean): void {
    if (this.notifiedBusy === busy) return;
    this.notifiedBusy = busy;
    this.hooks.onBusyChange?.(busy);
  }
}

function toResult(message: PreviewResultMessage): PreviewResult {
  return {
    jobId: message.jobId,
    width: message.width,
    height: message.height,
    data: new Uint8ClampedArray(message.data),
    indices: new Uint16Array(message.indices),
    colorsUsed: message.colorsUsed,
    elapsedMs: message.elapsedMs,
  };
}
