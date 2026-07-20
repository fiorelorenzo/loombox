import { describe, expect, it } from 'vitest';

import { detectSshAgent } from './ssh-agent';

describe('detectSshAgent', () => {
  it('reports unavailable when $SSH_AUTH_SOCK is unset, without ever invoking ssh-add', async () => {
    let called = false;
    const result = await detectSshAgent({
      env: {},
      listIdentities: async () => {
        called = true;
        return { stdout: '', exitCode: 0 };
      },
    });
    expect(result).toEqual({ available: false, socketPath: undefined, identities: [] });
    expect(called).toBe(false);
  });

  it('parses ssh-add -l output into identities when the agent has some', async () => {
    const result = await detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      listIdentities: async () => ({
        stdout: [
          '256 SHA256:abcDEF123 dev@devbox (ED25519)',
          '3072 SHA256:xyz789 lorenzo@mac (RSA)',
          '',
        ].join('\n'),
        exitCode: 0,
      }),
    });
    expect(result.available).toBe(true);
    expect(result.socketPath).toBe('/tmp/ssh-agent.sock');
    expect(result.identities).toEqual([
      { bits: 256, fingerprint: 'SHA256:abcDEF123', comment: 'dev@devbox', type: 'ED25519' },
      { bits: 3072, fingerprint: 'SHA256:xyz789', comment: 'lorenzo@mac', type: 'RSA' },
    ]);
  });

  it('reports available with zero identities when the agent is running but empty (ssh-add -l exit 1, "no identities")', async () => {
    const result = await detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      listIdentities: async () => ({
        stdout: 'The agent has no identities.',
        exitCode: 1,
      }),
    });
    expect(result.available).toBe(true);
    expect(result.identities).toEqual([]);
  });

  it('reports available with zero identities (never throws) when ssh-add itself is missing or errors', async () => {
    const result = await detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      listIdentities: async () => {
        throw new Error('spawn ssh-add ENOENT');
      },
    });
    expect(result.available).toBe(true);
    expect(result.identities).toEqual([]);
  });

  it('skips a line it cannot parse rather than throwing', async () => {
    const result = await detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      listIdentities: async () => ({
        stdout: 'garbage line with no useful shape\n256 SHA256:abc dev@devbox (ED25519)',
        exitCode: 0,
      }),
    });
    expect(result.identities).toEqual([
      { bits: 256, fingerprint: 'SHA256:abc', comment: 'dev@devbox', type: 'ED25519' },
    ]);
  });
});
