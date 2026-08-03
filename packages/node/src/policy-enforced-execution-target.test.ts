import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_PERMISSION_POLICY,
  PolicyViolationError,
  type PermissionPolicy,
} from './permission-policy';
import { PolicyEnforcedExecutionTarget } from './policy-enforced-execution-target';
import { LocalExecutionTarget } from './local-execution-target';
import { SshExecutionTarget } from './ssh-execution-target';
import { LocalProcessTransport } from './ssh/local-process-transport';

/**
 * Real spawn paths only, per SPEC §7.17's own bar: `LocalExecutionTarget`
 * runs real `child_process.spawn`, and `SshExecutionTarget` here is backed
 * by `LocalProcessTransport` — a real child process standing in for "the
 * remote host" (this package's own established hermetic-but-real testing
 * convention, see that class's doc comment), not a scripted fake of this
 * decorator's own matcher.
 */

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'loombox-policy-exec-target-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function policy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    command: { allow: [], deny: [], ...overrides.command },
    network: { allow: [], deny: [], ...overrides.network },
  };
}

describe('PolicyEnforcedExecutionTarget — local target, real child_process.spawn', () => {
  it('a deny match throws before the real process ever runs — the marker file is never created', async () => {
    const marker = path.join(workDir, 'marker');
    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: [], deny: ['touch *'] } }),
    });

    await expect(target.exec('touch', [marker])).rejects.toBeInstanceOf(PolicyViolationError);
    expect(existsSync(marker)).toBe(false);
  });

  it('a command with no matching deny rule actually runs', async () => {
    const marker = path.join(workDir, 'marker');
    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: [], deny: ['rm *'] } }),
    });

    const result = await target.exec('touch', [marker]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('EMPTY_PERMISSION_POLICY (absent policy) allows a real command to run', async () => {
    const marker = path.join(workDir, 'marker');
    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: EMPTY_PERMISSION_POLICY,
    });

    await target.exec('touch', [marker]);
    expect(existsSync(marker)).toBe(true);
  });

  it('deny wins over an overlapping allow rule, at the real spawn path', async () => {
    const marker = path.join(workDir, 'marker');
    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: ['touch *'], deny: ['touch *'] } }),
    });

    await expect(target.exec('touch', [marker])).rejects.toBeInstanceOf(PolicyViolationError);
    expect(existsSync(marker)).toBe(false);
  });

  it('closes the local symlink-defeat bypass: a symlink to a denied binary is still blocked', async () => {
    const realTouch = '/usr/bin/touch';
    if (!existsSync(realTouch)) return; // environment without /usr/bin/touch: skip rather than false-fail
    const alias = path.join(workDir, 'totally-harmless-name');
    symlinkSync(realTouch, alias);
    const marker = path.join(workDir, 'marker');

    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: [], deny: ['touch *'] } }),
    });

    await expect(target.exec(alias, [marker])).rejects.toBeInstanceOf(PolicyViolationError);
    expect(existsSync(marker)).toBe(false);
  });

  it('logs the violation and invokes onViolation, naming the project/rule/matched command', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onViolation = vi.fn();
    const target = new PolicyEnforcedExecutionTarget({
      inner: new LocalExecutionTarget(),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: [], deny: ['touch *'] } }),
      onViolation,
    });

    await expect(target.exec('touch', [path.join(workDir, 'marker')])).rejects.toThrow();

    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(onViolation.mock.calls[0]![0]).toMatchObject({
      projectPath: '/proj-a',
      surface: 'exec',
      dimension: 'command',
      rule: 'touch *',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('PermissionPolicy:');
    expect(warn.mock.calls[0]![0]).toContain('/proj-a');
    warn.mockRestore();
  });

  describe('network dimension — a real local TCP listener', () => {
    let server: Server;
    let port: number;
    let connections: number;

    beforeEach(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections += 1;
        socket.end();
      });
      const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
      server.listen(0, '127.0.0.1', onListening);
      await listening;
      const address = server.address();
      // `listen(0, '127.0.0.1', ...)` always yields an AddressInfo (a string is only ever reported for a unix-socket path).
      if (address === null || typeof address === 'string') {
        throw new Error('expected server.address() to be an AddressInfo');
      }
      port = address.port;
    });

    afterEach(async () => {
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
      server.close(() => onClosed());
      await closed;
    });

    /**
     * A tiny fixture script whose argv literally carries `host:port` as one
     * token, so this test proves a real network attempt is prevented, not
     * just that the matcher's regex would theoretically catch it. Waits for
     * `close` (not `connect`): the test server's connection handler
     * increments its counter and then immediately calls `socket.end()`, so
     * waiting for the client's own `close` guarantees that handler already
     * ran, with no race between "client thinks it's connected" and "server
     * has recorded the connection". Deterministic either way — no
     * wall-clock wait: `target.exec()` (which resolves only once this
     * child process exits) is itself the completion signal.
     */
    function connectFixtureArgs(): string[] {
      return [
        '-e',
        "const [dest] = process.argv.slice(1); const [host, port] = dest.split(':'); " +
          "const socket = require('net').createConnection(Number(port), host); " +
          "socket.on('close', () => process.exit(0)); " +
          "socket.on('error', () => process.exit(1));",
      ];
    }

    it('a network deny match blocks the connection before the real process ever dials out', async () => {
      const dest = `127.0.0.1:${port}`;
      const target = new PolicyEnforcedExecutionTarget({
        inner: new LocalExecutionTarget(),
        projectPath: '/proj-a',
        policy: policy({ network: { allow: [], deny: [dest] } }),
      });

      // The decorator throws before `LocalExecutionTarget.exec` (and so
      // `child_process.spawn`) is ever called — nothing async is in
      // flight afterward, so no wait is needed to know the connection
      // never happened.
      await expect(
        target.exec(process.execPath, [...connectFixtureArgs(), dest]),
      ).rejects.toBeInstanceOf(PolicyViolationError);
      expect(connections).toBe(0);
    });

    it('a destination not matching any network deny rule actually connects', async () => {
      const dest = `127.0.0.1:${port}`;
      const target = new PolicyEnforcedExecutionTarget({
        inner: new LocalExecutionTarget(),
        projectPath: '/proj-a',
        policy: policy({ network: { allow: [], deny: ['some-other-host:9999'] } }),
      });

      // Awaiting exec() itself is the deterministic signal: the fixture
      // process only closes once its connection attempt has settled.
      await target.exec(process.execPath, [...connectFixtureArgs(), dest]);
      expect(connections).toBe(1);
    });
  });
});

describe('PolicyEnforcedExecutionTarget — ssh: target, real child process via LocalProcessTransport', () => {
  it('a deny match blocks the ssh: exec path too, before the underlying transport ever runs the command', async () => {
    const marker = path.join(workDir, 'marker');
    const transport = new LocalProcessTransport();
    await transport.connect();
    const target = new PolicyEnforcedExecutionTarget({
      inner: new SshExecutionTarget(transport),
      projectPath: '/proj-a',
      policy: policy({ command: { allow: [], deny: ['touch *'] } }),
    });

    await expect(target.exec('touch', [marker])).rejects.toBeInstanceOf(PolicyViolationError);
    expect(existsSync(marker)).toBe(false);
    await transport.close();
  });

  it('an allowed command still runs over the ssh: path', async () => {
    const marker = path.join(workDir, 'marker');
    const transport = new LocalProcessTransport();
    await transport.connect();
    const target = new PolicyEnforcedExecutionTarget({
      inner: new SshExecutionTarget(transport),
      projectPath: '/proj-a',
      policy: EMPTY_PERMISSION_POLICY,
    });

    const result = await target.exec('touch', [marker]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    await transport.close();
  });
});
