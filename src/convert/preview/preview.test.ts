import { describe, expect, it, vi } from 'vitest';

import { bufferFrom, createBuffer, type PixelBuffer } from '../../pipeline/buffer.ts';
import { TRANSPARENT_INDEX } from '../../pipeline/quantize.ts';
import {
  defaultSettings,
  type ConvertSettings,
  type PaletteSpec,
} from '../../pipeline/settings.ts';
import { PreviewCore } from './core.ts';
import type { PreviewRequest, PreviewResponse } from './protocol.ts';
import { PREVIEW_PROXY_MAX_EDGE, makeProxy } from './proxy.ts';
import { PreviewScheduler } from './scheduler.ts';

const PALETTE: PaletteSpec = {
  kind: 'fixed',
  colors: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ],
};

function solid(width: number, height: number, color: [number, number, number, number]) {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) buf.data.set(color, i);
  return buf;
}

function settings(patch: Partial<ConvertSettings> = {}): ConvertSettings {
  return { ...defaultSettings(4, 4, PALETTE), ...patch };
}

describe('makeProxy', () => {
  it('leaves a small source alone, and does not copy it', () => {
    const src = solid(64, 48, [1, 2, 3, 255]);
    const proxy = makeProxy(src);
    expect(proxy.downscaled).toBe(false);
    expect(proxy.buffer).toBe(src);
  });

  it('caps the long edge and preserves aspect ratio', () => {
    const src = createBuffer(4000, 3000);
    const proxy = makeProxy(src);
    expect(proxy.downscaled).toBe(true);
    expect(Math.max(proxy.buffer.width, proxy.buffer.height)).toBe(PREVIEW_PROXY_MAX_EDGE);
    expect(proxy.buffer.width / proxy.buffer.height).toBeCloseTo(4000 / 3000, 2);
  });

  it('never produces a zero dimension on an extreme aspect ratio', () => {
    const proxy = makeProxy(createBuffer(5000, 2), 100);
    expect(proxy.buffer.width).toBe(100);
    expect(proxy.buffer.height).toBeGreaterThanOrEqual(1);
  });
});

describe('PreviewCore', () => {
  it('holds a proxy silently and converts against it', () => {
    const core = new PreviewCore();
    const src = solid(8, 8, [255, 255, 255, 255]);

    expect(
      core.handle({
        type: 'setProxy',
        proxyId: 1,
        width: 8,
        height: 8,
        data: src.data.buffer as ArrayBuffer,
      }),
    ).toBeUndefined();
    expect(core.proxyCount).toBe(1);

    const out = core.handle({ type: 'convert', jobId: 7, proxyId: 1, settings: settings() });
    expect(out?.response.type).toBe('result');
    const result = out?.response as Extract<PreviewResponse, { type: 'result' }>;
    expect(result.jobId).toBe(7);
    expect([result.width, result.height]).toEqual([4, 4]);
    expect(result.colorsUsed).toBe(1);
    expect(new Uint16Array(result.indices).every((i) => i === 1)).toBe(true);
  });

  it('transfers the pixel buffers rather than copying them', () => {
    const core = new PreviewCore();
    const src = solid(8, 8, [255, 255, 255, 255]);
    core.handle({
      type: 'setProxy',
      proxyId: 1,
      width: 8,
      height: 8,
      data: src.data.buffer as ArrayBuffer,
    });

    const out = core.handle({ type: 'convert', jobId: 1, proxyId: 1, settings: settings() });
    const result = out?.response as Extract<PreviewResponse, { type: 'result' }>;
    expect(out?.transfer).toContain(result.data);
    expect(out?.transfer).toContain(result.indices);
  });

  it('counts transparent pixels as no colour used', () => {
    const core = new PreviewCore();
    const src = solid(8, 8, [255, 255, 255, 0]);
    core.handle({
      type: 'setProxy',
      proxyId: 1,
      width: 8,
      height: 8,
      data: src.data.buffer as ArrayBuffer,
    });

    const out = core.handle({ type: 'convert', jobId: 1, proxyId: 1, settings: settings() });
    const result = out?.response as Extract<PreviewResponse, { type: 'result' }>;
    expect(result.colorsUsed).toBe(0);
    expect(new Uint16Array(result.indices).every((i) => i === TRANSPARENT_INDEX)).toBe(true);
  });

  it('reports a bad job as an error rather than dying', () => {
    const core = new PreviewCore();
    const src = solid(8, 8, [1, 2, 3, 255]);
    core.handle({
      type: 'setProxy',
      proxyId: 1,
      width: 8,
      height: 8,
      data: src.data.buffer as ArrayBuffer,
    });

    const missing = core.handle({ type: 'convert', jobId: 2, proxyId: 99, settings: settings() });
    expect(missing?.response.type).toBe('error');

    // A crop that misses the image entirely: the pipeline refuses rather than
    // returning a 0x0 buffer, and the worker has to survive that.
    const badCrop = core.handle({
      type: 'convert',
      jobId: 3,
      proxyId: 1,
      settings: settings({ crop: { x: 999, y: 999, w: 10, h: 10 } }),
    });
    expect(badCrop?.response.type).toBe('error');
    expect((badCrop?.response as { message: string }).message).toContain('crop');
  });

  it('releases a proxy', () => {
    const core = new PreviewCore();
    const src = solid(4, 4, [1, 2, 3, 255]);
    core.handle({
      type: 'setProxy',
      proxyId: 1,
      width: 4,
      height: 4,
      data: src.data.buffer as ArrayBuffer,
    });
    core.handle({ type: 'releaseProxy', proxyId: 1 });
    expect(core.proxyCount).toBe(0);
  });
});

