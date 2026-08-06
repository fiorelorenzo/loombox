import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  spendReportResponsePayloadV1,
  type EncryptedEnvelope,
  type SpendReportResponse,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import { decryptEnvelope, deriveProjectKey, generateAmk } from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import { SpendLedgerStore } from './spend-ledger-store';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * Wire-level proof for SPEC §7.9/issue #249: `spend_report_request`/
 * `_response` served straight from `SpendLedgerStore`, and — reusing
 * `spend-cap-acp-agent.mjs` (the same fixture `node-daemon-spend-cap.test.ts`
 * scripts) — a real `usage_update` landing in that same store through
 * `NodeDaemon.recordUsageCost`, the one write path this issue's own
 * acceptance requires SPEC §7.16's spend cap and this view to share.
 * Harness duplicated from `node-daemon-spend-cap.test.ts` (this package's
 * established per-file convention).
 */

function spendCapProvider(): AcpProvider {
  return {
    id: 'test-spend-report',
    spawnConfig: ({ cwd }) => ({
      command: process.execPath,
      args: [
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '..',
          '..',
          'providers',
          'core',
          'test',
          'fixtures',
          'spend-cap-acp-agent.mjs',
        ),
      ],
      cwd,
    }),
    enrich: (update) => update,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

class TestPhone {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(url: string, opts: { deviceId: string; devicePublicKey: string; authToken: string }) {
    this.socket = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ready = promise;
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
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 10000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error('TestPhone: timed out waiting for a matching message');
      await sleep(10);
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
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;
let requestCounter = 0;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-spend-report-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-spend-report-state-'));
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
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(projectPath, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

async function openSpendReportResponse(
  message: SpendReportResponse,
  amk: Uint8Array,
  accountId: string,
): Promise<{ rows: { date: string; provider: string; costUsd: number }[] }> {
  const key = await deriveProjectKey(amk, accountId, message.projectPath);
  const envelope = {
    resourceId: message.envelope.resourceId,
    iv: new Uint8Array(Buffer.from(message.envelope.iv, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(message.envelope.ciphertext, 'base64')),
  };
  const plaintext = await decryptEnvelope(message.projectPath, envelope, key);
  return spendReportResponsePayloadV1.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}

async function connectedPhone(accountId: string): Promise<TestPhone> {
  const p = new TestPhone(relay.url, {
    deviceId: `device-phone-${accountId}`,
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await p.ready;
  return p;
}

describe('spend_report_request / spend_report_response (SPEC §7.9; issue #249)', () => {
  it('answers straight from the seeded SpendLedgerStore, filtered to the requested project and date range', async () => {
    const amk = generateAmk();
    const accountId = 'acct-spend-report-seeded';
    const spendLedgerStore = new SpendLedgerStore({ stateDir: nodeStateDir });
    spendLedgerStore.recordDelta('2026-08-01', projectPath, 'claude', 1.5);
    spendLedgerStore.recordDelta('2026-08-02', projectPath, 'claude', 2.25);
    spendLedgerStore.recordDelta('2026-08-01', '/some-other-project', 'claude', 9);

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-spend-report-seeded',
      deviceId: 'device-node-spend-report-seeded',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      spendLedgerStore,
    });

    phone = await connectedPhone(accountId);
    requestCounter += 1;
    phone.send({
      type: 'spend_report_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-spend-report-seeded',
      projectPath,
      requestId: `spend-report-req-${requestCounter}`,
      sinceDate: '2026-08-02',
    });

    const response = (await phone.waitFor(
      (m) => m.type === 'spend_report_response',
    )) as SpendReportResponse;
    const payload = await openSpendReportResponse(response, amk, accountId);

    // Only the row on/after 2026-08-02, for THIS project only — the
    // earlier date and the other project's row are both excluded.
    expect(payload.rows).toEqual([{ date: '2026-08-02', provider: 'claude', costUsd: 2.25 }]);
  });

  it('answers with an empty rows array (never a dropped request) for a project with nothing recorded', async () => {
    const amk = generateAmk();
    const accountId = 'acct-spend-report-empty';

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-spend-report-empty',
      deviceId: 'device-node-spend-report-empty',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
    });

    phone = await connectedPhone(accountId);
    requestCounter += 1;
    phone.send({
      type: 'spend_report_request',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node-spend-report-empty',
      projectPath,
      requestId: `spend-report-req-${requestCounter}`,
    });

    const response = (await phone.waitFor(
      (m) => m.type === 'spend_report_response',
    )) as SpendReportResponse;
    const payload = await openSpendReportResponse(response, amk, accountId);
    expect(payload.rows).toEqual([]);
  });

  it('a real usage_update from a live session lands in the same SpendLedgerStore that answers spend_report_request — the shared aggregation source SPEC §7.16 also reads', async () => {
    const amk = generateAmk();
    const accountId = 'acct-spend-report-live';
    const spendLedgerStore = new SpendLedgerStore({ stateDir: nodeStateDir });

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-spend-report-live',
      deviceId: 'device-node-spend-report-live',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      spendLedgerStore,
      supervisor: new AgentSupervisor({ providers: [spendCapProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-spend-report' });

    phone = await connectedPhone(accountId);
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const sessionKey = await deriveProjectKey(amk, accountId, projectPath);
    // The fixture agent is scripted by prompt text alone; no envelope
    // decrypt is needed on this side since this test never reads the
    // resulting `session_update`, only the ledger it causes as a
    // side effect — a bare `EncryptedEnvelope`-shaped stub satisfies the
    // wire schema without this test caring about session-key sealing.
    void sessionKey;
    const envelope: EncryptedEnvelope = {
      resourceId: `${session.id}:prompt-1`,
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: toBase64(new TextEncoder().encode(JSON.stringify({ text: 'usage:3.25' }))),
      alg: 'AES-256-GCM',
    };
    // A garbled/unreadable prompt still exercises turn completion but
    // never reaches the agent's own scripted usage branch, so instead
    // this test drives the exact same real, correctly-sealed path
    // `node-daemon-spend-cap.test.ts` uses.
    void envelope;

    const { encryptEnvelope, deriveKeyTree, importAesGcmKey } = await import('@loombox/crypto');
    const node2 = await deriveKeyTree(amk, ['session', accountId, session.id]);
    const realSessionKey = await importAesGcmKey(node2.key);
    const plaintext = new TextEncoder().encode(JSON.stringify({ text: 'usage:3.25' }));
    const sealed = await encryptEnvelope(session.id, plaintext, realSessionKey);
    phone.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-1',
      envelope: {
        resourceId: sealed.resourceId,
        iv: toBase64(sealed.iv),
        ciphertext: toBase64(sealed.ciphertext),
        alg: 'AES-256-GCM',
      },
    });

    await phone.waitFor(
      (m) =>
        m.type === 'session_update' &&
        (m as { sessionId: string }).sessionId === session.id &&
        false, // never matches; real assertion below polls the store instead
      50,
    ).catch(() => undefined);

    // Poll the ledger directly rather than decrypting `session_update`
    // notifications — this test's only claim is "the write landed",
    // which `node-daemon-spend-cap.test.ts` already proves is driven by
    // a genuine `usage_update`.
    const deadline = Date.now() + 10000;
    let rows = spendLedgerStore.all();
    while (rows.length === 0 && Date.now() < deadline) {
      await sleep(20);
      rows = spendLedgerStore.all();
    }

    expect(rows).toEqual([
      { date: new Date().toISOString().slice(0, 10), projectPath, provider: 'test-spend-report', costUsd: 3.25 },
    ]);
  });
});
