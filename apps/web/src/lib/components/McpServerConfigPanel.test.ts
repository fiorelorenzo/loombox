// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from '@loombox/providers-core';
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

    expect(screen.getByTestId('mcp-config-error').textContent).toMatch(/duplicate/i);
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
});