/**
 * A fake worker: collects posted requests and replies only when told to, so a
 * test can hold a job "in flight" for as long as it likes.
 */
class FakeWorker {
  readonly sent: PreviewRequest[] = [];
  private readonly core = new PreviewCore();

  post = (request: PreviewRequest): void => {
    this.sent.push(request);
    if (request.type !== 'convert') this.core.handle(request);
  };

  /** Run the oldest un-answered convert request and return its reply. */
  respondToOldest(): PreviewResponse {
    const job = this.sent.find((r) => r.type === 'convert' && !this.answered.has(r.jobId));
    if (!job || job.type !== 'convert') throw new Error('no outstanding convert request');
    this.answered.add(job.jobId);
    return this.core.handle(job)!.response;
  }

  get converts(): Extract<PreviewRequest, { type: 'convert' }>[] {
    return this.sent.filter(
      (r): r is Extract<PreviewRequest, { type: 'convert' }> => r.type === 'convert',
    );
  }

  private readonly answered = new Set<number>();

  seedProxy(buffer: PixelBuffer, proxyId: number): void {
    this.core.handle({
      type: 'setProxy',
      proxyId,
      width: buffer.width,
      height: buffer.height,
      data: buffer.data.buffer as ArrayBuffer,
    });
  }
}

describe('PreviewScheduler — latest wins', () => {
  function setup() {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const onError = vi.fn();
    const onBusyChange = vi.fn();
    const scheduler = new PreviewScheduler({
      post: worker.post,
      onResult,
      onError,
      onBusyChange,
    });
    const src = solid(8, 8, [128, 128, 128, 255]);
    // The scheduler transfers the proxy, which a fake `post` cannot do, so the
    // fake worker is seeded separately with an equivalent buffer.
    worker.seedProxy(bufferFrom(8, 8, Uint8ClampedArray.from(src.data)), 1);
    scheduler.setProxy(src);
    return { worker, scheduler, onResult, onError, onBusyChange };
  }

  it('dispatches the first request immediately', () => {
    const { worker, scheduler } = setup();
    scheduler.request(settings());
    expect(worker.converts).toHaveLength(1);
    expect(scheduler.busy).toBe(true);
  });

  it('never queues stale work: many requests during one job collapse to one', () => {
    const { worker, scheduler } = setup();

    scheduler.request(settings({ brightness: 0.1 }));
    for (let i = 2; i <= 20; i++) scheduler.request(settings({ brightness: i / 100 }));

    // One in flight, nineteen collapsed into a single pending request.
    expect(worker.converts).toHaveLength(1);
    expect(scheduler.stats.requested).toBe(20);
    expect(scheduler.stats.dispatched).toBe(1);
    expect(scheduler.stats.superseded).toBe(18);

    scheduler.handleMessage(worker.respondToOldest());

    // Exactly one follow-up, carrying the *newest* settings — not the second.
    expect(worker.converts).toHaveLength(2);
    expect(worker.converts[1].settings.brightness).toBeCloseTo(0.2);
    expect(scheduler.stats.dispatched).toBe(2);
  });

  it('goes idle when the last result lands', () => {
    const { worker, scheduler, onBusyChange, onResult } = setup();
    scheduler.request(settings());
    scheduler.handleMessage(worker.respondToOldest());

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(scheduler.busy).toBe(false);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not toggle busy between chained jobs', () => {
    const { worker, scheduler, onBusyChange } = setup();
    scheduler.request(settings({ brightness: 0.1 }));
    scheduler.request(settings({ brightness: 0.2 }));
    scheduler.handleMessage(worker.respondToOldest());

    // Still busy running the queued job — one transition, not three.
    expect(scheduler.busy).toBe(true);
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true]);
  });

  it('surfaces a worker error against its job and keeps going', () => {
    const { worker, scheduler, onError } = setup();
    scheduler.request(settings({ crop: { x: 999, y: 999, w: 10, h: 10 } }));
    scheduler.handleMessage(worker.respondToOldest());

    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.busy).toBe(false);

    scheduler.request(settings());
    expect(worker.converts).toHaveLength(2);
  });

  it('drops a result that arrives after a reset', () => {
    const { worker, scheduler, onResult } = setup();
    scheduler.request(settings());
    const response = worker.respondToOldest();

    scheduler.reset();
    scheduler.handleMessage(response);

    expect(onResult).not.toHaveBeenCalled();
    expect(scheduler.stats.staleResults).toBe(1);
  });

  it('releases the old proxy when the source changes', () => {
    const { worker, scheduler } = setup();
    scheduler.setProxy(solid(4, 4, [0, 0, 0, 255]));
    expect(worker.sent.filter((r) => r.type === 'releaseProxy')).toHaveLength(1);
  });

  it('refuses to convert before a proxy exists', () => {
    const scheduler = new PreviewScheduler({ post: () => {}, onResult: () => {} });
    expect(() => scheduler.request(settings())).toThrow(/setProxy/);
  });
});

