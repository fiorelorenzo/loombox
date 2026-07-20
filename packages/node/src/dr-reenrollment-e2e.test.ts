import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type NewDeviceBootstrapResponse,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import { createInMemoryRelayStore, startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  deriveSessionKey,
  encryptEnvelope,
  generateAmk,
  generateRecoveryCode,
  openJson,
  packWrappedAmkForWire,
  unpackWrappedAmkFromWire,
  unwrapAmkWithRecoveryCode,
  wrapAmkWithRecoveryCode,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';

const execFileAsync = promisify(execFile);

/**
 * Disaster-recovery re-enrollment (SPEC §8, §14; issue #117): if the relay's
 * data is wiped/rebuilt, existing nodes and clients re-enroll from their own
 * keypairs plus a fresh AMK-escrow round trip, and at no point does the
 * server hold plaintext of the AMK or of session content.
 *
 * Modeled here exactly as SPEC §8 describes the "relay rebuilt" case: a
 * second, completely independent relay instance with a fresh, empty
 * in-memory store (no device registry, no escrow, no leases carried over) —
 * see `relay.ts`'s `createInMemoryRelayStore`/`startRelay({ store })` doc
 * comments, which is the same seam `store-postgres.test.ts` uses to swap
 * backends. Hermetic: no Docker, no real Postgres, no real Claude binary
 * (same fixture ACP agent every other node package e2e test in this repo
 * uses).
 */

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

/** Same minimal encrypted-PWA-like test client the other node e2e tests use (`amk-epoch-e2e.test.ts`'s `TestPhone`), duplicated here rather than shared so this file stays a single self-contained test-only unit. */
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

function waitForConnected(node: NodeDaemon): Promise<void> {
  return new Promise((resolve) => node.once('connected', resolve));
}

let relayA: StartedRelay | undefined;
let relayB: StartedRelay | undefined;
let projectPath: string;
let nodeA: NodeDaemon | undefined;
let nodeB: NodeDaemon | undefined;
let phones: TestPhone[] = [];

beforeEach(async () => {
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-dr-reenrollment-test-'));
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
  nodeA?.close();
  nodeB?.close();
  for (const phone of phones) phone.close();
  nodeA = undefined;
  nodeB = undefined;
  phones = [];
  await rm(projectPath, { recursive: true, force: true });
  await relayA?.close();
  await relayB?.close();
  relayA = undefined;
  relayB = undefined;
});

describe('relay-rebuild re-enrollment disaster recovery (SPEC §8, §14; issue #117)', () => {
  it(
    'after the relay is wiped and rebuilt from zero, a node and a recovering device re-enroll from their ' +
      'own keypair plus a fresh Recovery-Code AMK-escrow round trip, recover the exact same AMK, and complete ' +
      'a real encrypted session round trip on it — while the relay never held plaintext of the AMK, the ' +
      'Recovery Code, or session content at any point',
    async () => {
      const accountId = 'acct-dr-reenrollment';
      const originalAmk = generateAmk();
      const recoveryCode = generateRecoveryCode();

      const nodeDeviceId = 'device-node-dr';
      const nodeDevicePublicKey = randomBase64();
      const survivingDeviceId = 'device-survivor-dr';
      const survivingDevicePublicKey = randomBase64();

      // --- Relay A: the pre-disaster deployment. -----------------------
      const storeA = createInMemoryRelayStore();
      relayA = await startRelay({ store: storeA });

      nodeA = createNode({
        relayUrl: relayA.url,
        nodeId: 'node-dr',
        deviceId: nodeDeviceId,
        devicePublicKey: nodeDevicePublicKey,
        authToken: accountId,
        accountId,
        amk: originalAmk,
        amkEpoch: 0,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      await waitForConnected(nodeA);

      const survivor = new TestPhone(relayA.url, {
        deviceId: survivingDeviceId,
        devicePublicKey: survivingDevicePublicKey,
        authToken: accountId,
      });
      phones.push(survivor);
      await survivor.ready;

      // Escrows the AMK under the Recovery Code (SPEC §8 path 2, #114/#115)
      // so a device with only OAuth identity + the code can bootstrap.
      const escrowBlobA = await wrapAmkWithRecoveryCode(originalAmk, recoveryCode, accountId);
      survivor.send({
        type: 'amk_escrow',
        protocolVersion: PROTOCOL_V1,
        wrappedAmk: packWrappedAmkForWire(escrowBlobA),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Sanity: relay A really did receive and store *something* under this
      // account before it gets wiped below.
      expect(storeA.escrow.get(accountId)).toBeDefined();

      // --- The relay is wiped/rebuilt: a brand new instance, brand new, --
      // --- completely empty store. No device registry, no escrow, no ----
      // --- leases survive — `relayA`'s store is never touched again. ----
      await relayA.close();
      const storeB = createInMemoryRelayStore();
      relayB = await startRelay({ store: storeB });

      // The account has never escrowed anything against relay B yet.
      expect(storeB.escrow.get(accountId)).toBeUndefined();

      // --- Re-enrollment: the node reconnects to the rebuilt relay using --
      // --- its own existing keypair/identity and its own locally-held ----
      // --- AMK (never lost — it lived on the node's own device, not on --
      // --- the relay). This is a fresh `NodeDaemon`/connection since the --
      // --- old relay process is gone; the `initialize` handshake itself --
      // --- re-registers the device into relay B's fresh registry.
      nodeB = createNode({
        relayUrl: relayB.url,
        nodeId: 'node-dr',
        deviceId: nodeDeviceId,
        devicePublicKey: nodeDevicePublicKey,
        authToken: accountId,
        accountId,
        amk: originalAmk,
        amkEpoch: 0,
        supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
      });
      await waitForConnected(nodeB);
      expect(storeB.devices.get(nodeDeviceId)?.accountId).toBe(accountId);

      // The already-AMK-holding device re-registers too and re-escrows a
      // *fresh* wrapped blob against the rebuilt relay (SPEC §8: "a fresh
      // AMK-escrow round trip") — a new salt/iv every time, per
      // `wrapAmkWithRecoveryCode`'s own doc comment.
      const survivorAfter = new TestPhone(relayB.url, {
        deviceId: survivingDeviceId,
        devicePublicKey: survivingDevicePublicKey,
        authToken: accountId,
      });
      phones.push(survivorAfter);
      await survivorAfter.ready;

      const escrowBlobB = await wrapAmkWithRecoveryCode(originalAmk, recoveryCode, accountId);
      survivorAfter.send({
        type: 'amk_escrow',
        protocolVersion: PROTOCOL_V1,
        wrappedAmk: packWrappedAmkForWire(escrowBlobB),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // A genuinely new/recovering device — proven identity via this
      // connection's OAuth-style handshake alone, holding no AMK of its
      // own, only the Recovery Code a human transcribed — bootstraps from
      // the rebuilt relay with zero prior server-side history for it.
      const recoveringDeviceId = 'device-recovering-dr';
      const recovering = new TestPhone(relayB.url, {
        deviceId: recoveringDeviceId,
        devicePublicKey: randomBase64(),
        authToken: accountId,
      });
      phones.push(recovering);
      await recovering.ready;

      recovering.send({
        type: 'new_device_bootstrap_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: recoveringDeviceId,
        devicePublicKey: randomBase64(),
      });
      const bootstrapResponse = (await recovering.waitFor(
        (m) => m.type === 'new_device_bootstrap_response',
      )) as NewDeviceBootstrapResponse;
      const wrappedAmkWire = bootstrapResponse.wrappedAmk;

      const recoveredAmk = await unwrapAmkWithRecoveryCode(
        unpackWrappedAmkFromWire(wrappedAmkWire),
        recoveryCode,
        accountId,
      );

      // The whole point: the AMK recovered post-rebuild is byte-identical
      // to the original, pre-disaster AMK.
      expect(toBase64(recoveredAmk)).toBe(toBase64(originalAmk));

      // --- No relay-visible value ever held the AMK or the Recovery Code --
      // --- in the clear, at any point in either relay instance. ----------
      for (const store of [storeA, storeB]) {
        const stored = store.escrow.get(accountId);
        if (stored === undefined) continue;
        const storedBytes = Buffer.from(stored, 'base64');
        // Not the AMK itself, byte for byte...
        expect(Buffer.compare(storedBytes, Buffer.from(originalAmk))).not.toBe(0);
        // ...and not merely differently-encoded plaintext either: it only
        // ever unwraps with the correct Recovery Code (an AEAD tag check,
        // per `unwrapAmkWithRecoveryCode`'s doc comment) — a wrong code
        // rejects outright rather than returning garbage that happens to
        // look different.
        await expect(
          unwrapAmkWithRecoveryCode(
            unpackWrappedAmkFromWire(stored),
            generateRecoveryCode(),
            accountId,
          ),
        ).rejects.toThrow();
      }

      // --- End-to-end proof: the recovering device's freshly-recovered ---
      // --- AMK actually decrypts real session content produced on the ----
      // --- rebuilt relay, and that content never touched relay B's store --
      // --- in the clear. -------------------------------------------------
      const session = await nodeB.createSession({ projectPath, provider: 'test-echo' });
      const sessionKeyFromRecovered = await deriveSessionKey(recoveredAmk, accountId, session.id);
      const sessionKeyFromOriginal = await deriveSessionKey(originalAmk, accountId, session.id);

      recovering.send({
        type: 'session_resume',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
      });
      await recovering.waitFor((m) => m.type === 'session_announce');

      const promptPlaintext = 'hello after disaster recovery';
      const sealedPrompt = await encryptEnvelope(
        session.id,
        new TextEncoder().encode(JSON.stringify({ text: promptPlaintext })),
        sessionKeyFromRecovered,
      );
      const promptEnvelope: EncryptedEnvelope = {
        resourceId: sealedPrompt.resourceId,
        iv: toBase64(sealedPrompt.iv),
        ciphertext: toBase64(sealedPrompt.ciphertext),
        alg: 'AES-256-GCM',
      };

      recovering.send({
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        promptId: 'prompt-dr-1',
        envelope: promptEnvelope,
      });

      // The fixture agent (`echo-acp-agent.mjs`) streams several
      // `session_update` events per turn (turn-started status, two text
      // chunks, turn-ended) — poll until the one carrying its actual reply
      // text shows up, decrypting each with the key derived from the
      // *original* (pre-disaster) AMK: the recovered key and the original
      // key are, in fact, the same key (not just two keys that happen to
      // both decrypt something), so whatever the node freshly encrypts
      // under the recovered-AMK-derived key must still open under this one.
      async function waitForDecryptedReply(): Promise<void> {
        const deadline = Date.now() + 10000;
        for (;;) {
          const updates = recovering.messages.filter(
            (m): m is SessionUpdateEnvelopeV1 =>
              m.type === 'session_update' && m.sessionId === session.id,
          );
          for (const candidate of updates) {
            const decrypted = await openJson<unknown>(
              session.id,
              candidate.envelope,
              sessionKeyFromOriginal,
            );
            if (JSON.stringify(decrypted).includes('Hello')) return;
          }
          if (Date.now() > deadline) {
            throw new Error('timed out waiting for a decryptable "Hello" session_update');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await waitForDecryptedReply();

      // Relay B's own resync ring — the durable server-side record of this
      // exact update — holds only ciphertext: decoding its base64 bytes as
      // UTF-8 must never surface the agent's actual reply text nor the
      // prompt's plaintext.
      const ringEntries = storeB.sessions.getEntriesSince(session.id, 0).entries;
      expect(ringEntries.length).toBeGreaterThan(0);
      for (const entry of ringEntries) {
        const ciphertextBytes = Buffer.from(entry.envelope.ciphertext, 'base64').toString('latin1');
        expect(ciphertextBytes).not.toContain('Hello');
        expect(ciphertextBytes).not.toContain(promptPlaintext);
      }
    },
  );
});
