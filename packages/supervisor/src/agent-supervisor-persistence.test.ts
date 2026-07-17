import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranscriptState, reduceTranscript } from '@loombox/providers-core';
import type { AcpProvider } from '@loombox/providers-core';

import { AgentSupervisor } from './agent-supervisor';
import type { AgentSession } from './agent-session';
import { TranscriptStore } from './transcript-store';

// Same hermetic-fixture convention agent-supervisor.test.ts uses: reach into
// packages/providers/core's test/fixtures by relative path, since they are
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

const PERMISSION_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'permission-acp-agent.mjs',
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

function permissionProvider(): AcpProvider {
  return {
    id: 'test-permission',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [PERMISSION_FIXTURE], cwd }),
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
  workspacePath = await mkdtemp(path.join(tmpdir(), 'loombox-supervisor-persist-ws-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-supervisor-persist-state-'));
  activeSessions = [];
});

afterEach(async () => {
  for (const session of activeSessions) session.close();
  await rm(workspacePath, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe('AgentSupervisor — on-disk resumable transcript (issue #77)', () => {
  it('persists every session/update-derived transcript entry to disk, versioned, and replaying the log through the real reducer reconstructs the same state a live stream produced', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    await session.prompt('hi there');

    const store = new TranscriptStore({ stateDir });
    const log = store.readLog(session.id);

    // Two agent_message_chunk transcript_update entries and one turn_end,
    // interleaved with attention transitions (awaiting_input -> working ->
    // ... -> awaiting_input), everything versioned and in one strictly
    // increasing seq order — the "ordered event sequence" issue #77 asks for.
    const transcriptEntries = log.filter((entry) => entry.type === 'transcript_update');
    expect(transcriptEntries).toHaveLength(2);
    expect(log.every((entry) => entry.v === 1)).toBe(true);
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(log.at(-1)).toMatchObject({
      type: 'attention',
      attention: { status: 'awaiting_input' },
    });
    expect(log.find((entry) => entry.type === 'turn_end')).toMatchObject({
      type: 'turn_end',
      turnEnd: { stopReason: 'end_turn' },
    });

    expect(store.readTranscriptUpdates(session.id)).toEqual(session.getTranscriptUpdates());

    // "The same reducer runs identically for a live stream and for replayed
    // history" (SPEC.md §7.24): fold the persisted log through the real v1
    // reducer and compare against what a live client would have produced.
    const replayed = store
      .readTranscriptUpdates(session.id)
      .reduce(reduceTranscript, createTranscriptState());
    expect(replayed.items).toEqual([
      {
        type: 'message',
        id: expect.any(String),
        kind: 'agent_message_chunk',
        turnId: expect.any(String),
        messageId: 'msg_agent_1',
        text: 'Hello world',
      },
    ]);
  });
});

describe('AgentSupervisor — attach/resume across disconnects (issue #78)', () => {
  it('a detach then re-attach replays the persisted transcript (read straight off disk) and continues live', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    await session.prompt('first turn');
    session.removeAllListeners('update');

    // A caller re-attaching after a disconnect wouldn't necessarily still
    // hold the in-process AgentSession — it reads straight off disk.
    const independentStore = new TranscriptStore({ stateDir });
    const persistedBeforeReattach = independentStore.readTranscriptUpdates(session.id);
    expect(persistedBeforeReattach).toEqual(session.getTranscriptUpdates());
    expect(persistedBeforeReattach).toHaveLength(2);

    // Re-attach: the supervisor never respawns, the same live session picks
    // back up, and a second turn continues appending to the same log.
    const reattached = supervisor.get(session.id);
    expect(reattached).toBe(session);
    expect(reattached?.isLive).toBe(true);

    await reattached?.prompt('second turn');

    const persistedAfterReattach = independentStore.readTranscriptUpdates(session.id);
    expect(persistedAfterReattach).toHaveLength(4);
    expect(session.getTranscriptUpdates()).toHaveLength(4);
  });

  it('a NEW supervisor instance pointed at the same state dir reloads a persisted session as replay-only, with its full transcript and attention state, and refuses to prompt it', async () => {
    const supervisorA = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisorA.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);
    await session.prompt('hi there');

    // Simulates a supervisor *process* restart: a brand-new AgentSupervisor,
    // same on-disk state dir, that never registered the echo provider (it
    // doesn't need to — a reloaded session has no child to spawn/talk to).
    const supervisorB = new AgentSupervisor({ providers: [], stateDir });
    const reloaded = supervisorB.reloadPersistedSessions();

    expect(reloaded).toHaveLength(1);
    const reloadedSession = supervisorB.get(session.id);
    expect(reloadedSession).toBeDefined();
    expect(reloadedSession?.isLive).toBe(false);
    expect(reloadedSession?.providerId).toBe('test-echo');
    expect(reloadedSession?.workspacePath).toBe(workspacePath);
    expect(reloadedSession?.getTranscriptUpdates()).toEqual(session.getTranscriptUpdates());
    expect(reloadedSession?.getAttentionState().status).toBe('awaiting_input');

    await expect(reloadedSession?.prompt('anything')).rejects.toThrow(/no live agent process/);
    // A replay-only session has no client behind it, so its config-option
    // store is unreadable too (mirrors the `permissions` getter's own guard;
    // issue #149's node -> client config_options push).
    expect(() => reloadedSession?.configOptions).toThrow(/no live agent process/);

    // Reloading again (idempotent from the caller's point of view) must not
    // duplicate an already-tracked session.
    expect(supervisorB.reloadPersistedSessions()).toHaveLength(0);
    expect(supervisorB.listSessions()).toHaveLength(1);
  });
});

