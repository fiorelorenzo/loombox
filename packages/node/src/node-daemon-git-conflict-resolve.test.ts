import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type FsWriteResponsePayloadV1,
  type GitConflictResolveResponsePayloadV1,
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
 * The full wire-level, end-to-end proof for SPEC §7.6/issue #237: a real
 * session, in its own real isolated git worktree, produces a REAL
 * conflict via `git merge` (never a hand-typed conflict fixture), asks
 * the node to propose a resolution over `git_conflict_resolve_request`/
 * `git_conflict_resolve_response`, then applies it — one deliberate
 * `fs_write_request` — reusing issue #205's own conflict-safe write
 * rather than a bespoke "apply" message (see `@loombox/protocol`'s
 * `git-conflict-resolve.ts` file doc comment). A dedicated file, not
 * folded into `node-daemon.test.ts`, the same "new work in new files"
 * discipline `node-daemon-agent-instructions.test.ts`/
 * `node-daemon-pr-open.test.ts`/`node-daemon-checkpoint.test.ts` already
 * establish — `node-daemon.ts` itself is this wave's own highest
 * merge-conflict-risk file (several concurrent issues land in it at
 * once); its OWN test file needn't be a second one.
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
      if (Date.now() > deadline) {
        throw new Error('TestPhone: timed out waiting for a matching message');
      }
      await new Promise((resolve) => setTimeout(resolve, 10)); // real relay/socket round trip, no fake-timer substitute — see the file doc comment
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

function waitForConnected(node: NodeDaemon): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  node.once('connected', () => resolve());
  return promise;
}

/** This suite's own seam for reaching `NodeDaemon`'s private `bridges` map directly — mirrors `node-daemon.test.ts`'s identical `diffExplainInternals` helper (issue #236), named distinctly since this file is its own concurrent sibling this wave. */
interface GitConflictResolveDaemonInternals {
  bridges: Map<string, { agentSession: { prompt(text: string): Promise<void> } }>;
}
function gitConflictResolveInternals(node: NodeDaemon): GitConflictResolveDaemonInternals {
  return node as unknown as GitConflictResolveDaemonInternals;
}

let relay: StartedRelay;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  nodeStateDir = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-git-conflict-resolve-state-'),
  );
});

afterEach(async () => {
  node?.close();
  phone?.close();
  node = undefined;
  phone = undefined;
  await rm(nodeStateDir, { recursive: true, force: true });
  await relay.close();
});

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'loombox test',
      GIT_AUTHOR_EMAIL: 'test@loombox.dev',
      GIT_COMMITTER_NAME: 'loombox test',
      GIT_COMMITTER_EMAIL: 'test@loombox.dev',
    },
  });
  return stdout.trim();
}

/** A real project directory with a real branch (`feature`) that conflicts with `main` on `notes.txt`, ready for a session to merge in and hit a genuine conflict — never a hand-typed conflict fixture. */
async function makeConflictingProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-git-conflict-resolve-project-'));
  await execGit(projectPath, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(projectPath, 'notes.txt'), 'one\ntwo\nthree\n');
  await execGit(projectPath, ['add', 'notes.txt']);
  await execGit(projectPath, ['commit', '-q', '-m', 'seed']);

  await execGit(projectPath, ['checkout', '-q', '-b', 'feature']);
  await writeFile(path.join(projectPath, 'notes.txt'), 'one\nFEATURE-EDIT\nthree\n');
  await execGit(projectPath, ['commit', '-q', '-am', 'feature edit']);

  await execGit(projectPath, ['checkout', '-q', 'main']);
  await writeFile(path.join(projectPath, 'notes.txt'), 'one\nMAIN-EDIT\nthree\n');
  await execGit(projectPath, ['commit', '-q', '-am', 'main edit']);

  return projectPath;
}

