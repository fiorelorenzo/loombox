// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryMcpServerConfigStorage } from '$lib/mcp-server-store';
import { createInMemoryPluginConfigStorage } from '$lib/plugin-store';
import McpServerConfigPanel from './McpServerConfigPanel.svelte';
import PluginConfigPanel from './PluginConfigPanel.svelte';

afterEach(() => cleanup());

describe('PluginConfigPanel (issue #191)', () => {
  it('starts with an empty list', () => {
    render(PluginConfigPanel, {
      props: { projectPath: '/tmp/project', storage: createInMemoryPluginConfigStorage() },
    });
    expect(screen.getByText('No plugins configured yet.')).toBeTruthy();
  });

  it('adding a plugin round-trips into the visible list and storage', async () => {
    const storage = createInMemoryPluginConfigStorage();
    render(PluginConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.input(screen.getByTestId('plugin-add-name'), {
      target: { value: 'commit-lint' },
    });
    await fireEvent.input(screen.getByTestId('plugin-add-source'), {
      target: { value: '@loombox-plugins/commit-lint' },
    });
    await fireEvent.click(screen.getByTestId('plugin-add-submit'));

    expect(storage.get()).toEqual([
      { config: { name: 'commit-lint', source: '@loombox-plugins/commit-lint' }, enabled: true },
    ]);
    expect(screen.getByTestId('plugin-commit-lint')).toBeTruthy();
  });

  it('removing a plugin updates both the list and storage', async () => {
    const storage = createInMemoryPluginConfigStorage();
    render(PluginConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.input(screen.getByTestId('plugin-add-name'), { target: { value: 'p1' } });
    await fireEvent.input(screen.getByTestId('plugin-add-source'), { target: { value: 'src' } });
    await fireEvent.click(screen.getByTestId('plugin-add-submit'));

    await fireEvent.click(screen.getByTestId('plugin-remove-p1'));

    expect(storage.get()).toEqual([]);
    expect(screen.queryByTestId('plugin-p1')).toBeNull();
  });

  it('toggling enabled persists and calls onChange', async () => {
    const storage = createInMemoryPluginConfigStorage();
    const onChange = vi.fn();
    render(PluginConfigPanel, { props: { projectPath: '/tmp/project', storage, onChange } });

    await fireEvent.input(screen.getByTestId('plugin-add-name'), { target: { value: 'p1' } });
    await fireEvent.input(screen.getByTestId('plugin-add-source'), { target: { value: 'src' } });
    await fireEvent.click(screen.getByTestId('plugin-add-submit'));
    onChange.mockClear();

    await fireEvent.click(screen.getByTestId('plugin-enabled-p1'));
    expect(storage.get()[0]!.enabled).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('adding a plugin with a duplicate name shows a clear error', async () => {
    const storage = createInMemoryPluginConfigStorage();
    render(PluginConfigPanel, { props: { projectPath: '/tmp/project', storage } });

    for (let i = 0; i < 2; i++) {
      await fireEvent.input(screen.getByTestId('plugin-add-name'), { target: { value: 'p1' } });
      await fireEvent.input(screen.getByTestId('plugin-add-source'), { target: { value: 'src' } });
      await fireEvent.click(screen.getByTestId('plugin-add-submit'));
    }

    expect(screen.getByTestId('plugin-config-error').textContent).toMatch(/duplicate/i);
  });

  it('is isolated from the MCP-server config panel: adding an MCP server of the same name never appears in, or affects, the plugin list', async () => {
    const pluginStorage = createInMemoryPluginConfigStorage();
    const mcpStorage = createInMemoryMcpServerConfigStorage();

    render(PluginConfigPanel, { props: { projectPath: '/tmp/project', storage: pluginStorage } });
    await fireEvent.input(screen.getByTestId('plugin-add-name'), {
      target: { value: 'shared-name' },
    });
    await fireEvent.input(screen.getByTestId('plugin-add-source'), {
      target: { value: 'plugin-src' },
    });
    await fireEvent.click(screen.getByTestId('plugin-add-submit'));
    cleanup();

    render(McpServerConfigPanel, { props: { projectPath: '/tmp/project', storage: mcpStorage } });
    await fireEvent.input(screen.getByTestId('manual-add-name'), {
      target: { value: 'shared-name' },
    });
    await fireEvent.input(screen.getByTestId('manual-add-command'), {
      target: { value: '/bin/echo' },
    });
    await fireEvent.click(screen.getByTestId('manual-add-submit'));

    expect(pluginStorage.get()).toEqual([
      { config: { name: 'shared-name', source: 'plugin-src' }, enabled: true },
    ]);
    expect(mcpStorage.get()).toEqual([
      {
        config: {
          name: 'shared-name',
          transport: 'stdio',
          command: '/bin/echo',
          args: [],
          env: [],
        },
        enabled: true,
      },
    ]);
  });
});
