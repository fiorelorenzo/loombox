import { execFile } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcpProvider } from '@loombox/providers-core';
import { PROTOCOL_V1, type EncryptedEnvelope, type WireMessageV1 } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';
import { AgentSupervisor, defaultPtySpawn, TerminalSupervisor } from '@loombox/supervisor';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  importAesGcmKey,
} from '@loombox/crypto';

import { createNode, type NodeDaemon } from './node-daemon';
import { PermissionPolicyStore } from './permission-policy-store';
import type { PermissionPolicy } from './permission-policy';

type CryptoKey = webcrypto.CryptoKey;

const execFileAsync = promisify(execFile);

/**
 * The full wire-level proof for SPEC §7.17/issue #256's "central test":
 * a real relay, a real encrypted session, a real `terminal_open`/
 * `terminal_input` round trip driving a REAL local `bash` PTY through
 * `NodeDaemon.openTerminalForBridge`'s actual policy wiring — not
 * `PolicyEnforcedPty` unit-tested in isolation (see
 * `policy-enforced-pty.test.ts` for that), and not a mock of the matcher.
 * Harness duplicated from `node-daemon.test.ts` (this package's own
 * established per-file convention — see e.g.
 * `node-daemon-target-providers.test.ts`'s identical note) rather than
 * shared, so this file stays self-contained.
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
      if (Date.now() > deadline)
        throw new Error('TestPhone: timed out waiting for a matching message');
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

async function waitForTerminalOutputContains(
  phone: TestPhone,
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
  substring: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = phone.messages.filter(
      (m): m is Extract<WireMessageV1, { type: 'terminal_output' }> =>
        m.type === 'terminal_output' && m.sessionId === sessionId && m.terminalId === terminalId,
    );
    const chunks = await Promise.all(
      candidates.map((m) => phoneOpen<{ data: string }>(sessionId, m.envelope, key)),
    );
    const text = chunks.map((c) => Buffer.from(fromBase64(c.data)).toString('utf8')).join('');
    if (text.includes(substring)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForTerminalOutputContains: timed out waiting for ${JSON.stringify(substring)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Real hermetic bash (issue #503), matching `node-daemon.test.ts`'s own `hermeticTerminalSupervisor()`. */
function hermeticTerminalSupervisor(): TerminalSupervisor {
  return new TerminalSupervisor({
    spawnPty: (options) =>
      defaultPtySpawn({ ...options, args: [...(options.args ?? []), '--noprofile', '--norc'] }),
  });
}

let relay: StartedRelay;
let projectPath: string;
let nodeStateDir: string;
let node: NodeDaemon | undefined;
let phone: TestPhone | undefined;

beforeEach(async () => {
  relay = await startRelay();
  projectPath = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-permission-policy-test-'));
  nodeStateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-daemon-permission-policy-state-'));
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

async function openTerminalOverTheWire(options: {
  policy?: PermissionPolicy;
}): Promise<{ sessionId: string; key: CryptoKey; terminalId: string }> {
  const permissionPolicyStore = new PermissionPolicyStore({ stateDir: nodeStateDir });
  const amk = generateAmk();
  const accountId = 'acct-permission-policy';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-permission-policy',
    deviceId: 'device-node-permission-policy',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    terminalSupervisor: hermeticTerminalSupervisor(),
    permissionPolicyStore,
  });

  const session = await node.createSession({ projectPath, provider: 'test-echo' });
  if (options.policy) permissionPolicyStore.save(projectPath, options.policy);
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-permission-policy',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  const terminalId = 'term-1';
  const openEnvelope = await phoneSeal(session.id, { cols: 80, rows: 24 }, key);
  phone.send({
    type: 'terminal_open',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.id,
    targetId: 'local',
    terminalId,
    requestId: 'req-open-1',
    envelope: openEnvelope,
  });
  await phone.waitFor(
    (m) => m.type === 'terminal_opened' && (m as { requestId?: string }).requestId === 'req-open-1',
  );

  return { sessionId: session.id, key, terminalId };
}

async function typeIntoTerminal(
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
  text: string,
): Promise<void> {
  const envelope = await phoneSeal(
    sessionId,
    { data: toBase64(new TextEncoder().encode(text)) },
    key,
  );
  phone!.send({
    type: 'terminal_input',
    protocolVersion: PROTOCOL_V1,
    sessionId,
    terminalId,
    envelope,
  });
}

describe('NodeDaemon permission policy — real terminal, real bash, real relay (SPEC §7.17; issue #256)', () => {
  it(
    'a command matching a deny rule never runs on the real shell, even though nothing called session/request_permission — a rejection reaches the client over terminal_output',
    { retry: 0, timeout: 20000 },
    async () => {
      const marker = path.join(projectPath, 'marker');
      const { sessionId, key, terminalId } = await openTerminalOverTheWire({
        policy: { command: { allow: [], deny: ['touch *'] }, network: { allow: [], deny: [] } },
      });

      await typeIntoTerminal(sessionId, terminalId, key, `touch ${marker}\n`);
      await waitForTerminalOutputContains(
        phone!,
        sessionId,
        terminalId,
        key,
        'blocked by permission policy',
      );

      expect(existsSync(marker)).toBe(false);
    },
  );

  it(
    'an allowed command still runs for real over the same wire path',
    { retry: 0, timeout: 20000 },
    async () => {
      const { sessionId, key, terminalId } = await openTerminalOverTheWire({
        policy: { command: { allow: [], deny: ['rm *'] }, network: { allow: [], deny: [] } },
      });

      await typeIntoTerminal(sessionId, terminalId, key, 'echo hello-wire-pty\n');
      await waitForTerminalOutputContains(phone!, sessionId, terminalId, key, 'hello-wire-pty');
    },
  );

  it(
    "a saved policy is looked up by the terminal's own session projectPath — a project with no saved policy behaves like today (allow-all)",
    { retry: 0, timeout: 20000 },
    async () => {
      const marker = path.join(projectPath, 'marker');
      const { sessionId, key, terminalId } = await openTerminalOverTheWire({}); // no policy saved at all

      await typeIntoTerminal(sessionId, terminalId, key, `touch ${marker}\n`);
      const deadline = Date.now() + 10000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(marker)).toBe(true);
    },
  );

  describe('network dimension', () => {
    let server: Server;
    let port: number;
    let connections: number;

    beforeEach(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections += 1;
        socket.end();
      });
      const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
      server.listen(0, '127.0.0.1', onListening);
      await listening;
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server.address() to be an AddressInfo');
      }
      port = address.port;
    });

    afterEach(async () => {
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
      server.close(() => onClosed());
      await closed;
    });

    it(
      'a network destination matching a deny rule is blocked over the same real wire path',
      { retry: 0, timeout: 20000 },
      async () => {
        const dest = `127.0.0.1:${port}`;
        const { sessionId, key, terminalId } = await openTerminalOverTheWire({
          policy: { command: { allow: [], deny: [] }, network: { allow: [], deny: [dest] } },
        });

        await typeIntoTerminal(
          sessionId,
          terminalId,
          key,
          `${process.execPath} -e "require('net').createConnection(${port}, '127.0.0.1')" ${dest}\n`,
        );
        await waitForTerminalOutputContains(
          phone!,
          sessionId,
          terminalId,
          key,
          'blocked by permission policy',
        );

        expect(connections).toBe(0);
      },
    );
  });
});
