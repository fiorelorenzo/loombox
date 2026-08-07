import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type NodeSelfUpdateApplyResponse,
  type NodeSelfUpdateStatusAnnounce,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { generateAmk } from '@loombox/crypto';

import { createLocalInstallLayoutDriver, createTarGzArchive } from './install-layout';
import { createNode, type NodeDaemon } from './node-daemon';
import type { NodeUpdateSource } from './self-update';

/**
 * Real wire-level proof for issue #656 (epic #653): a real relay, a real
 * `NodeDaemon`, and a real `node.mjs --version` subprocess spawn for the
 * staged-verification/build-identity assertions — never a mock of THIS
 * package's own self-update machinery. Harness duplicated from
 * `node-daemon-agent-profile.test.ts` (this package's own established
 * per-file convention) rather than shared. No real network anywhere in
 * this file: `NodeUpdateSource` is always a fake, in-memory implementation.
 */

const execFileAsync = promisify(execFile);

const STREAMING_FIXTURE = path.join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'streaming-acp-agent.mjs',
);

function streamingProvider(): AcpProvider {
  return {
    id: 'test-streaming',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [STREAMING_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function goodBundleScript(version: string, commit = 'deadbeef'): string {
  return `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, commit: ${JSON.stringify(commit)} }));\n`;
}

async function fixtureNodeBundle(script: string): Promise<Uint8Array> {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-self-update-fixture-'));
  try {
    await writeFile(path.join(sourceDir, 'node.mjs'), script);
    return await createTarGzArchive(sourceDir);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/** A `NodeUpdateSource` that always reports `version` as the latest, and fetches it from `bytes` when `version` matches — a fake, in-memory implementation, exactly the seam `NodeDaemonOptions.selfUpdate.source` exists for. */
function fakeSource(version: string, bytes: Uint8Array): NodeUpdateSource {
  return {
    checkLatest: async () => ({ version }),
    async fetch(requested) {
      if (requested !== version) throw new Error(`fakeSource: no artifact for ${requested}`);
      return { version, bytes, signature: undefined };
    },
  };
}

interface BridgeLike {
  agentSession: { getAttentionState(): { status: string } };
}

/**
 * `NodeDaemon.bridges` is `private` only at the TypeScript level — the
 * cast lives in this ONE named helper, never inlined into a property
 * access, and is read-only synchronization plumbing for
 * {@link waitForWorkingAttention} below, never a substitute for
 * exercising the real `node_self_update_apply_request` wire path.
 */
function daemonBridges(node: NodeDaemon): Map<string, BridgeLike> {
  const withBridges = node as unknown as { bridges: Map<string, BridgeLike> };
  return withBridges.bridges;
}

/**
 * Polls this SAME in-process `NodeDaemon`'s own `bridges` map for
 * `sessionId`'s real `AttentionState.status` — the exact condition
 * `handleNodeSelfUpdateApplyRequest` itself gates on — rather than a fixed
 * sleep guessing how long a real subprocess spawn + first ACP round trip
 * takes under whatever load this box happens to be under. A real polling
 * delay (not a fake timer) is unavoidable here: the condition is driven
 * by a genuine child-process spawn and ACP round trip, which no fake
 * clock controls.
 */
async function waitForWorkingAttention(
  node: NodeDaemon,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (daemonBridges(node).get(sessionId)?.agentSession.getAttentionState().status === 'working') {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('waitForWorkingAttention: timed out waiting for a working turn');
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; devicePublicKey: string; authToken: string }) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'initialize',
            protocolVersion: PROTOCOL_V1,
            role: 'client',
            authToken: opts.authToken,
            deviceId: opts.deviceId,
            devicePublicKey: opts.devicePublicKey,
          }),
        );
      });
      this.socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        if (!settled && parsed.type === 'initialize_result') {
          settled = true;
          resolve();
          return;
        }
        this.messages.push(parsed as WireMessageV1);
      });
      this.socket.addEventListener('error', () => {
        if (!settled) reject(new Error(`TestPhone: cannot reach ${url}`));
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  // Polls real, already-arrived wire messages over a real relay socket —
  // the same convention every other `TestPhone` in this package's test
  // suite already uses (`node-daemon-ssh.test.ts`, `node-daemon-agent-
  // profile.test.ts`); there is no event to `await` here that isn't
  // itself timing-dependent on a real subprocess/relay round trip.
  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 5000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let baseDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-self-update-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-self-update-state-'));
  baseDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-self-update-install-'));
  const driver = createLocalInstallLayoutDriver();
  await driver.stageVersion(baseDir, '1.0.0', await fixtureNodeBundle(goodBundleScript('1.0.0')));
  await driver.activateVersion(baseDir, '1.0.0');
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await rm(baseDir, { recursive: true, force: true });
  await relay.close();
});

