import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { generateAmk } from '@loombox/crypto';

import { createNode, type NodeDaemon } from '../node-daemon';
import { runLocalGuidedSetup } from './local-guided-setup';

const execFileAsync = promisify(execFile);

// Same hermetic fixture agent packages/node's own node-daemon.test.ts uses —
// no real `claude` binary, and no network beyond this test's in-process relay.
const ECHO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;

beforeEach(async () => {
  relay = await startRelay();

  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-guided-setup-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-guided-setup-state-test-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: projectPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
});

afterEach(async () => {
  node?.close();
  node = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

describe('runLocalGuidedSetup (issue #91)', () => {
  it('walks a fresh, unconfigured node through configure-relay -> register -> first local session', async () => {
    const accountId = 'acct-guided-setup';
    const result = await runLocalGuidedSetup({
      relayUrl: relay.url,
      nodeId: 'node-guided-1',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      projectPath,
      provider: 'test-echo',
      title: 'first session',
      nodeFactory: (options) =>
        createNode({
          ...options,
          supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
        }),
    });
    node = result.node;

    expect(result.steps.map((s) => s.step)).toEqual([
      'configure_relay',
      'register_node',
      'start_first_session',
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.node?.isConnected).toBe(true);
    expect(result.sessionId).toBeDefined();
  });

  it('reports a failed configure_relay step and stops there when no relay URL is given', async () => {
    const result = await runLocalGuidedSetup({
      relayUrl: '   ',
      nodeId: 'node-guided-2',
      authToken: 'acct-x',
      amk: generateAmk(),
      stateDir: nodeStateDir,
      projectPath,
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      {
        step: 'configure_relay',
        ok: false,
        message: expect.stringMatching(/relay/i),
      },
    ]);
    expect(result.node).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
  });

  it('reports a failed register_node step when the relay never accepts the handshake, and does not attempt a session', async () => {
    const result = await runLocalGuidedSetup({
      relayUrl: 'ws://127.0.0.1:1/ws', // nothing listens here; the socket never opens
      nodeId: 'node-guided-3',
      authToken: 'acct-y',
      amk: generateAmk(),
      stateDir: nodeStateDir,
      projectPath,
      connectTimeoutMs: 300,
    });
    node = result.node;

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.step)).toEqual(['configure_relay', 'register_node']);
    expect(result.steps[1]?.ok).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });

  it('reports a failed start_first_session step when the project path is not usable, after successfully registering', async () => {
    const accountId = 'acct-guided-4';
    const badProjectPath = path.join(projectPath, 'does-not-exist');
    const result = await runLocalGuidedSetup({
      relayUrl: relay.url,
      nodeId: 'node-guided-4',
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      stateDir: nodeStateDir,
      projectPath: badProjectPath,
      provider: 'test-echo',
    });
    node = result.node;

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.step)).toEqual([
      'configure_relay',
      'register_node',
      'start_first_session',
    ]);
    expect(result.steps[2]?.ok).toBe(false);
    expect(result.sessionId).toBeUndefined();
    // Registration itself must have succeeded before the session step ran.
    expect(result.node?.isConnected).toBe(true);
  });
});
