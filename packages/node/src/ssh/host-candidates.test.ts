import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { discoverSshTargets } from './host-candidates';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'ssh-config',
);

describe('discoverSshTargets', () => {
  it('lists ~/.ssh/config Host entries as candidates and reports the agent alongside them', async () => {
    const result = await discoverSshTargets({
      configPath: path.join(fixturesDir, 'multiple-hosts'),
      homeDir: '/home/tester',
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      listIdentities: async () => ({
        stdout: '256 SHA256:abc dev@devbox (ED25519)',
        exitCode: 0,
      }),
    });

    expect(result.candidates.map((candidate) => candidate.alias)).toEqual([
      'prodbox',
      'staging',
      'mac',
      'macbook',
    ]);
    expect(result.requiresManualEntry).toBe(false);
    expect(result.agent).toEqual({
      available: true,
      socketPath: '/tmp/ssh-agent.sock',
      identities: [
        { bits: 256, fingerprint: 'SHA256:abc', comment: 'dev@devbox', type: 'ED25519' },
      ],
    });
  });

  it('defaults a Host entry with no explicit HostName to its own alias, matching real ssh behavior', async () => {
    const result = await discoverSshTargets({
      configPath: path.join(fixturesDir, 'single-host'),
      homeDir: '/home/tester',
      env: {},
    });
    expect(result.candidates[0]).toMatchObject({ alias: 'devbox', hostName: '100.87.202.117' });
  });

  it('requiresManualEntry is true when there is no ~/.ssh/config at all — the "falls back to manual entry" case (issue #83)', async () => {
    const result = await discoverSshTargets({
      configPath: path.join(fixturesDir, 'does-not-exist'),
      homeDir: '/home/tester',
      env: {},
    });
    expect(result.candidates).toEqual([]);
    expect(result.requiresManualEntry).toBe(true);
    expect(result.agent).toEqual({ available: false, socketPath: undefined, identities: [] });
  });
});
