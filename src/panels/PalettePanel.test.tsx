import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simulateColorBlindness } from '../lib/colorBlind';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';
import { PalettePanel } from './PalettePanel';

/**
 * `docs/05-ui-design.md` §8 — colour-blindness simulation in the palette
 * panel. Swatches must repaint under simulation *without* changing what a
 * click actually picks — the preview is for judging the palette, not for
 * constraining what the artist can paint with.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PalettePanel />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const simulateSelect = () =>
  container.querySelector('select[aria-label="Simulate colour blindness"]') as HTMLSelectElement;
const firstSwatch = () => container.querySelector('.palette-swatch') as HTMLButtonElement;

describe('PalettePanel colour-blindness simulation', () => {
  it('defaults to no simulation', () => {
    expect(simulateSelect().value).toBe('none');
  });

  it('repaints swatches under a simulation mode', () => {
    const palette = usePaletteStore
      .getState()
      .palettes.find((p) => p.id === usePaletteStore.getState().activePaletteId)!;
    const trueColor = palette.colors[0];
    const before = firstSwatch().style.background;

    act(() => {
      simulateSelect().value = 'deuteranopia';
      simulateSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });

    const [er, eg, eb] = simulateColorBlindness(trueColor, 'deuteranopia');
    // jsdom re-serializes `background` through its own CSSOM, so compare the
    // parsed channel values rather than the exact string `toCss` produced.
    expect(firstSwatch().style.background).toMatch(new RegExp(`${er},\\s*${eg},\\s*${eb}`));
    // Sanity: the deuteranopia matrix is not the identity for a real palette
    // colour, so the swatch must actually have changed.
    if (trueColor[0] !== trueColor[1] || trueColor[1] !== trueColor[2]) {
      expect(firstSwatch().style.background).not.toBe(before);
    }
  });

  it('still picks the true colour, not the simulated one, on click', () => {
    const palette = usePaletteStore
      .getState()
      .palettes.find((p) => p.id === usePaletteStore.getState().activePaletteId)!;
    const trueColor = palette.colors[0];

    act(() => {
      simulateSelect().value = 'protanopia';
      simulateSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => firstSwatch().dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(useToolStore.getState().primary).toEqual(trueColor);
  });
});
