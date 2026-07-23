import { describe, expect, it } from 'vitest';

import { LocalNodeProcessManager } from './process-manager';

/** Polls `check` until it returns true or `timeoutMs` elapses, then throws (mirrors `packages/supervisor/src/terminal-supervisor.test.ts`'s own helper — avoids a flat sleep for a real child process's async lifecycle events). */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error('waitFor: condition never became true within timeout');
}

describe('LocalNodeProcessManager (real child process)', () => {
  it('starts stopped and unspawned', () => {
    const manager = new LocalNodeProcessManager();
    expect(manager.status()).toBe('stopped');
    expect(manager.pid()).toBeUndefined();
  });

  it('spawns a real process, tracks its pid, and reaches running', async () => {
    const manager = new LocalNodeProcessManager();
    const status = manager.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    expect(status).toBe('starting');
    expect(manager.pid()).toBeGreaterThan(0);

    await waitFor(() => manager.status() === 'running');

    manager.stop();
    await waitFor(() => manager.status() === 'stopped');
    expect(manager.pid()).toBeUndefined();
  });

  it('is a no-op to spawn again while already running', async () => {
    const manager = new LocalNodeProcessManager();
    manager.spawn({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await waitFor(() => manager.status() === 'running');
    const firstPid = manager.pid();

    const second = manager.spawn({ command: process.execPath, args: ['-e', '1'] });
    expect(second).toBe('running');
    expect(manager.pid()).toBe(firstPid);

    manager.stop();
    await waitFor(() => manager.status() === 'stopped');
  });

  it('reaches error status when the command cannot be spawned at all', async () => {
    const manager = new LocalNodeProcessManager();
    manager.spawn({ command: '/no/such/loombox-node-binary' });
    await waitFor(() => manager.status() === 'error');
    expect(manager.pid()).toBeUndefined();
  });

  it('stop() is a no-op when nothing is running', () => {
    const manager = new LocalNodeProcessManager();
    expect(() => manager.stop()).not.toThrow();
    expect(manager.status()).toBe('stopped');
  });
});
