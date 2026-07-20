import { describe, expect, it } from 'vitest';

import {
  PluginConfigError,
  parsePluginConfig,
  parsePluginConfigList,
  resolveEffectivePlugins,
} from './plugin-config';
import type { PluginConfig, PluginConfigRecord } from './plugin-config';
import { parseMcpServerConfigList, resolveEffectiveMcpServers } from './mcp-config';
import type { McpServerConfigRecord } from './mcp-config';

describe('parsePluginConfigList (issue #191)', () => {
  it('parses a valid plugin list into the right typed shape', () => {
    const raw = [
      { name: 'commit-lint', source: '@loombox-plugins/commit-lint' },
      { name: 'local-notes', source: 'file:///home/user/.loombox/plugins/local-notes' },
    ];

    expect(parsePluginConfigList(raw)).toEqual<PluginConfig[]>([
      { name: 'commit-lint', source: '@loombox-plugins/commit-lint' },
      { name: 'local-notes', source: 'file:///home/user/.loombox/plugins/local-notes' },
    ]);
  });

  it('rejects a non-array top level', () => {
    expect(() => parsePluginConfigList({ not: 'an array' })).toThrow(PluginConfigError);
  });

  it('rejects an entry missing "name"', () => {
    expect(() => parsePluginConfigList([{ source: 'x' }])).toThrow(PluginConfigError);
  });

  it('rejects an entry missing "source"', () => {
    expect(() => parsePluginConfigList([{ name: 'x' }])).toThrow(PluginConfigError);
  });

  it('rejects a duplicate plugin name within the list', () => {
    const raw = [
      { name: 'dup', source: 'a' },
      { name: 'dup', source: 'b' },
    ];
    expect(() => parsePluginConfigList(raw)).toThrow(PluginConfigError);
  });

  it('parsePluginConfig names the offending index and field for a malformed entry', () => {
    expect(() => parsePluginConfig({ name: '' }, 2)).toThrow(/\[2\]/);
  });
});

describe('resolveEffectivePlugins (issue #191)', () => {
  const global: PluginConfigRecord[] = [
    { config: { name: 'a', source: 'global-a' }, enabled: true },
    { config: { name: 'b', source: 'global-b' }, enabled: true },
  ];

  it('includes every enabled global plugin when the project adds nothing', () => {
    expect(resolveEffectivePlugins(global, [])).toEqual<PluginConfig[]>([
      { name: 'a', source: 'global-a' },
      { name: 'b', source: 'global-b' },
    ]);
  });

  it('a project record for the same name always overrides the global one', () => {
    const project: PluginConfigRecord[] = [
      { config: { name: 'a', source: 'project-a' }, enabled: true },
    ];
    const result = resolveEffectivePlugins(global, project);
    expect(result.find((p) => p.name === 'a')).toEqual({ name: 'a', source: 'project-a' });
  });

  it('a project record with enabled:false disables an inherited global plugin', () => {
    const project: PluginConfigRecord[] = [
      { config: { name: 'a', source: 'global-a' }, enabled: false },
    ];
    const result = resolveEffectivePlugins(global, project);
    expect(result.find((p) => p.name === 'a')).toBeUndefined();
    expect(result.find((p) => p.name === 'b')).toBeDefined();
  });

  it('a project can add its own plugin not present globally', () => {
    const project: PluginConfigRecord[] = [
      { config: { name: 'c', source: 'project-c' }, enabled: true },
    ];
    const result = resolveEffectivePlugins(global, project);
    expect(result.find((p) => p.name === 'c')).toEqual({ name: 'c', source: 'project-c' });
  });
});

describe('plugin config isolation from the MCP-server list (issue #191)', () => {
  it('a plugin and an MCP server sharing the same name resolve independently through their own stores', () => {
    const sharedName = 'shared-name';

    const mcpGlobal: McpServerConfigRecord[] = [
      {
        config: { name: sharedName, transport: 'stdio', command: 'mcp-cmd', args: [], env: [] },
        enabled: true,
      },
    ];
    const pluginGlobal: PluginConfigRecord[] = [
      { config: { name: sharedName, source: 'plugin-source' }, enabled: true },
    ];

    // Disabling the plugin at the project level must not touch the MCP
    // server of the same name, and vice versa — they're resolved through
    // two entirely separate functions/maps, never a shared registry keyed
    // only by name.
    const pluginProjectOverride: PluginConfigRecord[] = [
      { config: { name: sharedName, source: 'plugin-source' }, enabled: false },
    ];

    const effectiveMcp = resolveEffectiveMcpServers(mcpGlobal, []);
    const effectivePlugins = resolveEffectivePlugins(pluginGlobal, pluginProjectOverride);

    expect(effectiveMcp).toEqual(parseMcpServerConfigList([mcpGlobal[0]!.config]));
    expect(effectivePlugins).toEqual([]);
  });
});
