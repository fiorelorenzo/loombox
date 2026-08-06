import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type PrOpenOutcome,
  type PrOpenPreviewOutcome,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * The full wire-level proof for SPEC §7.14/issue #238: a real session, in
 * its own real isolated git worktree/branch (`SessionManager`'s default —
 * no `worktree: false` override), pushed against a real bare "remote"
 * repo via a real `LocalExecutionTarget` — everything genuinely real
 * except `gh` itself, which is a fake CLI script this file writes and
 * prepends to `process.env.PATH` (restored in `afterEach`), so the whole
 * suite runs hermetically with no real GitHub network dependency,
 * matching this package's own "hermetic PATH" convention
 * (`provider-availability.test.ts`).
 */

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
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
          'echo-acp-agent.mjs',
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

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function derivePhoneSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

async function phoneSeal(
  sessionId: string,
  value: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(sessionId, plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

async function phoneOpen<T>(
  sessionId: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
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

const GH_OK = [
  '#!/bin/sh',
  'case "$1 $2" in',
  '"auth status") exit 0 ;;',
  '"repo view") echo \'{"defaultBranchRef":{"name":"main"}}\'; exit 0 ;;',
  '"pr create") echo "https://github.com/acme/widgets/pull/42"; exit 0 ;;',
  'esac',
  'exit 1',
].join('\n');

let relay: StartedRelay;
let projectPath: string;
let bareDir: string;
let nodeStateDir: string;
let ghBinDir: string | undefined;
let originalPath: string | undefined;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-pr-open-test-'));
  bareDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-pr-open-remote-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-pr-open-state-'));

  await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);
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
  await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: projectPath });
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: projectPath });
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  if (originalPath !== undefined) {
    process.env.PATH = originalPath;
    originalPath = undefined;
  }
  if (ghBinDir) {
    await rm(ghBinDir, { recursive: true, force: true });
    ghBinDir = undefined;
  }
  await rm(projectPath, { recursive: true, force: true });
  await rm(bareDir, { recursive: true, force: true });
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

