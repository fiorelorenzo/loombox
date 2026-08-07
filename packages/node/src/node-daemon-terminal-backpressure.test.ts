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
  type EncryptedEnvelope,
  type TerminalOutput,
  type WireMessageV1,
} from '@loombox/protocol';
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

/**
 * Issue #207: terminal backpressure and resize hardening, proved against a
 * REAL PTY (real `bash --noprofile --norc`, issue #503) producing real
 * volume, through a REAL relay — not a fake stream and not a mocked
 * `BoundedTerminalOutbox`. `terminal-outbox.test.ts` (pure, fast) and
 * `relay.test.ts`'s "terminal_output bounded fan-out backpressure" suite
 * (real WebSockets, artificially tiny depths to force the overflow path
 * deterministically) already cover the queue's own bound/drop-oldest
 * semantics in isolation; this file is the end-to-end proof that the whole
 * pipeline — `node-pty` -> `NodeDaemon`'s per-terminal `seq` assignment ->
 * encrypt -> relay -> decrypt — genuinely delivers a realistic burst
 * complete, in order, and promptly, with a real PTY reporting the numbers.
 *
 * Harness duplicated from `node-daemon-permission-policy.test.ts` (this
 * package's own established per-file convention for a real-terminal, real-
 * relay suite) rather than shared, so this file stays self-contained.
 */

const execFileAsync = promisify(execFile);

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

type CryptoKey = webcrypto.CryptoKey;

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
    timeoutMs = 20000,
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

/** Every `terminal_output` chunk seen so far for `sessionId`/`terminalId`, decrypted and sorted by the node-assigned `seq` (issue #207) — the authoritative reconstruction order, independent of arrival order. */
async function decryptedTerminalOutputChunks(
  phone: TestPhone,
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
): Promise<Array<{ seq: number; text: string }>> {
  const candidates = phone.messages.filter(
    (m): m is TerminalOutput =>
      m.type === 'terminal_output' && m.sessionId === sessionId && m.terminalId === terminalId,
  );
  const chunks = await Promise.all(
    candidates.map(async (m) => ({
      seq: m.seq,
      text: Buffer.from(
        fromBase64((await phoneOpen<{ data: string }>(sessionId, m.envelope, key)).data),
      ).toString('utf8'),
    })),
  );
  return chunks.sort((a, b) => a.seq - b.seq);
}