describe('NodeDaemon git-conflict-resolve (AI merge-conflict resolution, issue #237)', () => {
  it('proposes a resolution for a REAL git-merge conflict — hunks/resolution/origin/baseHash are all real and derived — then applies it via a real fs_write_request, leaving the on-disk file exactly the resolved content with no markers left', async () => {
    const amk = generateAmk();
    const accountId = 'acct-git-conflict-resolve-1';
    const projectPath = await makeConflictingProject();

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-1',
      deviceId: 'device-node-git-conflict-resolve-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      // echoProvider() always replies "Hello world" (the fixture's own
      // doc comment) — matching neither `notes.txt`'s real "ours"
      // (MAIN-EDIT) nor "theirs" (FEATURE-EDIT) side, so the ONE honest
      // origin this proves is 'rewritten' — proof `resolveHunkOrigin`
      // really is derived from the real hunk text, not just echoed back.
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    // A real merge, on the real isolated worktree, that really conflicts.
    const mergeResult = await execFileAsync('git', ['merge', 'feature'], {
      cwd: session.worktreePath,
    }).catch((error) => error as { stdout?: string; stderr?: string; code?: number });
    // TEMP DIAGNOSTIC for CI root-cause investigation (issue #237) — removed before merge.
    if (process.env.CI) {
      const { stdout: gitVersion } = await execFileAsync('git', ['--version']);
      const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: session.worktreePath,
      });
      const { stdout: branchList } = await execFileAsync('git', ['branch', '-a', '-v'], {
        cwd: session.worktreePath,
      });
      console.error(
        '[DIAG] gitVersion=' + gitVersion.trim(),
        '\n[DIAG] PATH=' + process.env.PATH,
        '\n[DIAG] worktreePath=' + session.worktreePath,
        '\n[DIAG] projectPath=' + projectPath,
        '\n[DIAG] headSha=' + headSha.trim(),
        '\n[DIAG] branchList=\n' + branchList,
        '\n[DIAG] mergeResult=' + JSON.stringify(mergeResult),
      );
    }
    const conflictedBefore = await readFile(path.join(session.worktreePath, 'notes.txt'), 'utf8');
    expect(conflictedBefore).toContain('<<<<<<<');
    expect(conflictedBefore).toContain('MAIN-EDIT');
    expect(conflictedBefore).toContain('FEATURE-EDIT');

    const bridge = gitConflictResolveInternals(node).bridges.get(session.id);
    if (!bridge) throw new Error('expected a live bridge right after createSession');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-git-conflict-resolve-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'notes.txt' }, key);
    phone.send({
      type: 'git_conflict_resolve_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-resolve-1',
      envelope: requestEnvelope,
    });

    const response = (await phone.waitFor(
      (m) =>
        m.type === 'git_conflict_resolve_response' &&
        (m as { requestId?: string }).requestId === 'req-resolve-1',
    )) as { type: 'git_conflict_resolve_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<GitConflictResolveResponsePayloadV1>(
      session.id,
      response.envelope,
      key,
    );

    expect(payload.outcome).toBe('ok');
    if (payload.outcome !== 'ok') return;
    expect(payload.path).toBe('notes.txt');
    expect(payload.hunks).toHaveLength(1);
    expect(payload.hunks[0]).toMatchObject({
      oursText: 'MAIN-EDIT\n',
      theirsText: 'FEATURE-EDIT\n',
    });
    expect(payload.resolution).toHaveLength(1);
    expect(payload.resolution[0]).toMatchObject({
      origin: 'rewritten',
      resolvedText: 'Hello world',
    });
    expect(payload.resolvedContent).toBe('one\nHello world\nthree\n');
    expect(payload.baseHash).toBeTruthy();

    // Nothing was written yet — the propose call is read-only (issue
    // #237's "declining leaves the file exactly as it was" acceptance,
    // proven here even before any explicit decline: simply not applying
    // is enough).
    const stillConflicted = await readFile(path.join(session.worktreePath, 'notes.txt'), 'utf8');
    expect(stillConflicted).toBe(conflictedBefore);

    // Applying is ONE deliberate action: a real fs_write_request with the
    // baseHash this proposal was computed from — issue #205's own
    // conflict-safe write, reused rather than reinvented.
    const writeEnvelope = await phoneSeal(
      session.id,
      { path: 'notes.txt', content: payload.resolvedContent, baseHash: payload.baseHash },
      key,
    );
    phone.send({
      type: 'fs_write_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      targetId: 'local',
      requestId: 'req-apply-1',
      envelope: writeEnvelope,
    });
    const writeResponse = (await phone.waitFor(
      (m) =>
        m.type === 'fs_write_response' && (m as { requestId?: string }).requestId === 'req-apply-1',
    )) as { type: 'fs_write_response'; envelope: EncryptedEnvelope };
    const writePayload = await phoneOpen<FsWriteResponsePayloadV1>(
      session.id,
      writeResponse.envelope,
      key,
    );
    expect(writePayload.outcome).toBe('ok');

    const onDiskAfterApply = await readFile(path.join(session.worktreePath, 'notes.txt'), 'utf8');
    expect(onDiskAfterApply).toBe('one\nHello world\nthree\n');
    expect(onDiskAfterApply).not.toContain('<<<<<<<');
  });

  it('declining leaves the file exactly as it was: never calling fs_write_request after a proposal means the real conflict markers are still on disk, byte for byte', async () => {
    const amk = generateAmk();
    const accountId = 'acct-git-conflict-resolve-decline';
    const projectPath = await makeConflictingProject();

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-decline',
      deviceId: 'device-node-git-conflict-resolve-decline',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });

    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    await execFileAsync('git', ['merge', 'feature'], { cwd: session.worktreePath }).catch(
      () => undefined,
    );
    const conflictedBefore = await readFile(path.join(session.worktreePath, 'notes.txt'), 'utf8');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-git-conflict-resolve-decline',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'notes.txt' }, key);
    phone.send({
      type: 'git_conflict_resolve_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-resolve-decline',
      envelope: requestEnvelope,
    });
    await phone.waitFor(
      (m) =>
        m.type === 'git_conflict_resolve_response' &&
        (m as { requestId?: string }).requestId === 'req-resolve-decline',
    );

    // The user declines: no fs_write_request is ever sent. The file must
    // be untouched.
    const onDiskAfterDecline = await readFile(path.join(session.worktreePath, 'notes.txt'), 'utf8');
    expect(onDiskAfterDecline).toBe(conflictedBefore);
    expect(onDiskAfterDecline).toContain('<<<<<<<');
  });

  it("reports outcome: 'error' honestly instead of hanging when a session has no live agent (disconnected since a restart) — the same contract git_diff_explain_request has", async () => {
    const amk = generateAmk();
    const accountId = 'acct-git-conflict-resolve-no-agent';
    const projectPath = await makeConflictingProject();

    const beforeRestart = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-2',
      deviceId: 'device-node-git-conflict-resolve-2-before',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await beforeRestart.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);
    await execFileAsync('git', ['merge', 'feature'], { cwd: session.worktreePath }).catch(
      () => undefined,
    );
    beforeRestart.close();

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-2',
      deviceId: 'device-node-git-conflict-resolve-2-after',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-git-conflict-resolve-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'notes.txt' }, key);
    phone.send({
      type: 'git_conflict_resolve_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-resolve-no-agent',
      envelope: requestEnvelope,
    });
    const response = (await phone.waitFor(
      (m) =>
        m.type === 'git_conflict_resolve_response' &&
        (m as { requestId?: string }).requestId === 'req-resolve-no-agent',
    )) as { type: 'git_conflict_resolve_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<GitConflictResolveResponsePayloadV1>(
      session.id,
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('error');
    if (payload.outcome === 'error') {
      expect(payload.message).toMatch(/no live agent/i);
    }
  });

  it("reports outcome: 'error' for a path with no conflict markers at all, without spending a real agent turn", async () => {
    const amk = generateAmk();
    const accountId = 'acct-git-conflict-resolve-clean';
    const projectPath = await mkdtemp(
      path.join(tmpdir(), 'loombox-git-conflict-resolve-clean-project-'),
    );
    await execGit(projectPath, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(projectPath, 'clean.txt'), 'nothing wrong here\n');
    await execGit(projectPath, ['add', 'clean.txt']);
    await execGit(projectPath, ['commit', '-q', '-m', 'seed']);

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-3',
      deviceId: 'device-node-git-conflict-resolve-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    const bridge = gitConflictResolveInternals(node).bridges.get(session.id);
    if (!bridge) throw new Error('expected a live bridge right after createSession');
    const promptSpy = vi.spyOn(bridge.agentSession, 'prompt');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-git-conflict-resolve-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'clean.txt' }, key);
    phone.send({
      type: 'git_conflict_resolve_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-resolve-clean',
      envelope: requestEnvelope,
    });
    const response = (await phone.waitFor(
      (m) =>
        m.type === 'git_conflict_resolve_response' &&
        (m as { requestId?: string }).requestId === 'req-resolve-clean',
    )) as { type: 'git_conflict_resolve_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<GitConflictResolveResponsePayloadV1>(
      session.id,
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('error');
    if (payload.outcome === 'error') {
      expect(payload.message).toMatch(/not currently conflicted/i);
    }
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("reports outcome: 'too_large' and spends no agent turns for a file with more conflicted hunks than the bound, rather than an unbounded number of turns from one click", async () => {
    const amk = generateAmk();
    const accountId = 'acct-git-conflict-resolve-too-large';
    const projectPath = await mkdtemp(
      path.join(tmpdir(), 'loombox-git-conflict-resolve-too-large-project-'),
    );
    await execGit(projectPath, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(projectPath, 'seed.txt'), 'seed\n');
    await execGit(projectPath, ['add', 'seed.txt']);
    await execGit(projectPath, ['commit', '-q', '-m', 'seed']);

    node = createNode({
      relayUrl: relay.url,
      stateDir: nodeStateDir,
      nodeId: 'node-git-conflict-resolve-4',
      deviceId: 'device-node-git-conflict-resolve-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const key = await derivePhoneSessionKey(amk, accountId, session.id);

    // 13 synthetic conflict hunks in one file — over the 12-hunk bound.
    // Real, well-formed marker syntax (our parser doesn't care whether
    // `git merge` produced it or a test hand-assembled it), just many of
    // them, which is the one thing worth proving here.
    const oneHunk = (n: number) =>
      `<<<<<<< HEAD\nmain-${n}\n=======\nfeature-${n}\n>>>>>>> feature\n`;
    const manyHunks = Array.from({ length: 13 }, (_, i) => oneHunk(i)).join('context\n');
    await writeFile(path.join(session.worktreePath, 'huge.txt'), manyHunks);

    const bridge = gitConflictResolveInternals(node).bridges.get(session.id);
    if (!bridge) throw new Error('expected a live bridge right after createSession');
    const promptSpy = vi.spyOn(bridge.agentSession, 'prompt');

    phone = new TestPhone(relay.url, {
      deviceId: 'device-phone-git-conflict-resolve-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await phone.ready;
    phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phone.waitFor((m) => m.type === 'session_announce');

    const requestEnvelope = await phoneSeal(session.id, { path: 'huge.txt' }, key);
    phone.send({
      type: 'git_conflict_resolve_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-resolve-huge',
      envelope: requestEnvelope,
    });
    const response = (await phone.waitFor(
      (m) =>
        m.type === 'git_conflict_resolve_response' &&
        (m as { requestId?: string }).requestId === 'req-resolve-huge',
    )) as { type: 'git_conflict_resolve_response'; envelope: EncryptedEnvelope };
    const payload = await phoneOpen<GitConflictResolveResponsePayloadV1>(
      session.id,
      response.envelope,
      key,
    );
    expect(payload.outcome).toBe('too_large');
    if (payload.outcome === 'too_large') {
      expect(payload.hunkCount).toBe(13);
      expect(payload.maxHunks).toBe(12);
    }
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
