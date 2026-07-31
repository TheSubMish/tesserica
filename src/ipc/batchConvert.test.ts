/**
 * `batchConvert`/`cancelBatchConvert` (`docs/08-roadmap.md` Phase 7 "Batch
 * conversion + CLI headless mode", `docs/06-workflows.md` W5).
 *
 * The one thing worth pinning down here that a Rust-side test cannot: the
 * Channel this wrapper constructs actually forwards every message it
 * receives to the caller's `onProgress`, and `invoke` is called with the
 * exact command name and request shape Rust expects.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeChannel, invokeMock } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (event: T) => void = () => {};
  }
  return { FakeChannel, invokeMock: vi.fn() };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel,
}));

import { batchConvert, cancelBatchConvert, type BatchConvertEvent } from './commands';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('batchConvert', () => {
  it('invokes batch_convert with the request and a channel, and resolves with the summary', async () => {
    const summary = { jobId: 1, total: 2, succeeded: 2, failed: 0, cancelled: false };
    invokeMock.mockResolvedValue(summary);

    const request = {
      folder: '/tmp/in',
      outFolder: '/tmp/out',
      pixelSize: 8,
      settings: { targetWidth: 1, targetHeight: 1 } as never,
      scale: 2 as const,
    };
    const result = await batchConvert(request, () => {});

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [name, args] = invokeMock.mock.calls[0];
    expect(name).toBe('batch_convert');
    expect((args as { request: unknown }).request).toBe(request);
    expect((args as { progress: unknown }).progress).toBeInstanceOf(FakeChannel);
    expect(result).toEqual(summary);
  });

  it('forwards every message the channel receives to onProgress, in order', async () => {
    invokeMock.mockResolvedValue({
      jobId: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      cancelled: false,
    });

    const received: BatchConvertEvent[] = [];
    await batchConvert(
      {
        folder: '/tmp/in',
        outFolder: '/tmp/out',
        pixelSize: 4,
        settings: {} as never,
        scale: 1 as const,
      },
      (event) => received.push(event),
    );

    const channel = (
      invokeMock.mock.calls[0][1] as { progress: { onmessage: (event: BatchConvertEvent) => void } }
    ).progress;

    const started: BatchConvertEvent = { kind: 'started', jobId: 1, total: 1 };
    const succeeded: BatchConvertEvent = {
      kind: 'fileSucceeded',
      index: 0,
      file: 'a.png',
      outputPath: '/tmp/out/a.png',
      width: 4,
      height: 4,
      colorsUsed: 2,
    };
    channel.onmessage(started);
    channel.onmessage(succeeded);

    expect(received).toEqual([started, succeeded]);
  });
});

describe('cancelBatchConvert', () => {
  it('invokes cancel_batch_convert with the job id', async () => {
    invokeMock.mockResolvedValue(undefined);
    await cancelBatchConvert(7);
    expect(invokeMock).toHaveBeenCalledWith('cancel_batch_convert', { jobId: 7 });
  });
});