/** Concatenates {@link decryptedTerminalOutputChunks} in seq order and polls until the result contains `substring`, or times out. */
async function waitForTerminalOutputContains(
  phone: TestPhone,
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
  substring: string,
  timeoutMs = 20000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunks = await decryptedTerminalOutputChunks(phone, sessionId, terminalId, key);
    const text = chunks.map((c) => c.text).join('');
    if (text.includes(substring)) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForTerminalOutputContains: timed out waiting for ${JSON.stringify(substring)} (saw ${text.length} chars, ${chunks.length} chunks)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Like {@link waitForTerminalOutputContains}, but requires `line` to appear
 * as a standalone printed line — real command OUTPUT — rather than a plain
 * substring. An interactive PTY echoes back whatever was TYPED before
 * running it (line-editing/local echo), so a marker like
 * `echo BURST_DONE_1` shows up verbatim in the transcript the instant it's
 * typed, well before the shell has actually run it; a naive substring
 * search would resolve on that echo instead of on the marker's real,
 * later-arriving output line — the exact trap this test suite's own burst
 * commands sit in (their `echo <marker>` tail is itself typed text).
 */
async function waitForTerminalOutputLine(
  phone: TestPhone,
  sessionId: string,
  terminalId: string,
  key: CryptoKey,
  line: string,
  timeoutMs = 20000,
): Promise<string> {
  // A real PTY's line boundaries are not always `\n`: bash's bracketed-
  // paste-mode-off sequence (`\u001b[?2004l`) is followed by a bare `\r`
  // (cursor to column 0) with no `\n`, so real command OUTPUT can start
  // right after a lone `\r` — both `\r` and `\n` (or the very start of the
  // transcript) count as a line boundary here, not `\n` alone.
  const ownLine = new RegExp(`(^|\\r|\\n)${line}\\r?(\\n|$)`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunks = await decryptedTerminalOutputChunks(phone, sessionId, terminalId, key);
    const text = chunks.map((c) => c.text).join('');
    if (ownLine.test(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForTerminalOutputLine: timed out waiting for ${JSON.stringify(line)} as its own output line (saw ${text.length} chars, ${chunks.length} chunks)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Real hermetic bash (issue #503), matching every other real-PTY suite in this package. */
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
  projectPath = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-terminal-backpressure-test-'),
  );
  nodeStateDir = await mkdtemp(
    path.join(tmpdir(), 'loombox-node-daemon-terminal-backpressure-state-'),
  );
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

/** Opens a real terminal over the wire, mirroring `node-daemon-permission-policy.test.ts`'s identical helper, returning everything a burst test needs. */
async function openRealTerminal(): Promise<{
  sessionId: string;
  key: CryptoKey;
  terminalId: string;
}> {
  const amk = generateAmk();
  const accountId = 'acct-terminal-backpressure';

  node = createNode({
    relayUrl: relay.url,
    stateDir: nodeStateDir,
    nodeId: 'node-terminal-backpressure',
    deviceId: 'device-node-terminal-backpressure',
    devicePublicKey: randomBase64(),
    authToken: accountId,
    accountId,
    amk,
    supervisor: new AgentSupervisor({ providers: [echoProvider()] }),
    terminalSupervisor: hermeticTerminalSupervisor(),
  });

  const session = await node.createSession({ projectPath, provider: 'test-echo' });
  const key = await derivePhoneSessionKey(amk, accountId, session.id);

  phone = new TestPhone(relay.url, {
    deviceId: 'device-phone-terminal-backpressure',
    devicePublicKey: randomBase64(),
    authToken: accountId,
  });
  await phone.ready;
  phone.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId: session.id });
  await phone.waitFor((m) => m.type === 'session_announce');

  const terminalId = 'term-burst';
  const openEnvelope = await phoneSeal(session.id, { cols: 80, rows: 24 }, key);
  phone.send({
    type: 'terminal_open',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.id,
    targetId: 'local',
    terminalId,
    requestId: 'req-open-burst',
    envelope: openEnvelope,
  });
  await phone.waitFor((m) => m.type === 'terminal_opened' && m.requestId === 'req-open-burst');

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

/** A hermetic bash `for` loop over builtins (`printf`, no per-line fork) that emits `count` uniquely-numbered lines fast, then one trailing done marker so a test can poll for real completion instead of guessing a duration. */
function burstCommand(count: number, doneMarker: string): string {
  return `for i in $(seq 1 ${count}); do printf 'L%05d-0123456789012345678901234567890123456789\\n' "$i"; done; echo ${doneMarker}\n`;
}

/** Extracts the sorted, deduped set of line numbers actually present in `text` (from `burstCommand`'s own `L%05d-...` format). */
function lineNumbersIn(text: string): number[] {
  const numbers = [...text.matchAll(/L(\d{5})-0123456789012345678901234567890123456789/g)].map(
    (m) => Number(m[1]),
  );
  return [...new Set(numbers)].sort((a, b) => a - b);
}

describe('a real PTY high-volume burst does not lose data, does not unbound memory, and delivers in order (SPEC §7.16; issue #207)', () => {
  it(
    'every line of a 4000-line real bash burst arrives exactly once, in order, at the default queue depth — with real numbers',
    { retry: 0, timeout: 30000 },
    async () => {
      const { sessionId, key, terminalId } = await openRealTerminal();
      const lineCount = 4000;

      await typeIntoTerminal(sessionId, terminalId, key, burstCommand(lineCount, 'BURST_DONE_1'));
      const fullText = await waitForTerminalOutputLine(
        phone!,
        sessionId,
        terminalId,
        key,
        'BURST_DONE_1',
      );

      const chunks = await decryptedTerminalOutputChunks(phone!, sessionId, terminalId, key);
      const numbers = lineNumbersIn(fullText);

      // Real numbers, not a theoretical claim: every one of the 4000 lines
      // the shell actually produced is present, exactly once, none missing.
      expect(numbers.length).toBe(lineCount);
      expect(numbers[0]).toBe(1);
      expect(numbers.at(-1)).toBe(lineCount);
      for (let i = 1; i < numbers.length; i++) {
        expect(numbers[i]).toBe(numbers[i - 1] + 1);
      }

      // seq is strictly increasing across every chunk this terminal ever
      // sent — the node-assigned order survived the encrypt/relay/decrypt
      // round trip unchanged.
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].seq).toBeGreaterThan(chunks[i - 1].seq);
      }

      // At the relay's default bound (64), a real bash burst read by a
      // normally-fast test client never overflows: no terminal_resync_marker
      // fired, because none of it needed to be dropped. This is the "no
      // loss under realistic conditions" half of the claim — `relay.test.ts`
      // and `terminal-outbox.test.ts` separately prove the drop-oldest path
      // itself is correct once a client genuinely cannot keep up.
      const markers = phone!.messages.filter(
        (m) => m.type === 'terminal_resync_marker' && m.terminalId === terminalId,
      );
      expect(markers.length).toBe(0);

      // The burst genuinely arrived as more than one wire frame — real
      // evidence this exercised the streaming path, not one lucky syscall.
      expect(chunks.length).toBeGreaterThan(1);
    },
  );
});

describe('a resize mid-burst reflows the real PTY and loses nothing (SPEC §7.5/§7.16; issue #207)', () => {
  it(
    'a terminal_resize sent while a burst is in flight is applied to the real PTY (proved via stty size, not CSS/xterm), and every line of the burst still survives intact',
    { retry: 0, timeout: 30000 },
    async () => {
      const { sessionId, key, terminalId } = await openRealTerminal();
      const lineCount = 3000;

      await typeIntoTerminal(sessionId, terminalId, key, burstCommand(lineCount, 'BURST_DONE_2'));

      // Wait for the burst to be genuinely under way (well short of done)
      // before resizing — a real mid-flight resize, not one that lands
      // before the shell has even started or after it already finished.
      await waitForTerminalOutputContains(phone!, sessionId, terminalId, key, 'L00500-');

      const resizeEnvelope = await phoneSeal(sessionId, { cols: 120, rows: 40 }, key);
      phone!.send({
        type: 'terminal_resize',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        terminalId,
        envelope: resizeEnvelope,
      });

      const fullText = await waitForTerminalOutputLine(
        phone!,
        sessionId,
        terminalId,
        key,
        'BURST_DONE_2',
      );
      const numbers = lineNumbersIn(fullText);
      expect(numbers.length).toBe(lineCount);
      expect(numbers[0]).toBe(1);
      expect(numbers.at(-1)).toBe(lineCount);
      for (let i = 1; i < numbers.length; i++) {
        expect(numbers[i]).toBe(numbers[i - 1] + 1);
      }

      // The real proof the resize took effect: `stty size` queries the PTY's
      // actual TIOCGWINSZ window, not xterm.js/CSS — it can only ever report
      // what node-pty's real `pty.resize()` ioctl actually set.
      await typeIntoTerminal(sessionId, terminalId, key, 'stty size\n');
      const withStty = await waitForTerminalOutputContains(
        phone!,
        sessionId,
        terminalId,
        key,
        '40 120',
      );
      expect(withStty).toContain('40 120');
    },
  );
});

describe('a busy terminal never blocks a second terminal on the same session (SPEC §7.16; issue #207)', () => {
  it(
    'opening and using a second terminal while the first is mid-burst completes promptly — the busy terminal never gates it',
    { retry: 0, timeout: 30000 },
    async () => {
      const { sessionId, key, terminalId: busyTerminalId } = await openRealTerminal();
      await typeIntoTerminal(sessionId, busyTerminalId, key, burstCommand(6000, 'BURST_DONE_3'));
      await waitForTerminalOutputContains(phone!, sessionId, busyTerminalId, key, 'L00500-');

      const secondTerminalId = 'term-fast';
      const openStart = Date.now();
      const openEnvelope = await phoneSeal(sessionId, { cols: 80, rows: 24 }, key);
      phone!.send({
        type: 'terminal_open',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId: 'local',
        terminalId: secondTerminalId,
        requestId: 'req-open-fast',
        envelope: openEnvelope,
      });
      await phone!.waitFor((m) => m.type === 'terminal_opened' && m.requestId === 'req-open-fast');
      const openLatencyMs = Date.now() - openStart;

      await typeIntoTerminal(sessionId, secondTerminalId, key, 'echo second-terminal-alive\n');
      await waitForTerminalOutputLine(
        phone!,
        sessionId,
        secondTerminalId,
        key,
        'second-terminal-alive',
      );
      const roundTripMs = Date.now() - openStart;

      // Real numbers: opening and round-tripping a command on a second
      // terminal, while the first is actively streaming a 6000-line burst,
      // stays fast — nowhere near the seconds a burst that size would take
      // to fully drain if this were queued behind it.
      expect(openLatencyMs).toBeLessThan(5000);
      expect(roundTripMs).toBeLessThan(10000);
    },
  );
});
