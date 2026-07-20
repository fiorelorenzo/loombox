import { describe, expect, it } from 'vitest';

import {
  McpServerConfigError,
  parseMcpServerConfig,
  parseMcpServerConfigList,
  requiredSecrets,
  requiredSecretsForList,
  resolveEffectiveMcpServers,
} from './mcp-config';
import type { McpServerConfig, McpServerConfigRecord } from './mcp-config';

describe('parseMcpServerConfigList (issue #187)', () => {
  it('parses a valid multi-server config (stdio + http) into the right typed shape', () => {
    const raw = [
      {
        name: 'filesystem',
        transport: 'stdio',
        command: '/usr/bin/mcp-filesystem',
        args: ['--root', '/tmp'],
        env: [
          { name: 'MCP_LOG_LEVEL', value: 'info' },
          { name: 'GITHUB_TOKEN', secret: 'github-pat' },
        ],
      },
      {
        name: 'tracker',
        transport: 'http',
        url: 'https://tracker.example/mcp',
        headers: [{ name: 'Authorization', secret: 'tracker-bearer' }],
      },
    ];

    const parsed = parseMcpServerConfigList(raw);

    expect(parsed).toEqual<McpServerConfig[]>([
      {
        name: 'filesystem',
        transport: 'stdio',
        command: '/usr/bin/mcp-filesystem',
        args: ['--root', '/tmp'],
        env: [
          { name: 'MCP_LOG_LEVEL', value: 'info' },
          { name: 'GITHUB_TOKEN', secret: 'github-pat' },
        ],
      },
      {
        name: 'tracker',
        transport: 'http',
        url: 'https://tracker.example/mcp',
        headers: [{ name: 'Authorization', secret: 'tracker-bearer' }],
      },
    ]);
  });

  it('parses an sse server and defaults args/env/headers to empty arrays', () => {
    const parsed = parseMcpServerConfig({
      name: 'events',
      transport: 'sse',
      url: 'https://events.example/mcp',
    });
    expect(parsed).toEqual({
      name: 'events',
      transport: 'sse',
      url: 'https://events.example/mcp',
      headers: [],
    });

    const stdio = parseMcpServerConfig({
      name: 'plain',
      transport: 'stdio',
      command: '/bin/plain',
    });
    expect(stdio).toEqual({
      name: 'plain',
      transport: 'stdio',
      command: '/bin/plain',
      args: [],
      env: [],
    });
  });

  it.each([
    [{ transport: 'stdio', command: '/bin/x' }, 'missing required field "name"'],
    [{ name: 'x', command: '/bin/x' }, '"transport"'],
    [{ name: 'x', transport: 'bogus', command: '/bin/x' }, '"transport"'],
    [{ name: 'x', transport: 'stdio' }, 'missing required field "command"'],
    [{ name: 'x', transport: 'http' }, 'missing required field "url"'],
    [{ name: 'x', transport: 'http', url: 'not-a-url' }, 'not a valid URL'],
    [
      { name: 'x', transport: 'stdio', command: '/bin/x', env: [{ name: 'A' }] },
      'exactly one of "value" or "secret"',
    ],
    [
      {
        name: 'x',
        transport: 'stdio',
        command: '/bin/x',
        env: [{ name: 'A', value: 'v', secret: 's' }],
      },
      'exactly one of "value" or "secret"',
    ],
    [
      { name: 'x', transport: 'stdio', command: '/bin/x', env: [{ value: 'v' }] },
      'missing required field "name"',
    ],
  ] as const)('rejects a malformed entry: %j', (raw, expectedMessage) => {
    expect(() => parseMcpServerConfig(raw)).toThrow(McpServerConfigError);
    expect(() => parseMcpServerConfig(raw)).toThrow(expectedMessage);
  });

  it('rejects a non-array top-level config and a non-object entry', () => {
    expect(() => parseMcpServerConfigList({ not: 'an array' })).toThrow(McpServerConfigError);
    expect(() => parseMcpServerConfigList(['nope'])).toThrow(McpServerConfigError);
  });

  it('rejects a list with a duplicate server name, naming the offending server', () => {
    const raw = [
      { name: 'dup', transport: 'stdio', command: '/bin/a' },
      { name: 'dup', transport: 'stdio', command: '/bin/b' },
    ];
    expect(() => parseMcpServerConfigList(raw)).toThrow(/duplicate.*"dup"/);
  });

  it('includes the entry index and server name in a malformed-entry error message', () => {
    const raw = [
      { name: 'good', transport: 'stdio', command: '/bin/a' },
      { name: 'bad', transport: 'stdio' },
    ];
    expect(() => parseMcpServerConfigList(raw)).toThrow(/\[1\].*"bad"/);
  });
});

describe('requiredSecrets / requiredSecretsForList (issue #187)', () => {
  it('collects the distinct named secrets a server declares it needs', () => {
    const config = parseMcpServerConfig({
      name: 'github',
      transport: 'stdio',
      command: '/bin/mcp-github',
      env: [
        { name: 'GITHUB_TOKEN', secret: 'github-pat' },
        { name: 'GITHUB_ORG', value: 'loombox' },
        { name: 'GITHUB_TOKEN_2', secret: 'github-pat' },
      ],
    });
    expect(requiredSecrets(config)).toEqual(['github-pat']);
  });

  it('returns an empty list for a server with no secret references', () => {
    const config = parseMcpServerConfig({
      name: 'plain',
      transport: 'stdio',
      command: '/bin/plain',
    });
    expect(requiredSecrets(config)).toEqual([]);
  });

  it('unions required secrets across a whole config list', () => {
    const configs = parseMcpServerConfigList([
      { name: 'a', transport: 'stdio', command: '/bin/a', env: [{ name: 'X', secret: 's1' }] },
      {
        name: 'b',
        transport: 'http',
        url: 'https://b.example',
        headers: [
          { name: 'Authorization', secret: 's2' },
          { name: 'X-Other', secret: 's1' },
        ],
      },
    ]);
    expect(requiredSecretsForList(configs).sort()).toEqual(['s1', 's2']);
  });
});

describe('resolveEffectiveMcpServers: global + project override (issue #187)', () => {
  function record(name: string, enabled: boolean): McpServerConfigRecord {
    return {
      config: { name, transport: 'stdio', command: `/bin/${name}`, args: [], env: [] },
      enabled,
    };
  }

  it('includes every enabled global server when a project adds no overrides', () => {
    const effective = resolveEffectiveMcpServers([record('g1', true), record('g2', true)], []);
    expect(effective.map((c) => c.name).sort()).toEqual(['g1', 'g2']);
  });

  it('lets a project add its own server alongside inherited globals', () => {
    const effective = resolveEffectiveMcpServers([record('g1', true)], [record('p1', true)]);
    expect(effective.map((c) => c.name).sort()).toEqual(['g1', 'p1']);
  });

  it('lets a project disable an inherited global server by name', () => {
    const effective = resolveEffectiveMcpServers([record('g1', true)], [record('g1', false)]);
    expect(effective).toEqual([]);
  });

  it('lets a project override a global server of the same name entirely', () => {
    const globalG1 = record('g1', true);
    const projectG1: McpServerConfigRecord = {
      config: { name: 'g1', transport: 'stdio', command: '/opt/custom/g1', args: [], env: [] },
      enabled: true,
    };
    const effective = resolveEffectiveMcpServers([globalG1], [projectG1]);
    expect(effective).toEqual([projectG1.config]);
  });
});
