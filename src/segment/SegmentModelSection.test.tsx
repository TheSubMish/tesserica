import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as commands from '../ipc/commands.ts';
import * as modelDownload from './modelDownload.ts';
import { SegmentModelSection } from './SegmentModelSection.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO = {
  id: 'isnet-general-use',
  filename: 'isnet-general-use.onnx',
  sourceUrl: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  approxBytes: 178_648_008,
  license: 'Apache-2.0',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(commands, 'hasBackend').mockReturnValue(true);
  vi.spyOn(commands, 'segmentationModelInfo').mockResolvedValue(INFO);
  vi.spyOn(commands, 'segmentationModelStatus').mockResolvedValue({ present: false, path: '' });

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

describe('SegmentModelSection', () => {
  it('never calls the download function on mount', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadLargerSegmentationModel');

    act(() => root.render(<SegmentModelSection />));
    await flush();

    expect(spy).not.toHaveBeenCalled();
  });

  it('only shows the confirm step, not a download, after the initial button click', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadLargerSegmentationModel');

    act(() => root.render(<SegmentModelSection />));
    await flush();

    act(() => button('Download larger model for better quality')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('170.4 MB');
    expect(container.textContent).toContain('github.com');
  });

  it('cancelling the confirm step never triggers a download', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadLargerSegmentationModel');

    act(() => root.render(<SegmentModelSection />));
    await flush();
    act(() => button('Download larger model for better quality')?.click());
    await flush();
    act(() => button('Cancel')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(button('Download larger model for better quality')).toBeTruthy();
  });

  it('only calls the download function once the confirm dialog is explicitly accepted', async () => {
    const spy = vi.spyOn(modelDownload, 'downloadLargerSegmentationModel').mockResolvedValue({
      kind: 'success',
      path: '/data/models/isnet-general-use.onnx',
      bytes: 3,
    });

    act(() => root.render(<SegmentModelSection />));
    await flush();
    act(() => button('Download larger model for better quality')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();

    act(() => button('Download')?.click());
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Downloaded and verified successfully');
  });

  it('shows an inline error and lets the user retry when the download fails', async () => {
    vi.spyOn(modelDownload, 'downloadLargerSegmentationModel').mockResolvedValue({
      kind: 'error',
      message: 'could not reach github.com — check your network connection.',
    });

    act(() => root.render(<SegmentModelSection />));
    await flush();
    act(() => button('Download larger model for better quality')?.click());
    await flush();
    act(() => button('Download')?.click());
    await flush();

    expect(container.textContent).toContain('could not reach github.com');
    expect(button('Try again')).toBeTruthy();
  });
});
