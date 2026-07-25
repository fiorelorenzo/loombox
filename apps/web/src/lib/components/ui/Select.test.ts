// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Select from './Select.svelte';

afterEach(() => cleanup());

const OPTIONS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
];

describe('Select (redesign v3 design spec §3.5, issue #502)', () => {
  it("renders the current option's label on the trigger", () => {
    render(Select, {
      props: { value: 'opus', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    expect(screen.getByTestId('ui-select-trigger').textContent).toContain('Opus');
  });

  it('opens the listbox on trigger click', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    expect(screen.queryByRole('listbox')).toBeNull();

    await fireEvent.click(screen.getByTestId('ui-select-trigger'));

    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByTestId('ui-select-trigger').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the listbox on ArrowDown', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    const trigger = screen.getByTestId('ui-select-trigger');

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('arrow keys move the active option, tracked via aria-activedescendant', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    const trigger = screen.getByTestId('ui-select-trigger');
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Sonnet' }).id,
    );

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Opus' }).id,
    );

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Haiku' }).id,
    );

    // Wraps around rather than stopping at the last option.
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Sonnet' }).id,
    );

    await fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Haiku' }).id,
    );
  });

  it('Enter selects the active option and calls onChange with its id, then closes', async () => {
    const onChange = vi.fn();
    render(Select, { props: { value: 'sonnet', options: OPTIONS, onChange, label: 'Model' } });
    const trigger = screen.getByTestId('ui-select-trigger');

    await fireEvent.click(trigger);
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // sonnet -> opus
    await fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('opus');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Space selects the active option the same way Enter does', async () => {
    const onChange = vi.fn();
    render(Select, { props: { value: 'sonnet', options: OPTIONS, onChange, label: 'Model' } });
    const trigger = screen.getByTestId('ui-select-trigger');

    await fireEvent.keyDown(trigger, { key: ' ' }); // closed -> opens
    expect(screen.getByRole('listbox')).toBeTruthy();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // sonnet -> opus
    await fireEvent.keyDown(trigger, { key: ' ' }); // open -> selects

    expect(onChange).toHaveBeenCalledWith('opus');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking an option selects it, calls onChange, and closes', async () => {
    const onChange = vi.fn();
    render(Select, { props: { value: 'sonnet', options: OPTIONS, onChange, label: 'Model' } });

    await fireEvent.click(screen.getByTestId('ui-select-trigger'));
    await fireEvent.click(screen.getByRole('option', { name: 'Haiku' }));

    expect(onChange).toHaveBeenCalledWith('haiku');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the listbox and returns focus to the trigger', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    const trigger = screen.getByTestId('ui-select-trigger') as HTMLButtonElement;

    await fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    await fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click outside the component closes the listbox', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    await fireEvent.click(screen.getByTestId('ui-select-trigger'));
    expect(screen.getByRole('listbox')).toBeTruthy();

    await fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a pointerdown inside the component (e.g. on an option) does not trigger the outside-close path', async () => {
    const onChange = vi.fn();
    render(Select, { props: { value: 'sonnet', options: OPTIONS, onChange, label: 'Model' } });
    await fireEvent.click(screen.getByTestId('ui-select-trigger'));

    await fireEvent.pointerDown(screen.getByRole('option', { name: 'Opus' }));

    // Still open — a pointerdown inside the root is ignored by the
    // window-level dismiss listener; only the option's own click commits.
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('Tab closes the listbox', async () => {
    render(Select, {
      props: { value: 'sonnet', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    const trigger = screen.getByTestId('ui-select-trigger');
    await fireEvent.click(trigger);

    await fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('exposes aria-haspopup/aria-expanded/role=listbox/role=option/aria-selected correctly', async () => {
    render(Select, {
      props: { value: 'opus', options: OPTIONS, onChange: vi.fn(), label: 'Model' },
    });
    const trigger = screen.getByTestId('ui-select-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);

    await fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-label')).toBe('Model');

    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: 'Opus' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'Sonnet' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('option', { name: 'Haiku' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('a disabled select opens for neither a click nor the keyboard', async () => {
    render(Select, {
      props: {
        value: 'sonnet',
        options: OPTIONS,
        onChange: vi.fn(),
        label: 'Model',
        disabled: true,
      },
    });
    const trigger = screen.getByTestId('ui-select-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);

    await fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('defaults data-testid to "ui-select" but lets a caller override it (per-instance ids)', () => {
    render(Select, {
      props: {
        value: 'sonnet',
        options: OPTIONS,
        onChange: vi.fn(),
        label: 'Model',
        dataTestId: 'config-option-model',
      },
    });
    expect(screen.getByTestId('config-option-model')).toBeTruthy();
    expect(screen.getByTestId('config-option-model-trigger')).toBeTruthy();
    expect(screen.queryByTestId('ui-select')).toBeNull();
  });
});
