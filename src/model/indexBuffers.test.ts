import { beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSPARENT_INDEX,
  allocateIndexBuffer,
  bumpIndexRevision,
  clearAllIndexBuffers,
  getIndexBuffer,
  indexRevision,
  releaseIndexBuffer,
  setIndexBuffer,
} from './indexBuffers';

beforeEach(() => clearAllIndexBuffers());

describe('allocateIndexBuffer', () => {
  it('is sized one byte per pixel, not four', () => {
    const buf = allocateIndexBuffer('c1', 4, 3);
    expect(buf.length).toBe(12);
  });

  it('starts fully transparent (index 0)', () => {
    const buf = allocateIndexBuffer('c1', 2, 2);
    expect([...buf]).toEqual([
      TRANSPARENT_INDEX,
      TRANSPARENT_INDEX,
      TRANSPARENT_INDEX,
      TRANSPARENT_INDEX,
    ]);
  });

  it('bumps the revision counter', () => {
    const before = indexRevision('c1');
    allocateIndexBuffer('c1', 2, 2);
    expect(indexRevision('c1')).toBe(before + 1);
  });
});

describe('getIndexBuffer/setIndexBuffer/releaseIndexBuffer', () => {
  it('round-trips a buffer', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    setIndexBuffer('c2', buf);
    expect(getIndexBuffer('c2')).toBe(buf);
  });

  it('forgets a released buffer', () => {
    allocateIndexBuffer('c3', 2, 2);
    releaseIndexBuffer('c3');
    expect(getIndexBuffer('c3')).toBeUndefined();
  });

  it('bumpIndexRevision increments independently of allocation', () => {
    allocateIndexBuffer('c4', 1, 1);
    const r0 = indexRevision('c4');
    bumpIndexRevision('c4');
    expect(indexRevision('c4')).toBe(r0 + 1);
  });
});
