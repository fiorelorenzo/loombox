import { describe, expect, it } from 'vitest';

import { McpServerSecretMissingError } from './client';
import { parseMcpServerConfigList } from './mcp-config';
import { McpSecretGrantStore, resolveMcpServerConfigs } from './mcp-secret-grants';

const CONFIGS = parseMcpServerConfigList([
  {
    name: 'github',
    transport: 'stdio',
    command: '/usr/bin/mcp-github',
    args: [],
    env: [
      { name: 'GITHUB_TOKEN', secret: 'github-pat' },
      { name: 'GITHUB_ORG', value: 'loombox' },
    ],
  },
  {
    name: 'tracker',
    transport: 'http',
    url: 'https://tracker.example/mcp',
    headers: [{ name: 'Authorization', secret: 'tracker-bearer' }],
  },
]);

describe('McpSecretGrantStore (issue #189)', () => {
  it('grants no secret to any server by default', () => {
    const grants = new McpSecretGrantStore();
    expect(grants.isGranted('github', 'github-pat')).toBe(false);
  });

  it('grant() is a distinct explicit action per (server, secret)', () => {
    const grants = new McpSecretGrantStore();
    grants.grant('github', 'github-pat');
    expect(grants.isGranted('github', 'github-pat')).toBe(true);
    // Granting one server's secret never grants it to another server, nor
    // grants that server any other secret.
    expect(grants.isGranted('tracker', 'github-pat')).toBe(false);
    expect(grants.isGranted('github', 'tracker-bearer')).toBe(false);
  });

  it('revoke() removes only that (server, secret) grant, leaving others untouched', () => {
    const grants = new McpSecretGrantStore();
    grants.grant('github', 'github-pat');
    grants.grant('tracker', 'github-pat');
    grants.grant('github', 'tracker-bearer');

    grants.revoke('github', 'github-pat');

    expect(grants.isGranted('github', 'github-pat')).toBe(false);
    expect(grants.isGranted('tracker', 'github-pat')).toBe(true);
    expect(grants.isGranted('github', 'tracker-bearer')).toBe(true);
  });

  it('revoking a never-granted (server, secret) pair is a harmless no-op', () => {
    const grants = new McpSecretGrantStore();
    expect(() => grants.revoke('github', 'github-pat')).not.toThrow();
    expect(grants.isGranted('github', 'github-pat')).toBe(false);
  });
});

describe('resolveMcpServerConfigs (issue #189)', () => {
  it('resolves a granted secret and passes literal values through unchanged', () => {
    const grants = new McpSecretGrantStore();
    grants.grant('github', 'github-pat');
    grants.grant('tracker', 'tracker-bearer');

    const resolved = resolveMcpServerConfigs(CONFIGS, grants, {
      'github-pat': 'ghp_secret_value',
      'tracker-bearer': 'bearer_secret_value',
    });

    expect(resolved).toEqual([
      {
        name: 'github',
        command: '/usr/bin/mcp-github',
        args: [],
        env: [
          { name: 'GITHUB_TOKEN', value: 'ghp_secret_value' },
          { name: 'GITHUB_ORG', value: 'loombox' },
        ],
      },
      {
        type: 'http',
        name: 'tracker',
        url: 'https://tracker.example/mcp',
        headers: [{ name: 'Authorization', value: 'bearer_secret_value' }],
      },
    ]);
  });

  it('throws McpServerSecretMissingError naming server+variable when the secret is not granted', () => {
    const grants = new McpSecretGrantStore();
    // tracker granted, github not.
    grants.grant('tracker', 'tracker-bearer');

    expect(() =>
      resolveMcpServerConfigs(CONFIGS, grants, {
        'github-pat': 'ghp_secret_value',
        'tracker-bearer': 'bearer_secret_value',
      }),
    ).toThrow(McpServerSecretMissingError);
    expect(() =>
      resolveMcpServerConfigs(CONFIGS, grants, {
        'github-pat': 'ghp_secret_value',
        'tracker-bearer': 'bearer_secret_value',
      }),
    ).toThrow(/"github".*"GITHUB_TOKEN"/);
  });

  it('throws McpServerSecretMissingError when granted but the secret value map has nothing for it', () => {
    const grants = new McpSecretGrantStore();
    grants.grant('github', 'github-pat');
    grants.grant('tracker', 'tracker-bearer');

    expect(() =>
      resolveMcpServerConfigs(CONFIGS, grants, { 'tracker-bearer': 'bearer_secret_value' }),
    ).toThrow(McpServerSecretMissingError);
  });

  it('fails before producing any output: a later server in the list is never partially resolved', () => {
    const grants = new McpSecretGrantStore();
    grants.grant('github', 'github-pat');
    // tracker not granted -> whole call throws, no partial array returned.
    let threw = false;
    try {
      resolveMcpServerConfigs(CONFIGS, grants, { 'github-pat': 'ghp_secret_value' });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(McpServerSecretMissingError);
    }
    expect(threw).toBe(true);
  });

  it('never includes the secret value in the thrown error message', () => {
    const grants = new McpSecretGrantStore();
    try {
      resolveMcpServerConfigs(CONFIGS, grants, {
        'github-pat': 'super-secret-do-not-leak',
        'tracker-bearer': 'super-secret-do-not-leak',
      });
      throw new Error('expected resolveMcpServerConfigs to throw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('super-secret-do-not-leak');
    }
  });

  it('resolves an empty config list to an empty list with no grants needed', () => {
    const grants = new McpSecretGrantStore();
    expect(resolveMcpServerConfigs([], grants, {})).toEqual([]);
  });
});
