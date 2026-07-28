import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliderField } from './SliderField';

/**
 * `docs/05-ui-design.md` §7.6 — "Click the value to type it." This is the one
 * behaviour every slider in the app shares, so it is worth testing once here
 * rather than once per panel.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<React.ComponentProps<typeof SliderField>> = {}) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <SliderField label="Size" min={0} max={10} value={4} onChange={onChange} {...props} />,
    );
  });
  return { onChange };
}

const range = () => container.querySelector('input[type="range"]') as HTMLInputElement;
const readout = () => container.querySelector('output') as HTMLElement;
const numberInput = () => container.querySelector('input[type="number"]') as HTMLInputElement;

/**
 * Setting `.value` directly does not go through React's tracked-value setter,
 * so the subsequent `input` event is silently dropped — a well-known jsdom/React
 * testing gotcha, not specific to this component.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SliderField', () => {
  it('shows the value as a readout, not an editable field, until clicked', () => {
    render();
    expect(readout().textContent).toBe('4');
    expect(numberInput()).toBeNull();
  });

  it('applies the format function to the display value only', () => {
    render({ value: 0.5, format: (v) => `${(v * 100).toFixed(0)}%` });
    expect(readout().textContent).toBe('50%');
  });

  it('switches to a number field on click', () => {
    render();
    act(() => readout().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(numberInput()).not.toBeNull();
    expect(numberInput().value).toBe('4');
  });

  it('commits a typed value on Enter, clamped to range', () => {
    const { onChange } = render();
    act(() => readout().dispatchEvent(new MouseEvent('click', { bubbles: true })));

    act(() => typeInto(numberInput(), '999'));
    act(() => {
      numberInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(10); // clamped to max
    expect(numberInput()).toBeNull(); // back to the readout
  });

  it('discards the edit on Escape without calling onChange', () => {
    const { onChange } = render();
    act(() => readout().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => typeInto(numberInput(), '7'));
    act(() => {
      numberInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(numberInput()).toBeNull();
  });

  it('calls onDragStart once when a range drag begins', () => {
    const onDragStart = vi.fn();
    render({ onDragStart });
    act(() => range().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it('is not clickable to edit while disabled', () => {
    render({ disabled: true });
    expect(readout().getAttribute('tabIndex')).toBe('-1');
    act(() => readout().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(numberInput()).toBeNull();
  });
});
