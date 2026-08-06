// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeymapV1 } from '@loombox/protocol';
import KeymapPanel, { type KeymapClient } from './KeymapPanel.svelte';

afterEach(() => cleanup());

function fakeClient(overrides: Partial<KeymapClient> = {}): KeymapClient {
  return {
    setKeymap: vi.fn(async (candidate: KeymapV1) => candidate),
    ...overrides,
  };
}

describe('KeymapPanel (Zed-parity F3-3, issue #760)', () => {
  it('renders every registered action, showing its default binding when nothing is remapped', () => {
    render(KeymapPanel, { props: { client: fakeClient(), keymap: {} } });
    expect(screen.getByTestId('keymap-row-stop-turn').textContent).toContain('Mod+.');
  });

  it('shows a remapped binding, not the built-in default (the palette reads the same registry, so it agrees)', () => {
    render(KeymapPanel, {
      props: { client: fakeClient(), keymap: { 'stop-turn': 'Mod+Shift+X' } },
    });
    expect(screen.getByTestId('keymap-row-stop-turn').textContent).toContain('Mod+Shift+X');
    expect(screen.getByTestId('keymap-row-stop-turn').textContent).not.toContain('Mod+.');
  });

  it('a remapped row offers Reset, an unremapped one does not', () => {
    render(KeymapPanel, {
      props: { client: fakeClient(), keymap: { 'stop-turn': 'Mod+Shift+X' } },
    });
    expect(screen.queryByTestId('keymap-row-reset-stop-turn')).toBeTruthy();
    expect(screen.queryByTestId('keymap-row-reset-toggle-sessions-sidebar')).toBeNull();
  });

  it('recording a valid, non-conflicting chord calls setKeymap with the full updated keymap', async () => {
    const client = fakeClient();
    render(KeymapPanel, { props: { client, keymap: {} } });

    await fireEvent.click(screen.getByTestId('keymap-row-change-stop-turn'));
    expect(screen.getByTestId('keymap-row-recording')).toBeTruthy();

    await fireEvent.keyDown(window, { key: 'x', metaKey: true, shiftKey: true });

    await waitFor(() =>
      expect(client.setKeymap).toHaveBeenCalledWith({ 'stop-turn': 'Mod+Shift+X' }),
    );
  });

  it('recording a chord that conflicts with another action is rejected by name, and setKeymap is never called', async () => {
    const client = fakeClient();
    // toggle-sessions-sidebar's built-in default is Mod+B (issue #758).
    render(KeymapPanel, { props: { client, keymap: {} } });

    await fireEvent.click(screen.getByTestId('keymap-row-change-stop-turn'));
    await fireEvent.keyDown(window, { key: 'b', metaKey: true });

    await waitFor(() => {
      const notice = screen.getByTestId('ui-error-notice');
      expect(notice.textContent).toContain('stop-turn');
      expect(notice.textContent).toContain('toggle-sessions-sidebar');
    });
    expect(client.setKeymap).not.toHaveBeenCalled();
  });

  it('Escape cancels recording without calling setKeymap', async () => {
    const client = fakeClient();
    render(KeymapPanel, { props: { client, keymap: {} } });

    await fireEvent.click(screen.getByTestId('keymap-row-change-stop-turn'));
    await fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('keymap-row-recording')).toBeNull();
    expect(client.setKeymap).not.toHaveBeenCalled();
  });

  it('Reset sends the keymap with that action\u2019s entry dropped', async () => {
    const client = fakeClient();
    render(KeymapPanel, {
      props: { client, keymap: { 'stop-turn': 'Mod+Shift+X', 'open-inbox': 'Mod+Shift+A' } },
    });

    await fireEvent.click(screen.getByTestId('keymap-row-reset-stop-turn'));

    await waitFor(() =>
      expect(client.setKeymap).toHaveBeenCalledWith({ 'open-inbox': 'Mod+Shift+A' }),
    );
  });
});
