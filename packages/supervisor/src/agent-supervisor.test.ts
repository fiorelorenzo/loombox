import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpChildProcess, AcpProvider, AcpUpdate } from '@loombox/providers-core';

import { AgentSupervisor } from './agent-supervisor';
import type { AgentSession } from './agent-session';

// Reuses the same hermetic fixture agent packages/providers/core and
// packages/providers/claude already exercise their tests against (not a real
// `claude` binary), the same way packages/providers/claude's own test does:
// by relative path into the sibling package's test/fixtures, since it is
// deliberately not published via that package's `exports`.
const ECHO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

const CRASH_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'crashing-acp-agent.mjs',
);

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function crashProvider(): AcpProvider {
  return {
    id: 'test-crash',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [CRASH_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

let workspacePath: string;
let stateDir: string;
let activeSessions: AgentSession[];

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), 'loombox-supervisor-test-'));
  // Every AgentSupervisor test below persists to disk the moment start() is
  // called (issue #77); always inject an os.mkdtemp() state dir here so
  // these tests never touch the real ~/.loombox/supervisor.
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-supervisor-state-test-'));
  activeSessions = [];
});

afterEach(async () => {
  for (const session of activeSessions) session.close();
  // maxRetries covers the rare ENOTEMPTY if a child's late 'exit' write races
  // the cleanup (close() already guards persistence, this is belt-and-suspenders).
  await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('AgentSupervisor', () => {
  it('spawns an agent, completes the ACP handshake, and opens a session', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });

    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    expect(session.id).toMatch(/^sess_test_/);
    expect(session.providerId).toBe('test-echo');
    expect(supervisor.get(session.id)).toBe(session);
  });

  it('rejects starting with an unregistered provider id', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });

    await expect(supervisor.start({ workspacePath, providerId: 'nope' })).rejects.toThrow(/nope/);
  });

  it('streams agent_message_chunk updates on prompt and buffers them in the transcript', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    const seen: AcpUpdate[] = [];
    const turnEnds: unknown[] = [];
    session.on('update', (update: AcpUpdate) => seen.push(update));
    session.on('turn_end', (turnEnd: unknown) => turnEnds.push(turnEnd));

    await session.prompt('hi there');

    expect(seen).toEqual([
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello' },
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello world' },
    ]);
    expect(turnEnds).toEqual([{ messageId: 'msg_agent_1', stopReason: 'end_turn' }]);
    expect(session.getTranscript()).toEqual(seen);
  });

  it('keeps the agent alive across a caller detach + re-attach, with the buffered transcript letting the new caller catch up', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    const firstCallerUpdates: AcpUpdate[] = [];
    const firstListener = (update: AcpUpdate): number => firstCallerUpdates.push(update);
    session.on('update', firstListener);

    await session.prompt('first turn');
    expect(firstCallerUpdates).toHaveLength(2);

    // "Detach": the caller stops listening (e.g. a node's WS client
    // disconnects). This must not touch the running child or its session.
    session.off('update', firstListener);

    // Re-attach: look the session back up by id. The supervisor never calls
    // start() again, so the child is not respawned, and the new caller can
    // catch up on everything it missed via the buffered transcript.
    const reattached = supervisor.get(session.id);
    expect(reattached).toBe(session);
    expect(reattached?.getTranscript()).toEqual(firstCallerUpdates);

    const secondCallerUpdates: AcpUpdate[] = [];
    reattached?.on('update', (update: AcpUpdate) => secondCallerUpdates.push(update));

    await session.prompt('second turn');

    expect(secondCallerUpdates).toHaveLength(2);
    // The first caller's listener was removed, so it must not have grown.
    expect(firstCallerUpdates).toHaveLength(2);
    // The transcript keeps accumulating across the whole session lifetime.
    expect(session.getTranscript()).toHaveLength(4);
  });

  it('startWithChild() gives an already-constructed AcpChildProcess (the ssh: target shape, issue #80) the exact same handshake/persistence/attention guarantees as start()', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });

    // Stands in for `@loombox/node`'s `RemoteAgentChildProcess`: any object
    // satisfying `AcpChildProcess` works, proving `startWithChild()` doesn't
    // care how the child's stdio is actually backed. A plain local spawn is
    // the simplest such stand-in that doesn't require this package to depend
    // on @loombox/node's ssh machinery just to test this seam.
    const child = spawn(process.execPath, [ECHO_FIXTURE], {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as AcpChildProcess;

    const session = await supervisor.startWithChild({
      workspacePath,
      providerId: 'test-echo',
      child,
    });
    activeSessions.push(session);

    expect(session.id).toMatch(/^sess_test_/);
    expect(session.isLive).toBe(true);
    expect(supervisor.get(session.id)).toBe(session);

    await session.prompt('hi there');
    expect(session.getTranscript()).toEqual([
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello' },
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello world' },
    ]);
  });

  it('emits a single terminal exit event, not a hang, when the child crashes unexpectedly', async () => {
    const supervisor = new AgentSupervisor({ providers: [crashProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-crash' });
    activeSessions.push(session);

    const exits: Array<number | null> = [];
    const errors: Error[] = [];
    session.on('exit', (code: number | null) => exits.push(code));
    session.on('error', (error: Error) => errors.push(error));

    await new Promise<void>((resolve) => session.on('exit', () => resolve()));
    // Give any duplicate terminal emission a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exits).toEqual([1]);
    expect(errors).toEqual([]);
  });
});
