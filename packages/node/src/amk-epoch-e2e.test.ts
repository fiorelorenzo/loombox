import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  deriveSessionKey,
  encryptEnvelope,
  envelopeToWire,
  exportPublicKeyRaw,
  generateAmk,
  generateAmkEpoch,
  generateEcdhKeyPair,
  wrapAmkEpochForDevice,
} from '@loombox/crypto';

import { wireAmkEpochAdoption, type AmkEpochIdentity } from './amk-epoch';
import { createNode, type NodeDaemon } from './node-daemon';

const execFileAsync = promisify(execFile);

type CryptoKey = webcrypto.CryptoKey;

// Same hermetic fixture agent every other package's tests exercise (not a real `claude` binary).
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

function echoProvider(): AcpProvider {
  return {
    id: 'test-echo',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A minimal encrypted-PWA-like client over the global WebSocket, speaking the v1 handshake — same shape node-daemon.test.ts's own `TestPhone` uses. */
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

  count(predicate: (message: WireMessageV1) => boolean): number {
    return this.messages.filter(predicate).length;
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
  return new Promise((resolve) => node.once('connected', resolve));
}

let relay: StartedRelay;
let projectPath: string;
let node: NodeDaemon | undefined;
let phones: TestPhone[] = [];

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-amk-epoch-e2e-test-'));
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
  for (const phone of phones) phone.close();
  node = undefined;
  phones = [];
  await rm(projectPath, { recursive: true, force: true });
  await relay.close();
});

describe('AMK epoch rotation end to end (SPEC §8, issue #116): a surviving node adopts a revoke on reconnect', () => {
  it('fetches, unwraps and adopts the new epoch, then operates on it going forward — while the old (pre-revoke) AMK can no longer decrypt', async () => {
    const accountId = 'acct-revoke-e2e';
    const originalAmk = generateAmk();

    // The surviving node's own device identity (real ECDH keys — this test
    // exercises the actual crypto, not a placeholder public key like most
    // other node-daemon tests use for `devicePublicKey`).
    const survivorKeyPair = await generateEcdhKeyPair();
    const survivorIdentity: AmkEpochIdentity = { keyPair: survivorKeyPair };
    const survivorPublicKeyRaw = await exportPublicKeyRaw(survivorKeyPair.publicKey);
    const survivorPublicKeyBase64 = toBase64(survivorPublicKeyRaw);

    // The acting (already-unlocked, online) device that performs the revoke.
    const actingKeyPair = await generateEcdhKeyPair();
    const actingPublicKeyBase64 = toBase64(await exportPublicKeyRaw(actingKeyPair.publicKey));

    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-survivor',
      deviceId: 'device-survivor',
      devicePublicKey: survivorPublicKeyBase64,
      authToken: accountId,
      accountId,
      amk: originalAmk,
      amkEpoch: 0,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    const unwireAdoption = wireAmkEpochAdoption(
      node,
      survivorIdentity,
      accountId,
      'device-survivor',
    );
    await waitForConnected(node);
    expect(node.currentAmkEpoch).toBe(0);

    // The acting device and the device being revoked both need to be
    // registered in the account's device registry first (the relay's
    // `device_revoke` handler requires the target to already be known).
    const acting = new TestPhone(relay.url, {
      deviceId: 'device-acting',
      devicePublicKey: actingPublicKeyBase64,
      authToken: accountId,
    });
    phones.push(acting);
    await acting.ready;
    const revoked = new TestPhone(relay.url, {
      deviceId: 'device-revoked',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phones.push(revoked);
    await revoked.ready;

    // The acting device mints a fresh epoch and ECDH-wraps it for the
    // survivor's already-known public key (SPEC §8 wrap-fan-out) — real
    // `@loombox/crypto` calls, not a stub.
    const newAmk = generateAmkEpoch();
    const envelope = await wrapAmkEpochForDevice({
      newAmk,
      epoch: 1,
      accountId,
      targetDeviceId: 'device-survivor',
      actingPrivateKey: actingKeyPair.privateKey,
      targetDevicePublicKeyRaw: survivorPublicKeyRaw,
    });

    acting.send({
      type: 'device_revoke',
      protocolVersion: PROTOCOL_V1,
      deviceId: 'device-revoked',
      newEpoch: 1,
      rewrappedAmk: [{ deviceId: 'device-survivor', envelope: envelopeToWire(envelope) }],
    });
    // Let the relay process the revoke (persist the pending envelope,
    // bump the epoch, close the revoked device) before forcing a reconnect.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // SPEC §8: delivery is "on next connect" — force the survivor node to
    // reconnect, which is when it re-sends `amk_epoch_fetch_request`.
    const adopted = new Promise<{ epoch: number }>((resolve) =>
      node!.once('amk-epoch-adopted', resolve),
    );
    node.simulateRelayDrop();
    const adoptedEvent = await adopted;
    expect(adoptedEvent.epoch).toBe(1);
    expect(node.currentAmkEpoch).toBe(1);
    unwireAdoption();

    // A session created *after* rotation is keyed off the newly-adopted
    // epoch: a phone deriving the session key from the NEW AMK completes a
    // normal round trip...
    const session = await node.createSession({ projectPath, provider: 'test-echo' });
    const keyNew = await deriveSessionKey(newAmk, accountId, session.id);

    const phoneNew = new TestPhone(relay.url, {
      deviceId: 'device-phone-new',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phones.push(phoneNew);
    await phoneNew.ready;
    phoneNew.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phoneNew.waitFor((m) => m.type === 'session_announce');

    async function sealPrompt(key: CryptoKey): Promise<EncryptedEnvelope> {
      const plaintext = new TextEncoder().encode(JSON.stringify({ text: 'hello after rotation' }));
      const sealed = await encryptEnvelope(session.id, plaintext, key);
      return {
        resourceId: sealed.resourceId,
        iv: toBase64(sealed.iv),
        ciphertext: toBase64(sealed.ciphertext),
        alg: 'AES-256-GCM',
      };
    }

    phoneNew.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-new-epoch',
      envelope: await sealPrompt(keyNew),
    });
    await phoneNew.waitFor(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );

    // ...while a phone that only ever held the OLD (pre-revoke) AMK — what a
    // revoked device would still be stuck with — derives a *different* key
    // for this same session and fails to decrypt: the prompt never reaches
    // the agent, logged rather than silently accepted.
    const keyOld = await deriveSessionKey(originalAmk, accountId, session.id);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const phoneOld = new TestPhone(relay.url, {
      deviceId: 'device-phone-old',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phones.push(phoneOld);
    await phoneOld.ready;
    phoneOld.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
    await phoneOld.waitFor((m) => m.type === 'session_announce');

    const updatesBeforeOldPrompt = phoneNew.count(
      (m) => m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
    );
    phoneOld.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      promptId: 'prompt-old-epoch',
      envelope: await sealPrompt(keyOld),
    });

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to handle prompt_inject'),
      ),
    );
    // No new session_update was produced for the old-AMK-sealed prompt.
    expect(
      phoneNew.count(
        (m) =>
          m.type === 'session_update' && (m as SessionUpdateEnvelopeV1).sessionId === session.id,
      ),
    ).toBe(updatesBeforeOldPrompt);

    warnSpy.mockRestore();
  });
});

