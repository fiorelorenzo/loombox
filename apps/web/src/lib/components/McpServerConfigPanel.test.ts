// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from '@loombox/providers-core/browser';
import { createInMemoryMcpServerConfigStorage } from '$lib/mcp-server-store';
import McpServerConfigPanel from './McpServerConfigPanel.svelte';

afterEach(() => cleanup());

const noSecretPreset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'filesystem')!;
const secretPreset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'github')!;

describe('McpServerConfigPanel (issue #188)', () => {
  it('renders a quick-add button per catalog preset', () => {
    render(McpServerConfigPanel, {
      props: { projectPath: '/tmp/project', storage: createInMemoryMcpServerConfigStorage() },
    });
    for (const preset of MCP_SERVER_PRESET_CATALOG) {
      expect(screen.getByTestId(`preset-add-${preset.config.name}`)).toBeTruthy();
    }
  });

  it('clicking a no-secret preset adds it to the storage with the exact instantiateMcpPreset shape, and to the visible list', async () => {
    const storage = createInMemoryMcpServerConfigStorage();
    render(McpServerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.click(screen.getByTestId(`preset-add-${noSecretPreset.config.name}`));

    expect(storage.get()).toEqual([
      { config: instantiateMcpPreset(noSecretPreset), enabled: true },
    ]);
    expect(screen.getByTestId(`mcp-server-${noSecretPreset.config.name}`)).toBeTruthy();
  });

  it('clicking a secret-requiring preset adds it and surfaces a "needs secret" badge, and calls onSecretRequired', async () => {
    const storage = createInMemoryMcpServerConfigStorage();
    const onSecretRequired = vi.fn();
    render(McpServerConfigPanel, {
      props: { projectPath: '/tmp/project', storage, onSecretRequired },
    });

    await fireEvent.click(screen.getByTestId(`preset-add-${secretPreset.config.name}`));

    expect(
      screen.getByTestId(
        `server-secret-badge-${secretPreset.config.name}-github-personal-access-token`,
      ),
    ).toBeTruthy();
    expect(onSecretRequired).toHaveBeenCalledWith(
      secretPreset.config.name,
      'github-personal-access-token',
    );
  });

  it('adding twice via quick-add shows a clear duplicate error rather than silently no-oping', async () => {
    const storage = createInMemoryMcpServerConfigStorage();
    render(McpServerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.click(screen.getByTestId(`preset-add-${noSecretPreset.config.name}`));
    await fireEvent.click(screen.getByTestId(`preset-add-${noSecretPreset.config.name}`));

    expect(screen.getByRole('alert').textContent).toMatch(/duplicate/i);
  });

  it('a manual add produces the same stored record shape (config + enabled) as a preset add', async () => {
    const storage = createInMemoryMcpServerConfigStorage();
    render(McpServerConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.input(screen.getByTestId('manual-add-name'), { target: { value: 'my-tool' } });
    await fireEvent.input(screen.getByTestId('manual-add-command'), {
      target: { value: '/usr/local/bin/my-tool' },
    });
    await fireEvent.input(screen.getByTestId('manual-add-args'), {
      target: { value: '--foo, --bar' },
    });
    await fireEvent.click(screen.getByTestId('manual-add-submit'));

    expect(storage.get()).toEqual([
      {
        config: {
          name: 'my-tool',
          transport: 'stdio',
          command: '/usr/local/bin/my-tool',
          args: ['--foo', '--bar'],
          env: [],
        },
        enabled: true,
      },
    ]);
    // Same wrapper shape (`{ config, enabled }`) as a preset-added record.
    expect(Object.keys(storage.get()[0]!).sort()).toEqual(['config', 'enabled'].sort());
  });

  it('toggling enabled and removing a server updates the list and calls onChange', async () => {
    const storage = createInMemoryMcpServerConfigStorage();
    const onChange = vi.fn();
    render(McpServerConfigPanel, { props: { projectPath: '/tmp/project', storage, onChange } });

    await fireEvent.click(screen.getByTestId(`preset-add-${noSecretPreset.config.name}`));
    onChange.mockClear();

    await fireEvent.click(screen.getByTestId(`server-enabled-${noSecretPreset.config.name}`));
    expect(storage.get()[0]!.enabled).toBe(false);
    expect(onChange).toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId(`server-remove-${noSecretPreset.config.name}`));
    expect(storage.get()).toEqual([]);
    expect(screen.queryByTestId(`mcp-server-${noSecretPreset.config.name}`)).toBeNull();
  });

  it('no Field in this panel renders prose as its control (design spec §0.7, applied repo-wide)', () => {
    render(McpServerConfigPanel, {
      props: { projectPath: '/tmp/project', storage: createInMemoryMcpServerConfigStorage() },
    });
    const fields = screen.getAllByTestId('ui-field');
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const control = field.querySelector('.ui-field-control');
      expect(control?.querySelector('input, button, textarea, select, [role]')).not.toBeNull();
    }
  });

  describe('mcp_server_status rendering (issue #750, D2-2; #794)', () => {
    it('renders no "Server status" section at all when nothing has failed', () => {
      render(McpServerConfigPanel, {
        props: { projectPath: '/tmp/project', storage: createInMemoryMcpServerConfigStorage() },
      });
      expect(screen.queryByTestId('mcp-status-list')).toBeNull();
    });

    it('renders a failing server by name, category, and reason', () => {
      render(McpServerConfigPanel, {
        props: {
          projectPath: '/tmp/project',
          storage: createInMemoryMcpServerConfigStorage(),
          mcpServerStatuses: [
            {
              name: 'bad-binary',
              ok: false,
              category: 'missing_binary',
              reason: 'Executable not found: this-binary-does-not-exist',
            },
          ],
        },
      });

      const row = screen.getByTestId('mcp-status-bad-binary');
      expect(row.textContent).toContain('bad-binary');
      expect(row.textContent).toContain('Executable not found: this-binary-does-not-exist');
      expect(screen.getByTestId('mcp-status-badge-bad-binary').textContent?.trim()).toBe(
        'Missing binary',
      );
    });

    it('renders an auto-disabled server distinctly from a plain failure', () => {
      render(McpServerConfigPanel, {
        props: {
          projectPath: '/tmp/project',
          storage: createInMemoryMcpServerConfigStorage(),
          mcpServerStatuses: [
            { name: 'retrying', ok: false, category: 'handshake_failed', reason: 'bad handshake' },
            {
              name: 'given-up',
              ok: false,
              category: 'handshake_failed',
              reason: 'bad handshake',
              disabled: true,
            },
          ],
        },
      });

      expect(screen.getByTestId('mcp-status-badge-retrying').textContent?.trim()).toBe(
        'Handshake failed',
      );
      expect(screen.getByTestId('mcp-status-badge-given-up').textContent?.trim()).toBe(
        'Auto-disabled',
      );
    });

    it('never renders a status row for a server this device never declared as an entry in "Configured servers" itself — status is its own independent section', () => {
      render(McpServerConfigPanel, {
        props: {
          projectPath: '/tmp/project',
          storage: createInMemoryMcpServerConfigStorage(),
          mcpServerStatuses: [
            { name: 'node-only-server', ok: false, category: 'secret_missing', reason: 'no grant' },
          ],
        },
      });

      expect(screen.getByTestId('mcp-status-node-only-server')).toBeTruthy();
      expect(screen.queryByTestId('mcp-server-node-only-server')).toBeNull();
    });
  });
});
