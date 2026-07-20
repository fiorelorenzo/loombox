import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AcpChildProcess,
  AcpMcpServerConfig,
  AcpProvider,
  AcpUpdate,
} from '@loombox/providers-core';

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

// Echoes back whatever `mcpServers` it received on `session/new` when
// prompted with "echo-mcp-servers" (`packages/providers/core`'s own
// `mcp-servers.test.ts` fixture, issue #190) — reused here (same relative-
// path pattern as ECHO_FIXTURE above) to prove issues #187/#189's node-side
// plumbing actually reaches `AcpClient.newSession`, not just that
// `AgentSupervisor.start()`/`startWithChild()` accept the option.
const MCP_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'mcp-acp-agent.mjs',
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

function mcpProvider(): AcpProvider {
  return {
    id: 'test-mcp',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [MCP_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

/** Prompts `session` with the fixture's magic "echo back what you got" text and parses its single reply chunk. Mirrors `packages/providers/core/src/mcp-servers.test.ts`'s own `echoMcpServers` helper, one layer up (through `AgentSession`, not a raw `AcpClient`). */
async function echoMcpServers(session: AgentSession): Promise<unknown> {
  const updates: AcpUpdate[] = [];
  const handler = (update: AcpUpdate) => updates.push(update);
  session.on('update', handler);
  await session.prompt('echo-mcp-servers');
  session.off('update', handler);
  return JSON.parse(updates.at(-1)?.text ?? '[]');
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

  it("exposes the live session's config-option store (SPEC.md §7.24; issue #149) — empty for a provider that advertises none", async () => {
    const supervisor = new AgentSupervisor({ providers: [echoProvider()], stateDir });
    const session = await supervisor.start({ workspacePath, providerId: 'test-echo' });
    activeSessions.push(session);

    // The echo fixture's `initialize` result carries no `configOptions`
    // (packages/providers/core/test/fixtures/echo-acp-agent.mjs), so the
    // store starts genuinely empty rather than throwing.
    expect(session.configOptions.get(session.id)).toEqual([]);
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

  it('resolves an attachment ref via the injected AttachmentChannel (issue #156), never opening a connection of its own', async () => {
    const calls: Array<{ sessionId: string; ref: string }> = [];
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const supervisor = new AgentSupervisor({
      stateDir,
      attachmentChannel: {
        resolveAttachment: async (sessionId: string, ref: string) => {
          calls.push({ sessionId, ref });
          return bytes;
        },
      },
    });

    const resolved = await supervisor.resolveAttachment('sess-1', 'ref-abc');

    expect(resolved).toEqual(bytes);
    expect(calls).toEqual([{ sessionId: 'sess-1', ref: 'ref-abc' }]);
  });

  it('rejects resolveAttachment with a clear error when no AttachmentChannel is configured', async () => {
    const supervisor = new AgentSupervisor({ stateDir });

    await expect(supervisor.resolveAttachment('sess-1', 'ref-abc')).rejects.toThrow(
      /no attachment channel configured/i,
    );
  });

  it('setAttachmentChannel() wires (or replaces) the channel after construction', async () => {
    const supervisor = new AgentSupervisor({ stateDir });

    await expect(supervisor.resolveAttachment('sess-1', 'ref-abc')).rejects.toThrow(
      /no attachment channel configured/i,
    );

    supervisor.setAttachmentChannel({
      resolveAttachment: async (sessionId: string, ref: string) =>
        new TextEncoder().encode(`${sessionId}:${ref}`),
    });

    await expect(supervisor.resolveAttachment('sess-1', 'ref-abc')).resolves.toEqual(
      new TextEncoder().encode('sess-1:ref-abc'),
    );

    // A later call replaces, rather than stacking behind, the previous one.
    supervisor.setAttachmentChannel({
      resolveAttachment: async () => new TextEncoder().encode('replaced'),
    });
    await expect(supervisor.resolveAttachment('sess-1', 'ref-abc')).resolves.toEqual(
      new TextEncoder().encode('replaced'),
    );
  });

  it('propagates a rejected AttachmentChannel lookup (e.g. blob not found or failed to decrypt) rather than swallowing it', async () => {
    const supervisor = new AgentSupervisor({
      stateDir,
      attachmentChannel: {
        resolveAttachment: async () => {
          throw new Error('boom: blob not found');
        },
      },
    });

    await expect(supervisor.resolveAttachment('sess-1', 'ref-missing')).rejects.toThrow(
      /boom: blob not found/,
    );
  });

  describe('mcpServers (issues #187/#189 node-side plumbing)', () => {
    it('start() with no mcpServers opens the session with an empty list, unchanged from before this option existed', async () => {
      const supervisor = new AgentSupervisor({ providers: [mcpProvider()], stateDir });
      const session = await supervisor.start({ workspacePath, providerId: 'test-mcp' });
      activeSessions.push(session);

      await expect(echoMcpServers(session)).resolves.toEqual([]);
    });

    it('start() with mcpServers passes them through verbatim to the underlying session/new call', async () => {
      const supervisor = new AgentSupervisor({ providers: [mcpProvider()], stateDir });
      const mcpServers: AcpMcpServerConfig[] = [
        { name: 'fs', command: '/usr/bin/mcp-fs', args: [], env: [] },
      ];

      const session = await supervisor.start({
        workspacePath,
        providerId: 'test-mcp',
        mcpServers,
      });
      activeSessions.push(session);

      await expect(echoMcpServers(session)).resolves.toEqual(mcpServers);
    });

    it('startWithChild() also threads mcpServers through, identically to start()', async () => {
      const supervisor = new AgentSupervisor({ providers: [mcpProvider()], stateDir });
      const mcpServers: AcpMcpServerConfig[] = [
        { type: 'http', name: 'tracker', url: 'https://tracker.example/mcp', headers: [] },
      ];
      const child = spawn(process.execPath, [MCP_FIXTURE], {
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as AcpChildProcess;

      const session = await supervisor.startWithChild({
        workspacePath,
        providerId: 'test-mcp',
        child,
        mcpServers,
      });
      activeSessions.push(session);

      await expect(echoMcpServers(session)).resolves.toEqual(mcpServers);
    });
  });
});