describe('NodeDaemon AMK epoch adoption edge cases (#116)', () => {
  it('adoptAmkEpoch is a no-op for an epoch that is not strictly ahead of the current one', async () => {
    const accountId = 'acct-adopt-noop';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-noop',
      deviceId: 'device-noop',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      amkEpoch: 3,
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);
    expect(node.currentAmkEpoch).toBe(3);

    // Same epoch: rejected.
    expect(node.adoptAmkEpoch(generateAmk(), 3)).toBe(false);
    expect(node.currentAmkEpoch).toBe(3);

    // Behind: rejected.
    expect(node.adoptAmkEpoch(generateAmk(), 2)).toBe(false);
    expect(node.currentAmkEpoch).toBe(3);

    // Strictly ahead: accepted.
    expect(node.adoptAmkEpoch(generateAmk(), 4)).toBe(true);
    expect(node.currentAmkEpoch).toBe(4);
  });

  it('revokeDevice sends a well-formed device_revoke that the relay actually applies (epoch bump, wrap-fan-out, revoked-device close)', async () => {
    const accountId = 'acct-revoke-method';
    node = createNode({
      relayUrl: relay.url,
      nodeId: 'node-actor',
      deviceId: 'device-actor-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      accountId,
      amk: generateAmk(),
      supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    });
    await waitForConnected(node);

    const victim = new TestPhone(relay.url, {
      deviceId: 'device-victim-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phones.push(victim);
    await victim.ready;
    const survivor = new TestPhone(relay.url, {
      deviceId: 'device-survivor-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    phones.push(survivor);
    await survivor.ready;

    const pendingEnvelope: EncryptedEnvelope = {
      resourceId: 'loombox-amk-rotation-v1:acct-revoke-method:device-survivor-3:1',
      iv: randomBase64(12),
      ciphertext: randomBase64(32),
      alg: 'AES-256-GCM',
    };
    node.revokeDevice('device-victim-3', 1, [
      { deviceId: 'device-survivor-3', envelope: pendingEnvelope },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    survivor.send({
      type: 'amk_epoch_fetch_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: 'device-survivor-3',
    });
    const response = await survivor.waitFor((m) => m.type === 'amk_epoch_fetch_response');
    expect(response).toMatchObject({
      type: 'amk_epoch_fetch_response',
      deviceId: 'device-survivor-3',
      pending: { epoch: 1, fromDeviceId: 'device-actor-3', envelope: pendingEnvelope },
    });
  });
});
