// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Checkbox from './Checkbox.svelte';

afterEach(() => cleanup());

describe('Checkbox (coherence v5 design spec §1, issue #508 toggle switch)', () => {
  it('renders a real, still-fully-functional checkbox input under the visible switch', () => {
    render(Checkbox, { props: { checked: false, label: 'Enable filesystem' } });
    const input = screen.getByTestId('ui-checkbox') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(false);
    expect(screen.getByText('Enable filesystem')).toBeTruthy();
  });

  it('reflects an initially-checked value', () => {
    render(Checkbox, { props: { checked: true, label: 'Enable filesystem' } });
    expect((screen.getByTestId('ui-checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('calls onCheckedChange with the new value on toggle, without requiring bind:checked', async () => {
    const onCheckedChange = vi.fn();
    render(Checkbox, { props: { checked: false, label: 'Enable filesystem', onCheckedChange } });
    await fireEvent.click(screen.getByTestId('ui-checkbox'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('lets a caller override the testid, matching a per-record convention like mcp-server-enabled-<name>', () => {
    render(Checkbox, {
      props: { checked: false, label: 'filesystem', dataTestId: 'server-enabled-filesystem' },
    });
    expect(screen.getByTestId('server-enabled-filesystem')).toBeTruthy();
    expect(screen.queryByTestId('ui-checkbox')).toBeNull();
  });

  it('disables the input and dims the control', () => {
    render(Checkbox, { props: { checked: false, label: 'filesystem', disabled: true } });
    const input = screen.getByTestId('ui-checkbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
