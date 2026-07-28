// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Input from './Input.svelte';

afterEach(() => cleanup());

describe('Input (coherence v5 design spec §1, issue #508)', () => {
  it('defaults to a text input, testid "ui-input", and forwards a typed value via bind:value semantics', async () => {
    render(Input, { props: { value: '' } });
    const input = screen.getByTestId('ui-input') as HTMLInputElement;
    expect(input.type).toBe('text');
    await fireEvent.input(input, { target: { value: 'hello' } });
    expect(input.value).toBe('hello');
  });

  it('lets a caller override the type, e.g. number', () => {
    render(Input, { props: { value: '', type: 'number' } });
    expect((screen.getByTestId('ui-input') as HTMLInputElement).type).toBe('number');
  });

  it('applies the monospace class only when requested', () => {
    render(Input, { props: { value: '', monospace: true } });
    expect(screen.getByTestId('ui-input').classList.contains('font-mono')).toBe(true);

    cleanup();
    render(Input, { props: { value: '' } });
    expect(screen.getByTestId('ui-input').classList.contains('font-mono')).toBe(false);
  });

  it('wires Field-style aria attributes only when the corresponding prop is set', () => {
    render(Input, {
      props: { value: '', describedBy: 'help-1', errorId: 'err-1', invalid: true, required: true },
    });
    const input = screen.getByTestId('ui-input');
    expect(input.getAttribute('aria-describedby')).toBe('help-1');
    expect(input.getAttribute('aria-errormessage')).toBe('err-1');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');

    cleanup();
    render(Input, { props: { value: '' } });
    const plain = screen.getByTestId('ui-input');
    expect(plain.hasAttribute('aria-describedby')).toBe(false);
    expect(plain.hasAttribute('aria-errormessage')).toBe(false);
    expect(plain.hasAttribute('aria-invalid')).toBe(false);
    expect(plain.hasAttribute('aria-required')).toBe(false);
  });

  it('fires oninput/onchange callbacks alongside the value binding', async () => {
    const oninput = vi.fn();
    const onchange = vi.fn();
    render(Input, { props: { value: '', oninput, onchange } });
    const input = screen.getByTestId('ui-input');
    await fireEvent.input(input, { target: { value: 'x' } });
    expect(oninput).toHaveBeenCalledTimes(1);
    await fireEvent.change(input);
    expect(onchange).toHaveBeenCalledTimes(1);
  });

  it('disables the control and lets a caller override the testid', () => {
    render(Input, { props: { value: '', disabled: true, dataTestId: 'my-input' } });
    const input = screen.getByTestId('my-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.queryByTestId('ui-input')).toBeNull();
  });
});