/** Writes a fake `gh` CLI to a fresh temp dir and puts it FIRST on `process.env.PATH` (restored in `afterEach`) — every real binary this suite needs (`git`, `sh`, node itself) still resolves normally from the rest of PATH. */
async function stubGh(script: string): Promise<void> {
  ghBinDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-pr-open-gh-'));
  const file = path.join(ghBinDir, 'gh');
  await writeFile(file, script, 'utf8');
  await chmod(file, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${ghBinDir}${path.delimiter}${originalPath ?? ''}`;
}

/** Replaces `process.env.PATH` entirely (not merely omitting a `gh` stub — this devbox may have a real, already-authenticated `gh` on its own ambient PATH) with a hermetic dir holding only `sh`/`git`, so `gh_missing` is reachable and deterministic regardless of what's actually installed here (restored in `afterEach`, reusing the same `ghBinDir`/`originalPath` bookkeeping `stubGh` does). */
async function hideGhFromPath(): Promise<void> {
  ghBinDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-pr-open-nogh-'));
  await symlink('/bin/sh', path.join(ghBinDir, 'sh'));
  await symlink('/usr/bin/git', path.join(ghBinDir, 'git'));
  originalPath = process.env.PATH;
  process.env.PATH = ghBinDir;
}

/** Creates a real node + a real isolated-worktree session (`SessionManager`'s default — the session's own `loombox/session-<id>` branch) over a real relay, resumed by a real phone. Returns the session id, its decryption key, and the real absolute worktree path a test can commit into directly. */
async function createSessionOverWire(): Promise<{
  sessionId: string;
  key: CryptoKey;
  worktreePath: string;
}> {
  const amk = generateAmk();
  const accountId = 'acct-pr-open';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-pr-open',
    deviceId: 'device-node-pr-open',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
  });

  const session = await node.createSession({ projectPath, provider: 'test-echo' });
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-pr-open',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  return { sessionId: session.id, key, worktreePath: session.worktreePath };
}

async function commitInWorktree(worktreePath: string, message: string): Promise<void> {
  await execFileAsync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: worktreePath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
}

describe('pr_open_preview_request / pr_open_request wire round trip (SPEC §7.14; issue #238)', () => {
  it(
    'a session with commits: preview shows branch/base/commitCount, then open pushes the branch and returns the real PR URL',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await createSessionOverWire();
      await commitInWorktree(worktreePath, 'session work');
      await stubGh(GH_OK);

      phone!.send({
        type: 'pr_open_preview_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-1',
      });
      const previewMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'pr_open_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-1',
      )) as { envelope: EncryptedEnvelope };
      const preview = await phoneOpen<{ result: PrOpenPreviewOutcome }>(
        sessionId,
        previewMsg.envelope,
        key,
      );
      expect(preview.result).toEqual({
        outcome: 'ok',
        branch: `loombox/session-${sessionId}`,
        base: 'main',
        commitCount: 1,
      });

      const openEnvelope = await phoneSeal(
        sessionId,
        { title: 'Add widget', body: 'Body text' },
        key,
      );
      phone!.send({
        type: 'pr_open_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-open-1',
        envelope: openEnvelope,
      });
      const openMsg = (await phone!.waitFor(
        (m) =>
          m.type === 'pr_open_result' && (m as { requestId?: string }).requestId === 'req-open-1',
      )) as { envelope: EncryptedEnvelope };
      const opened = await phoneOpen<{ result: PrOpenOutcome }>(sessionId, openMsg.envelope, key);
      expect(opened.result).toEqual({
        outcome: 'ok',
        url: 'https://github.com/acme/widgets/pull/42',
        number: 42,
      });

      const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
      expect(remoteRefs.stdout).toContain(`refs/heads/loombox/session-${sessionId}`);
    },
  );

  it(
    'a session with no commits reports the no_commits reason, distinct from a missing/unauthenticated gh',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key } = await createSessionOverWire();
      await stubGh(GH_OK);

      phone!.send({
        type: 'pr_open_preview_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-nocommits',
      });
      const message = (await phone!.waitFor(
        (m) =>
          m.type === 'pr_open_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-nocommits',
      )) as { envelope: EncryptedEnvelope };
      const preview = await phoneOpen<{ result: PrOpenPreviewOutcome }>(
        sessionId,
        message.envelope,
        key,
      );
      expect(preview.result.outcome).toBe('failure');
      expect(preview.result).toMatchObject({ category: 'no_commits' });
    },
  );

  it('a target with no gh on PATH reports gh_missing', { retry: 0, timeout: 20000 }, async () => {
    const { sessionId, key, worktreePath } = await createSessionOverWire();
    await commitInWorktree(worktreePath, 'session work');
    await hideGhFromPath();

    phone!.send({
      type: 'pr_open_preview_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId: 'req-preview-nogh',
    });
    const message = (await phone!.waitFor(
      (m) =>
        m.type === 'pr_open_preview_result' &&
        (m as { requestId?: string }).requestId === 'req-preview-nogh',
    )) as { envelope: EncryptedEnvelope };
    const preview = await phoneOpen<{ result: PrOpenPreviewOutcome }>(
      sessionId,
      message.envelope,
      key,
    );
    expect(preview.result.outcome).toBe('failure');
    expect(preview.result).toMatchObject({ category: 'gh_missing' });
  });

  it(
    'gh present but signed out reports gh_unauthenticated — a third, distinct reason from no_commits/gh_missing',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, worktreePath } = await createSessionOverWire();
      await commitInWorktree(worktreePath, 'session work');
      await stubGh(
        ['#!/bin/sh', 'case "$1 $2" in', '"auth status") exit 1 ;;', 'esac', 'exit 1'].join('\n'),
      );

      phone!.send({
        type: 'pr_open_preview_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-noauth',
      });
      const message = (await phone!.waitFor(
        (m) =>
          m.type === 'pr_open_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-noauth',
      )) as { envelope: EncryptedEnvelope };
      const preview = await phoneOpen<{ result: PrOpenPreviewOutcome }>(
        sessionId,
        message.envelope,
        key,
      );
      expect(preview.result.outcome).toBe('failure');
      expect(preview.result).toMatchObject({ category: 'gh_unauthenticated' });
    },
  );

  it(
    'pr_open_preview_request never pushes or creates anything — only pr_open_request has that side effect',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, worktreePath } = await createSessionOverWire();
      await commitInWorktree(worktreePath, 'session work');
      await stubGh(GH_OK);

      phone!.send({
        type: 'pr_open_preview_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId: 'req-preview-noside',
      });
      await phone!.waitFor(
        (m) =>
          m.type === 'pr_open_preview_result' &&
          (m as { requestId?: string }).requestId === 'req-preview-noside',
      );

      const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
      expect(remoteRefs.stdout).not.toContain(`refs/heads/loombox/session-${sessionId}`);
    },
  );
});
