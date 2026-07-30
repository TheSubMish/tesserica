import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assetsModelsDir,
  ensureModelFetched,
  md5Hex,
  ModelFetchError,
  type FetchImpl,
  type ModelSpec,
} from './modelFetch.ts';

/**
 * Tests the idempotency/checksum decisions in `ensureModelFetched` against
 * local fixtures — `fetchImpl` is injected, so none of this touches the
 * network (`docs/08-roadmap.md` Phase 5's own verification instructions).
 */

const CONTENT = new TextEncoder().encode('pretend-this-is-onnx-bytes');
const CONTENT_MD5 = md5Hex(CONTENT);

const SPEC: ModelSpec = {
  id: 'fixture-model',
  filename: 'fixture-model.onnx',
  url: 'https://example.invalid/fixture-model.onnx',
  expectedMd5: CONTENT_MD5,
  approxBytes: CONTENT.byteLength,
  license: 'Apache-2.0',
};

function fakeFetch(bytes: Uint8Array, ok = true, status = 200): FetchImpl {
  return vi.fn(async () => ({
    ok,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  }));
}

let destDir: string;

beforeEach(() => {
  destDir = mkdtempSync(join(tmpdir(), 'tesserica-model-fetch-'));
});

afterEach(() => {
  rmSync(destDir, { recursive: true, force: true });
});

describe('ensureModelFetched', () => {
  it('downloads when nothing is present yet, and verifies the checksum', async () => {
    const fetchImpl = fakeFetch(CONTENT);
    const outcome = await ensureModelFetched(SPEC, destDir, fetchImpl);

    expect(outcome.kind).toBe('downloaded');
    expect(fetchImpl).toHaveBeenCalledWith(SPEC.url);
    const written = readFileSync(join(destDir, SPEC.filename));
    expect(md5Hex(written)).toBe(SPEC.expectedMd5);
  });

  it('is idempotent: a second call with a correct file already present never re-fetches', async () => {
    const fetchImpl = fakeFetch(CONTENT);
    await ensureModelFetched(SPEC, destDir, fetchImpl);

    const secondFetch = fakeFetch(CONTENT);
    const outcome = await ensureModelFetched(SPEC, destDir, secondFetch);

    expect(outcome.kind).toBe('skipped-already-present');
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('re-fetches when an existing file does not match the expected checksum', async () => {
    writeFileSync(join(destDir, SPEC.filename), new Uint8Array([1, 2, 3]));

    const fetchImpl = fakeFetch(CONTENT);
    const outcome = await ensureModelFetched(SPEC, destDir, fetchImpl);

    expect(outcome.kind).toBe('downloaded');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const written = readFileSync(join(destDir, SPEC.filename));
    expect(md5Hex(written)).toBe(SPEC.expectedMd5);
  });

  it('throws a ModelFetchError and writes nothing when the response is not ok', async () => {
    const fetchImpl = fakeFetch(CONTENT, false, 404);
    await expect(ensureModelFetched(SPEC, destDir, fetchImpl)).rejects.toThrow(ModelFetchError);
  });

  it('throws a ModelFetchError and leaves no file behind when the checksum does not match', async () => {
    const wrongBytes = new TextEncoder().encode('not the right bytes at all');
    const fetchImpl = fakeFetch(wrongBytes);

    await expect(ensureModelFetched(SPEC, destDir, fetchImpl)).rejects.toThrow(ModelFetchError);

    expect(() => readFileSync(join(destDir, SPEC.filename))).toThrow();
  });

  it('throws a ModelFetchError with an actionable message when the network is unreachable', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND example.invalid');
    });

    await expect(ensureModelFetched(SPEC, destDir, fetchImpl)).rejects.toThrow(/network access/i);
  });

  it('creates the destination directory if it does not exist yet', async () => {
    const nestedDir = join(destDir, 'nested', 'models');
    const fetchImpl = fakeFetch(CONTENT);

    const outcome = await ensureModelFetched(SPEC, nestedDir, fetchImpl);

    expect(outcome.kind).toBe('downloaded');
    expect(md5Hex(readFileSync(join(nestedDir, SPEC.filename)))).toBe(SPEC.expectedMd5);
  });
});

describe('assetsModelsDir', () => {
  it('joins the project root with assets/models', () => {
    expect(assetsModelsDir('/home/user/tesserica')).toBe('/home/user/tesserica/assets/models');
  });
});
