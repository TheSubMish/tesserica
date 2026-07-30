import { describe, expect, it, vi } from 'vitest';

import type { SegmentationModelInfo } from '../ipc/commands.ts';
import {
  downloadLargerSegmentationModel,
  formatBytes,
  sourceHost,
  type DownloadFetchImpl,
  type SaveImpl,
} from './modelDownload.ts';

const INFO: SegmentationModelInfo = {
  id: 'isnet-general-use',
  filename: 'isnet-general-use.onnx',
  sourceUrl: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  approxBytes: 178_648_008,
  license: 'Apache-2.0',
};

function okFetch(bytes: ArrayBuffer): DownloadFetchImpl {
  return vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes }));
}

describe('downloadLargerSegmentationModel', () => {
  it('fetches the source URL and hands the bytes to save on success', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchImpl = okFetch(bytes);
    const save: SaveImpl = vi.fn(async () => ({
      path: '/data/models/isnet-general-use.onnx',
      bytes: 3,
    }));

    const outcome = await downloadLargerSegmentationModel(INFO, { fetchImpl, save });

    expect(fetchImpl).toHaveBeenCalledWith(INFO.sourceUrl);
    expect(save).toHaveBeenCalledWith(bytes);
    expect(outcome).toEqual({
      kind: 'success',
      path: '/data/models/isnet-general-use.onnx',
      bytes: 3,
    });
  });

  it('reports a non-ok HTTP response as an error, without calling save', async () => {
    const fetchImpl: DownloadFetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const save: SaveImpl = vi.fn();

    const outcome = await downloadLargerSegmentationModel(INFO, { fetchImpl, save });

    expect(outcome.kind).toBe('error');
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a network failure (offline) as an error, without throwing', async () => {
    const fetchImpl: DownloadFetchImpl = vi.fn(async () => {
      throw new Error('NetworkError: Failed to fetch');
    });
    const save: SaveImpl = vi.fn();

    const outcome = await downloadLargerSegmentationModel(INFO, { fetchImpl, save });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/network connection/i);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a checksum rejection from save as an error', async () => {
    const bytes = new Uint8Array([9, 9, 9]).buffer;
    const fetchImpl = okFetch(bytes);
    const save: SaveImpl = vi.fn(async () => {
      throw new Error('downloaded model failed checksum verification');
    });

    const outcome = await downloadLargerSegmentationModel(INFO, { fetchImpl, save });

    expect(outcome).toEqual({
      kind: 'error',
      message: 'downloaded model failed checksum verification',
    });
  });
});

describe('formatBytes', () => {
  it('formats the real isnet-general-use size as MB with one decimal', () => {
    expect(formatBytes(178_648_008)).toBe('170.4 MB');
  });

  it('formats the bundled u2netp size as MB', () => {
    expect(formatBytes(4_574_861)).toBe('4.4 MB');
  });
});

describe('sourceHost', () => {
  it('extracts the host from a real release URL', () => {
    expect(sourceHost(INFO.sourceUrl)).toBe('github.com');
  });

  it('falls back to the raw string for something that is not a URL', () => {
    expect(sourceHost('not a url')).toBe('not a url');
  });
});
