/**
 * Messages between the main thread and the conversion preview worker
 * (`docs/02-architecture.md` §8).
 *
 * Two rules shape this protocol:
 *
 * - **Pixels move as transferable `ArrayBuffer`s**, never as structured-cloned
 *   arrays. Transfer is zero-copy; cloning a 4 MB proxy on every slider tick is
 *   not.
 * - **The source crosses once.** A conversion job carries settings only, and
 *   refers to the proxy the worker already holds. Slider drags then cost a few
 *   hundred bytes each way.
 */

import type { ConvertSettings } from '../../pipeline/settings.ts';

/** Identifies a proxy held by the worker. Not a Rust `SourceId`. */
export type ProxyId = number;

export type JobId = number;

/** Hand the worker a proxy to keep. `data` is transferred, not copied. */
export interface SetProxyMessage {
  readonly type: 'setProxy';
  readonly proxyId: ProxyId;
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
}

/** Convert the held proxy with these settings. */
export interface ConvertMessage {
  readonly type: 'convert';
  readonly jobId: JobId;
  readonly proxyId: ProxyId;
  readonly settings: ConvertSettings;
}

/** Drop a proxy the session no longer needs. */
export interface ReleaseProxyMessage {
  readonly type: 'releaseProxy';
  readonly proxyId: ProxyId;
}

export type PreviewRequest = SetProxyMessage | ConvertMessage | ReleaseProxyMessage;

export interface PreviewResultMessage {
  readonly type: 'result';
  readonly jobId: JobId;
  readonly width: number;
  readonly height: number;
  /** Converted RGBA, transferred back. */
  readonly data: ArrayBuffer;
  /** Palette indices, `TRANSPARENT_INDEX` where transparent. Transferred. */
  readonly indices: ArrayBuffer;
  /** How many distinct palette entries the result actually used. */
  readonly colorsUsed: number;
  /** Milliseconds spent inside the pipeline, for the status bar. */
  readonly elapsedMs: number;
}

export interface PreviewErrorMessage {
  readonly type: 'error';
  readonly jobId: JobId;
  readonly message: string;
  /**
   * Set when the worker had no record of the proxy a job referenced
   * (`core.ts`). In production the worker and the main-thread scheduler are
   * created together and never diverge; in dev, Vite hot-reloading the
   * worker's module graph independently of the page can reset it. The
   * discriminant lets `PreviewScheduler` attempt one automatic recovery
   * before surfacing anything to the user, rather than string-matching
   * `message` (which is for display, not for control flow).
   */
  readonly reason?: 'missing-proxy';
}

export type PreviewResponse = PreviewResultMessage | PreviewErrorMessage;
