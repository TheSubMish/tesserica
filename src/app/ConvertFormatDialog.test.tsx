/**
 * `ConvertFormatDialog` — pick a source image, pick a target format, pick an
 * output path, convert. Unlike `BatchConvertDialog` this never touches the
 * open document, so there is no store setup here.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

const convertImageFormatMock = vi.fn();
const hasBackendMock = vi.fn(() => true);
vi.mock('../ipc/commands', async () => {
  const actual = await vi.importActual<typeof import('../ipc/commands')>('../ipc/commands');
  return {
    ...actual,
    hasBackend: () => hasBackendMock(),
    convertImageFormat: (...args: unknown[]) => convertImageFormatMock(...args),
  };
});

import { ConvertFormatDialog } from './ConvertFormatDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: () => void;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = vi.fn() as () => void;
  act(() => root.render(<ConvertFormatDialog onClose={onClose} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  hasBackendMock.mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const convertButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    /^Convert…|Converting…$/.test(b.textContent ?? ''),
  )! as HTMLButtonElement;
const chooseButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Choose…')!;

async function pickInput(path: string) {
  openMock.mockResolvedValueOnce(path);
  await act(async () => {
    chooseButton().click();
    await Promise.resolve();
  });
}

describe('input selection', () => {
  it('disables Convert until an image is chosen', async () => {
    render();
    expect(convertButton().disabled).toBe(true);

    await pickInput('/tmp/photo.png');
    expect(convertButton().disabled).toBe(false);
  });

  it('shows just the filename, not the full path', async () => {
    render();
    await pickInput('/home/user/pictures/photo.png');
    expect(container.textContent).toContain('photo.png');
    expect(container.textContent).not.toContain('/home/user/pictures');
  });

  it('offers an "All files" fallback alongside the image filter', async () => {
    render();
    openMock.mockResolvedValueOnce(null);
    await act(async () => {
      chooseButton().click();
      await Promise.resolve();
    });
    const [request] = openMock.mock.calls[0];
    expect(request.filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'All files', extensions: ['*'] })]),
    );
  });

  it('shows an honest error instead of an unhandled rejection when the picker itself fails', async () => {
    render();
    openMock.mockRejectedValueOnce(new Error('no such backend'));
    await act(async () => {
      chooseButton().click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('no such backend');
  });
});

describe('converting', () => {
  it('defaults the save dialog to the chosen format’s extension and converts', async () => {
    render();
    await pickInput('/tmp/photo.png');

    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => {
      select.value = 'webp';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    saveMock.mockResolvedValueOnce('/tmp/photo.webp');
    convertImageFormatMock.mockResolvedValueOnce({
      path: '/tmp/photo.webp',
      width: 10,
      height: 8,
      bytes: 42,
    });

    await act(async () => {
      convertButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'photo.webp' }));
    expect(convertImageFormatMock).toHaveBeenCalledWith({
      inputPath: '/tmp/photo.png',
      outputPath: '/tmp/photo.webp',
      format: 'webp',
    });
    expect(container.textContent).toContain('10×8');
  });

  it('does nothing when the save dialog is dismissed', async () => {
    render();
    await pickInput('/tmp/photo.png');
    saveMock.mockResolvedValueOnce(null);

    await act(async () => {
      convertButton().click();
      await Promise.resolve();
    });

    expect(convertImageFormatMock).not.toHaveBeenCalled();
  });

  it('shows the backend error message on failure', async () => {
    render();
    await pickInput('/tmp/photo.png');
    saveMock.mockResolvedValueOnce('/tmp/photo.png');
    convertImageFormatMock.mockRejectedValueOnce(
      new Error('output path must be different from the input path'),
    );

    await act(async () => {
      convertButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('output path must be different from the input path');
  });

  it('shows an honest error when there is no backend, instead of calling invoke', async () => {
    hasBackendMock.mockReturnValue(false);
    render();
    await pickInput('/tmp/photo.png');

    await act(async () => {
      convertButton().click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('needs the desktop app');
    expect(saveMock).not.toHaveBeenCalled();
  });
});
