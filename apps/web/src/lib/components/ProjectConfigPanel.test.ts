// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from '@loombox/providers-core';
import { createInMemoryMcpServerConfigStorage } from '$lib/mcp-server-store';
import { createInMemoryPluginConfigStorage } from '$lib/plugin-store';
import ProjectConfigPanel from './ProjectConfigPanel.svelte';

afterEach(() => cleanup());

const preset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'filesystem')!;

describe('ProjectConfigPanel (issue #366)', () => {
  it('mounts both the MCP-server and plugin config panels for the given project', () => {
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage: createInMemoryMcpServerConfigStorage(),
        pluginStorage: createInMemoryPluginConfigStorage(),
      },
    });

    expect(screen.getByTestId('mcp-config-panel')).toBeTruthy();
    expect(screen.getByTestId('plugin-config-panel')).toBeTruthy();
  });

  it('quick-adding an MCP preset produces a server record in the panel and its own storage', async () => {
    const mcpStorage = createInMemoryMcpServerConfigStorage();
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage,
        pluginStorage: createInMemoryPluginConfigStorage(),
      },
    });

    await fireEvent.click(screen.getByTestId(`preset-add-${preset.config.name}`));

    expect(mcpStorage.get()).toEqual([{ config: instantiateMcpPreset(preset), enabled: true }]);
    expect(screen.getByTestId(`mcp-server-${preset.config.name}`)).toBeTruthy();
  });

  it('adding then removing a plugin round-trips through its own storage, independently of the MCP list', async () => {
    const mcpStorage = createInMemoryMcpServerConfigStorage();
    const pluginStorage = createInMemoryPluginConfigStorage();
    render(ProjectConfigPanel, {
      props: { projectPath: '/tmp/project', mcpStorage, pluginStorage },
    });

    await fireEvent.input(screen.getByTestId('plugin-add-name'), {
      target: { value: 'commit-lint' },
    });
    await fireEvent.input(screen.getByTestId('plugin-add-source'), {
      target: { value: '@loombox-plugins/commit-lint' },
    });
    await fireEvent.click(screen.getByTestId('plugin-add-submit'));

    expect(pluginStorage.get()).toEqual([
      { config: { name: 'commit-lint', source: '@loombox-plugins/commit-lint' }, enabled: true },
    ]);
    expect(screen.getByTestId('plugin-commit-lint')).toBeTruthy();
    expect(mcpStorage.get()).toEqual([]);

    await fireEvent.click(screen.getByTestId('plugin-remove-commit-lint'));

    expect(pluginStorage.get()).toEqual([]);
    expect(screen.queryByTestId('plugin-commit-lint')).toBeNull();
  });

  it('quick-adding a secret-requiring preset forwards onSecretRequired through to the MCP panel', async () => {
    const secretPreset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'github')!;
    const calls: Array<[string, string]> = [];
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage: createInMemoryMcpServerConfigStorage(),
        pluginStorage: createInMemoryPluginConfigStorage(),
        onSecretRequired: (serverName, secretName) => calls.push([serverName, secretName]),
      },
    });

    await fireEvent.click(screen.getByTestId(`preset-add-${secretPreset.config.name}`));

    expect(calls).toEqual([[secretPreset.config.name, 'github-personal-access-token']]);
  });
});
