import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as lospecImport from '../lib/lospecImport';
import { usePaletteStore } from '../state/paletteStore';
import { LospecImportSection } from './LospecImportSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const initialPalettes = usePaletteStore.getState().palettes;
const initialActive = usePaletteStore.getState().activePaletteId;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  usePaletteStore.setState({ palettes: initialPalettes, activePaletteId: initialActive });
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

const urlInput = () =>
  container.querySelector('input[aria-label="Lospec palette URL"]') as HTMLInputElement;

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('LospecImportSection', () => {
  it('never calls the import function on mount', async () => {
    const spy = vi.spyOn(lospecImport, 'importLospecPalette');
    act(() => root.render(<LospecImportSection />));
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows the URL field after clicking the toggle, without fetching', async () => {
    const spy = vi.spyOn(lospecImport, 'importLospecPalette');
    act(() => root.render(<LospecImportSection />));
    await flush();

    act(() => button('Import from Lospec URL…')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(urlInput()).toBeTruthy();
  });

  it('never fetches just from typing/pasting a URL — only an explicit confirm click', async () => {
    const spy = vi.spyOn(lospecImport, 'importLospecPalette');
    act(() => root.render(<LospecImportSection />));
    await flush();
    act(() => button('Import from Lospec URL…')?.click());
    await flush();

    act(() => setInputValue(urlInput(), 'https://lospec.com/palette-list/pear36'));
    await flush();

    expect(spy).not.toHaveBeenCalled();
  });

  it('disables the fetch button while the URL is invalid, with an inline reason', async () => {
    act(() => root.render(<LospecImportSection />));
    await flush();
    act(() => button('Import from Lospec URL…')?.click());
    await flush();

    act(() => setInputValue(urlInput(), 'https://example.com/not-lospec'));
    await flush();

    const fetchButton = button('Fetch from lospec.com');
    expect(fetchButton?.disabled).toBe(true);
    expect(container.textContent).toContain('lospec.com');
  });

  it('only calls the import function once Fetch is explicitly clicked, and adds the palette on success', async () => {
    const spy = vi.spyOn(lospecImport, 'importLospecPalette').mockResolvedValue({
      kind: 'success',
      palette: {
        id: 'pear36',
        name: 'pear36',
        colors: [[94, 49, 91, 255]],
        source: { kind: 'file', ref: 'x' },
      },
    });

    act(() => root.render(<LospecImportSection />));
    await flush();
    act(() => button('Import from Lospec URL…')?.click());
    await flush();
    act(() => setInputValue(urlInput(), 'https://lospec.com/palette-list/pear36'));
    await flush();

    expect(spy).not.toHaveBeenCalled();

    act(() => button('Fetch from lospec.com')?.click());
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Imported');
    expect(usePaletteStore.getState().palettes.some((p) => p.id === 'pear36')).toBe(true);
  });

  it('shows an inline error and lets the user retry on failure, without touching the palette store', async () => {
    vi.spyOn(lospecImport, 'importLospecPalette').mockResolvedValue({
      kind: 'error',
      message: 'No palette named "nope" found on Lospec.',
    });

    const before = usePaletteStore.getState().palettes.length;

    act(() => root.render(<LospecImportSection />));
    await flush();
    act(() => button('Import from Lospec URL…')?.click());
    await flush();
    act(() => setInputValue(urlInput(), 'https://lospec.com/palette-list/nope'));
    await flush();
    act(() => button('Fetch from lospec.com')?.click());
    await flush();

    expect(container.textContent).toContain('No palette named "nope" found on Lospec.');
    expect(button('Try again')).toBeTruthy();
    expect(usePaletteStore.getState().palettes.length).toBe(before);
  });

  it('cancelling the form never triggers a fetch', async () => {
    const spy = vi.spyOn(lospecImport, 'importLospecPalette');
    act(() => root.render(<LospecImportSection />));
    await flush();
    act(() => button('Import from Lospec URL…')?.click());
    await flush();
    act(() => setInputValue(urlInput(), 'https://lospec.com/palette-list/pear36'));
    await flush();
    act(() => button('Cancel')?.click());
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(button('Import from Lospec URL…')).toBeTruthy();
  });
});
