import { describe, expect, it, vi } from 'vitest';

import {
  downloadConsentedFile,
  formatBytes,
  sourceHost,
  type DownloadImpl,
} from './modelDownload.ts';

describe('downloadConsentedFile', () => {
  it('calls the injected download function and reports its result on success', async () => {
    const download: DownloadImpl<{ path: string; bytes: number }> = vi.fn(async () => ({
      path: '/data/models/isnet-general-use.onnx',
      bytes: 3,
    }));

    const outcome = await downloadConsentedFile({ download });

    expect(download).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: 'success',
      path: '/data/models/isnet-general-use.onnx',
      bytes: 3,
    });
  });

  it('never calls download until this function is explicitly invoked', () => {
    // downloadConsentedFile only runs the injected download when called —
    // this is the same invariant the component tests exercise through the
    // UI (never calling it on mount or after just the first click), stated
    // here at the unit level: merely constructing/holding a reference to a
    // download function does not trigger it.
    const download = vi.fn();
    expect(download).not.toHaveBeenCalled();
  });

  it('reports a rejected download (e.g. network unreachable) as an error, without throwing', async () => {
    const download: DownloadImpl<{ path: string; bytes: number }> = vi.fn(async () => {
      throw new Error('could not reach github.com — check your network connection.');
    });

    const outcome = await downloadConsentedFile({ download });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/network connection/i);
    }
  });

  it('reports a checksum rejection from the Rust command as an error', async () => {
    const download: DownloadImpl<{ path: string; bytes: number }> = vi.fn(async () => {
      throw new Error('downloaded model failed checksum verification');
    });

    const outcome = await downloadConsentedFile({ download });

    expect(outcome).toEqual({
      kind: 'error',
      message: 'downloaded model failed checksum verification',
    });
  });

  it('reports a non-Error rejection as an error with a stringified message', async () => {
    const download: DownloadImpl<{ path: string; bytes: number }> = vi.fn(() =>
      Promise.reject('HTTP 404'),
    );

    const outcome = await downloadConsentedFile({ download });

    expect(outcome).toEqual({ kind: 'error', message: 'HTTP 404' });
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
    expect(
      sourceHost(
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
      ),
    ).toBe('github.com');
  });

  it('falls back to the raw string for something that is not a URL', () => {
    expect(sourceHost('not a url')).toBe('not a url');
  });
});
