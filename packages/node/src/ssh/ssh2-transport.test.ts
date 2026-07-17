import { describe, expect, it } from 'vitest';

import { Ssh2Transport } from './ssh2-transport';

describe('Ssh2Transport', () => {
  it('refuses exec() before connect() rather than hanging or crashing on a null client', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.exec('true')).rejects.toThrow(/not connected/);
  });

  it('close() before connect() is a harmless no-op', async () => {
    const transport = new Ssh2Transport({ host: 'example.invalid', username: 'nobody' });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

// Real-network smoke test, skipped by default (no live SSH host in this
// hermetic test environment). Set LOOMBOX_TEST_SSH_HOST (+ optionally
// LOOMBOX_TEST_SSH_PORT/_USER/_KEY_PATH) to run it against a real sshd, e.g.
// the Dockerized SSH fixture issues #80/#84 call for in a CI environment
// that has Docker available.
const sshHost = process.env.LOOMBOX_TEST_SSH_HOST;
describe.skipIf(!sshHost)('Ssh2Transport (real SSH — LOOMBOX_TEST_SSH_HOST)', () => {
  it('connects, execs a command, and closes cleanly against a real sshd', async () => {
    const transport = new Ssh2Transport({
      host: sshHost!,
      port: process.env.LOOMBOX_TEST_SSH_PORT ? Number(process.env.LOOMBOX_TEST_SSH_PORT) : 22,
      username: process.env.LOOMBOX_TEST_SSH_USER ?? 'root',
      privateKeyPath: process.env.LOOMBOX_TEST_SSH_KEY_PATH,
    });

    await transport.connect();
    const result = await transport.exec('echo hello-from-remote');
    expect(result.stdout.trim()).toBe('hello-from-remote');
    expect(result.exitCode).toBe(0);
    await transport.close();
  });
});