/**
 * Dev-mode Vite hot reload can re-evaluate the worker's module graph
 * independently of the page (`session.ts`), leaving the worker with no record
 * of a proxy the scheduler still believes is registered. This cannot happen in
 * a production build — nothing else here recreates the worker without also
 * recreating the scheduler — but recovering from it during development means
 * a live preview never looks broken just because the developer's editor saved
 * a file.
 */
describe('PreviewScheduler — recovering from a missing proxy', () => {
  function setup(onMissingProxy: () => PixelBuffer | undefined) {
    const posted: PreviewRequest[] = [];
    const onResult = vi.fn();
    const onError = vi.fn();
    const scheduler = new PreviewScheduler({
      post: (r) => posted.push(r),
      onResult,
      onError,
      onMissingProxy,
    });
    scheduler.setProxy(solid(2, 2, [9, 9, 9, 255]));
    return { posted, scheduler, onResult, onError };
  }

  function convertJobIds(posted: PreviewRequest[]): number[] {
    return posted
      .filter((r): r is Extract<PreviewRequest, { type: 'convert' }> => r.type === 'convert')
      .map((r) => r.jobId);
  }

  it('re-registers a fresh proxy and retries the same job once, without surfacing an error', () => {
    const recovery = solid(2, 2, [5, 5, 5, 255]);
    const onMissingProxy = vi.fn(() => bufferFrom(2, 2, Uint8ClampedArray.from(recovery.data)));
    const { posted, scheduler, onResult, onError } = setup(onMissingProxy);

    scheduler.request(settings());
    const [firstJobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'error',
      jobId: firstJobId,
      message: 'no proxy 1 in this worker',
      reason: 'missing-proxy',
    });

    expect(onMissingProxy).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(posted.filter((r) => r.type === 'setProxy')).toHaveLength(2); // original + recovery
    expect(convertJobIds(posted)).toHaveLength(2); // original job + the retry

    const [, retryJobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'result',
      jobId: retryJobId,
      width: 2,
      height: 2,
      data: new ArrayBuffer(2 * 2 * 4),
      indices: new ArrayBuffer(2 * 2 * 2),
      colorsUsed: 1,
      elapsedMs: 1,
    });

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(scheduler.stats.recovered).toBe(1);
  });

  it('gives up after one failed recovery attempt rather than retrying forever', () => {
    const onMissingProxy = vi.fn(() => bufferFrom(2, 2, new Uint8ClampedArray(2 * 2 * 4)));
    const { posted, scheduler, onResult, onError } = setup(onMissingProxy);

    scheduler.request(settings());
    const [firstJobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'error',
      jobId: firstJobId,
      message: 'no proxy 1 in this worker',
      reason: 'missing-proxy',
    });

    const [, retryJobId] = convertJobIds(posted);
    // The retry fails the exact same way — recovery must not loop forever.
    scheduler.handleMessage({
      type: 'error',
      jobId: retryJobId,
      message: 'no proxy 2 in this worker',
      reason: 'missing-proxy',
    });

    expect(onMissingProxy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    expect(scheduler.stats.recovered).toBe(1);
  });

  it('falls straight through to onError when there is nothing to recover with', () => {
    const onMissingProxy = vi.fn(() => undefined);
    const { posted, scheduler, onError } = setup(onMissingProxy);

    scheduler.request(settings());
    const [firstJobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'error',
      jobId: firstJobId,
      message: 'no proxy 1 in this worker',
      reason: 'missing-proxy',
    });

    expect(onMissingProxy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.stats.recovered).toBe(0);
  });

  it('is a per-job guard, not a one-time-ever guard: a later job can recover too', () => {
    const onMissingProxy = vi.fn(() => bufferFrom(2, 2, new Uint8ClampedArray(2 * 2 * 4)));
    const { posted, scheduler, onResult } = setup(onMissingProxy);
    const result = (jobId: number) => ({
      type: 'result' as const,
      jobId,
      width: 2,
      height: 2,
      data: new ArrayBuffer(2 * 2 * 4),
      indices: new ArrayBuffer(2 * 2 * 2),
      colorsUsed: 1,
      elapsedMs: 1,
    });

    // First job: recovers, then succeeds.
    scheduler.request(settings());
    let [jobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'error',
      jobId,
      message: 'no proxy 1 in this worker',
      reason: 'missing-proxy',
    });
    scheduler.handleMessage(result(convertJobIds(posted)[1]));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onMissingProxy).toHaveBeenCalledTimes(1);

    // A second, independent job also hits a missing-proxy error — the guard
    // from the first recovery must not have disabled recovery permanently.
    scheduler.request(settings({ brightness: 0.2 }));
    [, , jobId] = convertJobIds(posted);
    scheduler.handleMessage({
      type: 'error',
      jobId,
      message: 'no proxy 2 in this worker',
      reason: 'missing-proxy',
    });

    expect(onMissingProxy).toHaveBeenCalledTimes(2);
    expect(scheduler.stats.recovered).toBe(2);
  });
});