describe('NodeDaemon self-update — real relay, real subprocess (issue #656)', () => {
  it('refuses node_self_update_apply_request with an explanatory message when selfUpdate is not configured', async () => {
    const amk = generateAmk();
    const accountId = 'acct-self-update-unconfigured';
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-self-update-unconfigured',
      deviceId: 'device-node-self-update-unconfigured',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [] }),
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    phone.send({
      type: 'node_self_update_apply_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-self-update-unconfigured',
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'node_self_update_apply_response',
    )) as NodeSelfUpdateApplyResponse;

    expect(response.ok).toBe(false);
    expect(response.message).toMatch(/not configured/);
  });

  it('detects and surfaces an available update unprompted, without ever applying it — nothing updates without an explicit action', async () => {
    const amk = generateAmk();
    const accountId = 'acct-self-update-surface';
    const restart = vi.fn();
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-self-update-surface',
      deviceId: 'device-node-self-update-surface',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [] }),
      selfUpdate: {
        source: fakeSource('2.0.0', await fixtureNodeBundle(goodBundleScript('2.0.0'))),
        currentVersion: '1.0.0',
        baseDir,
        restart,
      },
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;

    const announce = (await phone.waitFor(
      (m) => m.type === 'node_self_update_status',
    )) as NodeSelfUpdateStatusAnnounce;
    expect(announce).toMatchObject({
      status: 'update_available',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
    });

    // Detected and surfaced, but never applied on its own: the install
    // layout's own `current` still points at the old version, and the
    // restart hook (the only thing that would actually affect the running
    // process) was never touched.
    const driver = createLocalInstallLayoutDriver();
    expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });

  it('applies a successful update end to end: stages, activates, restarts, and the node\u2019s reported build identity changes (issue #655)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-self-update-apply';
    const restart = vi.fn();
    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-self-update-apply',
      deviceId: 'device-node-self-update-apply',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [] }),
      selfUpdate: {
        source: fakeSource('2.0.0', await fixtureNodeBundle(goodBundleScript('2.0.0'))),
        currentVersion: '1.0.0',
        baseDir,
        restart,
      },
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    await phone.waitFor((m) => m.type === 'node_self_update_status'); // the automatic check has run

    phone.send({
      type: 'node_self_update_apply_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-apply',
      nodeId: 'node-self-update-apply',
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'node_self_update_apply_response',
    )) as NodeSelfUpdateApplyResponse;

    expect(response).toMatchObject({ ok: true, fromVersion: '1.0.0', toVersion: '2.0.0' });
    // `handleNodeSelfUpdateApplyRequest`'s own `restart` callback replies
    // BEFORE calling `selfUpdateOptions.restart()` (its own comment: the
    // client must learn the outcome before the process actually exits),
    // with a deliberate ~250ms pause in between so the reply has actually
    // left this process first — so `restart` is not necessarily called
    // yet the instant the response arrives client-side; poll for it
    // rather than asserting synchronously with the reply.
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce(), { timeout: 2000 });

    const driver = createLocalInstallLayoutDriver();
    expect(await driver.currentVersion(baseDir)).toBe('2.0.0');

    // Issue #655's own acceptance, proven for real: spawning the now-live
    // `current/node.mjs --version` (exactly what a real restart hands
    // control to, since the service unit's ExecStart resolves through
    // `current`) reports the NEW identity, not the one this node started
    // with — a real subprocess, not an assumption about what the symlink
    // points at.
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(baseDir, 'current', 'node.mjs'),
      '--version',
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ version: '2.0.0', commit: 'deadbeef' });
  });

  it(
    'refuses to apply while a session is actively mid-turn, and the node keeps running unaffected',
    { retry: 0, timeout: 20000 },
    async () => {
      const amk = generateAmk();
      const accountId = 'acct-self-update-mid-turn';
      const restart = vi.fn();
      node = createNode({
        relayUrl: relay.url,
        stateDir: nodeStateDir,
        nodeId: 'node-self-update-mid-turn',
        deviceId: 'device-node-self-update-mid-turn',
        devicePublicKey: randomBase64(),
        authToken: accountId,
        accountId,
        amk,
        supervisor: new AgentSupervisor({ providers: [streamingProvider()] }),
        selfUpdate: {
          source: fakeSource('2.0.0', await fixtureNodeBundle(goodBundleScript('2.0.0'))),
          currentVersion: '1.0.0',
          baseDir,
          restart,
        },
      });

      await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
      await execFileAsync('git', ['config', 'user.email', 'test@loombox.dev'], {
        cwd: projectPath,
      });
      await execFileAsync('git', ['config', 'user.name', 'loombox test'], { cwd: projectPath });
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
        cwd: projectPath,
      });
      const session = await node.createSession({ projectPath, provider: 'test-streaming' });

      phone = new TestPhone(relay.url, {
        deviceId: 'device-phone-4',
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      await phone.ready;

      // Fires a turn that streams for several real chunks (the fixture's
      // own default ~25ms/chunk over 18 chunks, ~450ms total) — plenty of
      // window to catch the session genuinely mid-turn. Waits for the
      // real `AttentionState` to actually read `'working'`
      // ({@link waitForWorkingAttention}) rather than a fixed sleep
      // guessing subprocess-spawn timing, which is exactly what raced
      // under load.
      void node.promptSession(session.id, 'go');
      await waitForWorkingAttention(node, session.id);

      phone.send({
        type: 'node_self_update_apply_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-mid-turn',
        nodeId: 'node-self-update-mid-turn',
      });
      const response = (await phone.waitFor(
        (m) => m.type === 'node_self_update_apply_response',
      )) as NodeSelfUpdateApplyResponse;

      expect(response.ok).toBe(false);
      expect(response.message).toMatch(/working on a turn/);

      // The node itself never restarted or updated anything.
      const driver = createLocalInstallLayoutDriver();
      expect(await driver.currentVersion(baseDir)).toBe('1.0.0');
      expect(restart).not.toHaveBeenCalled();
    },
  );

  it('a failed activation rolls back to the old version, replies ok: false, and never restarts \u2014 the node still runs', async () => {
    const amk = generateAmk();
    const accountId = 'acct-self-update-rollback';
    const restart = vi.fn();
    const realDriver = createLocalInstallLayoutDriver();
    // Simulates `activateVersion` itself failing for the NEW version only
    // (a real filesystem/permission problem, distinct from a bad build) —
    // rollback re-runs the SAME real `activateVersion` against the old
    // version, so this is still exercising the real install-layout
    // mechanics, not a mocked rollback.
    const failingDriver = {
      ...realDriver,
      activateVersion: async (dir: string, version: string) => {
        if (version === '2.0.0') throw new Error('simulated disk full');
        await realDriver.activateVersion(dir, version);
      },
    };

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-self-update-rollback',
      deviceId: 'device-node-self-update-rollback',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [] }),
      selfUpdate: {
        source: fakeSource('2.0.0', await fixtureNodeBundle(goodBundleScript('2.0.0'))),
        currentVersion: '1.0.0',
        baseDir,
        driver: failingDriver,
        restart,
      },
    });

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    await phone.waitFor((m) => m.type === 'node_self_update_status');

    phone.send({
      type: 'node_self_update_apply_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-rollback',
      nodeId: 'node-self-update-rollback',
    });
    const response = (await phone.waitFor(
      (m) => m.type === 'node_self_update_apply_response',
    )) as NodeSelfUpdateApplyResponse;

    expect(response.ok).toBe(false);
    expect(response.fromVersion).toBe('1.0.0');
    expect(response.toVersion).toBeUndefined();
    expect(await realDriver.currentVersion(baseDir)).toBe('1.0.0');
    expect(restart).not.toHaveBeenCalled();
  });
});
