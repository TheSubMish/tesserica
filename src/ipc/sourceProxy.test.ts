import { describe, expect, it } from 'vitest';

import { decodeSourceProxy } from './commands.ts';

/**
 * The proxy payload is the one place bulk pixels legitimately travel Rust →
 * frontend, so its framing is worth asserting without needing a backend. The
 * Rust half of the same contract is asserted in
 * `src-tauri/src/commands/source.rs`.
 */
describe('decodeSourceProxy', () => {
  function payload(width: number, height: number): ArrayBuffer {
    const buffer = new ArrayBuffer(8 + width * height * 4);
    const view = new DataView(buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    new Uint8ClampedArray(buffer, 8).fill(7);
    return buffer;
  }

  it('reads the header and exposes the pixels without copying', () => {
    const proxy = decodeSourceProxy(payload(3, 2));
    expect([proxy.width, proxy.height]).toEqual([3, 2]);
    expect(proxy.data.length).toBe(24);
    expect(proxy.data[0]).toBe(7);
  });

  it('rejects a payload whose length disagrees with its header', () => {
    const buffer = payload(3, 2).slice(0, 20);
    expect(() => decodeSourceProxy(buffer)).toThrow(/expected/);
  });
});
