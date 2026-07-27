/**
 * Ties the scheduler to a real `Worker`.
 *
 * The only file in the preview stack that touches the `Worker` API, so
 * everything else stays testable in plain Node/jsdom.
 */

import type { PixelBuffer } from '../../pipeline/buffer.ts';
import type { ConvertSettings } from '../../pipeline/settings.ts';
import { makeProxy, type Proxy } from './proxy.ts';
import type { PreviewResponse } from './protocol.ts';
import { PreviewScheduler, type PreviewResult, type SchedulerStats } from './scheduler.ts';

export interface PreviewSessionHooks {
  readonly onResult: (result: PreviewResult) => void;
  readonly onError?: (message: string) => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

export class PreviewSession {
  private readonly worker: Worker;
  private readonly scheduler: PreviewScheduler;
  private proxy: Proxy | undefined;

  constructor(hooks: PreviewSessionHooks) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.scheduler = new PreviewScheduler({
      post: (request, transfer) => this.worker.postMessage(request, transfer),
      onResult: hooks.onResult,
      onError: hooks.onError ? (message) => hooks.onError?.(message) : undefined,
      onBusyChange: hooks.onBusyChange,
    });
    this.worker.onmessage = (event: MessageEvent<PreviewResponse>) =>
      this.scheduler.handleMessage(event.data);
  }

  /** True when the preview is running on a downscaled proxy (`docs/05` §3). */
  get isProxy(): boolean {
    return this.proxy?.downscaled ?? false;
  }

  get stats(): SchedulerStats {
    return this.scheduler.stats;
  }

  /**
   * Point the session at a source image.
   *
   * The proxy is built here, on the main thread, because it is a one-off cost
   * and because the caller needs to know synchronously whether the preview will
   * be approximate.
   */
  setSource(source: PixelBuffer): void {
    this.scheduler.reset();
    this.proxy = makeProxy(source);
    this.scheduler.setProxy(this.proxy.buffer);
  }

  request(settings: ConvertSettings): void {
    this.scheduler.request(settings);
  }

  dispose(): void {
    this.scheduler.reset();
    this.worker.terminate();
  }
}
