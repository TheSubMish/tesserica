/**
 * `convertImageFormat` (`src-tauri/src/commands/format_convert.rs`,
 * `src/app/ConvertFormatDialog.tsx`).
 *
 * Same reasoning as `batchConvert.test.ts`: what a Rust-side test cannot
 * pin down is that this wrapper calls `invoke` with the exact command name
 * and request shape Rust expects.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { convertImageFormat } from './commands';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('convertImageFormat', () => {
  it('invokes convert_image_format with the request and resolves with the result', async () => {
    const result = { path: '/tmp/out.webp', width: 10, height: 5, bytes: 123 };
    invokeMock.mockResolvedValue(result);

    const request = { inputPath: '/tmp/in.png', outputPath: '/tmp/out.webp', format: 'webp' };
    const resolved = await convertImageFormat(request);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [name, args] = invokeMock.mock.calls[0];
    expect(name).toBe('convert_image_format');
    expect((args as { request: unknown }).request).toBe(request);
    expect(resolved).toEqual(result);
  });
});
