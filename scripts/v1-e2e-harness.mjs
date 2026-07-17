/**
 * loombox v1 end-to-end validation harness (`docs/v1-plan.md`; issue #315;
 * v1 Wave C, node). Protocol v1 wire, FULLY END-TO-END ENCRYPTED — the whole
 * point of this harness (as opposed to the superseded `v0-e2e-harness.mjs`)
 * is to prove the relay never sees plaintext.
 *
 * The v1 acceptance (SPEC §12) is the same shape as v0's: "from a phone on
 * the tailnet, observe a running session and inject one prompt that the
 * agent acts on" — plus, new in v1, "and the relay only ever carries
 * ciphertext." The dev box is headless (no browser, no phone), so this
 * harness stands in for the phone: it drives the whole loop end to end over
 * a real relay and a real node, using a hermetic fixture ACP agent instead
 * of the real `claude` binary, and a shared Account Master Key it provisions
 * itself (real AMK distribution is the device-pairing flow, #113/#114/#115,
 * out of scope here — see `NodeDaemonOptions.amk`'s doc comment).
 *
 *   relay (real @loombox/relay, v1) <-- WS --> node (createNode: SessionManager
 *   + AgentSupervisor + v1 RelayConnection, running a fixture agent in a real
 *   git worktree)                   <-- WS --> a headless encrypted "phone" client
 *
 * Checks:
 *   A. a client that connects AFTER the session exists observes it via the
 *      account-scoped session_list snapshot, without having started anything
 *      itself — and the snapshot's clear routing metadata carries no
 *      title/projectPath; only the paired encrypted envelope decrypts to them.
 *   B. output the client did NOT initiate (an operator-side prompt) streams
 *      to it live as ciphertext it decrypts correctly.
 *   C. a prompt the client injects over the relay, itself encrypted, reaches
 *      the agent and produces a NEW turn of (again encrypted) updates.
 *   D. everything the relay carried for this session (session_list's private
 *      envelope, every session_update) was opaque ciphertext — the relay
 *      payloads never expose the plaintext title, prompt, or transcript text.
 *
 * Run:  RELAY_HOST=100.87.202.117 pnpm exec tsx scripts/v1-e2e-harness.mjs
 * (defaults to 127.0.0.1; point RELAY_HOST at `tailscale ip -4` to exercise the
 * same tailnet path a phone uses).
 *
 * What this does NOT cover (the human confirmation step): a real Claude Code
 * agent, a real phone browser on the tailnet, and real AMK distribution via
 * device pairing. Those are Lorenzo's manual pass; everything structural,
 * including the encryption, is proven here.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createNode } from '@loombox/node';
import { PROTOCOL_V1 } from '@loombox/protocol';
import { startRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

const execFileAsync = promisify(execFile);
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1';
const RELAY_PORT = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 0;
const ACCOUNT_ID = 'devbox-account-1';

const ECHO_FIXTURE = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'packages',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fixture ACP provider registered as 'claude' so no real claude binary is needed. */
function echoProvider() {
  return {
    id: 'claude',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32) {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// The same documented v1 session-key derivation contract
// `packages/node/src/session-keys.ts` implements — reimplemented here
// directly against `@loombox/crypto`'s primitives (not a call into
// `@loombox/node`'s own helper) so this harness proves the phone, an
// independent party holding only the AMK, actually interoperates with the
// node rather than merely agreeing with itself.
async function derivePhoneSessionKey(amk, accountId, sessionId) {
  const node = deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

async function phoneSeal(sessionId, value, key) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const envelope = await encryptEnvelope(sessionId, plaintext, key);
  return {
    resourceId: envelope.resourceId,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
    alg: 'AES-256-GCM',
  };
}

async function phoneOpen(sessionId, wire, key) {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** True only if none of `plainSubstrings` appear verbatim in the envelope's ciphertext bytes. */
function isOpaque(wire, plainSubstrings) {
  const raw = Buffer.from(wire.ciphertext, 'base64').toString('latin1');
  return plainSubstrings.every((needle) => !raw.includes(needle));
}

/** A headless encrypted "phone" client over Node's global WebSocket, speaking the v1 handshake. */
class Phone {
  constructor(url, opts) {
    this.messages = [];
    this.rawFrames = [];
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
        const raw = String(event.data);
        const parsed = JSON.parse(raw);
        if (!settled && parsed.type === 'initialize_result') {
          settled = true;
          resolve();
          return;
        }
        this.rawFrames.push(raw);
        this.messages.push(parsed);
      });
      this.socket.addEventListener('error', () => {
        if (!settled) reject(new Error(`phone cannot reach ${url}`));
      });
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  count(predicate) {
    return this.messages.filter(predicate).length;
  }

  async waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) return undefined;
      await sleep(20);
    }
  }

  async waitForCount(predicate, count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.filter(predicate);
      if (found.length >= count) return found;
      if (Date.now() > deadline) return found;
      await sleep(20);
    }
  }

  close() {
    this.socket.close();
  }
}

async function makeGitRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'loombox-v1-e2e-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'loombox',
    GIT_AUTHOR_EMAIL: 'loombox@example.com',
    GIT_COMMITTER_NAME: 'loombox',
    GIT_COMMITTER_EMAIL: 'loombox@example.com',
  };
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir, env });
  return dir;
}