describe('AgentSupervisor — completion/attention events independent of any client (issue #79)', () => {
  it('records a turn-finished attention transition to disk even with zero listeners attached', async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    expect(session.getAttentionState().status).toBe('awaiting_input');

    // No 'attention'/'update'/'turn_end' listener attached anywhere: only
    // await the prompt's own promise.
    await session.prompt('hi there');

    expect(session.getAttentionState().status).toBe('awaiting_input');

    const store = new TranscriptStore({ stateDir });
    expect(store.readMeta(session.id)?.attention.status).toBe('awaiting_input');

    // A caller that attaches only now still observes future transitions.
    const seenLater: string[] = [];
    session.on('attention', (state: { status: string }) => seenLater.push(state.status));
    await session.prompt('again');
    expect(seenLater).toEqual(['working', 'awaiting_input']);
  });

  it('records a permission-required attention transition with no listeners attached, and a later attach observes it via getAttentionState()', async () => {
    const supervisor = new AgentSupervisor({ providers: [permissionProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-permission' });
    activeSessions.push(session);

    const promptPromise = session.prompt('request-permission');

    await vi.waitFor(() => {
      expect(session.getAttentionState().status).toBe('permission_required');
    });

    const store = new TranscriptStore({ stateDir });
    expect(store.readMeta(session.id)?.attention.status).toBe('permission_required');
    const detail = session.getAttentionState().detail as { requestId: string };
    expect(detail.requestId).toBeDefined();

    // Resolve so the turn can finish (a real caller would do this from the
    // permission UI; here it's the supervisor-level queue API directly).
    const pending = session.permissions.head(session.id);
    expect(pending).toBeDefined();
    session.permissions.resolve(pending!.requestId, { outcome: 'selected', optionId: 'allow' });

    await promptPromise;
    expect(session.getAttentionState().status).toBe('awaiting_input');
  });

  it('records a terminal error/exit attention transition with no listeners attached', async () => {
    const supervisor = new AgentSupervisor({ providers: [crashProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-crash' });
    activeSessions.push(session);

    await vi.waitFor(() => {
      expect(session.getAttentionState().status).toBe('exited');
    });

    const store = new TranscriptStore({ stateDir });
    const meta = store.readMeta(session.id);
    expect(meta?.attention.status).toBe('exited');
    expect((meta?.attention.detail as { code: number | null })?.code).toBe(1);
  });
});
