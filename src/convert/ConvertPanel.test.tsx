import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as commands from '../ipc/commands.ts';
import { useConvertStore } from '../state/convertStore.ts';
import { ConvertPanel } from './ConvertPanel.tsx';

/**
 * Convert-mode's "AI segmentation" background-removal method option
 * (`docs/08-roadmap.md` Phase 5 — connecting ML background removal
 * end-to-end). These tests exercise only the availability-gating and
 * preview-honesty pieces described in `ConvertPanel.tsx`'s own Background
 * section, not the full panel — everything else there already has its own
 * coverage via `convertStore.test.ts`/`pipeline.test.ts`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL = useConvertStore.getState();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useConvertStore.setState(INITIAL, true);
  vi.spyOn(commands, 'hasBackend').mockReturnValue(true);

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

function openBackgroundSection() {
  const header = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Background'),
  ) as HTMLButtonElement;
  act(() => header.click());
}

function enableBackgroundRemoval() {
  const checkbox = Array.from(container.querySelectorAll('input[type="checkbox"]')).find(
    (el) => el.closest('label')?.textContent === 'Remove background',
  ) as HTMLInputElement;
  act(() => checkbox.click());
}

function radio(label: string): HTMLInputElement {
  return Array.from(container.querySelectorAll('input[type="radio"]')).find(
    (el) => el.closest('label')?.textContent === label,
  ) as HTMLInputElement;
}

describe('ConvertPanel background removal method', () => {
  it('disables the AI segmentation radio and shows the reason while unavailable', async () => {
    vi.spyOn(commands, 'segmentationAvailability').mockResolvedValue({
      available: false,
      reason: 'no segmentation model available',
    });

    act(() => root.render(<ConvertPanel onExport={() => {}} onEdit={() => {}} />));
    openBackgroundSection();
    enableBackgroundRemoval();
    await flush();

    const mlRadio = radio('AI segmentation (u2net)');
    expect(mlRadio.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="ml-segmentation-unavailable"]')?.textContent,
    ).toContain('no segmentation model available');
  });

  it('enables the radio once available, and selecting it shows the preview-not-available note', async () => {
    vi.spyOn(commands, 'segmentationAvailability').mockResolvedValue({ available: true });

    act(() => root.render(<ConvertPanel onExport={() => {}} onEdit={() => {}} />));
    openBackgroundSection();
    enableBackgroundRemoval();
    await flush();

    const mlRadio = radio('AI segmentation (u2net)');
    expect(mlRadio.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();

    act(() => mlRadio.click());
    await flush();

    expect(useConvertStore.getState().backgroundRemovalMethod).toBe('ml');
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Preview isn't available for AI segmentation");
  });

  it('never calls segmentationAvailability when there is no backend', async () => {
    vi.spyOn(commands, 'hasBackend').mockReturnValue(false);
    const spy = vi.spyOn(commands, 'segmentationAvailability');

    act(() => root.render(<ConvertPanel onExport={() => {}} onEdit={() => {}} />));
    await flush();

    expect(spy).not.toHaveBeenCalled();
  });
});
