import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simulateColorBlindness } from '../lib/colorBlind';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
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

describe('PalettePanel — indexed color mode sprite palette (docs/08-roadmap.md Phase 7)', () => {
  const spritePalette: Palette = {
    id: 'sp1',
    name: 'Sprite Colours',
    colors: [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  beforeEach(() => {
    useHistoryStore.getState().clear();
    act(() => useDocumentStore.getState().newDocument(4, 4, 'indexed', spritePalette));
    useHistoryStore.getState().clear();
    // The component was mounted in the outer `beforeEach` before this ran —
    // force a fresh render so it reflects the just-created indexed document.
    act(() => root.render(<PalettePanel />));
  });

  const section = () =>
    Array.from(container.querySelectorAll('.panel-head')).find(
      (h) => h.textContent === "This Sprite's Palette",
    )?.parentElement as HTMLElement | undefined;
  const assignSelect = () =>
    container.querySelector(
      'select[aria-label="Assign a different palette to this sprite"]',
    ) as HTMLSelectElement;
  const recolorInputs = () =>
    Array.from(
      container.querySelectorAll('.palette-swatch-recolor input[type="color"]'),
    ) as HTMLInputElement[];

  /**
   * Setting `.value` directly and dispatching a plain event does not reach a
   * React-controlled input's `onChange` reliably in jsdom — the same fix this
   * project already applies in `LayerEffectsSection.test.tsx`/
   * `TimelinePanel.test.tsx`/`SliderField.test.tsx`: go through the native
   * property setter so React's own change-detection actually fires.
   */
  function setNativeInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('is not shown for an rgba-mode sprite', () => {
    act(() => useDocumentStore.getState().newDocument(4, 4));
    act(() => root.render(<PalettePanel />));
    expect(section()).toBeUndefined();
  });

  it('shows one recolor swatch per sprite palette entry, matching its colour', () => {
    const inputs = recolorInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value.toLowerCase()).toBe('#ff0000');
    expect(inputs[1].value.toLowerCase()).toBe('#00ff00');
  });

  it('recoloring a swatch updates the sprite palette live and is undoable', () => {
    const input = recolorInputs()[0];
    act(() => setNativeInputValue(input, '#123456'));

    expect(useDocumentStore.getState().sprite.palette?.colors[0]).toEqual([0x12, 0x34, 0x56, 255]);

    act(() => useHistoryStore.getState().undo());
    expect(useDocumentStore.getState().sprite.palette?.colors[0]).toEqual([255, 0, 0, 255]);
  });

  it('assigning a different palette swaps the sprite palette wholesale', () => {
    const target = usePaletteStore.getState().palettes[1];
    act(() => {
      assignSelect().value = target.id;
      assignSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(useDocumentStore.getState().sprite.palette?.colors).toEqual(target.colors);
  });
});
