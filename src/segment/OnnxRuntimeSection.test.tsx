import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as commands from '../ipc/commands.ts';
import * as modelDownload from './modelDownload.ts';
import { OnnxRuntimeSection } from './OnnxRuntimeSection.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO = {
  version: '1.28.0',
  filename: 'libonnxruntime.so',
  sourceUrl:
    'https://github.com/microsoft/onnxruntime/releases/download/v1.28.0/onnxruntime-linux-x64-1.28.0.tgz',
  approxBytes: 9_125_960,
  extractedApproxBytes: 24_268_848,
  license: 'MIT',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(commands, 'hasBackend').mockReturnValue(true);
  vi.spyOn(commands, 'onnxRuntimeInfo').mockResolvedValue(INFO);
  vi.spyOn(commands, 'onnxRuntimeStatus').mockResolvedValue({ present: false, path: '' });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as
    HTMLButtonElement | undefined;

describe('OnnxRuntimeSection', () => {
  it('never calls the download function on mount', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadConsentedFile');

    act(() => root.render(<OnnxRuntimeSection />));
    await flush();

    expect(spy).not.toHaveBeenCalled();
  });

  it('only shows the confirm step, not a download, after the initial button click', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadConsentedFile');

    act(() => root.render(<OnnxRuntimeSection />));
    await flush();

    act(() => button('Download AI background-removal engine')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('8.7 MB');
    expect(container.textContent).toContain('github.com');
  });

  it('cancelling the confirm step never triggers a download', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadConsentedFile');

    act(() => root.render(<OnnxRuntimeSection />));
    await flush();
    act(() => button('Download AI background-removal engine')?.click());
    await flush();
    act(() => button('Cancel')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(button('Download AI background-removal engine')).toBeTruthy();
  });

  it('only calls the download function once the confirm dialog is explicitly accepted', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadConsentedFile').mockResolvedValue({
      kind: 'success',
      path: '/data/onnxruntime/libonnxruntime.so',
      bytes: 24_268_848,
    });

    act(() => root.render(<OnnxRuntimeSection />));
    await flush();
    act(() => button('Download AI background-removal engine')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();

    act(() => button('Download')?.click());
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Downloaded and verified successfully');
  });

  it('shows an inline error and lets the user retry when the download fails', async () => {
    vi.spyOn(modelDownload, 'downloadConsentedFile').mockResolvedValue({
      kind: 'error',
      message: 'could not reach github.com — check your network connection.',
    });

    act(() => root.render(<OnnxRuntimeSection />));
    await flush();
    act(() => button('Download AI background-removal engine')?.click());
    await flush();
    act(() => button('Download')?.click());
    await flush();

    expect(container.textContent).toContain('could not reach github.com');
    expect(button('Try again')).toBeTruthy();
  });
});
