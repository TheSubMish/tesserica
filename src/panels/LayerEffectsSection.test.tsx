import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Effect } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { usePaletteStore } from '../state/paletteStore';
import { LayerEffectsSection } from './LayerEffectsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const layer = () => doc().sprite.layers[0];

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<LayerEffectsSection layer={layer()} />));
}

beforeEach(() => {
  history().clear();
  doc().newDocument(4, 4);
  history().clear();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** See `panels/TimelinePanel.test.tsx` for why a tracker-bypassing setter is needed. */
function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const addEffectSelect = () =>
  container.querySelector('select[aria-label="Add effect"]') as HTMLSelectElement;
const button = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

function addEffect(kind: string) {
  act(() => setNativeSelectValue(addEffectSelect(), kind));
  render();
}

describe('LayerEffectsSection', () => {
  it('shows a hint and no rows when the layer has no effects', () => {
    expect(container.textContent).toContain('No effects on this layer.');
    expect(container.querySelectorAll('.effect-row')).toHaveLength(0);
  });

  it('adds each of the five kinds via the add-effect dropdown', () => {
    for (const kind of ['outline', 'outline-inner', 'drop-shadow', 'gradient-map', 'hsv-shift']) {
      addEffect(kind);
    }
    expect(layer().effects.map((e) => e.kind)).toEqual([
      'outline',
      'outline-inner',
      'drop-shadow',
      'gradient-map',
      'hsv-shift',
    ]);
    expect(container.querySelectorAll('.effect-row')).toHaveLength(5);
  });

  it('toggles an effect enabled/disabled via its own button, undoably', () => {
    addEffect('outline');
    const id = layer().effects[0].id;

    const toggle = button('Disable Outline')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    act(() => toggle.click());
    render();

    expect(layer().effects.find((e) => e.id === id)!.enabled).toBe(false);
    expect(button('Enable Outline')!.getAttribute('aria-pressed')).toBe('false');

    act(() => history().undo());
    expect(layer().effects.find((e) => e.id === id)!.enabled).toBe(true);
  });

  it('removes an effect via its own button', () => {
    addEffect('outline');
    expect(layer().effects).toHaveLength(1);
    act(() => button('Remove Outline')!.click());
    render();
    expect(layer().effects).toHaveLength(0);
  });

  it('reorders effects with the up/down buttons, disabling at either end', () => {
    addEffect('outline');
    addEffect('gradient-map');
    const [outlineId, gradientId] = layer().effects.map((e) => e.id);

    expect(button('Move Outline up')!.hasAttribute('disabled')).toBe(true);
    expect(button('Move Gradient Map down')!.hasAttribute('disabled')).toBe(true);

    act(() => button('Move Outline down')!.click());
    render();
    expect(layer().effects.map((e) => e.id)).toEqual([gradientId, outlineId]);
  });

  it("edits an outline's thickness and colour through its own controls", () => {
    addEffect('outline');
    const id = layer().effects[0].id;

    const thicknessInput = container.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => setNativeInputValue(thicknessInput, '5'));
    render();
    const outlineEffect = () =>
      layer().effects.find((e) => e.id === id) as Extract<Effect, { kind: 'outline' }>;
    expect(outlineEffect().thickness).toBe(5);

    const colorInput = container.querySelector('input[type="color"]') as HTMLInputElement;
    act(() => setNativeInputValue(colorInput, '#00ff00'));
    render();
    expect(outlineEffect().color.slice(0, 3)).toEqual([0, 255, 0]);
  });

  it('an outline has no "corners" checkbox on outline-inner', () => {
    addEffect('outline');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    addEffect('outline-inner');
    // Still exactly one checkbox — only the outline (outward) row has one.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it("gradient-map's palette picker snapshots the chosen palette's colours", () => {
    addEffect('gradient-map');
    const id = layer().effects[0].id;
    const gradientEffect = () =>
      layer().effects.find((e) => e.id === id) as Extract<Effect, { kind: 'gradient-map' }>;
    expect(gradientEffect().palette).toHaveLength(2);

    const palette = usePaletteStore.getState().palettes[0];
    const select = container.querySelector(
      'select[aria-label="Load gradient from palette"]',
    ) as HTMLSelectElement;
    act(() => setNativeSelectValue(select, palette.id));
    render();

    const after = gradientEffect().palette;
    expect(after).toEqual(palette.colors);
    // A snapshot, not the same array reference as the palette store's own.
    expect(after).not.toBe(palette.colors);
  });
});