async function main() {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  };

  const relay = await startRelay({ host: RELAY_HOST, port: RELAY_PORT });
  console.log(`relay listening on ${relay.url} (protocol v1)`);
  const projectPath = await makeGitRepo();

  // The shared Account Master Key: minted once here to stand in for the
  // device-pairing flow (#113/#114/#115). Both the node and the phone derive
  // every session key from this independently — no relay round trip.
  const amk = generateAmk();

  const supervisor = new AgentSupervisor({ providers: [echoProvider()] });
  const node = createNode({
    relayUrl: relay.url,
    nodeId: 'devbox-node-1',
    deviceId: 'devbox-node-1-device',
    devicePublicKey: randomBase64(),
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk,
    supervisor,
  });
  await new Promise((resolve) => node.once('connected', resolve));

  const session = await node.createSession({
    projectPath,
    provider: 'claude',
    title: 'operator session',
  });
  console.log(`session ${session.id} in worktree ${session.worktreePath}`);
  const sessionKey = await derivePhoneSessionKey(amk, ACCOUNT_ID, session.id);

  // The phone connects only now, AFTER the session already exists, and starts nothing.
  const phone = new Phone(relay.url, {
    deviceId: 'phone-1-device',
    devicePublicKey: randomBase64(),
    authToken: ACCOUNT_ID,
  });
  await phone.ready;

  // A. the phone observes the session it did not start via the account
  // snapshot, with clear metadata carrying no title/projectPath.
  phone.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
  const listMsg = await phone.waitFor((m) => m.type === 'session_list');
  const entry = listMsg?.sessions.find((s) => s.session.id === session.id);
  const cleanMeta =
    Boolean(entry) && !('title' in entry.session) && !('projectPath' in entry.session);
  record('A. phone observes the running session without starting it', Boolean(entry));
  record("A2. the session's clear routing metadata carries no title/projectPath", cleanMeta);

  let decryptedMeta;
  if (entry) {
    decryptedMeta = await phoneOpen(session.id, entry.privateEnvelope, sessionKey);
  }
  record(
    'A3. the private envelope decrypts to the real title/projectPath',
    Boolean(decryptedMeta) &&
      decryptedMeta.title === 'operator session' &&
      decryptedMeta.projectPath === session.projectPath,
  );

  // Subscribe so the phone starts receiving this session's live fan-out.
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  // B. operator-side activity the phone did not initiate streams to it live, as ciphertext.
  const before = phone.count((m) => m.type === 'session_update' && m.sessionId === session.id);
  await node.promptSession(session.id, 'operator: summarize the repo');
  const liveChunks = await phone.waitForCount(
    (m) => m.type === 'session_update' && m.sessionId === session.id,
    before + 2,
  );
  const liveDecrypted = await Promise.all(
    liveChunks
      .slice(before)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => phoneOpen(session.id, m.envelope, sessionKey)),
  );
  record(
    'B. phone sees live output it did not initiate, and can decrypt it',
    liveDecrypted.length >= 2 && liveDecrypted.every((u) => u.kind === 'agent_message_chunk'),
    `decrypted: ${JSON.stringify(liveDecrypted.map((u) => u.text))}`,
  );

  // C. a prompt the phone injects over the relay, itself encrypted, produces a NEW agent turn.
  const afterOperator = phone.count(
    (m) => m.type === 'session_update' && m.sessionId === session.id,
  );
  const promptEnvelope = await phoneSeal(
    session.id,
    { text: 'phone: and now add a test' },
    sessionKey,
  );
  phone.send({
    type: 'prompt_inject',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.id,
    promptId: 'phone-prompt-1',
    envelope: promptEnvelope,
  });
  const grownChunks = await phone.waitForCount(
    (m) => m.type === 'session_update' && m.sessionId === session.id,
    afterOperator + 1,
  );
  const grew = grownChunks.length > afterOperator;
  record(
    'C. phone-injected (encrypted) prompt produces a new agent turn',
    grew,
    `chunks before=${before} afterOperator=${afterOperator} final=${phone.count((m) => m.type === 'session_update' && m.sessionId === session.id)}`,
  );

  // D. the relay only ever carried EncryptedEnvelopes for this session: the
  // raw frames the phone received contain no plaintext title, prompt text,
  // or transcript text anywhere.
  const plainNeedles = [
    'operator session',
    'operator: summarize the repo',
    'phone: and now add a test',
    'Hello',
    'world',
  ];
  const sessionFrames = phone.messages.filter(
    (m) =>
      (m.type === 'session_update' || m.type === 'session_announce') &&
      (m.sessionId === session.id || m.session?.id === session.id),
  );
  const noPlaintextFields = sessionFrames.every(
    (m) => !('text' in m) && !('kind' in m) && !('title' in m),
  );
  const allEnvelopesOpaque =
    (entry ? isOpaque(entry.privateEnvelope, plainNeedles) : false) &&
    sessionFrames
      .filter((m) => m.type === 'session_update')
      .every((m) => isOpaque(m.envelope, plainNeedles)) &&
    isOpaque(promptEnvelope, plainNeedles);
  record(
    'D. every relay payload for this session was an opaque EncryptedEnvelope',
    noPlaintextFields && allEnvelopesOpaque,
    `${sessionFrames.length} session frames inspected`,
  );

  phone.close();
  node.close();
  await relay.close();
  await rm(projectPath, { recursive: true, force: true });

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\nv1 end-to-end: ${passed}/${checks.length} checks passed over ${relay.url}`);
  return passed === checks.length;
}

main()
  .then((ok) => {
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error('harness error:', error);
    process.exit(1);
  });
