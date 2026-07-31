/**
 * `docs/08-roadmap.md` Phase 7 "Batch conversion + CLI headless mode",
 * `docs/06-workflows.md` W5's dialog: folder pickers, the four primary
 * controls, "use these settings" from an existing conversion layer, a live
 * per-file progress list streamed from `batchConvert`'s `onProgress`
 * callback, and cancellation.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const batchConvertMock = vi.fn();
const cancelBatchConvertMock = vi.fn();
const hasBackendMock = vi.fn(() => true);
vi.mock('../ipc/commands', async () => {
  const actual = await vi.importActual<typeof import('../ipc/commands')>('../ipc/commands');
  return {
    ...actual,
    hasBackend: () => hasBackendMock(),
    batchConvert: (...args: unknown[]) => batchConvertMock(...args),
    cancelBatchConvert: (...args: unknown[]) => cancelBatchConvertMock(...args),
  };
});

import type { BatchConvertEvent } from '../ipc/commands';
import { conversionDocument } from '../convert/editHandoff';
import { defaultSettings } from '../pipeline/settings';
import { useDocumentStore } from '../state/documentStore';
import { bufferFrom } from '../pipeline/buffer';
import { BatchConvertDialog } from './BatchConvertDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: () => void;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = vi.fn() as () => void;
  act(() => root.render(<BatchConvertDialog onClose={onClose} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  useDocumentStore.getState().newDocument(4, 4);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const runButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    /^Run|Running…$/.test(b.textContent ?? ''),
  )!;
const chooseButtons = () =>
  Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Choose…');

describe('folder selection', () => {
  it('disables Run until both a source and an output folder are chosen', async () => {
    render();
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);

    openMock.mockResolvedValueOnce('/tmp/src');
    await act(async () => {
      chooseButtons()[0].click();
      await Promise.resolve();
    });
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);

    openMock.mockResolvedValueOnce('/tmp/out');
    await act(async () => {
      chooseButtons()[1].click();
      await Promise.resolve();
    });
    expect((runButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('passes directory:true to the folder picker', async () => {
    render();
    openMock.mockResolvedValueOnce('/tmp/src');
    await act(async () => {
      chooseButtons()[0].click();
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });

  /**
   * Caught live over CDP against the real Vite dev bundle (no Tauri shell,
   * so `@tauri-apps/plugin-dialog`'s `open()` really does throw rather than
   * resolving `null`): with no try/catch around the folder pickers, clicking
   * "Choose…" produced an uncaught exception / unhandled rejection instead
   * of the honest in-dialog error every other failure path here shows.
   */
  it('shows an honest error instead of an unhandled rejection when the folder picker itself fails', async () => {
    render();
    openMock.mockRejectedValueOnce(new Error('no such backend'));
    await act(async () => {
      chooseButtons()[0].click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('no such backend');
  });
});

describe('loading settings from a conversion layer', () => {
  it('shows no "use these settings" button when the document has no conversion layer', () => {
    render();
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Use settings from'),
    );
    expect(btn).toBeUndefined();
  });

  it('offers to load settings when a conversion layer exists, and carries its palette/dither into the request', async () => {
    const image = bufferFrom(2, 2, new Uint8ClampedArray(2 * 2 * 4));
    const settings = {
      ...defaultSettings(2, 2, {
        kind: 'fixed' as const,
        colors: [[1, 2, 3, 255] as const],
      }),
      dither: 'atkinson' as const,
      ditherStrength: 0.42,
    };
    const { sprite, pixels } = conversionDocument(image, 1, settings, 'My Photo');
    act(() => useDocumentStore.getState().replaceDocument(sprite, pixels));

    render();
    const useBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Use settings from'),
    )!;
    expect(useBtn).toBeDefined();
    act(() => useBtn.click());

    expect(container.textContent).toContain('My Photo');

    openMock.mockResolvedValueOnce('/tmp/src').mockResolvedValueOnce('/tmp/out');
    await act(async () => {
      chooseButtons()[0].click();
      await Promise.resolve();
    });
    await act(async () => {
      chooseButtons()[1].click();
      await Promise.resolve();
    });

    batchConvertMock.mockResolvedValue({
      jobId: 1,
      total: 0,
      succeeded: 0,
      failed: 0,
      cancelled: false,
    });
    await act(async () => {
      (runButton() as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const [request] = batchConvertMock.mock.calls[0];
    expect(request.settings.dither).toBe('atkinson');
    expect(request.settings.ditherStrength).toBeCloseTo(0.42);
    expect(request.settings.palette).toEqual({ kind: 'fixed', colors: [[1, 2, 3, 255]] });
  });
});

describe('running a batch', () => {
  async function chooseFolders() {
    openMock.mockResolvedValueOnce('/tmp/src').mockResolvedValueOnce('/tmp/out');
    await act(async () => {
      chooseButtons()[0].click();
      await Promise.resolve();
    });
    await act(async () => {
      chooseButtons()[1].click();
      await Promise.resolve();
    });
  }

  it('renders a per-file progress row for each streamed event and shows the final summary', async () => {
    render();
    await chooseFolders();

    let deliver: (e: BatchConvertEvent) => void = () => {};
    batchConvertMock.mockImplementation(
      (_req: unknown, onProgress: (e: BatchConvertEvent) => void) => {
        deliver = onProgress;
        return new Promise((resolve) => {
          (globalThis as { __resolveBatch?: (v: unknown) => void }).__resolveBatch = resolve;
        });
      },
    );

    await act(async () => {
      (runButton() as HTMLButtonElement).click();
      await Promise.resolve();
    });

    act(() => deliver({ kind: 'started', jobId: 9, total: 2 }));
    act(() => deliver({ kind: 'fileStarted', index: 0, file: 'a.png' }));
    act(() =>
      deliver({
        kind: 'fileSucceeded',
        index: 0,
        file: 'a.png',
        outputPath: '/tmp/out/a.png',
        width: 4,
        height: 4,
        colorsUsed: 3,
      }),
    );
    act(() => deliver({ kind: 'fileFailed', index: 1, file: 'b.png', error: 'bad file' }));

    expect(container.textContent).toContain('a.png');
    expect(container.textContent).toContain('3 colours');
    expect(container.textContent).toContain('b.png');
    expect(container.textContent).toContain('bad file');

    // Cancel is offered while running.
    const cancelBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    );
    expect(cancelBtn).toBeDefined();
    act(() => cancelBtn!.click());
    expect(cancelBatchConvertMock).toHaveBeenCalledWith(9);

    await act(async () => {
      (globalThis as { __resolveBatch?: (v: unknown) => void }).__resolveBatch?.({
        jobId: 9,
        total: 2,
        succeeded: 1,
        failed: 1,
        cancelled: false,
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('1 succeeded, 1 failed');
    // Cancel disappears once the run has finished.
    expect(
      Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Cancel'),
    ).toBe(false);
  });

  it('reports an error rather than throwing when there is no backend', async () => {
    hasBackendMock.mockReturnValueOnce(false);

    render();
    await chooseFolders();
    await act(async () => {
      (runButton() as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('needs the desktop app');
    expect(batchConvertMock).not.toHaveBeenCalled();
  });
});
