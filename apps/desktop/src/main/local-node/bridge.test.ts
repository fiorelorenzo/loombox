import { describe, expect, it } from 'vitest';

import { LocalNodeBridge, resolveLocalNodeLaunchCommand } from './bridge';

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error('waitFor: condition never became true within timeout');
}

describe('resolveLocalNodeLaunchCommand', () => {
  it('returns undefined when no override is configured (the default, honest scaffold state)', () => {
    expect(resolveLocalNodeLaunchCommand({}, undefined)).toBeUndefined();
  });

  it('parses LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND into a command + args', () => {
    const launch = resolveLocalNodeLaunchCommand(
      { LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND: 'node -e 1' },
      { FOO: 'bar' },
    );
    expect(launch).toEqual({ command: 'node', args: ['-e', '1'], env: { FOO: 'bar' } });
  });
});

describe('LocalNodeBridge', () => {
  it('spawnLocalNode reports notConfigured when no launch command is resolved', () => {
    const bridge = new LocalNodeBridge(undefined, {});
    const result = bridge.spawnLocalNode();
    expect(result.notConfigured).toBe(true);
    expect(result.status).toBe('stopped');
  });

  it('spawnLocalNode spawns a real process when LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND is set', async () => {
    const bridge = new LocalNodeBridge(undefined, {
      LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND: `${process.execPath} -e setInterval(()=>{},1000)`,
    });
    const result = bridge.spawnLocalNode();
    expect(result.notConfigured).toBeUndefined();
    expect(result.status).toBe('starting');
    expect(result.pid).toBeGreaterThan(0);

    await waitFor(() => bridge.status().status === 'running');

    const stopped = bridge.stopLocalNode();
    expect(['running', 'stopped']).toContain(stopped.status);
    await waitFor(() => bridge.status().status === 'stopped');
  });
});
