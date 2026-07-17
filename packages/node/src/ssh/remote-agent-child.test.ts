import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AcpClient, type AcpUpdate } from '@loombox/providers-core';

import { LocalProcessTransport } from './local-process-transport';
import { RemoteProcessRunner } from './remote-process-runner';
import { shQuote } from './remote-transport';
import { asAcpChildProcess, RemoteAgentChildProcess } from './remote-agent-child';

// The same hermetic fixture agent packages/providers/core,
// packages/providers/claude, packages/supervisor and packages/node's own
// node-daemon.test.ts already exercise their tests against (not a real
// `claude` binary).
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

let baseDir: string;
let transport: LocalProcessTransport;
let runner: RemoteProcessRunner;
let child: RemoteAgentChildProcess | undefined;
// Bridges the test deliberately abandons (to simulate a driving node
// exiting without ever calling kill()) still need their poll timers torn
// down at the *test-harness* level so they don't outlive the test and throw
// once `transport` is closed underneath them — the production code's
// contract is exactly that the remote process keeps running unattended, not
// that this local bridge object leaks forever.
let abandonedChildren: RemoteAgentChildProcess[];

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-remote-child-'));
  transport = new LocalProcessTransport();
  await transport.connect();
  runner = new RemoteProcessRunner(transport, { baseDir });
  abandonedChildren = [];
});

afterEach(async () => {
  child?.kill();
  for (const abandoned of abandonedChildren) abandoned.kill();
  await transport.close();
  await rm(baseDir, { recursive: true, force: true });
});

describe('RemoteAgentChildProcess + AcpClient (proves ssh: target session parity with local)', () => {
  it('drives the exact same ACP handshake and prompt/response flow as a local spawn, over the remote-process bridge instead of a direct pipe', async () => {
    const runId = randomUUID();
    const command = `${shQuote(process.execPath)} ${shQuote(ECHO_FIXTURE)}`;
    const handle = await runner.launch(runId, command, 'setsid');

    child = new RemoteAgentChildProcess(runner, handle, { pollIntervalMs: 30 });
    child.start();

    const client = new AcpClient(asAcpChildProcess(child));
    const initResult = await client.initialize();
    expect(initResult.agentInfo?.name).toBe('echo-acp-agent');

    const sessionId = await client.newSession('/workspace');
    expect(sessionId).toMatch(/^sess_test_/);

    const chunks: string[] = [];
    client.on('update', (update: AcpUpdate) => {
      if (update.kind === 'agent_message_chunk') chunks.push(update.text);
    });

    await client.prompt(sessionId, 'hi there');
    expect(chunks.at(-1)).toBe('Hello world');

    client.close();
  }, 10_000);

  it('surviving a client disconnect: a second bridge reattaches to the same still-running remote process and keeps working', async () => {
    const runId = randomUUID();
    const command = `${shQuote(process.execPath)} ${shQuote(ECHO_FIXTURE)}`;
    const handle = await runner.launch(runId, command, 'setsid');

    const firstChild = new RemoteAgentChildProcess(runner, handle, { pollIntervalMs: 30 });
    abandonedChildren.push(firstChild); // stop *this test's* polling in afterEach; see the variable's doc comment
    firstChild.start();
    const firstClient = new AcpClient(asAcpChildProcess(firstChild));
    await firstClient.initialize();
    const sessionId = await firstClient.newSession('/workspace');

    // The driving node "exits": nothing calls firstChild.kill(), it is
    // simply abandoned, exactly like a node process dying without ever
    // sending SIGTERM to the (setsid-detached) remote agent.

    const attached = await runner.attach(runId);
    expect(attached?.alive).toBe(true);

    // A real reattach resumes tailing from the *current* end of the log,
    // not from byte 0: the log already holds the first client's own
    // initialize/newSession traffic, and a fresh `AcpClient` numbers its
    // own outgoing request ids starting at 1 again — replaying history
    // from the start would let a stale response with a colliding id
    // resolve the new client's own in-flight request. `start(fromOffset)`
    // exists exactly for this (see its doc comment).
    const { offset: currentOffset } = await runner.readOutput(attached!.handle, 0);

    child = new RemoteAgentChildProcess(runner, attached!.handle, { pollIntervalMs: 30 });
    child.start(currentOffset);
    const secondClient = new AcpClient(asAcpChildProcess(child));

    const chunks: string[] = [];
    secondClient.on('update', (update: AcpUpdate) => {
      if (update.kind === 'agent_message_chunk') chunks.push(update.text);
    });

    // The already-open session is still live on the still-running remote
    // agent; a fresh bridge can prompt it directly without re-initializing.
    await secondClient.prompt(sessionId, 'still there?');
    expect(chunks.at(-1)).toBe('Hello world');

    secondClient.close();
  }, 10_000);
});
