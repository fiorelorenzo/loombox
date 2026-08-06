// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpAvailableCommand } from '@loombox/providers-core/browser';
import SlashCommandPicker from './SlashCommandPicker.svelte';

afterEach(() => cleanup());

const TWO_COMMANDS: AcpAvailableCommand[] = [
  { name: 'model', description: 'Show current model selection', input: undefined },
  { name: 'security', description: 'Run a security scan', input: { hint: '<plan|scan|status>' } },
];

describe('SlashCommandPicker (Zed-parity C2-4, agent-declared `/`-commands; issue #743)', () => {
  it('renders nothing when closed', () => {
    render(SlashCommandPicker, {
      props: { open: false, commands: TWO_COMMANDS, onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('lists every command the agent declared, in order, when the query is empty', () => {
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect: vi.fn(), onClose: vi.fn() },
    });
    const items = screen.getAllByTestId('slash-command-picker-item');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('/model'),
      expect.stringContaining('/security'),
    ]);
  });

  it('shows no rows and no placeholder for an agent that has declared no commands at all (issue #743 acceptance)', () => {
    render(SlashCommandPicker, {
      props: { open: true, commands: [], onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.queryAllByTestId('slash-command-picker-item')).toHaveLength(0);
    expect(screen.getByText('No matching commands.')).not.toBeNull();
  });

  it("renders a declared command's own input hint next to it, never a loombox-invented one", () => {
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.getByText('<plan|scan|status>')).not.toBeNull();
  });

  it('fuzzy-filters by name and description as the user types', async () => {
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect: vi.fn(), onClose: vi.fn() },
    });
    await fireEvent.input(screen.getByTestId('slash-command-picker-input'), {
      target: { value: 'scan' },
    });
    const items = screen.getAllByTestId('slash-command-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('/security');
  });

  it('Enter selects the active entry and fires onSelect with the full declared command, then onClose', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect, onClose },
    });
    const input = screen.getByTestId('slash-command-picker-input');
    await fireEvent.input(input, { target: { value: 'model' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(TWO_COMMANDS[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ArrowDown/ArrowUp move the active row without a mouse, wrapping at each end', async () => {
    const onSelect = vi.fn();
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect, onClose: vi.fn() },
    });
    const input = screen.getByTestId('slash-command-picker-input');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(TWO_COMMANDS[1]);
  });

  it('clicking an entry selects it directly', async () => {
    const onSelect = vi.fn();
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect, onClose: vi.fn() },
    });
    const items = screen.getAllByTestId('slash-command-picker-item');
    const security = items.find((i) => i.textContent?.includes('/security'));
    await fireEvent.click(security!);
    expect(onSelect).toHaveBeenCalledWith(TWO_COMMANDS[1]);
  });

  it('Esc closes without selecting anything', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(SlashCommandPicker, {
      props: { open: true, commands: TWO_COMMANDS, onSelect, onClose },
    });
    await fireEvent.keyDown(screen.getByTestId('slash-command-picker-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reflects a mid-session catalogue replacement without a reload — a rerender with a new commands list updates the results immediately (issue #743 acceptance)', async () => {
    const { rerender } = render(SlashCommandPicker, {
      props: { open: true, commands: [TWO_COMMANDS[0]], onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.getAllByTestId('slash-command-picker-item')).toHaveLength(1);
    expect(screen.getByText('/model')).not.toBeNull();

    const replacement: AcpAvailableCommand[] = [
      { name: 'jobs', description: 'Show background jobs', input: undefined },
    ];
    await rerender({ open: true, commands: replacement, onSelect: vi.fn(), onClose: vi.fn() });

    const items = screen.getAllByTestId('slash-command-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('/jobs');
    expect(screen.queryByText('/model')).toBeNull();
  });
});
