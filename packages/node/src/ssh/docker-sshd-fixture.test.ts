import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { wrapForLoginShell } from './login-shell';
import { Ssh2Transport } from './ssh2-transport';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';

// Issue #70: a real, throwaway Docker sshd the ssh2-transport machinery is
// exercised against, so the pooled/reconnecting transport and the
// non-interactive-shell PATH fix (#73) are proven against a real `sshd`, not
// only the fake/local-process stand-ins the rest of this directory's tests
// use. Gated on Docker actually being available (`docker info` reachable);
// skips cleanly, without hanging, when it isn't — see `isDockerAvailable`'s
// own doc comment.
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('Dockerized sshd fixture (issue #70)', () => {
  let fixture: DockerSshdFixture;

  beforeAll(async () => {
    fixture = await startDockerSshdFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.stop();
  }, 30_000);

  it('accepts a real SSH connection via ssh2, keyed by the fixture credentials', async () => {
    const transport = new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
      loginShell: false,
    });

    await transport.connect();
    try {
      const result = await transport.exec('echo hello-from-the-fixture');
      expect(result.stdout.trim()).toBe('hello-from-the-fixture');
      expect(result.exitCode).toBe(0);
    } finally {
      await transport.close();
    }
  });

  it('reproduces the non-interactive-shell PATH gap on purpose (SPEC §9)', async () => {
    const transport = new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
      loginShell: false,
    });

    await transport.connect();
    try {
      const bare = await transport.exec('node --version');
      expect(bare.exitCode).not.toBe(0);
      expect(bare.stderr + bare.stdout).toMatch(/not found/);
    } finally {
      await transport.close();
    }
  });

  it('wrapForLoginShell (issue #73) fixes the gap by sourcing the mise activation', async () => {
    const transport = new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
      loginShell: false,
    });

    await transport.connect();
    try {
      const wrapped = await transport.exec(wrapForLoginShell('node --version'));
      expect(wrapped.exitCode).toBe(0);
      expect(wrapped.stdout.trim()).toBe('v22.99.0-mise-fixture');
    } finally {
      await transport.close();
    }
  });

  it('Ssh2Transport wraps through the login shell by default, so the gap is fixed with no caller opt-in', async () => {
    const transport = new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
    });

    await transport.connect();
    try {
      const result = await transport.exec('node --version');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('v22.99.0-mise-fixture');
    } finally {
      await transport.close();
    }
  });
});

describe('isDockerAvailable', () => {
  it('resolves without throwing regardless of whether Docker is present', async () => {
    await expect(isDockerAvailable()).resolves.toEqual(expect.any(Boolean));
  });
});
