// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from '@loombox/providers-core/browser';
import { createInMemoryMcpServerConfigStorage } from '$lib/mcp-server-store';
import { createInMemoryPluginConfigStorage } from '$lib/plugin-store';
import { createInMemoryProjectEnvStorage } from '$lib/project-env-store';
import ProjectConfigPanel from './ProjectConfigPanel.svelte';

afterEach(() => cleanup());

const preset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'filesystem')!;

describe('ProjectConfigPanel (issue #366)', () => {
  it('mounts the MCP-server and plugin config panels for the given project', () => {
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage: createInMemoryMcpServerConfigStorage(),
        pluginStorage: createInMemoryPluginConfigStorage(),
      },
    });

    expect(screen.getByTestId('mcp-config-panel')).toBeTruthy();
    expect(screen.getByTestId('plugin-config-panel')).toBeTruthy();
    expect(screen.getByTestId('project-secrets-panel')).toBeTruthy();
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
        onSecretRequired: (serverName: string, secretName: string) =>
          calls.push([serverName, secretName]),
      },
    });

    await fireEvent.click(screen.getByTestId(`preset-add-${secretPreset.config.name}`));

    expect(calls).toEqual([[secretPreset.config.name, 'github-personal-access-token']]);
  });

  it('declaring a project env var round-trips through its own storage, independently of the MCP list', async () => {
    const mcpStorage = createInMemoryMcpServerConfigStorage();
    const projectEnvStorage = createInMemoryProjectEnvStorage();
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage,
        pluginStorage: createInMemoryPluginConfigStorage(),
        projectEnvStorage,
      },
    });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'DB_PASSWORD' },
    });
    await fireEvent.input(screen.getByTestId('env-add-secret'), {
      target: { value: 'db-password' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));

    expect(projectEnvStorage.get()).toEqual([{ name: 'DB_PASSWORD', secret: 'db-password' }]);
    expect(screen.getByTestId('project-secret-DB_PASSWORD')).toBeTruthy();
    expect(mcpStorage.get()).toEqual([]);
  });

  it('declaring a secret-requiring env var forwards onEnvSecretRequired, never onSecretRequired (the MCP-scoped one)', async () => {
    const mcpCalls: Array<[string, string]> = [];
    const envCalls: Array<[string, string]> = [];
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage: createInMemoryMcpServerConfigStorage(),
        pluginStorage: createInMemoryPluginConfigStorage(),
        projectEnvStorage: createInMemoryProjectEnvStorage(),
        onSecretRequired: (serverName: string, secretName: string) =>
          mcpCalls.push([serverName, secretName]),
        onEnvSecretRequired: (envVarName: string, secretName: string) =>
          envCalls.push([envVarName, secretName]),
      },
    });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'DB_PASSWORD' },
    });
    await fireEvent.input(screen.getByTestId('env-add-secret'), {
      target: { value: 'db-password' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));

    expect(envCalls).toEqual([['DB_PASSWORD', 'db-password']]);
    expect(mcpCalls).toEqual([]);
  });

  it("forwards mcpServerStatuses through to McpServerConfigPanel's own Server status section (issue #750, D2-2; #794)", () => {
    render(ProjectConfigPanel, {
      props: {
        projectPath: '/tmp/project',
        mcpStorage: createInMemoryMcpServerConfigStorage(),
        pluginStorage: createInMemoryPluginConfigStorage(),
        mcpServerStatuses: [
          { name: 'bad-binary', ok: false, category: 'missing_binary', reason: 'not found' },
        ],
      },
    });

    expect(screen.getByTestId('mcp-status-bad-binary')).toBeTruthy();
  });
});
