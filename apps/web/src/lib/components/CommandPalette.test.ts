// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette.svelte';

afterEach(() => cleanup());

const sessions = [
  { id: 's1', title: 'loombox web polish', projectPath: '/proj/loombox' },
  { id: 's2', title: 'relay deploy fix', projectPath: '/proj/relay' },
];

describe('CommandPalette (#132)', () => {
  it('renders nothing when closed', () => {
    render(CommandPalette, {
      props: { open: false, sessions, onSelectSession: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('shows every session/action when the query is empty', () => {
    render(CommandPalette, {
      props: {
        open: true,
        sessions,
        actions: [{ id: 'stop', label: 'Stop current turn', run: vi.fn() }],
        onSelectSession: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.getAllByTestId('command-palette-item')).toHaveLength(3);
  });

  it('fuzzy-filters as the user types', async () => {
    render(CommandPalette, {
      props: { open: true, sessions, onSelectSession: vi.fn(), onClose: vi.fn() },
    });
    await fireEvent.input(screen.getByTestId('command-palette-input'), {
      target: { value: 'relay' },
    });
    const items = screen.getAllByTestId('command-palette-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('relay deploy fix');
  });

  it('Enter activates the active entry and fires onSelectSession then onClose', async () => {
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    render(CommandPalette, {
      props: { open: true, sessions, onSelectSession, onClose },
    });
    const input = screen.getByTestId('command-palette-input');
    await fireEvent.input(input, { target: { value: 'relay' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking an action entry runs the action and closes, without calling onSelectSession', async () => {
    const run = vi.fn();
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    render(CommandPalette, {
      props: {
        open: true,
        sessions: [],
        actions: [{ id: 'stop', label: 'Stop current turn', run }],
        onSelectSession,
        onClose,
      },
    });
    await fireEvent.click(screen.getByTestId('command-palette-item'));
    expect(run).toHaveBeenCalledOnce();
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ArrowDown/ArrowUp move the active row', async () => {
    render(CommandPalette, {
      props: { open: true, sessions, onSelectSession: vi.fn(), onClose: vi.fn() },
    });
    const input = screen.getByTestId('command-palette-input');
    const items = () => screen.getAllByTestId('command-palette-item');

    expect(items()[0].getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[1].getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(items()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('Esc closes without selecting or running anything', async () => {
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    render(CommandPalette, {
      props: { open: true, sessions, onSelectSession, onClose },
    });
    await fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('lists bound shortcuts in one discoverable place (the palette footer)', () => {
    render(CommandPalette, {
      props: {
        open: true,
        sessions: [],
        actions: [{ id: 'stop', label: 'Stop current turn', shortcut: 'Mod+.', run: vi.fn() }],
        onSelectSession: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const hint = screen.getByTestId('command-palette').querySelector('.palette-hints');
    expect(hint?.textContent).toContain('Mod+.');
    expect(screen.getByText('Esc close')).toBeTruthy();
  });
});
