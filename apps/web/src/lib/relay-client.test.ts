import 'fake-indexeddb/auto';
import type { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  decryptEnvelope,
  deriveKeyTree,
  encryptEnvelope,
  generateAmk,
  generateRecoveryCode,
  importAesGcmKey,
} from '@loombox/crypto';
import { createTranscriptState, reduceTranscript } from '@loombox/providers-core/browser';
import {
  HEARTBEAT_CAPABILITY,
  PROTOCOL_V1,
  buildIdentityMismatch,
  type BlobDownloadResponse,
  type BuildIdentityV1,
  type ConfigOption,
  type ConnectedAccount,
  type EncryptedEnvelope,
  type PermissionResponse,
  type PermissionPolicyV1,
  type PromptInjectV1,
  type SessionMetaPublic,
  type WireMessageV1,
} from '@loombox/protocol';
import {
  createInMemoryRelayStore,
  createRelayAuth,
  startRelay,
  type RelayAuth,
  type StartedRelay,
} from '@loombox/relay';

import {
  RelayClient,
  bootstrapAmkFromRecoveryCode,
  withRelayWsPath,
  type ClientSessionMeta,
  type WebSocketConstructor,
  type WebSocketLike,
} from './relay-client';
import { AuthStore, createInMemoryAuthStorage } from './auth-store';
import { createEnvelopeCrypto, type EnvelopeCrypto } from './envelope-crypto-client';
import { createInMemoryAmkStorage, loadOrCreateAmk } from './amk-store';
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  attachmentResourceId,
  hasBlockingAttachments,
} from './attachments';
import {
  createIndexedDbOutboxStorage,
  createInMemoryOutboxStorage,
  type OutboxStorage,
  type QueuedPrompt,
} from './outbox';
import { fileMention } from './mentions';

type CryptoKey = webcrypto.CryptoKey;

// -----------------------------------------------------------------------
// Test-only crypto helpers standing in for a node. Deliberately NOT calls
// into RelayClient's own imports of @loombox/crypto's deriveSessionKey/
// sealJson/openJson — reimplementing the same *documented* v1 derivation
// contract (packages/crypto/src/session-keys.ts's doc comment: path
// ['session', accountId, sessionId]) directly against the lower-level
// primitives, exactly like packages/node/src/node-daemon.test.ts's
// TestPhone does for the client side. A passing test this way proves two
// independent parties interoperate, not just that RelayClient agrees with
// itself.
// -----------------------------------------------------------------------

describe('withRelayWsPath', () => {
  it('appends /ws to a bare relay origin so the WS opens against the relay route, not root', () => {
    // The bug this guards: a bare origin opens against the relay's root (404),
    // which silently broke device pairing + AMK escrow while HTTP sign-in
    // (derived by stripping /ws) still worked.
    expect(withRelayWsPath('wss://relay.loombox.dev')).toBe('wss://relay.loombox.dev/ws');
    expect(withRelayWsPath('ws://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/ws');
  });

  it('leaves an already-/ws-terminated URL untouched and tolerates a trailing slash', () => {
    expect(withRelayWsPath('wss://relay.loombox.dev/ws')).toBe('wss://relay.loombox.dev/ws');
    expect(withRelayWsPath('wss://relay.loombox.dev/')).toBe('wss://relay.loombox.dev/ws');
    expect(withRelayWsPath('wss://relay.loombox.dev/ws/')).toBe('wss://relay.loombox.dev/ws');
  });
});

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function deriveNodeSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

/** The directory picker's own derivation (issue #474) — `['target', accountId, targetId]`, mirroring `deriveNodeSessionKey` above but never the same key, even for the same account. */
async function deriveNodeTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
  return importAesGcmKey(node.key);
}

/** The project-addressed tracker records' own derivation (issue #697) — `['project', accountId, projectPath]`, mirroring `deriveNodeSessionKey`/`deriveNodeTargetKey` above but never the same key, even for the same account, and with no session or target involved at all. */
async function deriveNodeProjectKey(
  amk: Uint8Array,
  accountId: string,
  projectPath: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['project', accountId, projectPath]);
  return importAesGcmKey(node.key);
}

async function nodeSeal(
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

async function nodeOpen<T>(sessionId: string, wire: EncryptedEnvelope, key: CryptoKey): Promise<T> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  const plaintext = await decryptEnvelope(sessionId, envelope, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A minimal encrypted-node-like peer over the global WebSocket, speaking the v1 handshake's `role: 'node'` side. */
class FakeNode {
  readonly messages: WireMessageV1[] = [];
  private readonly socket: WebSocket;
  readonly ready: Promise<void>;

  constructor(
    url: string,
    opts: {
      deviceId: string;
      devicePublicKey: string;
      authToken: string;
      /** Issue #655: this fake node's own build identity, sent on `initialize` — omitted exercises the pre-#655 "no build identity" shape every other `FakeNode` use already relies on. */
      buildIdentity?: BuildIdentityV1;
    },
  ) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'initialize',
            protocolVersion: PROTOCOL_V1,
            role: 'node',
            authToken: opts.authToken,
            deviceId: opts.deviceId,
            devicePublicKey: opts.devicePublicKey,
            ...(opts.buildIdentity ? { buildIdentity: opts.buildIdentity } : {}),
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
        if (!settled) reject(new Error(`FakeNode: cannot reach ${url}`));
      });
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 3000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('FakeNode: timed out waiting for a message');
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

/**
 * Waits until `predicate(get(store))` is true, or a genuine-hang safety net
 * fires. Event-driven (subscribes and resolves off the store's own push
 * notifications) rather than polling a fixed deadline: a deadline sized for
 * "the real relay + real crypto this test drives finished in time" flakes
 * under CI load (issue #529) because the wall-clock cost of that real work
 * is exactly what varies with load, and a deadline generous enough to
 * absorb the worst case is still just a slower flake, never a fix. Waiting
 * on the store's own notification instead removes the guess entirely: this
 * resolves the instant a satisfying value is pushed, however long that
 * takes, and `timeoutMs` becomes a pure backstop against a value that never
 * arrives (a real hang), so it can be generous with no cost to a passing
 * run.
 */
async function waitForStore<T>(
  store: { subscribe: (run: (value: T) => void) => () => void },
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const initial = get(store);
  if (predicate(initial)) return initial;
  return new Promise<T>((resolve, reject) => {
    // A genuine wall-clock timer, deliberately: this isn't waiting out a
    // race, it's a backstop against a store that never receives a
    // satisfying value at all (a real hang in the real WebSocket/relay/
    // crypto this test drives). There is no logical event to await instead
    // — fake timers would require mocking that entire real I/O stack, which
    // is precisely what makes this suite worth having. Kept generous
    // (10s default) since, unlike a poll deadline, it never adds latency to
    // a passing run — it only bounds how long a truly stuck run waits.
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('waitForStore: timed out'));
    }, timeoutMs);
    // Every svelte store re-emits its current value synchronously on
    // subscribe, i.e. `initial` again here, which already failed the
    // predicate above — so this callback can never resolve (and therefore
    // never call `unsubscribe`) during `store.subscribe()` itself, before
    // the `const` below is assigned. No TDZ hazard.
    const unsubscribe = store.subscribe((value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
  });
}

/**
 * Waits until a store's value is no longer reference-equal to `previous`.
 * `RelayClient` always sets/updates its stores with a fresh array/object, so
 * this reliably detects "another inbound wire message was processed" even
 * when its decrypted content happens to equal what was already there —
 * used to deterministically wait for `session_resume`'s `session_announce`
 * reply (confirming the relay subscribed this client) before a test
 * triggers a `session_update` from the node side, avoiding a race between
 * two independent WebSocket connections.
 */
async function waitForStoreChange<T>(
  store: { subscribe: (run: (value: T) => void) => () => void },
  previous: T,
  timeoutMs = 10_000,
): Promise<T> {
  return waitForStore(store, (value) => value !== previous, timeoutMs).catch((error: Error) => {
    throw new Error(error.message.replace('waitForStore', 'waitForStoreChange'));
  });
}

/**
 * Waits for `count` real changes on a store, counted off its `subscribe`
 * callback's own push notifications rather than polling `get()` — polling
 * can coalesce two rapid-fire changes into a single observed jump (missing
 * the intermediate value entirely), which `waitForStoreChange` called twice
 * in a row is vulnerable to when two independent `session_resume` round
 * trips (e.g. two sessions subscribed back-to-back) can each complete and
 * notify within the same polling tick. Every svelte store's `subscribe`
 * fires synchronously once with its current value on subscribe, which does
 * not count as a change.
 */
async function waitForNotificationCount(
  store: { subscribe: (run: (value: unknown) => void) => () => void },
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('waitForNotificationCount: timed out'));
    }, timeoutMs);
    // `count` is always > 0 for every caller below, so the synchronous
    // "current value" callback `subscribe` fires during this very call
    // (seen becomes 1, never > count here) never reads `unsubscribe` before
    // this assignment completes — no TDZ hazard from the self-reference.
    const unsubscribe = store.subscribe(() => {
      seen += 1;
      if (seen > count) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Spies on `console.warn`, resolving `settled` the instant a call's first
 * argument contains `substring` — the deterministic, event-driven signal
 * that a rejected `handleSessionUpdate`/`handlePermissionRequest` promise
 * chain (issue #593's drop-and-log path) has settled, mirroring
 * `waitForStore`'s "resolve off a real notification; `timeoutMs` is only a
 * backstop against a genuine hang in the real WebSocket/crypto stack this
 * suite drives" shape for a value that isn't a Svelte store. `restore()`
 * must be called once done observing, same as any other `vi.spyOn`.
 */
function watchConsoleWarnFor(
  substring: string,
  timeoutMs = 10_000,
): { settled: Promise<void>; restore: () => void } {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error(`watchConsoleWarnFor(${JSON.stringify(substring)}): timed out`)),
    timeoutMs,
  );
  const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (String(message).includes(substring)) {
      clearTimeout(timer);
      resolve();
    }
  });
  return { settled: promise, restore: () => spy.mockRestore() };
}

/** Polls `storage.list()` (a real, possibly-async read, unlike `waitForStore`'s synchronous `get()`) until `predicate` holds — used to wait for a fire-and-forget IndexedDB write to actually land before the next step depends on it. */
async function waitForOutbox(
  storage: OutboxStorage,
  predicate: (list: QueuedPrompt[]) => boolean,
  timeoutMs = 3000,
): Promise<QueuedPrompt[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await storage.list();
    if (predicate(list)) return list;
    if (Date.now() > deadline) throw new Error('waitForOutbox: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeSessionMeta(overrides: Partial<SessionMetaPublic> = {}): SessionMetaPublic {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'local',
    accountId: 'acct-test',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// Attachment test fixtures (SPEC §7.25; issues #151/#152/#153/#155).
// -----------------------------------------------------------------------

/**
 * A real PNG's magic-byte signature plus filler "pixel" bytes — sniffs as an
 * actual PNG, not a fake. Explicitly typed `Uint8Array<ArrayBuffer>` (not
 * the bare `Uint8Array` alias, which defaults to `Uint8Array<ArrayBufferLike>`)
 * so the result is directly usable as a `File`/`Blob` part without a cast.
 */
function realPngBytes(fillerByte = 0x01, totalLength = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalLength).fill(fillerByte);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** A minimal ISOBMFF `ftyp` box declaring the `heic` major brand — real HEIC magic bytes. */
function realHeicBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  const encoder = new TextEncoder();
  bytes.set([0x00, 0x00, 0x00, 0x18], 0);
  bytes.set(encoder.encode('ftyp'), 4);
  bytes.set(encoder.encode('heic'), 8);
  return bytes;
}

/** Not any recognized image format, however it's named/declared. */
function notAnImageBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode('%PDF-1.4 definitely not an image'));
}

/**
 * Decrypts a raw (non-JSON) attachment blob envelope under the given
 * session key, bound to the same `attachmentResourceId` AAD the relay's
 * blob store keys by and `@loombox/node`'s `AttachmentResolver` decrypts
 * against — the peer side of an attachment round trip, reimplemented here
 * (not imported from `@loombox/node`, which this package must not depend
 * on) directly against the lower-level `@loombox/crypto` primitives, same
 * spirit as this file's `nodeSeal`/`nodeOpen` helpers above.
 */
async function nodeOpenAttachment(
  sessionId: string,
  ref: string,
  wire: EncryptedEnvelope,
  key: CryptoKey,
): Promise<Uint8Array> {
  const envelope = {
    resourceId: wire.resourceId,
    iv: fromBase64(wire.iv),
    ciphertext: fromBase64(wire.ciphertext),
  };
  return decryptEnvelope(attachmentResourceId(sessionId, ref), envelope, key);
}

/**
 * A `WebSocketConstructor` (real class, so `new`-able like the global
 * `WebSocket` `RelayClient` normally uses) wrapping a real WebSocket that
 * throws synchronously on `send()` for the first `failUntilAttempt`
 * outbound `blob_upload` frames, then behaves normally — simulates a
 * transient send failure (SPEC §7.25's "Upload failure & retry") without
 * ever actually dropping the connection, isolating a manual-retry test
 * from the separate connection-drop/reconnect path. `counter` is shared by
 * reference so it persists across the multiple socket instances the same
 * `RelayClient` creates on successive `connect()` calls.
 */
function flakyBlobUploadSocketCtor(counter: {
  attempts: number;
  failUntilAttempt: number;
}): WebSocketConstructor {
  return class FlakyBlobUploadSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      this.real = new WebSocket(url) as unknown as WebSocketLike;
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      if (typeof data === 'string' && data.includes('"blob_upload"')) {
        counter.attempts += 1;
        if (counter.attempts <= counter.failUntilAttempt) {
          throw new Error(`FlakyBlobUploadSocket: simulated failure #${counter.attempts}`);
        }
      }
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/**
 * A `WebSocketConstructor` wrapping a real WebSocket that records every
 * outbound frame (parsed) into `sent` and every created instance into
 * `sockets` — `session_list_request`/`ping` are relay-answered directly
 * and never routed to a `FakeNode`, so this is how a test inspects what a
 * (re)connect actually sent. `sockets[i].close()` also gives a test a way
 * to force an unexpected drop: `RelayClient` has no way to tell "the test
 * closed the underlying transport" from "the network did", so this is
 * indistinguishable from a real drop from its point of view.
 */
function recordingSocketCtor(
  sent: WireMessageV1[],
  sockets: WebSocketLike[],
): WebSocketConstructor {
  return class RecordingSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      this.real = new WebSocket(url) as unknown as WebSocketLike;
      sockets.push(this);
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      sent.push(JSON.parse(data) as WireMessageV1);
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/**
 * Wraps a real `EnvelopeCrypto` so every `open()` call takes at least
 * `delayMs` to resolve — used only to widen the live/resync-replay overlap
 * window deterministically (issue #729's dedupe proof) instead of racing
 * real network/CPU timing, which would make the proof flaky by
 * construction. `onOpenStart`, if given, fires synchronously the instant
 * `open()` is CALLED (before the delay) — lets a test await "the client
 * has synchronously reached this decrypt call" deterministically, rather
 * than guessing a wall-clock margin for "the wire frame must have arrived
 * by now". Every other operation (`seal`, `sealBytes`, ...) forwards
 * straight through, unchanged and undelayed. Explicit per-method
 * forwarding, deliberately NOT `{ ...real, open: ... }`: `real` is a class
 * instance (`EnvelopeCryptoClientBase`), whose methods live on the
 * prototype, not as the instance's own enumerable properties — a spread
 * would silently drop every one of them (`seal`/`sealBytes`/
 * `wrapAmkForEscrow`/`dispose` would all be `undefined`).
 */
function delayedOpenEnvelopeCrypto(
  real: EnvelopeCrypto,
  delayMs: number,
  onOpenStart?: () => void,
): EnvelopeCrypto {
  return {
    open: <T>(...args: Parameters<EnvelopeCrypto['open']>) => {
      onOpenStart?.();
      return new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(() =>
        real.open<T>(...args),
      );
    },
    seal: (...args: Parameters<EnvelopeCrypto['seal']>) => real.seal(...args),
    sealBytes: (...args: Parameters<EnvelopeCrypto['sealBytes']>) => real.sealBytes(...args),
    wrapAmkForEscrow: (...args: Parameters<EnvelopeCrypto['wrapAmkForEscrow']>) =>
      real.wrapAmkForEscrow(...args),
    dispose: () => real.dispose(),
  };
}

/**
 * A `WebSocketConstructor` that throws synchronously out of its own
 * constructor for the first `failUntilAttempt` instances, then wraps a real
 * WebSocket normally — an unreachable relay can surface as a synchronous
 * construction failure rather than an async 'error'/'close' pair depending
 * on the environment, which `RelayClient.open()` must recover from exactly
 * like any other failed attempt (mirrors `@loombox/node`'s
 * `RelayConnection`, issue #511).
 */
function flakyConstructorSocketCtor(counter: {
  attempts: number;
  failUntilAttempt: number;
}): WebSocketConstructor {
  return class FlakyConstructorSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      counter.attempts += 1;
      if (counter.attempts <= counter.failUntilAttempt) {
        throw new Error(
          `FlakyConstructorSocket: simulated construction failure #${counter.attempts}`,
        );
      }
      this.real = new WebSocket(url) as unknown as WebSocketLike;
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/**
 * A `WebSocketConstructor` whose first `failUntilAttempt` instances fire
 * only 'error' and never 'close' — reproducing the exact asymmetry issue
 * #511 was filed for: Node's undici `WebSocket` (this whole suite's global
 * `WebSocket`, since it runs under Vitest/Node, not a browser) emits
 * 'error' with no 'close' at all on a *failed connection attempt*, as
 * opposed to a socket that opened and later dropped. `RelayClient.open()`
 * must not depend on 'close' ever following 'error' to recover. Later
 * instances (once `failUntilAttempt` is exhausted) wrap a real WebSocket
 * normally.
 */
function errorWithoutCloseSocketCtor(counter: {
  attempts: number;
  failUntilAttempt: number;
}): WebSocketConstructor {
  return class ErrorWithoutCloseSocket implements WebSocketLike {
    private readonly real: WebSocketLike | undefined;
    private readonly failing: boolean;
    private errorListener: (() => void) | undefined;

    constructor(url: string) {
      counter.attempts += 1;
      this.failing = counter.attempts <= counter.failUntilAttempt;
      if (this.failing) {
        // No real socket at all: this attempt never reaches OPEN, exactly
        // like trying to connect to a relay that is down. Deferred past
        // the constructor so `attemptOpen()` has already registered the
        // 'error' listener below by the time this fires.
        queueMicrotask(() => this.errorListener?.());
      } else {
        this.real = new WebSocket(url) as unknown as WebSocketLike;
      }
    }

    get readyState(): number {
      return this.real ? this.real.readyState : 0;
    }

    send(data: string): void {
      this.real?.send(data);
    }

    close(): void {
      this.real?.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      if (this.failing) {
        // 'open'/'message' never come (it never connects), and 'close' is
        // deliberately never invoked — that is the whole point of this
        // double.
        if (type === 'error') this.errorListener = listener as () => void;
        return;
      }
      const real = this.real!;
      switch (type) {
        case 'open':
          real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/**
 * A `WebSocketConstructor` wrapping a real WebSocket that records every
 * outbound frame into `sent` like {@link recordingSocketCtor}, but silently
 * drops (never forwards) any `ping` — the relay never sees it and never
 * answers it, which is what a half-open socket looks like from
 * `RelayClient`'s side: everything else it sends still works, only the
 * heartbeat's own probe goes unanswered.
 */
function pingSwallowingSocketCtor(
  sent: WireMessageV1[],
  sockets: WebSocketLike[],
): WebSocketConstructor {
  return class PingSwallowingSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      this.real = new WebSocket(url) as unknown as WebSocketLike;
      sockets.push(this);
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      const message = JSON.parse(data) as WireMessageV1;
      sent.push(message);
      if (message.type === 'ping') return;
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message':
          this.real.addEventListener('message', listener as (event: { data: unknown }) => void);
          return;
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/** Rewrites a relay message event to drop `HEARTBEAT_CAPABILITY` from an `initialize_result`'s `capabilities`, otherwise passes it through unchanged — see {@link capabilityStrippingSocketCtor}'s doc comment. */
function stripHeartbeatCapability(event: { data: unknown }): { data: unknown } {
  const parsed = JSON.parse(String(event.data)) as { type?: string; capabilities?: unknown };
  if (parsed.type !== 'initialize_result' || !Array.isArray(parsed.capabilities)) return event;
  return {
    data: JSON.stringify({
      ...parsed,
      capabilities: parsed.capabilities.filter((capability) => capability !== HEARTBEAT_CAPABILITY),
    }),
  };
}

/**
 * A `WebSocketConstructor` wrapping a real WebSocket that strips
 * `HEARTBEAT_CAPABILITY` out of the relay's `initialize_result` before
 * `RelayClient` ever parses it, and records every outbound frame into
 * `sent`. The real in-process relay this suite runs against always
 * advertises the capability (`relay.test.ts`'s own coverage), so this is
 * the only way to exercise "the relay didn't" without touching the relay
 * package itself.
 */
function capabilityStrippingSocketCtor(sent: WireMessageV1[]): WebSocketConstructor {
  return class CapabilityStrippingSocket implements WebSocketLike {
    private readonly real: WebSocketLike;

    constructor(url: string) {
      this.real = new WebSocket(url) as unknown as WebSocketLike;
    }

    get readyState(): number {
      return this.real.readyState;
    }

    send(data: string): void {
      sent.push(JSON.parse(data) as WireMessageV1);
      this.real.send(data);
    }

    close(): void {
      this.real.close();
    }

    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: () => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    addEventListener(
      type: 'open' | 'message' | 'close' | 'error',
      listener: (() => void) | ((event: { data: unknown }) => void),
    ): void {
      switch (type) {
        case 'open':
          this.real.addEventListener('open', listener as () => void);
          return;
        case 'message': {
          const messageListener = listener as (event: { data: unknown }) => void;
          this.real.addEventListener('message', (event: { data: unknown }) => {
            messageListener(stripHeartbeatCapability(event));
          });
          return;
        }
        case 'close':
          this.real.addEventListener('close', listener as () => void);
          return;
        case 'error':
          this.real.addEventListener('error', listener as () => void);
          return;
      }
    }
  };
}

/**
 * Waits until `sent` contains a message satisfying `predicate` — the
 * outbound-frame counterpart of `FakeNode.waitFor` above, for assertions
 * against a recording socket ctor's own client-side record rather than a
 * peer's inbox. A real timer, not a fake/advanced one, for the same reason
 * `waitForStore`/`FakeNode.waitFor` already poll on one: every `RelayClient`
 * here talks to a real in-process `@loombox/relay` over a real WebSocket
 * (`RelayClient`'s own class docstring), so nothing here is on a mockable
 * clock.
 */
async function waitForSentMessage(
  sent: WireMessageV1[],
  predicate: (message: WireMessageV1) => boolean,
  timeoutMs = 3000,
): Promise<WireMessageV1> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sent.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('waitForSentMessage: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Polls an arbitrary synchronous condition on a real timer (see
 * `waitForSentMessage`'s doc comment for why one is unavoidable here) —
 * used instead of `waitForStore` where the awaited transition is only
 * momentarily true (e.g. `status === 'closed'` during this test file's own
 * tiny `initialBackoffMs`, which the store can flip past between two 10ms
 * polls); `sockets.length` growing is monotonic and so never races.
 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitForCondition: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let relay: StartedRelay;
let node: FakeNode | undefined;
let client: RelayClient | undefined;

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  client?.close();
  node?.close();
  client = undefined;
  node = undefined;
  await relay.close();
});

describe('reduceTranscript (pure reducer, re-exported from @loombox/providers-core)', () => {
  it('appends a new message item on first sight of a (turnId, kind, messageId)', () => {
    const state = reduceTranscript(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 't1::agent_message_chunk::m1',
        kind: 'agent_message_chunk',
        turnId: 't1',
        messageId: 'm1',
        text: 'Hello',
      },
    ]);
  });

  it('accumulates chunks with the same (turnId, kind, messageId) in order', () => {
    let state = reduceTranscript(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello',
    });
    state = reduceTranscript(state, {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: ' world',
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Hello world' });
  });
});

describe('RelayClient', () => {
  it('connects, sends initialize, and surfaces the initial (empty) session_list snapshot', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-empty',
      deviceId: 'client-1',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'open');
    const sessions = await waitForStore(client.sessions, () => true);
    expect(sessions).toEqual([]);
  });

  it('surfaces a session announced by a node before the client connects, decrypting its title/projectPath', async () => {
    const amk = generateAmk();
    const accountId = 'acct-list';

    node = new FakeNode(relay.url, {
      deviceId: 'node-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_announced', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'my session', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([{ ...session, title: 'my session', projectPath: '/proj' }]);
    // Never exposes the wire envelope itself, only the values it decrypted to.
    expect(sessions[0]).not.toHaveProperty('privateEnvelope');
  });

  it('decrypts and reduces a live session_update stream after subscribing via transcriptFor', async () => {
    const amk = generateAmk();
    const accountId = 'acct-transcript';

    node = new FakeNode(relay.url, {
      deviceId: 'node-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_transcript', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'live', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);

    // transcriptFor() sent session_resume; wait for its session_announce
    // reply to land (confirming the relay actually subscribed this client)
    // before triggering updates from the node side, avoiding a race between
    // the two independent WebSocket connections.
    await waitForStoreChange(client.sessions, initialSessions);

    const chunk1Envelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: 'Hello' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: chunk1Envelope,
    });
    const chunk2Envelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: ' world' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: chunk2Envelope,
    });

    const state = await waitForStore(transcript, (value) => {
      const first = value.items[0];
      return first?.type === 'message' && first.text === 'Hello world';
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 'turn-1::agent_message_chunk::msg-1',
        kind: 'agent_message_chunk',
        turnId: 'turn-1',
        messageId: 'msg-1',
        text: 'Hello world',
      },
    ]);
  });

  it('sendPrompt appends the user turn locally and makes the relay route a decryptable prompt_inject to the node', async () => {
    const amk = generateAmk();
    const accountId = 'acct-prompt';

    node = new FakeNode(relay.url, {
      deviceId: 'node-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_prompt', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);

    const promptId = client.sendPrompt(session.id, 'do the thing');

    // The composer's own turn is visible immediately, before any reply.
    expect(get(transcript).items).toEqual([
      {
        type: 'message',
        id: `${promptId}::user_message_chunk::${promptId}`,
        kind: 'user_message_chunk',
        turnId: promptId,
        messageId: promptId,
        text: 'do the thing',
      },
    ]);

    // The relay routed the (encrypted) prompt_inject through to the node,
    // and the node independently derives the same key and decrypts it back
    // to the original text — proving real interop, not self-consistency.
    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.sessionId).toBe(session.id);
    expect(routed.promptId).toBe(promptId);
    const decrypted = await nodeOpen<{ text: string }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({ text: 'do the thing' });

    // The relay only ever carried ciphertext.
    const raw = Buffer.from(routed.envelope.ciphertext, 'base64').toString('latin1');
    expect(raw.includes('do the thing')).toBe(false);
  });

  it('decrypts a live permission_request and enqueues it onto permissionQueueFor, FIFO', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permission';

    node = new FakeNode(relay.url, {
      deviceId: 'node-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_permission', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-6' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ];
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' }, options },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-1',
      envelope,
    });

    const state = await waitForStore(queue, (value) => value.byId.size > 0);
    const pending = state.byId.get('req-1');
    expect(pending?.toolCall).toEqual({ kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' });
    expect(pending?.options).toEqual(options);
    expect([...(state.bySession.get(session.id) ?? [])].map((r) => r.requestId)).toEqual(['req-1']);
  });

  it('resolvePermission removes the request locally and sends a clear permission_response with the option kind', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resolve';

    node = new FakeNode(relay.url, {
      deviceId: 'node-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resolve', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-7' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc1' }, options: [option] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-2',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    client.resolvePermission(session.id, 'req-2', option);

    expect(get(queue).byId.size).toBe(0);
    const response = (await node.waitFor(
      (m) => m.type === 'permission_response',
    )) as PermissionResponse;
    expect(response).toMatchObject({
      sessionId: session.id,
      requestId: 'req-2',
      decision: 'allow_once',
    });
  });

  it('cancelPermissionRequests optimistically clears every open request for a session (Stop)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-cancel';

    node = new FakeNode(relay.url, {
      deviceId: 'node-6',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_cancel', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-8' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    for (const requestId of ['req-a', 'req-b', 'req-c']) {
      const envelope = await nodeSeal(
        session.id,
        { toolCall: { kind: 'tool_call', id: requestId }, options: [] },
        key,
      );
      node.send({
        type: 'permission_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId,
        envelope,
      });
    }
    await waitForStore(queue, (value) => value.byId.size === 3);

    client.cancelPermissionRequests(session.id);

    expect(get(queue).byId.size).toBe(0);
  });

  it('setConfigOption sends the clear config_option message and does NOT guess the new value locally (issue #718: the agent can reject it, so only its own config_options push may apply one)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-config';

    node = new FakeNode(relay.url, {
      deviceId: 'node-7',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-9' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    client.setConfigOption(session.id, 'model', 'opus');

    const options = get(client.configOptionsFor(session.id));
    expect(options).toEqual([]);

    const sent = (await node.waitFor((m) => m.type === 'config_option')) as ConfigOption;
    expect(sent).toMatchObject({ sessionId: session.id, category: 'model', optionId: 'opus' });
  });

  it('does not send a wire frame while the socket is not yet open, but queues the prompt for the offline outbox instead of faking a sent transcript entry (issue #130)', () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-offline',
      deviceId: 'client-5',
      outboxStorage: createInMemoryOutboxStorage(),
    });
    // sendPrompt before connect(): should not throw, and should not send a
    // wire frame — instead it queues locally (issue #130's offline
    // composer outbox), NOT an optimistic "sent" transcript entry, since
    // this prompt hasn't actually reached the node yet.
    const promptId = client.sendPrompt('sess_never_connected', 'hello?');
    const transcript = client.transcriptFor('sess_never_connected');
    expect(get(transcript).items).toEqual([]);

    const queued = client.queuedPromptsFor('sess_never_connected');
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: promptId, sessionId: 'sess_never_connected', text: 'hello?' }),
    ]);
  });
});

describe('RelayClient: config_option_result (SPEC §7.24; issue #718)', () => {
  it("a rejected config_option publishes a ConfigOptionErrorNotice carrying the agent's own reason, and a later successful retry for the same category clears it", async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-result-error';

    node = new FakeNode(relay.url, {
      deviceId: 'node-config-result-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config_result_error', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-config-result-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const errorNotice = client.configOptionErrorFor(session.id);
    expect(get(errorNotice)).toBeUndefined();

    client.setConfigOption(session.id, 'model', 'not-a-real-model');
    await node.waitFor((m) => m.type === 'config_option');

    node.send({
      type: 'config_option_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      category: 'model',
      result: { outcome: 'error', message: 'Unsupported value: not-a-real-model' },
    });
    await waitForStore(errorNotice, (value) => value !== undefined);

    expect(get(errorNotice)).toMatchObject({
      category: 'model',
      message: 'Unsupported value: not-a-real-model',
    });

    // A later successful retry for the SAME category clears the stale
    // notice rather than leaving it to linger.
    client.setConfigOption(session.id, 'model', 'a-real-model');
    await node.waitFor(
      (m) => m.type === 'config_option' && (m as ConfigOption).optionId === 'a-real-model',
    );
    node.send({
      type: 'config_option_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      category: 'model',
      result: { outcome: 'ok' },
    });
    await waitForStore(errorNotice, (value) => value === undefined);
  });

  it("a client ignores a config_option_result for another device's own pending request on the same session (fanned out, not addressed) — neither publishing a notice nor clearing an unrelated one", async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-result-sibling';

    node = new FakeNode(relay.url, {
      deviceId: 'node-config-result-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config_result_sibling', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-config-result-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const errorNotice = client.configOptionErrorFor(session.id);

    // This client never sent a config_option for 'thought_level' — a
    // sibling device's own attempt, fanned out to every subscriber of the
    // session exactly like fs_list_response.
    node.send({
      type: 'config_option_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      category: 'thought_level',
      result: { outcome: 'error', message: 'Unsupported value: xhigh' },
    });

    // The correct behavior produces NO store change here, so there is no
    // event to await instead — mirrors the identical real-timer wait
    // `relay-client.test.ts`'s own fs_list_response sibling-device test
    // uses for the same "prove a fanned-out foreign reply was ignored"
    // shape, over the same real WebSocket/relay this suite drives.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    expect(get(errorNotice)).toBeUndefined();
  });
});

describe('RelayClient: connectedAccounts (SPEC §7.26, issue #221 wiring; consumed by issue #220)', () => {
  it('starts empty and surfaces an account announced by a node before the client connects, exactly like the sessions snapshot', async () => {
    const amk = generateAmk();
    const accountId = 'acct-connected-accounts';

    node = new FakeNode(relay.url, {
      deviceId: 'node-ca-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const account: ConnectedAccount = {
      id: 'github:github.com:123',
      provider: 'github',
      host: 'github.com',
      providerAccountId: '123',
      label: 'octocat',
      credentialSource: 'device_flow',
      scopes: ['repo'],
      capabilities: ['repo', 'issues'],
      connectedAt: 1,
      updatedAt: 1,
      secretRef: 'connected-account-token:github:github.com:123',
    };
    node.send({ type: 'connected_account_announce', protocolVersion: PROTOCOL_V1, account });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-ca-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const accounts = await waitForStore(client.connectedAccounts, (value) => value.length > 0);
    expect(accounts).toEqual([account]);
    // Routing metadata only — never a token-shaped field anywhere in what
    // this client surfaces (mirrors the relay's own "no token" test).
    expect(JSON.stringify(accounts)).not.toContain('"token"');
  });

  it('two devices under the same account both see the same connected account list (SPEC §7.26 "a picker renders from any device")', async () => {
    const amk = generateAmk();
    const accountId = 'acct-connected-accounts-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-ca-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const account: ConnectedAccount = {
      id: 'jira:myteam.atlassian.net:acc_1',
      provider: 'jira',
      host: 'myteam.atlassian.net',
      providerAccountId: 'acc_1',
      label: 'lorenzo@example.com',
      credentialSource: 'api_token',
      scopes: null,
      capabilities: ['issues'],
      connectedAt: 1,
      updatedAt: 1,
      secretRef: 'connected-account-token:jira:myteam.atlassian.net:acc_1',
    };
    node.send({ type: 'connected_account_announce', protocolVersion: PROTOCOL_V1, account });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-ca-2a' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.connectedAccounts, (value) => value.length > 0);

    const secondClient = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-ca-2b',
    });
    secondClient.connect();
    try {
      await waitForStore(secondClient.status, (status) => status === 'open');
      const secondAccounts = await waitForStore(
        secondClient.connectedAccounts,
        (value) => value.length > 0,
      );
      expect(secondAccounts).toEqual([account]);
    } finally {
      secondClient.close();
    }
  });
});

describe('RelayClient: turn Stop/interrupt (SPEC §7.3/§7.24; issue #129)', () => {
  it('interruptTurn cancels every open permission request for the session, same as cancelPermissionRequests', async () => {
    const amk = generateAmk();
    const accountId = 'acct-interrupt';

    node = new FakeNode(relay.url, {
      deviceId: 'node-interrupt',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_interrupt', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-interrupt' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc-interrupt' }, options: [] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-interrupt',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    client.interruptTurn(session.id);

    expect(get(queue).byId.size).toBe(0);
  });

  it('interruptTurn settles the turn locally so a queued follow-up flushes right away instead of waiting out turnIdleMs — and never touches rollback/workspace state (no such call exists on this client)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-interrupt-queue';

    node = new FakeNode(relay.url, {
      deviceId: 'node-interrupt-queue',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_interrupt_queue', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-interrupt-queue',
      outboxStorage: createInMemoryOutboxStorage(),
      // Deliberately long: proves the flush below comes from interruptTurn
      // itself, not from the turnIdleMs fallback timer happening to fire.
      turnIdleMs: 60_000,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const queued = client.queuedPromptsFor(session.id);
    const firstId = client.sendPrompt(session.id, 'first, in flight');
    await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === firstId,
    );

    const secondId = client.sendPrompt(session.id, 'second, queued behind the first turn');
    expect(get(queued)).toEqual([expect.objectContaining({ id: secondId, sessionId: session.id })]);

    client.interruptTurn(session.id);

    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: stale approve/deny discard (SPEC §7.3; issue #131)', () => {
  it('resolving a request this client already resolved is a graceful no-op: no second permission_response is sent, and a stale notice is published instead of erroring', async () => {
    const amk = generateAmk();
    const accountId = 'acct-stale-local';

    node = new FakeNode(relay.url, {
      deviceId: 'node-stale-local',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_stale_local', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-local',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    const staleNotice = client.staleNoticeFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
    const envelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc-stale' }, options: [option] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-stale-local',
      envelope,
    });
    await waitForStore(queue, (value) => value.byId.size > 0);

    // The first (real) resolve — same path already covered elsewhere, just
    // the setup this test's actual case (the second, stale resolve) needs.
    client.resolvePermission(session.id, 'req-stale-local', option);
    await node.waitFor((m) => m.type === 'permission_response');
    expect(get(staleNotice)).toBeUndefined();

    // The late/duplicate action — a double click, or a click that lands
    // after the card already re-rendered without it (SPEC §7.3's "no
    // longer applies" rule).
    client.resolvePermission(session.id, 'req-stale-local', option);

    expect(node.messages.filter((m) => m.type === 'permission_response')).toHaveLength(1);
    const notice = get(staleNotice);
    expect(notice?.requestId).toBe('req-stale-local');
    expect(notice?.message).toMatch(/no longer applies/i);
  });

  it('two clients racing the same permission request: once the tool call update reveals device A already resolved it, device B auto-discards its own copy and a late resolve on B is a stale no-op, not a second permission_response', async () => {
    const amk = generateAmk();
    const accountId = 'acct-stale-race';

    node = new FakeNode(relay.url, {
      deviceId: 'node-stale-race',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_stale_race', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Device A.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-race-a',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessionsA = await waitForStore(client.sessions, (value) => value.length > 0);
    const queueA = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessionsA);

    // Device B — a second, independent RelayClient on the SAME account,
    // exactly like a second browser tab/phone watching the same session.
    const clientB = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-stale-race-b',
    });
    try {
      clientB.connect();
      await waitForStore(clientB.status, (status) => status === 'open');
      const initialSessionsB = await waitForStore(clientB.sessions, (value) => value.length > 0);
      const queueB = clientB.permissionQueueFor(session.id);
      const staleNoticeB = clientB.staleNoticeFor(session.id);
      await waitForStoreChange(clientB.sessions, initialSessionsB);

      const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
      const envelope = await nodeSeal(
        session.id,
        { toolCall: { kind: 'tool_call', id: 'tc-race' }, options: [option] },
        key,
      );
      // The relay fans a live permission_request out to every subscribed
      // client on the account — both A and B see the exact same request.
      node.send({
        type: 'permission_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-race',
        envelope,
      });
      await waitForStore(queueA, (value) => value.byId.size > 0);
      await waitForStore(queueB, (value) => value.byId.size > 0);

      // Device A resolves first.
      client.resolvePermission(session.id, 'req-race', option);
      await node.waitFor((m) => m.type === 'permission_response');

      // v1's relay never broadcasts permission_response to sibling clients
      // (only routes it to the owning node) — B only learns the request
      // was already handled once the agent's own ordinary tool_call_update
      // reflects it, exactly like every other session_update fan-out.
      const statusEnvelope = await nodeSeal(
        session.id,
        { kind: 'tool_call_update', id: 'tc-race', status: 'completed' },
        key,
      );
      node.send({
        type: 'session_update',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        seq: 1,
        envelope: statusEnvelope,
      });
      await waitForStore(queueB, (value) => value.byId.size === 0);
      expect(get(staleNoticeB)?.requestId).toBe('req-race');

      // B's user, unaware, still submits the (now stale) approve — a
      // graceful no-op: the queue was already empty, so this must not
      // throw, must not send a second permission_response, and must
      // (re-)publish the stale notice rather than silently applying it.
      clientB.resolvePermission(session.id, 'req-race', option);

      expect(node.messages.filter((m) => m.type === 'permission_response')).toHaveLength(1);
      expect(get(staleNoticeB)?.requestId).toBe('req-race');
    } finally {
      clientB.close();
    }
  });

  it("a permission_request payload with a missing toolCall.id is dropped and logged, never reaching the queue, and a well-formed one still flows through afterward (issue #593; supersedes #548's reducer-level guard for this case)", async () => {
    // #548 added a reducer-level guard (`discardStalePermissionForToolCall`'s
    // `event.id === undefined` check, still in `relay-client.ts` — kept as
    // defense in depth) for a malformed `tool_call`/`tool_call_update`
    // whose `id` never validated against its declared `string` type. #593
    // closes the hole one layer earlier: `handlePermissionRequest` now
    // parses the decrypted payload against a real Zod schema before it
    // ever reaches the permission queue, so a payload missing `id`
    // (`JSON.stringify` drops an `undefined`-valued key entirely, exactly
    // what a real malformed wire payload looks like) is dropped and
    // logged right here — the queue never sees it at all.
    const amk = generateAmk();
    const accountId = 'acct-permission-no-id';

    node = new FakeNode(relay.url, {
      deviceId: 'node-permission-no-id',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_permission_no_id', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-permission-no-id',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const queue = client.permissionQueueFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const warned = watchConsoleWarnFor(
      `RelayClient: failed to decrypt/validate permission_request for session ${session.id}`,
    );

    const option = { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const };
    const malformedEnvelope = await nodeSeal(
      session.id,
      {
        toolCall: { kind: 'tool_call', id: undefined, title: 'Mystery permission' },
        options: [option],
      },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-no-id',
      envelope: malformedEnvelope,
    });
    await warned.settled;

    expect(get(queue).byId.size).toBe(0);
    warned.restore();

    // The client keeps working after dropping the malformed one: a
    // well-formed request right after it still reaches the queue.
    const wellFormedEnvelope = await nodeSeal(
      session.id,
      { toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' }, options: [option] },
      key,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-well-formed',
      envelope: wellFormedEnvelope,
    });
    const state = await waitForStore(queue, (value) => value.byId.size > 0);
    expect(state.byId.get('req-well-formed')?.toolCall).toEqual({
      kind: 'tool_call',
      id: 'tc1',
      title: 'Edit foo.ts',
    });
  });

  it("a session_update payload with a missing tool_call_update id is dropped and logged, never reaching the transcript, and a well-formed one still flows through afterward (issue #593; supersedes #548's reducer-level guard for this case)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-session-update-no-id';

    node = new FakeNode(relay.url, {
      deviceId: 'node-session-update-no-id',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_session_update_no_id', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-session-update-no-id',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);
    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const warned = watchConsoleWarnFor(
      `RelayClient: failed to decrypt/validate session_update for ${session.id}`,
    );

    const malformedEnvelope = await nodeSeal(
      session.id,
      { kind: 'tool_call_update', id: undefined, status: 'completed' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: malformedEnvelope,
    });
    await warned.settled;

    expect(get(transcript).items).toEqual([]);
    warned.restore();

    // The client keeps working after dropping the malformed one: a
    // well-formed update right after it still reaches the transcript.
    const wellFormedEnvelope = await nodeSeal(
      session.id,
      { kind: 'tool_call', id: 'tc1', status: 'completed' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: wellFormedEnvelope,
    });
    await waitForStore(client.transcriptFor(session.id), (value) =>
      value.items.some((item) => item.type === 'tool_call' && item.status === 'completed'),
    );
  });
});

describe('RelayClient: attachments (SPEC §7.25; issues #151/#152/#153/#155)', () => {
  it("attachFile validates real image bytes, encrypts+uploads via blob_upload, and a peer (the node, exactly the executing host's own #156 download path) decrypts the exact original bytes (#151, #153)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-attach';

    node = new FakeNode(relay.url, {
      deviceId: 'node-attach',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_attach', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-attach' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const pngBytes = realPngBytes();
    const file = new File([pngBytes], 'photo.png', { type: 'image/png' });

    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    // Instant local state, before any network round trip.
    expect(get(attachments)).toEqual([
      expect.objectContaining({ id: attachmentId, name: 'photo.png', status: 'uploading' }),
    ]);

    const uploaded = await waitForStore(
      attachments,
      (list) => list.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    const entry = uploaded.find((a) => a.id === attachmentId)!;
    expect(entry.mimeType).toBe('image/png');
    // Instant local preview (SPEC §7.25), no network round trip involved.
    expect(entry.previewUrl).toMatch(/^blob:/);
    expect(entry.error).toBeUndefined();

    // The relay only ever received/stored ciphertext under blob_upload — a
    // peer (here: the node, exactly `@loombox/node`'s `AttachmentResolver`
    // path for #156) fetches it by ref and decrypts it back to the exact
    // original bytes.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    const response = (await node.waitFor(
      (m) => m.type === 'blob_download_response',
    )) as BlobDownloadResponse;
    const decryptedBytes = await nodeOpenAttachment(
      session.id,
      attachmentId,
      response.envelope,
      key,
    );
    expect(decryptedBytes).toEqual(pngBytes);

    // The relay never saw the plaintext bytes.
    const raw = Buffer.from(response.envelope.ciphertext, 'base64');
    expect(raw.includes(Buffer.from('PNG'))).toBe(false);
  });

  it('attachFile rejects a HEIC file client-side with a clear convert-and-re-upload message, before any upload attempt (#152)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-heic';

    node = new FakeNode(relay.url, {
      deviceId: 'node-heic',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_heic', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-heic' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realHeicBytes()], 'photo.heic', { type: 'image/heic' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    const list = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );
    const entry = list.find((a) => a.id === attachmentId)!;
    expect(entry.error).toMatch(/heic\/heif/i);
    expect(entry.error).toMatch(/convert/i);
    expect(entry.error).toMatch(/re-upload/i);
    // A rejected attachment never blocks sending.
    expect(hasBlockingAttachments(list)).toBe(false);

    // Never uploaded: the relay has nothing stored under this ref.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    await expect(node.waitFor((m) => m.type === 'blob_download_response', 200)).rejects.toThrow(
      /timed out/,
    );
  });

  it('attachFile rejects a spoofed file by its real sniffed bytes, ignoring its declared mimeType/extension (#151)', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-spoof',
      deviceId: 'client-spoof',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    // Declares itself as a PNG (name + mimeType) but its actual bytes are not an image.
    const file = new File([notAnImageBytes()], 'totally-a-photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor('sess_spoof');
    const attachmentId = client.attachFile('sess_spoof', file);

    const list = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );
    expect(list.find((a) => a.id === attachmentId)?.error).toMatch(/unsupported image type/i);
  });

  it('sendPrompt embeds only a fully-uploaded attachment as a PromptAttachmentRef the node decrypts, and clears it from the composer (#153)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-send-attach';

    node = new FakeNode(relay.url, {
      deviceId: 'node-send-attach',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_send_attach', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-send-attach',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );

    client.sendPrompt(session.id, 'here is a photo', [attachmentId]);

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<{
      text: string;
      attachments?: { ref: string; mimeType: string; name?: string }[];
    }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({
      text: 'here is a photo',
      attachments: [{ ref: attachmentId, mimeType: 'image/png', name: 'photo.png' }],
    });

    // Sent attachments are cleared from the composer's pending list — they now belong to the sent prompt.
    expect(get(attachments)).toEqual([]);
  });

  it('sendPrompt embeds a still-live @-mention as a PromptMentionRef the node decrypts (issue #742)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-send-mention';

    node = new FakeNode(relay.url, {
      deviceId: 'node-send-mention',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_send_mention', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-send-mention',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const mention = fileMention('apps/web/src/lib/relay-client.ts');
    client.sendPrompt(session.id, 'check this out', [], [mention]);

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<{
      text: string;
      mentions?: { uri: string; name: string }[];
    }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({
      text: 'check this out',
      mentions: [{ uri: 'file:apps/web/src/lib/relay-client.ts', name: 'relay-client.ts' }],
    });
  });

  it('sendPrompt with no mentions omits the field entirely, not an empty array', async () => {
    const amk = generateAmk();
    const accountId = 'acct-send-no-mention';

    node = new FakeNode(relay.url, {
      deviceId: 'node-send-no-mention',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_send_no_mention', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-send-no-mention',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    client.sendPrompt(session.id, 'plain prompt, nothing attached');

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<Record<string, unknown>>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({ text: 'plain prompt, nothing attached' });
    expect(Object.keys(decrypted)).not.toContain('mentions');
  });

  it('sendPrompt never references a still-uploading attachment — a broken ref must never reach the agent (SPEC §7.25)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-broken-ref';

    node = new FakeNode(relay.url, {
      deviceId: 'node-broken-ref',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_broken_ref', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-broken-ref',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    // sendPrompt is called immediately, synchronously after attachFile —
    // before the async validate/encrypt/upload pipeline has had a chance
    // to run a single microtask, so the attachment is still 'uploading'.
    const attachmentId = client.attachFile(session.id, file);
    client.sendPrompt(session.id, 'quick, before it finishes', [attachmentId]);

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    const decrypted = await nodeOpen<{ text: string; attachments?: unknown }>(
      session.id,
      routed.envelope,
      key,
    );
    expect(decrypted).toEqual({ text: 'quick, before it finishes' });
  });

  it('retryAttachment re-uploads a failed attachment using its cached bytes, without re-reading the file (#155 manual retry)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-manual-retry';

    node = new FakeNode(relay.url, {
      deviceId: 'node-manual-retry',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_manual_retry', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Fails exactly the FIRST blob_upload send (the initial attach attempt),
    // succeeds on every subsequent one (the manual retry) — the connection
    // itself is never dropped, isolating this from the reconnect path below.
    const counter = { attempts: 0, failUntilAttempt: 1 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-manual-retry',
      webSocketImpl: flakyBlobUploadSocketCtor(counter),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const bytes = realPngBytes();
    const file = new File([bytes], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);

    const failed = await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(failed.find((a) => a.id === attachmentId)?.error).toMatch(/upload failed/i);
    expect(counter.attempts).toBe(1);

    client.retryAttachment(session.id, attachmentId);

    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    expect(counter.attempts).toBe(2);

    // The retry uploaded the SAME bytes originally read, without asking for the file again.
    node.send({
      type: 'blob_download',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      ref: attachmentId,
    });
    const response = (await node.waitFor(
      (m) => m.type === 'blob_download_response',
    )) as BlobDownloadResponse;
    const decryptedBytes = await nodeOpenAttachment(
      session.id,
      attachmentId,
      response.envelope,
      key,
    );
    expect(decryptedBytes).toEqual(bytes);
  });

  it('a connection-dropped upload failure gets exactly one automatic retry on reconnect, never a second one (#155)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-auto-retry';

    node = new FakeNode(relay.url, {
      deviceId: 'node-auto-retry',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_auto_retry', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // The reconnect's own automatic retry attempt (the 2nd blob_upload send
    // overall) also fails, so `autoRetried` must be the only thing stopping
    // a 3rd, 4th, ... attempt on further reconnects — proving "exactly
    // once" rather than "retries until it works".
    const counter = { attempts: 0, failUntilAttempt: 2 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-auto-retry',
      webSocketImpl: flakyBlobUploadSocketCtor(counter),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const file = new File([realPngBytes()], 'photo.png', { type: 'image/png' });
    const attachments = client.attachmentsFor(session.id);
    const attachmentId = client.attachFile(session.id, file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(counter.attempts).toBe(1);

    // Drop and reconnect — `connect()` alone is a no-op while a socket is
    // already open, so an actual connection drop (`close()`) is what makes
    // the next `connect()` reach a fresh `initialize_result`, matching what
    // a real dropped-and-recovered phone connection looks like from
    // RelayClient's point of view. The automatic retry fires — and, per
    // this test's setup, fails again too.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'failed',
    );
    expect(counter.attempts).toBe(2);

    // A second drop+reconnect must NOT retry a third time — the one
    // automatic retry has already been used.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    // Give any (incorrect) further auto-retry a moment to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counter.attempts).toBe(2);
    expect(get(attachments).find((a) => a.id === attachmentId)?.status).toBe('failed');

    // The manual retry control still works after the automatic one is spent.
    client.retryAttachment(session.id, attachmentId);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'uploaded',
    );
    expect(counter.attempts).toBe(3);
  });

  it('rejects the 21st image attached to the same prompt with a clear over-limit message (SPEC §7.25 default cap)', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-too-many',
      deviceId: 'client-too-many',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const attachments = client.attachmentsFor('sess_too_many');
    const ids: string[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_PROMPT; i++) {
      const file = new File([realPngBytes(i + 1)], `photo-${i}.png`, { type: 'image/png' });
      ids.push(client.attachFile('sess_too_many', file));
    }
    await waitForStore(
      attachments,
      (value) => value.filter((a) => a.status === 'uploaded').length === MAX_ATTACHMENTS_PER_PROMPT,
    );

    const oneTooMany = new File([realPngBytes(99)], 'photo-extra.png', { type: 'image/png' });
    const extraId = client.attachFile('sess_too_many', oneTooMany);
    const list = get(attachments);
    const extraEntry = list.find((a) => a.id === extraId)!;
    expect(extraEntry.status).toBe('rejected');
    expect(extraEntry.error).toMatch(/up to 20 images/i);
  });

  it('removeAttachment drops a rejected/failed attachment from the composer', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-remove',
      deviceId: 'client-remove',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const file = new File([realHeicBytes()], 'photo.heic', { type: 'image/heic' });
    const attachments = client.attachmentsFor('sess_remove');
    const attachmentId = client.attachFile('sess_remove', file);
    await waitForStore(
      attachments,
      (value) => value.find((a) => a.id === attachmentId)?.status === 'rejected',
    );

    client.removeAttachment('sess_remove', attachmentId);
    expect(get(attachments)).toEqual([]);
  });
});

describe('RelayClient: session-lifecycle wire events (SPEC §7.13/§7.24/§8; issues #126/#128/#149)', () => {
  it('decrypts a session_status event into transcriptFor/statusFor, replacing an earlier status on the next transition', async () => {
    const amk = generateAmk();
    const accountId = 'acct-status';

    node = new FakeNode(relay.url, {
      deviceId: 'node-status',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_status', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-status' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const status = client.statusFor(session.id);
    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const workingEnvelope = await nodeSeal(
      session.id,
      { kind: 'session_status', status: 'working', updatedAt: 't1' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: workingEnvelope,
    });
    await waitForStore(status, (value) => value === 'working');
    expect(get(transcript).status).toBe('working');
    expect(get(transcript).statusUpdatedAt).toBe('t1');

    const permissionEnvelope = await nodeSeal(
      session.id,
      { kind: 'session_status', status: 'permission_required', updatedAt: 't2' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: permissionEnvelope,
    });
    await waitForStore(status, (value) => value === 'permission_required');
  });

  it('decrypts config_options / config_option_update into configOptionsFor, always replacing the whole catalog wholesale', async () => {
    const amk = generateAmk();
    const accountId = 'acct-config-wire';

    node = new FakeNode(relay.url, {
      deviceId: 'node-config-wire',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_config_wire', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-config-wire',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const options = client.configOptionsFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const catalog = [
      { category: 'model', current: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
    ];
    const catalogEnvelope = await nodeSeal(
      session.id,
      { kind: 'config_options', options: catalog },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: catalogEnvelope,
    });
    await waitForStore(options, (value) => value.length > 0);
    expect(get(options)).toEqual(catalog);

    // An unprompted config_option_update (e.g. an automatic cheaper-model
    // fallback) fully replaces the catalog too — never a per-category patch
    // (issue #149's "two missing acceptance bullets").
    const fallback = [
      { category: 'model', current: 'haiku', choices: [{ id: 'haiku', name: 'Haiku' }] },
    ];
    const fallbackEnvelope = await nodeSeal(
      session.id,
      { kind: 'config_option_update', options: fallback },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: fallbackEnvelope,
    });
    await waitForStore(options, (value) => value[0]?.current === 'haiku');
    expect(get(options)).toEqual(fallback);
  });

  it('decrypts available_commands_update into commandsFor, replacing the whole catalogue wholesale and preserving an unrecognized field on a command (issue #741)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-commands-wire';

    node = new FakeNode(relay.url, {
      deviceId: 'node-commands-wire',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_commands_wire', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-commands-wire',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const commands = client.commandsFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    // An agent that has not declared any commands yet starts empty, not an
    // error (issue #741 acceptance).
    expect(get(commands)).toEqual([]);

    const catalog = [
      { name: 'model', description: 'Show current model selection' },
      {
        name: 'security',
        description: 'Run a security scan',
        input: { hint: '<plan|scan|status>' },
        // Unrecognized/future field — must survive decryption + zod
        // validation + the reducer, all the way into the store (#741).
        icon: 'shield',
      },
    ];
    const commandsEnvelope = await nodeSeal(
      session.id,
      { kind: 'available_commands_update', commands: catalog },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: commandsEnvelope,
    });
    await waitForStore(commands, (value) => value.length > 0);
    expect(get(commands)).toEqual(catalog);

    // A later available_commands_update fully replaces the catalogue too —
    // never appended to or patched per-command.
    const redeclared = [{ name: 'jobs', description: 'Show background jobs' }];
    const redeclaredEnvelope = await nodeSeal(
      session.id,
      { kind: 'available_commands_update', commands: redeclared },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: redeclaredEnvelope,
    });
    await waitForStore(commands, (value) => value[0]?.name === 'jobs');
    expect(get(commands)).toEqual(redeclared);
  });

  it('flushes a queued prompt immediately on turn_ended, without waiting out the idle-timeout fallback', async () => {
    const amk = generateAmk();
    const accountId = 'acct-turn-ended';

    node = new FakeNode(relay.url, {
      deviceId: 'node-turn-ended',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_turn_ended', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-turn-ended',
      outboxStorage: createInMemoryOutboxStorage(),
      // Deliberately much longer than this test's own timeout budget: if the
      // queued prompt below only flushed via the idle-timeout fallback, this
      // test would time out rather than pass — proving turn_ended is what
      // actually flushed it, not the fallback.
      turnIdleMs: 60000,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const firstId = client.sendPrompt(session.id, 'first prompt');
    const firstRouted = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(firstRouted.promptId).toBe(firstId);

    const queued = client.queuedPromptsFor(session.id);
    const secondId = client.sendPrompt(session.id, 'second, queued');
    expect(get(queued)).toEqual([expect.objectContaining({ id: secondId, sessionId: session.id })]);

    const turnStartedEnvelope = await nodeSeal(
      session.id,
      { kind: 'turn_started', turnId: 'turn-1' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: turnStartedEnvelope,
    });
    await waitForStore(transcript, (value) => value.turnActive === true);

    const turnEndedEnvelope = await nodeSeal(
      session.id,
      { kind: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: turnEndedEnvelope,
    });

    await waitForStore(transcript, (value) => value.turnActive === false);
    expect(get(transcript).lastStopReason).toBe('end_turn');

    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: mid-turn composer queueing (issue #128)', () => {
  it("queues a follow-up submitted while this session's own turn is still active, then flushes it once idle, preserving order", async () => {
    const amk = generateAmk();
    const accountId = 'acct-midturn';

    node = new FakeNode(relay.url, {
      deviceId: 'node-midturn',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_midturn', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-midturn',
      outboxStorage: createInMemoryOutboxStorage(),
      turnIdleMs: 80,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const queued = client.queuedPromptsFor(session.id);

    const firstId = client.sendPrompt(session.id, 'first prompt');
    const firstRouted = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(firstRouted.promptId).toBe(firstId);

    // Submitted immediately after, while the first turn is still considered
    // in flight — must queue, not interrupt (SPEC §7.24's mid-turn composer
    // state bullet).
    const secondId = client.sendPrompt(session.id, 'second, queued');
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: secondId, sessionId: session.id, text: 'second, queued' }),
    ]);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    // Once the turn goes idle (no further activity), the queued prompt
    // flushes on its own, in order.
    const secondRouted = (await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === secondId,
    )) as PromptInjectV1;
    expect(secondRouted.sessionId).toBe(session.id);
    await waitForStore(queued, (value) => value.length === 0);
  });

  it('an inbound session_update alone (e.g. another device mid-turn on the same session) also holds the local queue open', async () => {
    const amk = generateAmk();
    const accountId = 'acct-midturn-remote';

    node = new FakeNode(relay.url, {
      deviceId: 'node-midturn-remote',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_midturn_remote', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-midturn-remote',
      outboxStorage: createInMemoryOutboxStorage(),
      turnIdleMs: 80,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    await waitForStoreChange(client.sessions, initialSessions);

    const chunkEnvelope = await nodeSeal(
      session.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-remote',
        messageId: 'msg-remote',
        text: 'from another device',
      },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: chunkEnvelope,
    });
    await waitForStore(transcript, (value) => value.items.length > 0);

    const queued = client.queuedPromptsFor(session.id);
    const promptId = client.sendPrompt(session.id, "queued behind another device's turn");
    expect(get(queued)).toEqual([expect.objectContaining({ id: promptId, sessionId: session.id })]);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(0);

    await node.waitFor(
      (m) => m.type === 'prompt_inject' && (m as PromptInjectV1).promptId === promptId,
    );
    await waitForStore(queued, (value) => value.length === 0);
  });
});

describe('RelayClient: offline composer outbox (issue #130)', () => {
  it('a prompt composed with no relay connection is queued and persisted to IndexedDB, then flushes automatically once connected', async () => {
    const amk = generateAmk();
    const accountId = 'acct-offline-outbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-offline-outbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_offline_outbox', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // Composed before `connect()` is ever called — no relay connection
    // exists yet. Uses the DEFAULT (IndexedDB-backed, via the
    // `fake-indexeddb` polyfill this test file installs) outbox storage, to
    // exercise the real production persistence path end to end.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-offline-outbox',
    });
    const promptId = client.sendPrompt(session.id, 'composed offline');

    const queued = client.queuedPromptsFor(session.id);
    expect(get(queued)).toEqual([
      expect.objectContaining({ id: promptId, sessionId: session.id, text: 'composed offline' }),
    ]);

    // Actually persisted, not just held in memory — a fresh storage handle
    // for the SAME account already sees it before this client even connects.
    const outboxStorage = createIndexedDbOutboxStorage(accountId);
    await waitForOutbox(outboxStorage, (list) => list.length > 0);

    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.promptId).toBe(promptId);
    const decrypted = await nodeOpen<{ text: string }>(session.id, routed.envelope, key);
    expect(decrypted).toEqual({ text: 'composed offline' });

    await waitForStore(queued, (value) => value.length === 0);
    await waitForOutbox(outboxStorage, (list) => list.length === 0);
  });

  it('a queued prompt persisted to IndexedDB survives a simulated reload (a fresh RelayClient for the same account) and is flushed exactly once on reconnect', async () => {
    const amk = generateAmk();
    const accountId = 'acct-reload-outbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-reload-outbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_reload_outbox', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'p', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // "Before the reload": composes offline and is torn down without ever
    // having connected — nothing was ever actually sent, only persisted.
    const before = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-before-reload',
    });
    const promptId = before.sendPrompt(session.id, 'survive the reload');
    const outboxStorage = createIndexedDbOutboxStorage(accountId);
    await waitForOutbox(outboxStorage, (list) => list.length > 0);
    before.close();

    // "After the reload": a brand-new RelayClient instance for the SAME
    // account — nothing shared with `before` except the same IndexedDB
    // database this account's outbox lives in.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-after-reload',
    });
    await waitForStore(client.queuedPromptsFor(session.id), (value) => value.length > 0);

    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const routed = (await node.waitFor((m) => m.type === 'prompt_inject')) as PromptInjectV1;
    expect(routed.promptId).toBe(promptId);
    await waitForStore(client.queuedPromptsFor(session.id), (value) => value.length === 0);
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    // A second reconnect must NOT resend it — exactly once, mirroring
    // issue #155's attachment auto-retry "exactly once" guarantee.
    client.close();
    await waitForStore(client.status, (status) => status === 'closed');
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(node.messages.filter((m) => m.type === 'prompt_inject')).toHaveLength(1);

    await waitForOutbox(outboxStorage, (list) => list.length === 0);
  });
});

describe('RelayClient: file-tree panel (SPEC §7.4; issue #171)', () => {
  it('fileTreeFor lazily loads the root directory, decrypting a real fs_list_response the node opaquely routed back', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-root';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_root', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);

    // fileTreeFor sent session_resume + an fs_list_request for the root
    // ('') path; the request must never carry the path in the clear.
    const request = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      type: 'fs_list_request';
      sessionId: string;
      targetId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.sessionId).toBe(session.id);
    expect(request.targetId).toBe('local');
    expect(Object.keys(request).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
    );
    const requestPayload = await nodeOpen<{ path: string }>(session.id, request.envelope, key);
    expect(requestPayload).toEqual({ path: '' });

    const responseEnvelope = await nodeSeal(
      session.id,
      {
        outcome: 'ok',
        path: '',
        entries: [
          { name: 'README.md', kind: 'file', size: 42 },
          { name: 'src', kind: 'dir', size: 0 },
        ],
      },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const loaded = await waitForStore(tree, (value) => value.get('')?.status === 'loaded');
    expect(loaded.get('')).toEqual({
      path: '',
      status: 'loaded',
      entries: [
        { name: 'README.md', kind: 'file', size: 42 },
        { name: 'src', kind: 'dir', size: 0 },
      ],
    });
  });

  it('expandDirectory lazily loads a nested directory on demand, and is a no-op while already loading/loaded', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-nested';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_nested', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    const rootRequest = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      requestId: string;
    };
    const rootResponseEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: '', entries: [{ name: 'src', kind: 'dir', size: 0 }] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: rootRequest.requestId,
      envelope: rootResponseEnvelope,
    });
    await waitForStore(tree, (value) => value.get('')?.status === 'loaded');

    // Not yet in the tree — the nested directory has NOT been eagerly
    // fetched just because the root loaded (SPEC §7.4's lazy-expand
    // requirement).
    expect(get(tree).has('src')).toBe(false);

    client.expandDirectory(session.id, 'src');
    // A second call while still loading must not send a second request.
    client.expandDirectory(session.id, 'src');

    const nestedRequests = await node.waitFor((m) => {
      if (m.type !== 'fs_list_request') return false;
      return (m as { requestId: string }).requestId !== rootRequest.requestId;
    });
    const nestedRequest = nestedRequests as { requestId: string };
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.messages.filter((m) => m.type === 'fs_list_request')).toHaveLength(2);

    const nestedResponseEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: 'src', entries: [{ name: 'index.ts', kind: 'file', size: 10 }] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: nestedRequest.requestId,
      envelope: nestedResponseEnvelope,
    });

    const loaded = await waitForStore(tree, (value) => value.get('src')?.status === 'loaded');
    expect(loaded.get('src')).toEqual({
      path: 'src',
      status: 'loaded',
      entries: [{ name: 'index.ts', kind: 'file', size: 10 }],
    });

    // A third call once loaded must also not re-fetch.
    client.expandDirectory(session.id, 'src');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.messages.filter((m) => m.type === 'fs_list_request')).toHaveLength(2);
  });

  it('surfaces an error outcome (e.g. path-traversal refusal) as status "error" rather than hanging', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-error';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_error', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    const request = (await node.waitFor((m) => m.type === 'fs_list_request')) as {
      requestId: string;
    };
    const errorEnvelope = await nodeSeal(
      session.id,
      { outcome: 'error', path: '', message: 'path escapes the project root' },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: errorEnvelope,
    });

    const errored = await waitForStore(tree, (value) => value.get('')?.status === 'error');
    expect(errored.get('')).toEqual({
      path: '',
      status: 'error',
      entries: [],
      error: 'path escapes the project root',
    });
  });

  it("a client ignores an fs_list_response for another device's own pending request on the same session (fanned out, not addressed)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-fs-tree-sibling';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fs-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_fs_sibling', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fs-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const tree = client.fileTreeFor(session.id);
    await node.waitFor((m) => m.type === 'fs_list_request'); // this client's own root request

    // A reply to a requestId this client never sent (a sibling device's
    // own request, fanned out to every subscriber of the session).
    const foreignEnvelope = await nodeSeal(
      session.id,
      { outcome: 'ok', path: 'other-dir', entries: [] },
      key,
    );
    node.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: 'req-not-mine',
      envelope: foreignEnvelope,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(get(tree).has('other-dir')).toBe(false);
  });
});

describe('RelayClient: native tracker (SPEC §7.10, §7.26; issues #212, #697)', () => {
  it('trackerSnapshotFor lazily loads a project\u2019s tracker snapshot with NO session anywhere \u2014 decrypting a real tracker_snapshot_response sealed to the project key, addressed by nodeId+projectPath alone', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-snapshot';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-1';
    const snapshot = client.trackerSnapshotFor('node_tracker_1', projectPath);

    const request = (await node.waitFor((m) => m.type === 'tracker_snapshot_request')) as {
      type: 'tracker_snapshot_request';
      nodeId: string;
      projectPath: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.nodeId).toBe('node_tracker_1');
    expect(request.projectPath).toBe(projectPath);
    expect(Object.keys(request).sort()).toEqual(
      ['envelope', 'nodeId', 'projectPath', 'protocolVersion', 'requestId', 'type'].sort(),
    );

    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const requestPayload = await nodeOpen<{ includeArchived?: boolean }>(
      projectPath,
      request.envelope,
      key,
    );
    expect(requestPayload).toEqual({});

    const taskRecord = {
      id: 'rec-1',
      primaryType: 'task',
      typeTags: [],
      issueNumber: 1,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      fields: { title: 'Ship it', status: 'todo' },
      system: {
        authorId: 'author-1',
        linkedCommitSha: [],
        linkedPullRequests: [],
        linkedSessionIds: [],
        activity: [],
        comments: [],
      },
    };
    const taskType = {
      id: 'task',
      label: 'Task',
      builtin: true,
      roles: {
        title: 'title',
        workflowStatus: 'status',
        priority: 'priority',
        assignee: 'assignee',
      },
    };
    const responseEnvelope = await nodeSeal(
      projectPath,
      { outcome: 'ok', records: [taskRecord], types: [taskType] },
      key,
    );
    node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_1',
      projectPath,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const loaded = await waitForStore(snapshot, (value) => value.status === 'loaded');
    expect(loaded.records).toEqual([taskRecord]);
    expect(loaded.types).toEqual([taskType]);
  });

  it('is keyed by projectPath, not a session: a second call for the same project reuses the one store and never fires a second request (issue #697\u2019s "two sessions on one project fetch and fight" fix)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-dedupe';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-dedupe',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_dedupe',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-tracker-dedupe',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-dedupe';
    const first = client.trackerSnapshotFor('node_tracker_dedupe', projectPath);
    await node.waitFor((m) => m.type === 'tracker_snapshot_request');

    // A second caller for the SAME project (e.g. a different session bound
    // to it) gets the identical store back, with no fresh request fired.
    const second = client.trackerSnapshotFor('node_tracker_dedupe', projectPath);
    expect(second).toBe(first);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const requests = node.messages.filter((m) => m.type === 'tracker_snapshot_request');
    expect(requests).toHaveLength(1);
  });

  it('surfaces an error outcome as status "error" rather than hanging, and reloadTrackerSnapshot retries \u2014 still no session involved', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-error';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-2';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const snapshot = client.trackerSnapshotFor('node_tracker_2', projectPath);
    const request = (await node.waitFor((m) => m.type === 'tracker_snapshot_request')) as {
      requestId: string;
    };
    const errorEnvelope = await nodeSeal(
      projectPath,
      { outcome: 'error', message: 'the node did not answer in time' },
      key,
    );
    node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_2',
      projectPath,
      requestId: request.requestId,
      envelope: errorEnvelope,
    });
    const errored = await waitForStore(snapshot, (value) => value.status === 'error');
    expect(errored.error).toBe('the node did not answer in time');

    // Retry: reloadTrackerSnapshot sends a fresh request; a successful reply flips status back to loaded.
    client.reloadTrackerSnapshot('node_tracker_2', projectPath);
    const retryRequest = (await node.waitFor((m) => {
      if (m.type !== 'tracker_snapshot_request') return false;
      return (m as { requestId: string }).requestId !== request.requestId;
    })) as { requestId: string };
    const okEnvelope = await nodeSeal(projectPath, { outcome: 'ok', records: [], types: [] }, key);
    node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_2',
      projectPath,
      requestId: retryRequest.requestId,
      envelope: okEnvelope,
    });
    const reloaded = await waitForStore(snapshot, (value) => value.status === 'loaded');
    expect(reloaded.records).toEqual([]);
  });

  it('ignores a tracker_snapshot_response for a requestId it never sent \u2014 a stray/duplicate-reply guard, same shape pendingTargetFsListRequests documents (issue #697: the relay now answers the requester alone, so this is no longer about a sibling device\u2019s own reply, just a late/duplicate one)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-stray';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_3',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-3';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const snapshot = client.trackerSnapshotFor('node_tracker_3', projectPath);
    await node.waitFor((m) => m.type === 'tracker_snapshot_request'); // this client's own request

    const strayEnvelope = await nodeSeal(
      projectPath,
      { outcome: 'ok', records: [], types: [] },
      key,
    );
    node.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_3',
      projectPath,
      requestId: 'req-not-mine',
      envelope: strayEnvelope,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(get(snapshot).status).toBe('loading');
  });

  it('createTrackerRecord sends a real tracker_write_request(op: create) addressed by nodeId+projectPath, resolves with the node\u2019s record, and merges it into the snapshot store \u2014 no session anywhere', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-create';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_4',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-4';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const createPromise = client.createTrackerRecord('node_tracker_4', projectPath, {
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
    });

    const request = (await node.waitFor((m) => m.type === 'tracker_write_request')) as {
      type: 'tracker_write_request';
      nodeId: string;
      projectPath: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.nodeId).toBe('node_tracker_4');
    expect(request.projectPath).toBe(projectPath);
    const requestPayload = await nodeOpen<{ op: string; primaryType: string }>(
      projectPath,
      request.envelope,
      key,
    );
    expect(requestPayload).toEqual({
      op: 'create',
      primaryType: 'task',
      fields: { title: 'Ship it', status: 'todo' },
    });

    const record = {
      id: 'rec-created',
      primaryType: 'task',
      typeTags: [],
      issueNumber: 2,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      fields: { title: 'Ship it', status: 'todo' },
      system: {
        authorId: accountId,
        linkedCommitSha: [],
        linkedPullRequests: [],
        linkedSessionIds: [],
        activity: [],
        comments: [],
      },
    };
    const responseEnvelope = await nodeSeal(projectPath, { outcome: 'ok', record }, key);
    node.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_4',
      projectPath,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const resolved = await createPromise;
    expect(resolved).toEqual(record);
    const snapshot = client.trackerSnapshotFor('node_tracker_4', projectPath);
    await waitForStore(snapshot, (value) => value.records.some((r) => r.id === 'rec-created'));
  });

  it('createTrackerRecord rejects (never silently drops) when the node replies with outcome: error', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-create-error';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-5',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_5',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-5' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-5';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const createPromise = client.createTrackerRecord('node_tracker_5', projectPath, {
      primaryType: 'ghost-type',
      fields: {},
    });
    const request = (await node.waitFor((m) => m.type === 'tracker_write_request')) as {
      requestId: string;
    };
    const errorEnvelope = await nodeSeal(
      projectPath,
      { outcome: 'error', message: 'unknown tracker type "ghost-type"' },
      key,
    );
    node.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_5',
      projectPath,
      requestId: request.requestId,
      envelope: errorEnvelope,
    });

    await expect(createPromise).rejects.toThrow('unknown tracker type "ghost-type"');
  });

  it('updateTrackerRecord sends a real tracker_write_request(op: update) \u2014 the kanban board\u2019s drag-to-move path, addressed by nodeId+projectPath', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-update';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-6',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_6',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-6' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-6';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const updatePromise = client.updateTrackerRecord('node_tracker_6', projectPath, 'rec-1', {
      fields: { title: 'Ship it', status: 'done' },
    });
    const request = (await node.waitFor((m) => m.type === 'tracker_write_request')) as {
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    const requestPayload = await nodeOpen<{ op: string; id: string }>(
      projectPath,
      request.envelope,
      key,
    );
    expect(requestPayload).toEqual({
      op: 'update',
      id: 'rec-1',
      fields: { title: 'Ship it', status: 'done' },
    });

    const record = {
      id: 'rec-1',
      primaryType: 'task',
      typeTags: [],
      issueNumber: 1,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      fields: { title: 'Ship it', status: 'done' },
      system: {
        authorId: 'author-1',
        linkedCommitSha: [],
        linkedPullRequests: [],
        linkedSessionIds: [],
        activity: [],
        comments: [],
      },
    };
    const responseEnvelope = await nodeSeal(projectPath, { outcome: 'ok', record }, key);
    node.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_6',
      projectPath,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const resolved = await updatePromise;
    expect(resolved.fields.status).toBe('done');
  });

  it('defineTrackerType sends a real tracker_write_request(op: defineType) and merges the returned type into the snapshot store', async () => {
    const amk = generateAmk();
    const accountId = 'acct-tracker-definetype';

    node = new FakeNode(relay.url, {
      deviceId: 'node-tracker-7',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_7',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-tracker-7' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const projectPath = '/workspace/proj-7';
    const key = await deriveNodeProjectKey(amk, accountId, projectPath);
    const definePromise = client.defineTrackerType('node_tracker_7', projectPath, {
      id: 'feature-request',
      label: 'Feature Request',
      roles: { title: 'summary', workflowStatus: 'stage' },
    });
    const request = (await node.waitFor((m) => m.type === 'tracker_write_request')) as {
      requestId: string;
    };
    const typeDefinition = {
      id: 'feature-request',
      label: 'Feature Request',
      builtin: false,
      roles: { title: 'summary', workflowStatus: 'stage' },
    };
    const responseEnvelope = await nodeSeal(projectPath, { outcome: 'ok', typeDefinition }, key);
    node.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_tracker_7',
      projectPath,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const resolved = await definePromise;
    expect(resolved).toEqual(typeDefinition);
    const snapshot = client.trackerSnapshotFor('node_tracker_7', projectPath);
    await waitForStore(snapshot, (value) => value.types.some((t) => t.id === 'feature-request'));
  });
});

describe('RelayClient: listTargets (issue #383)', () => {
  it("resolves with the account's targets, marked reachable while the announcing node stays connected", async () => {
    const amk = generateAmk();
    const accountId = 'acct-targets-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targets: [
        { id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] },
        { id: 'ssh_devbox', kind: 'ssh', label: 'devbox', providers: ['claude'] },
      ],
    });
    // Give the relay a beat to record the announce before the client asks.
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-targets-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    expect(targets).toHaveLength(2);
    expect(targets).toEqual(
      expect.arrayContaining([
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: 'This machine',
          kind: 'local',
          reachable: true,
          providers: ['claude'],
        },
        {
          nodeId: 'node_1',
          targetId: 'ssh_devbox',
          label: 'devbox',
          kind: 'ssh',
          reachable: true,
          providers: ['claude'],
        },
      ]),
    );
  });

  it("never resolves with another account's targets", async () => {
    const amk = generateAmk();
    const ownerAccountId = 'acct-targets-owner';
    const intruderAccountId = 'acct-targets-intruder';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-2',
      devicePublicKey: randomBase64(),
      authToken: ownerAccountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_owner',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: intruderAccountId,
      deviceId: 'client-targets-intruder',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    expect(targets).toEqual([]);
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-targets-no-conn',
      deviceId: 'client-targets-no-conn',
    });
    // Deliberately never connected.
    await expect(client.listTargets()).rejects.toThrow(/no open connection/);
  });

  it("passes through a target's latest CPU/RAM/disk reading (issues #253/#269) once its node has pushed a target_status", async () => {
    const amk = generateAmk();
    const accountId = 'acct-targets-health';

    node = new FakeNode(relay.url, {
      deviceId: 'node-targets-health',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_health',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    node.send({
      type: 'target_status',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_health',
      samples: [
        {
          targetId: 'local',
          cpuPercent: 33,
          memPercent: 44,
          memUsedBytes: 4,
          memTotalBytes: 9,
          diskPercent: 55,
          diskUsedBytes: 5,
          diskTotalBytes: 9,
          healthy: true,
          sampledAt: 1_700_000_000_000,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-targets-health',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    const local = targets.find((target) => target.targetId === 'local');
    expect(local?.health).toEqual({
      cpuPercent: 33,
      memPercent: 44,
      memUsedBytes: 4,
      memTotalBytes: 9,
      diskPercent: 55,
      diskUsedBytes: 5,
      diskTotalBytes: 9,
      healthy: true,
      sampledAt: 1_700_000_000_000,
    });
  });
});

describe('RelayClient: build identity (issue #655)', () => {
  let buildRelay: StartedRelay | undefined;

  afterEach(async () => {
    await buildRelay?.close();
    buildRelay = undefined;
  });

  it("surfaces this relay's own buildIdentity, and flags a node whose buildIdentity differs — the middle outcome: allowed and surfaced, not silent and not refused", async () => {
    const relayBuildIdentity: BuildIdentityV1 = { version: '0.4.1', commit: 'relay-sha' };
    buildRelay = await startRelay({ buildIdentity: relayBuildIdentity });

    const amk = generateAmk();
    const accountId = 'acct-build-identity-1';

    const nodeSame = new FakeNode(buildRelay.url, {
      deviceId: 'node-same-device',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      buildIdentity: { ...relayBuildIdentity },
    });
    await nodeSame.ready;
    nodeSame.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_same',
      targets: [{ id: 'local', kind: 'local', label: 'Same build', providers: [] }],
    });

    const nodeDrifted = new FakeNode(buildRelay.url, {
      deviceId: 'node-drifted-device',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      buildIdentity: { version: relayBuildIdentity.version, commit: 'drifted-sha' },
    });
    await nodeDrifted.ready;
    nodeDrifted.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_drifted',
      targets: [{ id: 'local', kind: 'local', label: 'Drifted build', providers: [] }],
    });
    // Give the relay a beat to record both announces before the client asks.
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: buildRelay.url,
      amk,
      accountId,
      deviceId: 'client-build-identity-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const relayBuild = await waitForStore(
      client.relayBuildIdentity,
      (value) => value !== undefined,
    );
    expect(relayBuild).toEqual(relayBuildIdentity);

    const targets = await client.listTargets();
    const sameEntry = targets.find((t) => t.nodeId === 'node_same');
    const driftedEntry = targets.find((t) => t.nodeId === 'node_drifted');
    expect(sameEntry?.reachable).toBe(true);
    expect(driftedEntry?.reachable).toBe(true);

    // Outcome 1: same protocol, same build — nothing to surface.
    expect(buildIdentityMismatch(relayBuild, sameEntry?.build)).toBe(false);
    // Outcome 2, the middle one that does not exist before this change:
    // same protocol, different build — allowed (both nodes connected and
    // are reachable above) AND surfaced.
    expect(buildIdentityMismatch(relayBuild, driftedEntry?.build)).toBe(true);
  });

  it('a node with no buildIdentity at all still connects and lists, with build simply absent (pre-#655 compat)', async () => {
    buildRelay = await startRelay({
      buildIdentity: { version: '0.4.1', commit: 'relay-sha' },
    });
    const amk = generateAmk();
    const accountId = 'acct-build-identity-2';

    const legacyNode = new FakeNode(buildRelay.url, {
      deviceId: 'legacy-node-device',
      devicePublicKey: randomBase64(),
      authToken: accountId,
      // no buildIdentity — a peer that predates #655.
    });
    await legacyNode.ready;
    legacyNode.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_legacy',
      targets: [{ id: 'local', kind: 'local', label: 'Legacy', providers: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: buildRelay.url,
      amk,
      accountId,
      deviceId: 'client-build-identity-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const targets = await client.listTargets();
    const entry = targets.find((t) => t.nodeId === 'node_legacy');
    expect(entry?.reachable).toBe(true);
    expect(entry?.build).toBeUndefined();
  });
});

describe('RelayClient: browseDirectory (SPEC §7.25 directory picker; issue #474)', () => {
  it('resolves with a decrypted directory listing from the owning node, sealed under a per-target key (not the session key)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-dirpicker-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-dirpicker-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-dirpicker-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const browsePromise = client.browseDirectory({
      nodeId: 'node_1',
      targetId: 'local',
      path: '',
    });

    const request = (await node.waitFor((m) => m.type === 'target_fs_list_request')) as {
      type: 'target_fs_list_request';
      nodeId: string;
      targetId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(request.nodeId).toBe('node_1');
    expect(request.targetId).toBe('local');
    expect(Object.keys(request).sort()).toEqual(
      ['envelope', 'nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );

    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const requestPayload = await nodeOpen<{ path: string }>('local', request.envelope, key);
    expect(requestPayload).toEqual({ path: '' });

    const responseEnvelope = await nodeSeal(
      'local',
      {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [
          { name: 'projects', kind: 'dir', size: 0 },
          { name: '.bashrc', kind: 'file', size: 220 },
        ],
      },
      key,
    );
    node.send({
      type: 'target_fs_list_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    const payload = await browsePromise;
    expect(payload).toEqual({
      outcome: 'ok',
      path: '/home/lorenzo',
      entries: [
        { name: 'projects', kind: 'dir', size: 0 },
        { name: '.bashrc', kind: 'file', size: 220 },
      ],
    });
  });

  it('resolves with an error outcome payload rather than rejecting, when the node reports one', async () => {
    const amk = generateAmk();
    const accountId = 'acct-dirpicker-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-dirpicker-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-dirpicker-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const browsePromise = client.browseDirectory({
      nodeId: 'node_2',
      targetId: 'local',
      path: '/root',
    });

    const request = (await node.waitFor((m) => m.type === 'target_fs_list_request')) as {
      requestId: string;
    };
    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const errorEnvelope = await nodeSeal(
      'local',
      { outcome: 'error', path: '/root', message: 'permission denied' },
      key,
    );
    node.send({
      type: 'target_fs_list_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: request.requestId,
      envelope: errorEnvelope,
    });

    const payload = await browsePromise;
    expect(payload).toEqual({ outcome: 'error', path: '/root', message: 'permission denied' });
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-dirpicker-no-conn',
      deviceId: 'client-dirpicker-no-conn',
    });
    // Deliberately never connected.
    await expect(
      client.browseDirectory({ nodeId: 'node_x', targetId: 'local', path: '' }),
    ).rejects.toThrow(/no open connection/);
  });

  it("ignores a target_fs_list_response for another device's own pending request (not addressed to this client)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-dirpicker-sibling';

    node = new FakeNode(relay.url, {
      deviceId: 'node-dirpicker-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_3',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-dirpicker-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const browsePromise = client.browseDirectory(
      { nodeId: 'node_3', targetId: 'local', path: '' },
      200,
    );
    // Swallow the eventual timeout rejection below; the assertion is that it
    // times out at all (never resolved by the foreign reply).
    browsePromise.catch(() => undefined);

    await node.waitFor((m) => m.type === 'target_fs_list_request');
    const key = await deriveNodeTargetKey(amk, accountId, 'local');
    const foreignEnvelope = await nodeSeal('local', { outcome: 'ok', path: '', entries: [] }, key);
    node.send({
      type: 'target_fs_list_response',
      protocolVersion: PROTOCOL_V1,
      targetId: 'local',
      requestId: 'req-not-mine',
      envelope: foreignEnvelope,
    });

    await expect(browsePromise).rejects.toThrow(/timed out/);
  });
});

describe('RelayClient: test runner config (SPEC §7.15; issue #245)', () => {
  it('getTestRunnerConfig resolves with the decrypted saved commands the owning node replies with, sealed under the session key', async () => {
    const amk = generateAmk();
    const accountId = 'acct-runnercfg-get';

    node = new FakeNode(relay.url, {
      deviceId: 'node-runnercfg-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_runnercfg_get', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-runnercfg-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const getPromise = client.getTestRunnerConfig(session.id);

    const request = (await node.waitFor((m) => m.type === 'test_runner_config_get')) as {
      type: 'test_runner_config_get';
      sessionId: string;
      requestId: string;
    };
    expect(request.sessionId).toBe(session.id);
    // No envelope: a plain "which session am I asking about" request carries no content.
    expect(Object.keys(request).sort()).toEqual(
      ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
    );

    const responseEnvelope = await nodeSeal(
      session.id,
      { commands: { test: 'pnpm test', lint: 'pnpm lint' } },
      key,
    );
    node.send({
      type: 'test_runner_config_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(getPromise).resolves.toEqual({ test: 'pnpm test', lint: 'pnpm lint' });
  });

  it('setTestRunnerConfig seals only the submitted commands and resolves with the merged result the node replies with', async () => {
    const amk = generateAmk();
    const accountId = 'acct-runnercfg-set';

    node = new FakeNode(relay.url, {
      deviceId: 'node-runnercfg-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_runnercfg_set', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-runnercfg-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const setPromise = client.setTestRunnerConfig(session.id, { build: 'pnpm build' });

    const request = (await node.waitFor((m) => m.type === 'test_runner_config_set')) as {
      type: 'test_runner_config_set';
      sessionId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    const requestPayload = await nodeOpen<{ commands: unknown }>(session.id, request.envelope, key);
    expect(requestPayload).toEqual({ commands: { build: 'pnpm build' } });

    const responseEnvelope = await nodeSeal(
      session.id,
      { commands: { test: 'pnpm test', build: 'pnpm build' } },
      key,
    );
    node.send({
      type: 'test_runner_config_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(setPromise).resolves.toEqual({ test: 'pnpm test', build: 'pnpm build' });
  });

  it('detectTestRunnerConfig resolves with the suggestions from a test_runner_config_detected reply, never a test_runner_config_result', async () => {
    const amk = generateAmk();
    const accountId = 'acct-runnercfg-detect';

    node = new FakeNode(relay.url, {
      deviceId: 'node-runnercfg-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_runnercfg_detect', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-runnercfg-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const detectPromise = client.detectTestRunnerConfig(session.id);

    const request = (await node.waitFor((m) => m.type === 'test_runner_config_detect')) as {
      type: 'test_runner_config_detect';
      sessionId: string;
      requestId: string;
    };
    expect(Object.keys(request).sort()).toEqual(
      ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
    );

    const responseEnvelope = await nodeSeal(
      session.id,
      { suggestions: { test: 'pnpm test' } },
      key,
    );
    node.send({
      type: 'test_runner_config_detected',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(detectPromise).resolves.toEqual({ test: 'pnpm test' });
  });

  it('rejects immediately when there is no open connection, for all three calls', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-runnercfg-no-conn',
      deviceId: 'client-runnercfg-no-conn',
    });
    // Deliberately never connected.
    await expect(client.getTestRunnerConfig('sess_x')).rejects.toThrow(/no open connection/);
    await expect(client.setTestRunnerConfig('sess_x', {})).rejects.toThrow(/no open connection/);
    await expect(client.detectTestRunnerConfig('sess_x')).rejects.toThrow(/no open connection/);
  });
});

describe('RelayClient: permission policy (SPEC §7.17; issue #751)', () => {
  it('getPermissionPolicy resolves with the decrypted saved policy the owning node replies with, sealed under the session key', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permpolicy-get';

    node = new FakeNode(relay.url, {
      deviceId: 'node-permpolicy-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_permpolicy_get', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-permpolicy-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const getPromise = client.getPermissionPolicy(session.id);

    const request = (await node.waitFor((m) => m.type === 'permission_policy_get')) as {
      type: 'permission_policy_get';
      sessionId: string;
      requestId: string;
    };
    expect(request.sessionId).toBe(session.id);
    // No envelope: a plain "which session am I asking about" request carries no content.
    expect(Object.keys(request).sort()).toEqual(
      ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
    );

    const policy: PermissionPolicyV1 = {
      command: { allow: [], deny: ['rm -rf *'] },
      network: { allow: [], deny: [] },
    };
    const responseEnvelope = await nodeSeal(session.id, { policy }, key);
    node.send({
      type: 'permission_policy_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(getPromise).resolves.toEqual(policy);
  });

  it('setPermissionPolicy seals the full policy (never a partial patch) and resolves with what the node replies with', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permpolicy-set';

    node = new FakeNode(relay.url, {
      deviceId: 'node-permpolicy-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_permpolicy_set', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-permpolicy-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const newPolicy: PermissionPolicyV1 = {
      command: { allow: ['pnpm *'], deny: [] },
      network: { allow: [], deny: ['*.internal'] },
    };
    const setPromise = client.setPermissionPolicy(session.id, newPolicy);

    const request = (await node.waitFor((m) => m.type === 'permission_policy_set')) as {
      type: 'permission_policy_set';
      sessionId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    const requestPayload = await nodeOpen<{ policy: unknown }>(session.id, request.envelope, key);
    expect(requestPayload).toEqual({ policy: newPolicy });

    const responseEnvelope = await nodeSeal(session.id, { policy: newPolicy }, key);
    node.send({
      type: 'permission_policy_result',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      requestId: request.requestId,
      envelope: responseEnvelope,
    });

    await expect(setPromise).resolves.toEqual(newPolicy);
  });

  it('rejects immediately when there is no open connection, for both calls', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-permpolicy-no-conn',
      deviceId: 'client-permpolicy-no-conn',
    });
    // Deliberately never connected.
    await expect(client.getPermissionPolicy('sess_x')).rejects.toThrow(/no open connection/);
    await expect(
      client.setPermissionPolicy('sess_x', {
        command: { allow: [], deny: [] },
        network: { allow: [], deny: [] },
      }),
    ).rejects.toThrow(/no open connection/);
  });

  it('onPermissionPolicyViolation fires with the decrypted violation, naming the deny rule (D3-4 attribution)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-permpolicy-violation';

    node = new FakeNode(relay.url, {
      deviceId: 'node-permpolicy-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({
      id: 'sess_permpolicy_violation',
      accountId,
      targetId: 'local',
    });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-permpolicy-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    // Establishes the relay subscription this client needs to receive a
    // fanned-out permission_policy_violation — getPermissionPolicy is
    // deliberately never answered here; only its subscribe side effect
    // matters (mirrors how the real PermissionPolicyPanel already
    // subscribes on mount via its own initial load).
    client.getPermissionPolicy(session.id).catch(() => undefined);
    await node.waitFor((m) => m.type === 'permission_policy_get');

    const violationPromise = new Promise<unknown>((resolve) => {
      const unsubscribe = client!.onPermissionPolicyViolation(session.id, (violation) => {
        unsubscribe();
        resolve(violation);
      });
    });

    const violationPayload = {
      reason: {
        kind: 'permission_policy' as const,
        dimension: 'command' as const,
        rule: 'rm *',
        matched: 'rm -rf /',
      },
      surface: 'terminal' as const,
      command: 'rm -rf /',
      timestamp: '2026-08-06T00:00:00.000Z',
    };
    const violationEnvelope = await nodeSeal(session.id, violationPayload, key);
    node.send({
      type: 'permission_policy_violation',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      envelope: violationEnvelope,
    });

    await expect(violationPromise).resolves.toEqual(violationPayload);
  });
});

describe('RelayClient: discoverSshHosts (redesign v2 §3.2 add-target candidate picker; issue #475)', () => {
  it("resolves with the acting node's discovered SSH candidates, plain fields only (no envelope)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-sshdisco-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-sshdisco-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-sshdisco-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const discoverPromise = client.discoverSshHosts('node_1');

    const request = (await node.waitFor((m) => m.type === 'ssh_discovery_request')) as {
      type: 'ssh_discovery_request';
      nodeId: string;
      requestId: string;
    };
    expect(request.nodeId).toBe('node_1');
    expect(Object.keys(request).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'type'].sort(),
    );

    node.send({
      type: 'ssh_discovery_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      requestId: request.requestId,
      result: {
        outcome: 'ok',
        candidates: [
          {
            alias: 'devbox',
            hostName: '100.87.202.117',
            user: 'lorenzo',
            port: 22,
            identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
          },
        ],
        agent: { available: true, socketPath: '/tmp/ssh-agent.sock', identities: [] },
        requiresManualEntry: false,
      },
    });

    const result = await discoverPromise;
    expect(result).toEqual({
      outcome: 'ok',
      candidates: [
        {
          alias: 'devbox',
          hostName: '100.87.202.117',
          user: 'lorenzo',
          port: 22,
          identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
        },
      ],
      agent: { available: true, socketPath: '/tmp/ssh-agent.sock', identities: [] },
      requiresManualEntry: false,
    });
  });

  it('resolves with an error outcome rather than rejecting, when the node reports one', async () => {
    const amk = generateAmk();
    const accountId = 'acct-sshdisco-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-sshdisco-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-sshdisco-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const discoverPromise = client.discoverSshHosts('node_2');
    const request = (await node.waitFor((m) => m.type === 'ssh_discovery_request')) as {
      requestId: string;
    };
    node.send({
      type: 'ssh_discovery_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_2',
      requestId: request.requestId,
      result: { outcome: 'error', message: 'ssh config unreadable' },
    });

    const result = await discoverPromise;
    expect(result).toEqual({ outcome: 'error', message: 'ssh config unreadable' });
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-sshdisco-no-conn',
      deviceId: 'client-sshdisco-no-conn',
    });
    // Deliberately never connected.
    await expect(client.discoverSshHosts('node_x')).rejects.toThrow(/no open connection/);
  });

  it("ignores an ssh_discovery_response for another device's own pending request (not addressed to this client)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-sshdisco-sibling';

    node = new FakeNode(relay.url, {
      deviceId: 'node-sshdisco-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_3',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-sshdisco-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const discoverPromise = client.discoverSshHosts('node_3', 200);
    // Swallow the eventual timeout rejection below; the assertion is that it
    // times out at all (never resolved by the foreign reply).
    discoverPromise.catch(() => undefined);

    await node.waitFor((m) => m.type === 'ssh_discovery_request');
    node.send({
      type: 'ssh_discovery_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_3',
      requestId: 'req-not-mine',
      result: {
        outcome: 'ok',
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      },
    });

    await expect(discoverPromise).rejects.toThrow(/timed out/);
  });
});

describe('RelayClient: decommissionTarget / updateTarget (redesign v2 §3.3 connection management; issue #476)', () => {
  it('decommissionTarget sends a plain decommission_target_request and resolves with the ok result, no envelope', async () => {
    const amk = generateAmk();
    const accountId = 'acct-connmgmt-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-connmgmt-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-connmgmt-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const decommissionPromise = client.decommissionTarget({
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
    });

    const request = (await node.waitFor((m) => m.type === 'decommission_target_request')) as {
      type: 'decommission_target_request';
      nodeId: string;
      targetId: string;
      requestId: string;
    };
    expect(request.nodeId).toBe('node_1');
    expect(request.targetId).toBe('ssh:devbox');
    expect(Object.keys(request).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );

    node.send({
      type: 'decommission_target_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      targetId: 'ssh:devbox',
      requestId: request.requestId,
      ok: true,
      result: {
        unitWasInstalled: true,
        unitStopped: true,
        unitDisabled: true,
        deviceKeyRevoked: true,
        filesRemoved: false,
      },
      message: 'decommissioned "ssh:devbox"',
    });

    const response = await decommissionPromise;
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      unitWasInstalled: true,
      unitStopped: true,
      unitDisabled: true,
      deviceKeyRevoked: true,
      filesRemoved: false,
    });
  });

  it('decommissionTarget resolves with ok: false rather than rejecting, when the node reports a failure', async () => {
    const amk = generateAmk();
    const accountId = 'acct-connmgmt-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-connmgmt-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_2',
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-connmgmt-2',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const decommissionPromise = client.decommissionTarget({
      nodeId: 'node_2',
      targetId: 'ssh:unreachable',
    });
    const request = (await node.waitFor((m) => m.type === 'decommission_target_request')) as {
      requestId: string;
    };
    node.send({
      type: 'decommission_target_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_2',
      targetId: 'ssh:unreachable',
      requestId: request.requestId,
      ok: false,
      message: 'connect ECONNREFUSED',
    });

    const response = await decommissionPromise;
    expect(response.ok).toBe(false);
    expect(response.message).toBe('connect ECONNREFUSED');
  });

  it('decommissionTarget rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-connmgmt-no-conn',
      deviceId: 'client-connmgmt-no-conn',
    });
    await expect(
      client.decommissionTarget({ nodeId: 'node_x', targetId: 'ssh:devbox' }),
    ).rejects.toThrow(/no open connection/);
  });

  it('updateTarget sends a plain target_update_request and resolves with the status/version fields, no envelope', async () => {
    const amk = generateAmk();
    const accountId = 'acct-connmgmt-3';

    node = new FakeNode(relay.url, {
      deviceId: 'node-connmgmt-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_3',
      targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-connmgmt-3',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const updatePromise = client.updateTarget({ nodeId: 'node_3', targetId: 'ssh:devbox' });

    const request = (await node.waitFor((m) => m.type === 'target_update_request')) as {
      type: 'target_update_request';
      nodeId: string;
      targetId: string;
      requestId: string;
    };
    expect(request.nodeId).toBe('node_3');
    expect(request.targetId).toBe('ssh:devbox');
    expect(Object.keys(request).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
    );

    node.send({
      type: 'target_update_response',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_3',
      targetId: 'ssh:devbox',
      requestId: request.requestId,
      ok: true,
      status: 'current',
      remoteVersion: '2.0.0',
      installedVersion: '2.0.0',
      message: '"ssh:devbox" is now at 2.0.0',
    });

    const response = await updatePromise;
    expect(response.ok).toBe(true);
    expect(response.status).toBe('current');
    expect(response.installedVersion).toBe('2.0.0');
  });

  it('updateTarget rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-connmgmt-update-no-conn',
      deviceId: 'client-connmgmt-update-no-conn',
    });
    await expect(client.updateTarget({ nodeId: 'node_x', targetId: 'ssh:devbox' })).rejects.toThrow(
      /no open connection/,
    );
  });
});

describe('RelayClient: archiveSession (SPEC §7.2 board archive; issue #512)', () => {
  it('archiveSession sends a plain session_archive_request and resolves once outcome: "ok" comes back, dropping the session from the store', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-archive-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_archive_1', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'Archive me', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-archive-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (sessions) => sessions.some((s) => s.id === session.id));

    const archivePromise = client.archiveSession(session.id, { removeWorktree: true });

    const request = (await node.waitFor((m) => m.type === 'session_archive_request')) as {
      type: 'session_archive_request';
      requestId: string;
      sessionId: string;
      removeWorktree: boolean;
    };
    expect(request.sessionId).toBe(session.id);
    expect(request.removeWorktree).toBe(true);
    expect(Object.keys(request).sort()).toEqual(
      ['protocolVersion', 'removeWorktree', 'requestId', 'sessionId', 'type'].sort(),
    );

    node.send({
      type: 'session_archive_response',
      protocolVersion: PROTOCOL_V1,
      requestId: request.requestId,
      sessionId: session.id,
      result: { outcome: 'ok' },
    });

    await expect(archivePromise).resolves.toBeUndefined();
    await waitForStore(client.sessions, (sessions) => !sessions.some((s) => s.id === session.id));
  });

  it('archiveSession rejects with the node-reported message when outcome: "error" comes back, and leaves the session on the board', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-archive-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_archive_2', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'Archive me too', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-archive-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (sessions) => sessions.some((s) => s.id === session.id));

    const archivePromise = client.archiveSession(session.id, { removeWorktree: true });
    const request = (await node.waitFor((m) => m.type === 'session_archive_request')) as {
      requestId: string;
    };
    node.send({
      type: 'session_archive_response',
      protocolVersion: PROTOCOL_V1,
      requestId: request.requestId,
      sessionId: session.id,
      result: { outcome: 'error', message: 'git worktree remove failed: exit code 128' },
    });

    await expect(archivePromise).rejects.toThrow('git worktree remove failed: exit code 128');
    // A failed archive never drops the session — it is still on the board.
    expect(get(client.sessions).some((s) => s.id === session.id)).toBe(true);
  });

  it('archiveSession rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-archive-no-conn',
      deviceId: 'client-archive-no-conn',
    });
    await expect(
      client.archiveSession('sess_nonexistent', { removeWorktree: true }),
    ).rejects.toThrow(/no open connection/);
  });

  it('drops a session from the store on any outcome: "ok" response, even one this client never itself requested (account-wide fan-out, issue #512)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-archive-fanout';

    node = new FakeNode(relay.url, {
      deviceId: 'node-archive-fanout',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_archive_fanout', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'Archived elsewhere', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-archive-fanout',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (sessions) => sessions.some((s) => s.id === session.id));

    // This client never called archiveSession for this sessionId — this is
    // the relay's own account-wide publish for another device's request
    // (packages/relay/src/relay.ts). The requestId matches nothing this
    // client is waiting on.
    node.send({
      type: 'session_archive_response',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-from-another-device',
      sessionId: session.id,
      result: { outcome: 'ok' },
    });

    await waitForStore(client.sessions, (sessions) => !sessions.some((s) => s.id === session.id));
  });
});

describe('RelayClient: forkSession (design spec `2026-08-05-zed-parity-decisions.md` §3 C6-2; issue #746)', () => {
  it('sends a session_fork_request derived from the source session\'s own known meta, and resolves with the new session id once outcome: "ok" comes back', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fork-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fork-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    // The node must have announced its targets before a fork can resolve
    // one: `forkSession` routes by `targetId`, and the relay refuses an
    // unknown target exactly as it does for `createSession`, whose own test
    // above seeds the same announce.
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_fork_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = makeSessionMeta({ id: 'sess_fork_source', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'Fork me', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fork-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (sessions) => sessions.some((s) => s.id === session.id));

    const forkPromise = client.forkSession(session.id, 'turn:1');

    const request = (await node.waitFor((m) => m.type === 'session_fork_request')) as {
      type: 'session_fork_request';
      requestId: string;
      sessionId: string;
      sourceSessionId: string;
      targetId: string;
      provider: string;
      privateEnvelope: EncryptedEnvelope;
    };
    expect(request.sourceSessionId).toBe(session.id);
    expect(request.targetId).toBe('local');
    expect(request.provider).toBe(session.provider);
    expect(Object.keys(request).sort()).toEqual(
      [
        'privateEnvelope',
        'protocolVersion',
        'provider',
        'requestId',
        'sessionId',
        'sourceSessionId',
        'targetId',
        'type',
      ].sort(),
    );

    const forkKey = await deriveNodeSessionKey(amk, accountId, request.sessionId);
    const decryptedMeta = await nodeOpen<{
      title: string;
      projectPath: string;
      forkFromTurnId: string;
    }>(request.sessionId, request.privateEnvelope, forkKey);
    expect(decryptedMeta.projectPath).toBe('/proj');
    expect(decryptedMeta.forkFromTurnId).toBe('turn:1');
    expect(decryptedMeta.title).toBe('Fork me (fork)');

    node.send({
      type: 'session_fork_response',
      protocolVersion: PROTOCOL_V1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      result: { outcome: 'ok' },
    });

    await expect(forkPromise).resolves.toBe(request.sessionId);
  });

  it('rejects with the node-reported refusal reason when outcome: "error" comes back', async () => {
    const amk = generateAmk();
    const accountId = 'acct-fork-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-fork-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_fork_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = makeSessionMeta({ id: 'sess_fork_source_2', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'Fork me too', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-fork-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (sessions) => sessions.some((s) => s.id === session.id));

    const forkPromise = client.forkSession(session.id, 'turn:1');
    const request = (await node.waitFor((m) => m.type === 'session_fork_request')) as {
      requestId: string;
      sessionId: string;
    };
    node.send({
      type: 'session_fork_response',
      protocolVersion: PROTOCOL_V1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      result: { outcome: 'error', message: 'no active agent for the source session' },
    });

    await expect(forkPromise).rejects.toThrow('no active agent for the source session');
  });

  it('rejects immediately for an unknown source session, sending nothing over the wire', async () => {
    const amk = generateAmk();

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-fork-unknown',
      deviceId: 'client-fork-unknown',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await expect(client.forkSession('sess_does_not_exist', 'turn:1')).rejects.toThrow(
      /unknown source session/,
    );
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-fork-no-conn',
      deviceId: 'client-fork-no-conn',
    });
    await expect(client.forkSession('sess_whatever', 'turn:1')).rejects.toThrow(
      /not connected to the relay/,
    );
  });
});

describe('RelayClient: interactive PTY terminals (SPEC §7.5; issues #172/#173/#174)', () => {
  it('openTerminal sends an encrypted terminal_open, flips to open on terminal_opened ok, streams decrypted output to onTerminalOutput listeners, and resize/close send their own encrypted/plain frames', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_1', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    expect(get(terminals).get(terminalId)?.status).toBe('opening');

    const openRequest = (await node.waitFor((m) => m.type === 'terminal_open')) as {
      type: 'terminal_open';
      sessionId: string;
      targetId: string;
      terminalId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(openRequest.sessionId).toBe(session.id);
    expect(openRequest.targetId).toBe('local');
    expect(openRequest.terminalId).toBe(terminalId);
    expect(Object.keys(openRequest).sort()).toEqual(
      [
        'envelope',
        'protocolVersion',
        'requestId',
        'sessionId',
        'targetId',
        'terminalId',
        'type',
      ].sort(),
    );
    const openPayload = await nodeOpen<{ cols: number; rows: number }>(
      session.id,
      openRequest.envelope,
      key,
    );
    expect(openPayload).toEqual({ cols: 80, rows: 24 });

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      requestId: openRequest.requestId,
      envelope: await nodeSeal(
        session.id,
        { outcome: 'ok', cwd: '/home/dev/project', shell: '/bin/zsh' },
        key,
      ),
    });
    await waitForStore(terminals, (value) => value.get(terminalId)?.status === 'open');
    // Issue #669: the terminal dock's chrome reads these off the store —
    // real values carried straight from the node's own reply, never guessed
    // client-side.
    expect(get(terminals).get(terminalId)).toMatchObject({
      cwd: '/home/dev/project',
      shell: '/bin/zsh',
    });

    // Output: node -> client, decrypted and fanned out to onTerminalOutput.
    const received: Uint8Array[] = [];
    const unsubscribe = client.onTerminalOutput(session.id, terminalId, (chunk) => {
      received.push(chunk);
    });
    const outputBytes = new TextEncoder().encode('hello from the shell');
    node.send({
      type: 'terminal_output',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      envelope: await nodeSeal(
        session.id,
        { data: Buffer.from(outputBytes).toString('base64') },
        key,
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe('hello from the shell');
    unsubscribe();

    // Input: client -> node, encrypted, base64 bytes inside.
    client.sendTerminalInput(session.id, terminalId, 'echo hi\n');
    const inputMessage = (await node.waitFor((m) => m.type === 'terminal_input')) as {
      type: 'terminal_input';
      sessionId: string;
      terminalId: string;
      envelope: EncryptedEnvelope;
    };
    expect(Object.keys(inputMessage).sort()).toEqual(
      ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );
    const inputPayload = await nodeOpen<{ data: string }>(session.id, inputMessage.envelope, key);
    expect(Buffer.from(inputPayload.data, 'base64').toString('utf8')).toBe('echo hi\n');

    // Resize: client -> node, encrypted.
    client.resizeTerminal(session.id, terminalId, 120, 40);
    const resizeMessage = (await node.waitFor((m) => m.type === 'terminal_resize')) as {
      type: 'terminal_resize';
      envelope: EncryptedEnvelope;
    };
    const resizePayload = await nodeOpen<{ cols: number; rows: number }>(
      session.id,
      resizeMessage.envelope,
      key,
    );
    expect(resizePayload).toEqual({ cols: 120, rows: 40 });

    // Close: client -> node, no envelope.
    client.closeTerminal(session.id, terminalId);
    const closeMessage = await node.waitFor((m) => m.type === 'terminal_close');
    expect(Object.keys(closeMessage).sort()).toEqual(
      ['protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );

    // terminal_closed: node -> client, flips status to closed with a reason.
    node.send({
      type: 'terminal_closed',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      envelope: await nodeSeal(session.id, { reason: 'closed_by_client' }, key),
    });
    const closedState = await waitForStore(
      terminals,
      (value) => value.get(terminalId)?.status === 'closed',
    );
    expect(closedState.get(terminalId)?.closedReason).toBe('closed_by_client');
  });

  it('a failed terminal_open (error outcome) flips the terminal to error with the node-supplied message', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_2', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    const openRequest = (await node.waitFor((m) => m.type === 'terminal_open')) as {
      type: 'terminal_open';
      requestId: string;
    };

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId,
      requestId: openRequest.requestId,
      envelope: await nodeSeal(
        session.id,
        { outcome: 'error', message: 'no shell available' },
        key,
      ),
    });

    const errored = await waitForStore(
      terminals,
      (value) => value.get(terminalId)?.status === 'error',
    );
    expect(errored.get(terminalId)?.error).toBe('no shell available');
  });

  it("a client ignores a terminal_opened for another device's own pending request on the same session (fanned out, not addressed)", async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-3';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_3', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalId = client.openTerminal(session.id, 80, 24);
    await node.waitFor((m) => m.type === 'terminal_open'); // this client's own request

    node.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId: 'sibling-terminal',
      requestId: 'req-not-mine',
      envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(get(terminals).get(terminalId)?.status).toBe('opening');
    expect(get(terminals).has('sibling-terminal')).toBe(false);
  });

  it('opening a second terminal for the same session is independent of the first (issue #173: multiple terminals per session)', async () => {
    const amk = generateAmk();
    const accountId = 'acct-term-4';

    node = new FakeNode(relay.url, {
      deviceId: 'node-term-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_term_4', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-term-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const terminals = client.terminalsFor(session.id);
    const terminalA = client.openTerminal(session.id, 80, 24);
    const terminalB = client.openTerminal(session.id, 80, 24);
    expect(terminalA).not.toBe(terminalB);

    const deadline = Date.now() + 3000;
    while (node.messages.filter((msg) => msg.type === 'terminal_open').length < 2) {
      if (Date.now() > deadline) throw new Error('timed out waiting for both terminal_open frames');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const opens = node.messages.filter((msg) => msg.type === 'terminal_open') as Array<{
      type: 'terminal_open';
      terminalId: string;
      requestId: string;
    }>;

    for (const request of opens) {
      node!.send({
        type: 'terminal_opened',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        terminalId: request.terminalId,
        requestId: request.requestId,
        envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
      });
    }

    await waitForStore(
      terminals,
      (value) => value.get(terminalA)?.status === 'open' && value.get(terminalB)?.status === 'open',
    );

    // Closing terminalA must not affect terminalB's state.
    client.closeTerminal(session.id, terminalA);
    node!.send({
      type: 'terminal_closed',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      terminalId: terminalA,
      envelope: await nodeSeal(session.id, { reason: 'closed_by_client' }, key),
    });
    await waitForStore(terminals, (value) => value.get(terminalA)?.status === 'closed');
    expect(get(terminals).get(terminalB)?.status).toBe('open');
  });
});

describe('RelayClient: test/lint/build runner (SPEC §7.15; issue #244)', () => {
  it('startRun sends an encrypted run_start, flips to running on run_started ok, streams decrypted output to onRunOutput listeners, and run_exit settles the run with its outcome/exitCode', async () => {
    const amk = generateAmk();
    const accountId = 'acct-run-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-run-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_run_1', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-run-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const runs = client.runsFor(session.id);
    const runId = client.startRun(session.id, 'test');
    expect(get(runs).get(runId)).toEqual({ runId, kind: 'test', status: 'starting' });

    const startRequest = (await node.waitFor((m) => m.type === 'run_start')) as {
      type: 'run_start';
      sessionId: string;
      targetId: string;
      runId: string;
      requestId: string;
      envelope: EncryptedEnvelope;
    };
    expect(startRequest.sessionId).toBe(session.id);
    expect(startRequest.targetId).toBe('local');
    expect(startRequest.runId).toBe(runId);
    expect(Object.keys(startRequest).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'runId', 'sessionId', 'targetId', 'type'].sort(),
    );
    const startPayload = await nodeOpen<{ kind: string }>(session.id, startRequest.envelope, key);
    expect(startPayload).toEqual({ kind: 'test' });

    node.send({
      type: 'run_started',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      runId,
      requestId: startRequest.requestId,
      envelope: await nodeSeal(session.id, { outcome: 'ok' }, key),
    });
    await waitForStore(runs, (value) => value.get(runId)?.status === 'running');

    // Output: node -> client, decrypted and fanned out to onRunOutput.
    const received: Uint8Array[] = [];
    const unsubscribe = client.onRunOutput(session.id, runId, (chunk) => {
      received.push(chunk);
    });
    const outputBytes = new TextEncoder().encode('PASS src/foo.test.ts');
    node.send({
      type: 'run_output',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      runId,
      envelope: await nodeSeal(
        session.id,
        { data: Buffer.from(outputBytes).toString('base64') },
        key,
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe('PASS src/foo.test.ts');
    unsubscribe();

    // run_exit: node -> client, settles the run's reactive state.
    node.send({
      type: 'run_exit',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      runId,
      envelope: await nodeSeal(session.id, { outcome: 'pass', exitCode: 0 }, key),
    });
    await waitForStore(runs, (value) => value.get(runId)?.status === 'exited');
    expect(get(runs).get(runId)).toEqual({
      runId,
      kind: 'test',
      status: 'exited',
      outcome: 'pass',
      exitCode: 0,
      reason: undefined,
      cancelled: undefined,
    });
  });

  it('run_started outcome: error flips the run to status: error with the message, without ever spawning', async () => {
    const amk = generateAmk();
    const accountId = 'acct-run-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-run-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_run_2', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-run-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const runs = client.runsFor(session.id);
    const runId = client.startRun(session.id, 'lint');
    const startRequest = (await node.waitFor((m) => m.type === 'run_start')) as {
      type: 'run_start';
      requestId: string;
    };

    node.send({
      type: 'run_started',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      runId,
      requestId: startRequest.requestId,
      envelope: await nodeSeal(
        session.id,
        { outcome: 'error', message: 'no lint command configured for this project' },
        key,
      ),
    });
    await waitForStore(runs, (value) => value.get(runId)?.status === 'error');
    expect(get(runs).get(runId)?.error).toBe('no lint command configured for this project');
  });

  it('cancelRun sends a plain run_cancel — no envelope, since cancelling carries no content', async () => {
    const amk = generateAmk();
    const accountId = 'acct-run-3';

    node = new FakeNode(relay.url, {
      deviceId: 'node-run-3',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_run_3', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-run-3' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const runId = client.startRun(session.id, 'build');
    await node.waitFor((m) => m.type === 'run_start');

    client.cancelRun(session.id, runId);
    const cancelMessage = (await node.waitFor((m) => m.type === 'run_cancel')) as {
      type: 'run_cancel';
      sessionId: string;
      runId: string;
    };
    expect(cancelMessage.sessionId).toBe(session.id);
    expect(cancelMessage.runId).toBe(runId);
    expect(Object.keys(cancelMessage).sort()).toEqual(
      ['protocolVersion', 'runId', 'sessionId', 'type'].sort(),
    );
  });

  it('startRun called twice (even for the same kind) generates two independent runIds', async () => {
    const amk = generateAmk();
    const accountId = 'acct-run-4';

    node = new FakeNode(relay.url, {
      deviceId: 'node-run-4',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_run_4', accountId, targetId: 'local' });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 't', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-run-4' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length > 0);

    const runA = client.startRun(session.id, 'test');
    const runB = client.startRun(session.id, 'test');
    expect(runA).not.toBe(runB);

    const runs = client.runsFor(session.id);
    await waitForStore(runs, (value) => value.has(runA) && value.has(runB));
  });
});

/**
 * Applies Better Auth's own schema to a hermetic sqlite database — the same
 * call `packages/relay/src/auth.ts`'s `migrateBetterAuth` makes
 * (`better-auth/db/migration`), inlined rather than imported because it
 * isn't part of `@loombox/relay`'s public `index.ts` export surface and
 * this PR does not touch `packages/relay` to add it (mirrors
 * `auth-store.test.ts`'s identical helper/rationale).
 */
async function migrateBetterAuth(auth: RelayAuth): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** `ws://host:port/ws` -> `http://host:port` (Better Auth's routes live on the same Fastify instance). */
function httpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

describe('RelayClient wired to a real Better Auth account (issue #126, the real-auth wave)', () => {
  let authedRelay: StartedRelay | undefined;

  afterEach(async () => {
    await authedRelay?.close();
    authedRelay = undefined;
  });

  it('an AuthStore-issued bearer token authenticates the WS handshake, the relay resolves it to the SAME accountId as the client, and a persisted (not injected) AMK decrypts the account-scoped session list', async () => {
    // A relay configured with a REAL Better Auth instance (hermetic:
    // in-memory sqlite + the email-password test escape hatch), unlike
    // every other test in this file, which uses `startRelay()`'s default
    // `deriveAccountIdStub`. This is the actual production wiring
    // (`main.ts` supplies `resolveAccountIdViaBetterAuth` the same way once
    // `DATABASE_URL` is set), exercised end to end here.
    const database = new Database(':memory:');
    const auth = createRelayAuth({
      database,
      baseURL: 'http://127.0.0.1:0',
      secret: 'hermetic-test-secret-hermetic-test-secret',
      enableEmailPasswordForTests: true,
    });
    await migrateBetterAuth(auth);
    authedRelay = await startRelay({ auth });

    // 1. The client obtains a real bearer token + its accountId from the
    // relay's own Better Auth over real HTTP — no injected/stubbed token.
    const authStore = new AuthStore({
      relayBaseUrl: httpBaseUrl(authedRelay.url),
      storage: createInMemoryAuthStorage(),
    });
    const session = await authStore.signUpWithEmailPassword(
      'client-auth-wave@example.com',
      'correct horse battery staple',
    );
    expect(session.token).toBeTruthy();
    expect(session.accountId).toBeTruthy();

    // 2. The client generates + persists its own AMK on-device (not
    // injected via options) — a second lookup for the same account returns
    // the identical key, proving persistence rather than a fresh random
    // value each call.
    const amkStorage = createInMemoryAmkStorage();
    const amk = loadOrCreateAmk(session.accountId, amkStorage);
    expect(loadOrCreateAmk(session.accountId, amkStorage)).toEqual(amk);

    // A node, independently, announces a session under that SAME accountId
    // (as the relay's real Better Auth resolved it) — proving the node and
    // this client, which never coordinated directly, agree on the account.
    // The relay's real resolver (not the dev stub every other test in this
    // file relies on) applies to node connections too, so the node
    // authenticates with its OWN real bearer token — a second "device"
    // signing in as the same self-hosting operator, exactly SPEC §8's model.
    const nodeAuthStore = new AuthStore({
      relayBaseUrl: httpBaseUrl(authedRelay.url),
      storage: createInMemoryAuthStorage(),
    });
    // Same underlying account, a second "device" signing back in — Better
    // Auth issues its own distinct session/bearer, but resolves to the same
    // accountId (see `auth-store.test.ts`'s equivalent client-only test).
    const nodeSession = await nodeAuthStore.signInWithEmailPassword(
      'client-auth-wave@example.com',
      'correct horse battery staple',
    );
    expect(nodeSession.accountId).toBe(session.accountId);

    node = new FakeNode(authedRelay.url, {
      deviceId: 'node-real-auth',
      devicePublicKey: randomBase64(),
      authToken: nodeSession.token,
    });
    await node.ready;

    const sessionMeta = makeSessionMeta({ id: 'sess_real_auth', accountId: session.accountId });
    const key = await deriveNodeSessionKey(amk, session.accountId, sessionMeta.id);
    const privateEnvelope = await nodeSeal(
      sessionMeta.id,
      { title: 'wired for real', projectPath: '/proj' },
      key,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionMeta,
      privateEnvelope,
    });

    // 3. The client connects using the REAL bearer token as the WS
    // handshake's authToken (not accountId doubling as a stub) and the
    // persisted AMK (not one handed in via options for this test to share).
    client = new RelayClient({
      relayUrl: authedRelay.url,
      amk,
      accountId: session.accountId,
      authToken: session.token,
      deviceId: 'client-real-auth',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'open');
    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([{ ...sessionMeta, title: 'wired for real', projectPath: '/proj' }]);
  });

  it('rejects the WS handshake outright when authToken is not a valid Better Auth bearer', async () => {
    const database = new Database(':memory:');
    const auth = createRelayAuth({
      database,
      baseURL: 'http://127.0.0.1:0',
      secret: 'hermetic-test-secret-hermetic-test-secret',
      enableEmailPasswordForTests: true,
    });
    await migrateBetterAuth(auth);
    authedRelay = await startRelay({ auth });

    client = new RelayClient({
      relayUrl: authedRelay.url,
      amk: generateAmk(),
      accountId: 'whatever-this-is-ignored-by-the-real-resolver',
      authToken: 'not-a-real-bearer-token',
      deviceId: 'client-rejected',
    });
    client.connect();

    await waitForStore(client.status, (status) => status === 'error' || status === 'closed');
  });
});

describe('RelayClient: cross-project attention inbox (SPEC §7.13; issues #167/#168/#169)', () => {
  it('aggregates a pending permission request and an awaiting_input session across sessions, sorted oldest-waiting first, and stays consistent with the session-scoped queue', async () => {
    const amk = generateAmk();
    const accountId = 'acct-inbox';

    node = new FakeNode(relay.url, {
      deviceId: 'node-inbox',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const sessionA = makeSessionMeta({ id: 'sess_inbox_a', accountId });
    const sessionB = makeSessionMeta({ id: 'sess_inbox_b', accountId });
    const keyA = await deriveNodeSessionKey(amk, accountId, sessionA.id);
    const keyB = await deriveNodeSessionKey(amk, accountId, sessionB.id);
    const privateA = await nodeSeal(
      sessionA.id,
      { title: 'Fix the bug', projectPath: '/proj-a' },
      keyA,
    );
    const privateB = await nodeSeal(
      sessionB.id,
      { title: 'Add feature', projectPath: '/proj-b' },
      keyB,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionA,
      privateEnvelope: privateA,
    });
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionB,
      privateEnvelope: privateB,
    });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-inbox' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length === 2);

    // Calling attentionInbox() subscribes BOTH sessions even though neither
    // has been opened via transcriptFor/permissionQueueFor — the whole
    // point of a cross-session view. Wait for both subscription-confirming
    // session_announce replies before the node emits anything, so neither
    // event races ahead of the relay actually registering the subscription
    // (waitForNotificationCount, not two chained waitForStoreChange calls,
    // since the latter can miss the first of two rapid-fire changes).
    const inbox = client.attentionInbox();
    await waitForNotificationCount(client.sessions, 2);

    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ];
    const permissionEnvelope = await nodeSeal(
      sessionA.id,
      { toolCall: { kind: 'tool_call', id: 'tc-a', title: 'Run tests' }, options },
      keyA,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      requestId: 'req-inbox-a',
      envelope: permissionEnvelope,
    });

    // Session B transitions to awaiting_input with a deliberately EARLIER
    // timestamp than session A's permission request (sent second on the
    // wire) — an oldest-first sort must still put B ahead of A.
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const statusEnvelope = await nodeSeal(
      sessionB.id,
      { kind: 'session_status', status: 'awaiting_input', updatedAt: earlier },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 1,
      envelope: statusEnvelope,
    });

    const items = await waitForStore(inbox, (value) => value.length === 2);
    expect(items.map((item) => item.kind)).toEqual(['awaiting_input', 'permission']);
    expect(items[0]).toMatchObject({
      sessionId: sessionB.id,
      sessionTitle: 'Add feature',
      projectPath: '/proj-b',
      nodeId: sessionB.nodeId,
    });
    expect(items[1]).toMatchObject({
      sessionId: sessionA.id,
      sessionTitle: 'Fix the bug',
      projectPath: '/proj-a',
      nodeId: sessionA.nodeId,
      permission: expect.objectContaining({ requestId: 'req-inbox-a' }),
    });

    // The session view's own queue for A carries the exact same pending
    // request — subscribing here mirrors what the UI does when the user
    // opens that session directly (issue #169's single source of truth).
    const queueA = client.permissionQueueFor(sessionA.id);
    expect(get(queueA).byId.has('req-inbox-a')).toBe(true);

    // Approving from the inbox (the exact RelayClient call the inbox
    // component's approve button makes) resolves it in the session's own
    // queue too, and the item disappears from the inbox.
    client.resolvePermission(sessionA.id, 'req-inbox-a', options[0]);
    expect(get(queueA).byId.has('req-inbox-a')).toBe(false);
    const afterApprove = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterApprove[0]?.sessionId).toBe(sessionB.id);

    // "Resolved elsewhere": a second permission request on B, cancelled via
    // the session-level Stop control (not through the inbox at all), must
    // also vanish from the inbox — proving the inbox holds no separate copy
    // of queue state it could fall out of sync with.
    const secondPermissionEnvelope = await nodeSeal(
      sessionB.id,
      { toolCall: { kind: 'tool_call', id: 'tc-b' }, options: [options[0]] },
      keyB,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      requestId: 'req-inbox-b',
      envelope: secondPermissionEnvelope,
    });
    await waitForStore(inbox, (value) => value.some((item) => item.kind === 'permission'));

    client.cancelPermissionRequests(sessionB.id);
    const final = await waitForStore(
      inbox,
      (value) => !value.some((item) => item.kind === 'permission'),
    );
    expect(
      final.some((item) => item.sessionId === sessionB.id && item.kind === 'awaiting_input'),
    ).toBe(true);
  });
});

describe('RelayClient: attention inbox agentMessage field (issue #662)', () => {
  it("carries the agent's last transcript message for both a permission and an awaiting_input item, and recomputes it live when a new chunk arrives", async () => {
    const amk = generateAmk();
    const accountId = 'acct-inbox-message';

    node = new FakeNode(relay.url, {
      deviceId: 'node-inbox-message',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const sessionA = makeSessionMeta({ id: 'sess_inbox_msg_a', accountId });
    const sessionB = makeSessionMeta({ id: 'sess_inbox_msg_b', accountId });
    const keyA = await deriveNodeSessionKey(amk, accountId, sessionA.id);
    const keyB = await deriveNodeSessionKey(amk, accountId, sessionB.id);
    const privateA = await nodeSeal(
      sessionA.id,
      { title: 'Cleanup script', projectPath: '/proj-a' },
      keyA,
    );
    const privateB = await nodeSeal(
      sessionB.id,
      { title: 'Draft the reply', projectPath: '/proj-b' },
      keyB,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionA,
      privateEnvelope: privateA,
    });
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionB,
      privateEnvelope: privateB,
    });

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-inbox-message',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length === 2);

    const inbox = client.attentionInbox();
    await waitForNotificationCount(client.sessions, 2);

    // Session A: the agent asks before requesting permission — the exact
    // "answer without being able to read the question" gap issue #662
    // closes. A trailing thought chunk on the SAME turn must not win over
    // the real message (`lastAgentMessageText` only looks at
    // `'agent_message_chunk'` items).
    const questionEnvelope = await nodeSeal(
      sessionA.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-a1',
        messageId: 'msg-a1',
        text: 'May I delete build/?',
      },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 1,
      envelope: questionEnvelope,
    });
    const thoughtEnvelope = await nodeSeal(
      sessionA.id,
      {
        kind: 'agent_thought_chunk',
        turnId: 'turn-a1',
        messageId: 'thought-a1',
        text: 'weighing the risk',
      },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 2,
      envelope: thoughtEnvelope,
    });

    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ];
    const permissionEnvelope = await nodeSeal(
      sessionA.id,
      { toolCall: { kind: 'tool_call', id: 'tc-a1', title: 'rm -rf build/' }, options },
      keyA,
    );
    node.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      requestId: 'req-inbox-message-a',
      envelope: permissionEnvelope,
    });

    // Session B: the agent's last message, then it goes idle waiting for
    // the user's reply.
    const firstReplyEnvelope = await nodeSeal(
      sessionB.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-b1',
        messageId: 'msg-b1',
        text: 'Draft ready, ship it?',
      },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 1,
      envelope: firstReplyEnvelope,
    });
    const statusEnvelope = await nodeSeal(
      sessionB.id,
      { kind: 'session_status', status: 'awaiting_input', updatedAt: new Date().toISOString() },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 2,
      envelope: statusEnvelope,
    });

    const items = await waitForStore(inbox, (value) => value.length === 2);
    const permissionItem = items.find((item) => item.kind === 'permission');
    const awaitingItem = items.find((item) => item.kind === 'awaiting_input');
    expect(permissionItem?.agentMessage).toBe('May I delete build/?');
    expect(awaitingItem?.agentMessage).toBe('Draft ready, ship it?');

    // The transcript keeps streaming after the item already exists: the
    // inbox is a pure recompute from live stores, so a later chunk on the
    // same session must replace, not append to, `agentMessage`.
    const secondReplyEnvelope = await nodeSeal(
      sessionB.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-b2',
        messageId: 'msg-b2',
        text: 'Actually, hold off on shipping.',
      },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 3,
      envelope: secondReplyEnvelope,
    });

    const updated = await waitForStore(inbox, (value) =>
      value.some(
        (item) =>
          item.kind === 'awaiting_input' && item.agentMessage === 'Actually, hold off on shipping.',
      ),
    );
    expect(updated.find((item) => item.kind === 'permission')?.agentMessage).toBe(
      'May I delete build/?',
    );
  });
});

describe('RelayClient: attention inbox session-outcome class (SPEC §7.13; issue #167)', () => {
  it('surfaces a session_outcome item live when a session settles to exited or error, replacing it in place, and clears it when the session resumes working', async () => {
    const amk = generateAmk();
    const accountId = 'acct-inbox-outcome';

    node = new FakeNode(relay.url, {
      deviceId: 'node-inbox-outcome',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const sessionA = makeSessionMeta({ id: 'sess_outcome_a', accountId });
    const sessionB = makeSessionMeta({ id: 'sess_outcome_b', accountId, nodeId: 'node_2' });
    const keyA = await deriveNodeSessionKey(amk, accountId, sessionA.id);
    const keyB = await deriveNodeSessionKey(amk, accountId, sessionB.id);
    const privateA = await nodeSeal(
      sessionA.id,
      { title: 'Refactor module', projectPath: '/proj-a' },
      keyA,
    );
    const privateB = await nodeSeal(
      sessionB.id,
      { title: 'Migrate DB', projectPath: '/proj-b' },
      keyB,
    );
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionA,
      privateEnvelope: privateA,
    });
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: sessionB,
      privateEnvelope: privateB,
    });

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-outcome' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => value.length === 2);

    const inbox = client.attentionInbox();
    await waitForNotificationCount(client.sessions, 2);

    // Session A finishes cleanly.
    const finishedEnvelope = await nodeSeal(
      sessionA.id,
      { kind: 'session_status', status: 'exited', updatedAt: new Date().toISOString() },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 1,
      envelope: finishedEnvelope,
    });

    const afterFinish = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterFinish[0]).toMatchObject({
      kind: 'session_outcome',
      sessionId: sessionA.id,
      sessionTitle: 'Refactor module',
      projectPath: '/proj-a',
      nodeId: sessionA.nodeId,
      outcome: 'exited',
    });

    // Session B errors — both session_outcome items coexist, each tagged
    // with its own node and outcome (cross-node, class-distinguished).
    const erroredEnvelope = await nodeSeal(
      sessionB.id,
      {
        kind: 'session_status',
        status: 'error',
        updatedAt: new Date(Date.now() - 1000).toISOString(),
      },
      keyB,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionB.id,
      seq: 1,
      envelope: erroredEnvelope,
    });

    const afterError = await waitForStore(inbox, (value) => value.length === 2);
    // B errored a second EARLIER than A finished, so the oldest-first sort
    // puts B ahead of A even though A's event was sent first.
    expect(afterError.map((item) => [item.sessionId, item.kind, item.outcome])).toEqual([
      [sessionB.id, 'session_outcome', 'error'],
      [sessionA.id, 'session_outcome', 'exited'],
    ]);
    expect(afterError[0].nodeId).toBe(sessionB.nodeId);

    // Session A resumes working: its session_outcome item must disappear
    // (a live status transition away from exited/error clears it, exactly
    // like awaiting_input does), leaving only B's.
    const resumedEnvelope = await nodeSeal(
      sessionA.id,
      { kind: 'session_status', status: 'working', updatedAt: new Date().toISOString() },
      keyA,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: sessionA.id,
      seq: 2,
      envelope: resumedEnvelope,
    });

    const afterResume = await waitForStore(inbox, (value) => value.length === 1);
    expect(afterResume[0].sessionId).toBe(sessionB.id);
  });
});

describe('RelayClient: recovery-code AMK escrow + new-device bootstrap (SPEC §8 path 2, §16; issues #114/#115)', () => {
  it('escrows the AMK from a first device, then a fresh device bootstraps from just the Recovery Code and decrypts a session the first device could', async () => {
    const accountId = 'acct-recovery';
    const recoveryCode = generateRecoveryCode();
    const amk = generateAmk();

    // The first device: escrows its AMK to the relay.
    const firstDevice = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'device-first',
    });
    firstDevice.connect();
    await waitForStore(firstDevice.status, (status) => status === 'open');
    await firstDevice.escrowAmk(recoveryCode);

    // A node announces a session under this account, sealed under the
    // first device's AMK-derived session key.
    node = new FakeNode(relay.url, {
      deviceId: 'node-recovery',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    const session = makeSessionMeta({ id: 'sess_recovery', accountId });
    const sessionKey = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'recovered session', projectPath: '/proj-recovery' },
      sessionKey,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    // A brand-new device, with no prior state at all: OAuth identity
    // (`accountId`/`authToken`) plus only the Recovery Code — no previously
    // trusted device involved.
    const bootstrapped = await bootstrapAmkFromRecoveryCode({
      relayUrl: relay.url,
      accountId,
      deviceId: 'device-new',
      recoveryCode,
    });
    expect(bootstrapped.amk).toEqual(amk);
    // SPEC §8: bootstrap also generates the new device's own ECDH P-256
    // identity keypair (not the placeholder random bytes RelayClient uses
    // when no keypair is supplied).
    expect(bootstrapped.deviceKeyPair).toBeDefined();
    expect(bootstrapped.devicePublicKey).toBeTruthy();
    expect(bootstrapped.deviceId).toBe('device-new');

    client = new RelayClient({
      relayUrl: relay.url,
      amk: bootstrapped.amk,
      accountId,
      deviceId: bootstrapped.deviceId,
      devicePublicKey: bootstrapped.devicePublicKey,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessions = (await waitForStore(
      client.sessions,
      (value) => value.length > 0,
    )) as ClientSessionMeta[];
    expect(sessions).toEqual([
      { ...session, title: 'recovered session', projectPath: '/proj-recovery' },
    ]);
  });

  it('rejects bootstrap with the wrong Recovery Code', async () => {
    const accountId = 'acct-recovery-wrong-code';
    const amk = generateAmk();

    const firstDevice = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'device-first',
    });
    firstDevice.connect();
    await waitForStore(firstDevice.status, (status) => status === 'open');
    await firstDevice.escrowAmk(generateRecoveryCode());

    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId,
        deviceId: 'device-new',
        recoveryCode: generateRecoveryCode(),
      }),
    ).rejects.toThrow();
  });

  it('rejects bootstrap for an account that has never escrowed an AMK', async () => {
    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId: 'acct-never-escrowed',
        deviceId: 'device-new',
        recoveryCode: generateRecoveryCode(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow();
  });

  it('escrowAmk rejects when called before the connection is open', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-not-connected',
      deviceId: 'device-x',
    });
    await expect(client.escrowAmk(generateRecoveryCode())).rejects.toThrow();
  });
});

describe('RelayClient: createSession (SPEC §7.1; issue #385)', () => {
  it('sends a session_create matching the wire schema and resolves with the generated session id without waiting for the node to create/announce it', async () => {
    const amk = generateAmk();
    const accountId = 'acct-create-session-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-create-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_create_1',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-create-1' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    // Deliberately never sends `session_announce` back: this method must not
    // need it to resolve (issue #761 removed the poll-until-announced wait,
    // which only ever existed to time the starting prompt this method used
    // to send right after — see its own doc comment).
    const sessionId = await client.createSession({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project',
      title: 'my new session',
    });

    const createMessage = (await node.waitFor((m) => m.type === 'session_create')) as {
      type: 'session_create';
      protocolVersion: typeof PROTOCOL_V1;
      sessionId: string;
      targetId: string;
      provider: string;
      privateEnvelope: EncryptedEnvelope;
    };
    expect(createMessage.sessionId).toBe(sessionId);
    expect(Object.keys(createMessage).sort()).toEqual(
      ['privateEnvelope', 'protocolVersion', 'provider', 'sessionId', 'targetId', 'type'].sort(),
    );
    expect(createMessage.targetId).toBe('local');
    expect(createMessage.provider).toBe('claude');

    const sessionKey = await deriveNodeSessionKey(amk, accountId, createMessage.sessionId);
    const decryptedMeta = await nodeOpen<{ title: string; projectPath: string }>(
      createMessage.sessionId,
      createMessage.privateEnvelope,
      sessionKey,
    );
    expect(decryptedMeta).toEqual({ title: 'my new session', projectPath: '/home/dev/project' });
  });

  it('never sends a follow-up prompt after creating a session', async () => {
    const amk = generateAmk();
    const accountId = 'acct-create-session-2';

    node = new FakeNode(relay.url, {
      deviceId: 'node-create-2',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;
    node.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_create_2',
      targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({ relayUrl: relay.url, amk, accountId, deviceId: 'client-create-2' });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const createPromise = client.createSession({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project-2',
    });

    const createMessage = (await node.waitFor((m) => m.type === 'session_create')) as {
      sessionId: string;
      privateEnvelope: EncryptedEnvelope;
    };
    node.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: makeSessionMeta({
        id: createMessage.sessionId,
        nodeId: 'node_create_2',
        targetId: 'local',
        accountId,
        provider: 'claude',
      }),
      privateEnvelope: createMessage.privateEnvelope,
    });

    await createPromise;
    // Give any errant send a beat to arrive, then confirm none did.
    // `CreateSessionOptions` no longer has a `prompt` field at all (issue
    // #761): a session is always created empty, and the first thing typed
    // goes through the composer's ordinary `sendPrompt` path instead.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(node.messages.some((m) => m.type === 'prompt_inject')).toBe(false);
  });

  it('rejects immediately when there is no open connection', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-create-session-no-conn',
      deviceId: 'client-create-no-conn',
    });
    await expect(
      client.createSession({ targetId: 'local', provider: 'claude', projectPath: '/proj' }),
    ).rejects.toThrow(/not connected/);
  });

  it("selecting a session before its own session_announce arrives still ends up 'error' with a reason, never stuck on 'awaiting you' (issue #730 — this method's own doc comment names the gap its \"remaining half\")", async () => {
    const amk = generateAmk();
    const accountId = 'acct-create-session-race';

    node = new FakeNode(relay.url, {
      deviceId: 'node-create-race',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-create-race',
      // Real default is 300ms; a few ms keeps this test fast without
      // changing what it proves (retry-until-acked, not the exact timing).
      sessionResumeRetryMs: 20,
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const sessionId = 'sess-race-1';
    const key = await deriveNodeSessionKey(amk, accountId, sessionId);

    // Subscribes to a session id the relay has never heard of yet — every
    // real `session_resume` this sends is dropped with no ack
    // (`relay.ts`'s own "resume for unknown/foreign session" branch),
    // exactly the race `selectSession`'s own `ensureSubscribed` call hits
    // right after `createSession` returns (that method's own doc comment,
    // just above this describe block, names this issue).
    const status = client.statusFor(sessionId);
    const attentionInbox = client.attentionInbox();

    // Proves the race is real, not accidentally already resolved: several
    // retry intervals pass with the relay still not knowing this session,
    // so status stays exactly `undefined` — never a stale/wrong guess.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(get(status)).toBeUndefined();

    // The node "catches up": announces (same as a real node's
    // `createSessionInternal` would, well after `session_create` reached
    // it over the network), reports 'starting' immediately, then the
    // spawn fails.
    const session = makeSessionMeta({ id: sessionId, accountId, nodeId: 'node_create_race' });
    const privateEnvelope = await nodeSeal(
      sessionId,
      { title: 'races the subscribe', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    const startingEnvelope = await nodeSeal(
      sessionId,
      { kind: 'session_status', status: 'starting', updatedAt: 't1' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      seq: 1,
      envelope: startingEnvelope,
    });
    const errorEnvelope = await nodeSeal(
      sessionId,
      {
        kind: 'session_status',
        status: 'error',
        updatedAt: 't2',
        reason: 'agent spawn did not complete within 120000ms',
      },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      seq: 2,
      envelope: errorEnvelope,
    });

    // The retry-until-acked subscribe plus its one-time post-ack resync
    // eventually catch up: 'error' — with its reason — actually arrives,
    // whether by live fan-out (the retry's subscribe landed before these
    // sends) or by the resync backfill (it landed after). Either way the
    // client never stays stuck on `undefined`, and never guesses
    // 'awaiting_input'.
    await waitForStore(status, (value) => value === 'error');
    const reason = await waitForStore(
      client.statusReasonFor(sessionId),
      (value) => value !== undefined,
    );
    expect(reason).toBe('agent spawn did not complete within 120000ms');

    // The inbox's own half of the same acceptance criterion: never an
    // 'awaiting_input' item for this session (it never WAS awaiting
    // input), and the session_outcome item it does get carries the same
    // reason as its stopReason (RelayClient's own fallback, for a session
    // whose agent never got as far as a turn, in `recomputeAttentionInbox`).
    const items = await waitForStore(attentionInbox, (value) =>
      value.some((item) => item.sessionId === sessionId),
    );
    expect(items.filter((item) => item.sessionId === sessionId)).toEqual([
      expect.objectContaining({
        kind: 'session_outcome',
        sessionId,
        outcome: 'error',
        stopReason: 'agent spawn did not complete within 120000ms',
      }),
    ]);
    expect(
      items.some((item) => item.sessionId === sessionId && item.kind === 'awaiting_input'),
    ).toBe(false);
  });
});

describe('RelayClient: sessionDecryptFailures (issue #384 mismatched-AMK state)', () => {
  it('counts sessions the current AMK could not decrypt in the latest session_list snapshot, distinct from a genuinely empty list', async () => {
    const wrongAmk = generateAmk();
    const rightAmk = generateAmk();
    const accountId = 'acct-mismatch-1';

    node = new FakeNode(relay.url, {
      deviceId: 'node-mismatch-1',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_mismatch_1', accountId });
    // Sealed under the RIGHT AMK's derived key — this client will connect
    // with the WRONG one, exactly like a second browser that never went
    // through this account's recovery-code onboarding.
    const rightKey = await deriveNodeSessionKey(rightAmk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'unreadable', projectPath: '/proj' },
      rightKey,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });
    await new Promise((resolve) => setTimeout(resolve, 50));

    client = new RelayClient({
      relayUrl: relay.url,
      amk: wrongAmk,
      accountId,
      deviceId: 'client-mismatch-1',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await waitForStore(client.sessionDecryptFailures, (count) => count > 0);
    expect(get(client.sessionDecryptFailures)).toBe(1);
    expect(get(client.sessions)).toEqual([]);
  });

  it('stays 0 for an account that genuinely has no sessions', async () => {
    const amk = generateAmk();
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-mismatch-none',
      deviceId: 'client-mismatch-none',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    await waitForStore(client.sessions, (value) => Array.isArray(value));
    expect(get(client.sessionDecryptFailures)).toBe(0);
  });
});

describe('RelayClient: auto-reconnect + heartbeat (issue #511)', () => {
  it('an unexpected drop reconnects on its own, with backoff, and re-sends session_list_request', async () => {
    const amk = generateAmk();
    const sent: WireMessageV1[] = [];
    const sockets: WebSocketLike[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-auto-reconnect',
      deviceId: 'client-auto-reconnect',
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: recordingSocketCtor(sent, sockets),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    expect(sent.filter((m) => m.type === 'session_list_request')).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    // An unexpected drop, not client.close() — RelayClient cannot tell the
    // difference between the test closing the underlying transport and a
    // real network blip closing it.
    sockets[0].close();

    await waitForCondition(() => sockets.length >= 2);
    await waitForStore(client.status, (status) => status === 'open');
    expect(sockets).toHaveLength(2);
    expect(sent.filter((m) => m.type === 'session_list_request')).toHaveLength(2);
  });

  it('an explicit close() never reconnects, even after waiting out several backoff intervals', async () => {
    const amk = generateAmk();
    const sockets: WebSocketLike[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-no-reconnect-after-close',
      deviceId: 'client-no-reconnect-after-close',
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: recordingSocketCtor([], sockets),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    client.close();
    await waitForStore(client.status, (status) => status === 'closed');

    // Long enough for several (incorrect) automatic retries to have fired
    // if close() hadn't disarmed them.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(get(client.status)).toBe('closed');
    expect(sockets).toHaveLength(1);
  });

  it('a WebSocket constructor that throws once still recovers on the automatic retry', async () => {
    const amk = generateAmk();
    const counter = { attempts: 0, failUntilAttempt: 1 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-ctor-throws',
      deviceId: 'client-ctor-throws',
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: flakyConstructorSocketCtor(counter),
    });

    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    expect(counter.attempts).toBe(2);
  });

  it('recovers from a socket that fires only "error" and never "close" on a failed connection attempt (undici asymmetry, issue #511)', async () => {
    const amk = generateAmk();
    const counter = { attempts: 0, failUntilAttempt: 1 };
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-error-without-close',
      deviceId: 'client-error-without-close',
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: errorWithoutCloseSocketCtor(counter),
    });

    // Under the old close-handler-only reconnect wiring this hangs forever
    // (the failing attempt's 'error' sets status 'error' and nothing ever
    // schedules a retry) — this is the exact four-hour-outage shape #511
    // was filed for, reproduced at the RelayClient level.
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    expect(counter.attempts).toBe(2);
  });

  it('pings a relay that advertised HEARTBEAT_CAPABILITY, every heartbeatIntervalMs', async () => {
    const amk = generateAmk();
    const sent: WireMessageV1[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-heartbeat-pings',
      deviceId: 'client-heartbeat-pings',
      heartbeatIntervalMs: 20,
      webSocketImpl: recordingSocketCtor(sent, []),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const ping = await waitForSentMessage(sent, (m) => m.type === 'ping');
    if (ping.type !== 'ping') throw new Error('expected a ping frame');
    expect(ping.protocolVersion).toBe(PROTOCOL_V1);
    expect(ping.nonce.length).toBeGreaterThan(0);

    // The real relay answers every ping, so the heartbeat itself must never
    // tear a healthy connection down.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get(client.status)).toBe('open');
  });

  it('tears the socket down and reconnects when a ping goes unanswered by the next tick', async () => {
    const amk = generateAmk();
    const sent: WireMessageV1[] = [];
    const sockets: WebSocketLike[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-heartbeat-timeout',
      deviceId: 'client-heartbeat-timeout',
      heartbeatIntervalMs: 25,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: pingSwallowingSocketCtor(sent, sockets),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    await waitForCondition(() => sockets.length >= 2);
    await waitForStore(client.status, (status) => status === 'open');
    expect(sent.some((m) => m.type === 'ping')).toBe(true);
  });

  it('never pings a relay that did not advertise HEARTBEAT_CAPABILITY', async () => {
    const amk = generateAmk();
    const sent: WireMessageV1[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId: 'acct-heartbeat-unsupported',
      deviceId: 'client-heartbeat-unsupported',
      heartbeatIntervalMs: 15,
      webSocketImpl: capabilityStrippingSocketCtor(sent),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    // A real wait, not an awaited event: the claim under test is that
    // nothing happens, so there is no signal to await instead — several
    // heartbeatIntervalMs multiples give a false negative here a real
    // chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(sent.some((m) => m.type === 'ping')).toBe(false);
    expect(get(client.status)).toBe('open');
  });
});

describe('RelayClient: resubscribe after reconnect keeps a session live (issue #660)', () => {
  it("keeps decrypting a subscribed session's live session_update stream across an unexpected reconnect, not just up to the moment it drops", async () => {
    const amk = generateAmk();
    const accountId = 'acct-resubscribe-reconnect';

    node = new FakeNode(relay.url, {
      deviceId: 'node-resubscribe',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resubscribe', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'live', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    const sent: WireMessageV1[] = [];
    const sockets: WebSocketLike[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-resubscribe',
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      webSocketImpl: recordingSocketCtor(sent, sockets),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    // Same race-avoidance as the plain "decrypts and reduces a live
    // session_update stream" test above: confirm the relay actually
    // subscribed this connection (via transcriptFor's session_resume
    // round trip) before the node sends anything.
    await waitForStoreChange(client.sessions, initialSessions);

    const firstEnvelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: 'Hello' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope: firstEnvelope,
    });
    await waitForStore(transcript, (value) => {
      const first = value.items[0];
      return first?.type === 'message' && first.text === 'Hello';
    });

    // An unexpected drop, not client.close() — exactly `recordingSocketCtor`'s
    // own doc comment: RelayClient cannot tell this apart from a real
    // network blip (a slept laptop's tunnel dropping, issue #660's likely
    // real-world trigger — see AGENTS.md's own documented "a slept laptop
    // takes the tunnel down" gotcha for the exact same reverse-SSH path
    // Lorenzo's report was driven over).
    sockets[0]!.close();
    await waitForCondition(() => sockets.length >= 2);
    await waitForStore(client.status, (status) => status === 'open');

    // The turn is still open on the node side; this second chunk streams
    // in after the reconnect completed. Without resending session_resume
    // on the new connection, the relay's fan-out subscription for this
    // session died with the old connection and this chunk is silently
    // never delivered — `waitForStore` below times out on today's code.
    const secondEnvelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 'turn-1', messageId: 'msg-1', text: ' world' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 2,
      envelope: secondEnvelope,
    });

    const state = await waitForStore(transcript, (value) => {
      const first = value.items[0];
      return first?.type === 'message' && first.text === 'Hello world';
    });
    expect(state.items).toEqual([
      {
        type: 'message',
        id: 'turn-1::agent_message_chunk::msg-1',
        kind: 'agent_message_chunk',
        turnId: 'turn-1',
        messageId: 'msg-1',
        text: 'Hello world',
      },
    ]);

    // The mechanism, not just the symptom: a fresh `session_resume` for
    // this session actually went out on the reconnected socket.
    expect(
      sent.filter((m) => m.type === 'session_resume' && m.sessionId === session.id).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('RelayClient: resync on reconnect (issue #729)', () => {
  it('recovers a session_update the node emitted while this client was disconnected, once the socket reconnects — never delivered live, only through resync', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resync-reconnect';

    node = new FakeNode(relay.url, {
      deviceId: 'node-resync-reconnect',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resync_reconnect', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'resync on reconnect', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    const sent: WireMessageV1[] = [];
    const sockets: WebSocketLike[] = [];
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-resync-reconnect',
      // Wide enough that the node's update below (sent right after the
      // drop) is safely buffered in the relay's ring well before this
      // client's own automatic reconnect fires — this test is about
      // resync recovering something that was NEVER live-delivered, not
      // about winning a race against a fast reconnect.
      initialBackoffMs: 250,
      maxBackoffMs: 300,
      webSocketImpl: recordingSocketCtor(sent, sockets),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    // Same race-avoidance every other test in this file uses: confirm the
    // relay actually subscribed this connection before dropping it.
    await waitForStoreChange(client.sessions, initialSessions);

    // An unexpected drop, not client.close() — this connection is gone,
    // and nothing is live-subscribed to receive what happens next.
    sockets[0]!.close();

    const envelope = await nodeSeal(
      session.id,
      {
        kind: 'agent_message_chunk',
        turnId: 'turn-1',
        messageId: 'msg-1',
        text: 'missed while offline',
      },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 1,
      envelope,
    });

    await waitForCondition(() => sockets.length >= 2);
    await waitForStore(client.status, (status) => status === 'open');

    const state = await waitForStore(transcript, (value) => {
      const first = value.items[0];
      return first?.type === 'message' && first.text === 'missed while offline';
    });
    expect(state.items).toHaveLength(1);

    // The mechanism, not just the symptom: a resync_request actually went
    // out on the reconnected socket, not just another session_resume.
    expect(sent.some((m) => m.type === 'resync_request' && m.sessionId === session.id)).toBe(true);
  });
});

describe('RelayClient: live/replay dedupe by seq (issue #729)', () => {
  it('a session_update this connection already started decrypting live, and the identical ring entry a reconnect resync also replays, is applied exactly once — proven by deliberately racing two decrypts of the same seq via a slowed EnvelopeCrypto, against a real relay', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resync-dedupe';

    node = new FakeNode(relay.url, {
      deviceId: 'node-resync-dedupe',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resync_dedupe', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'dedupe', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });

    const sent: WireMessageV1[] = [];
    const sockets: WebSocketLike[] = [];
    let openStarts = 0;
    // Every decrypt now takes >= 300ms (`delayedOpenEnvelopeCrypto`): long
    // enough that the reconnect below (30ms backoff, a same-host WS round
    // trip) completes and its `resync_request` lands WHILE the very first
    // live delivery's own decrypt is still pending — the exact overlap
    // the mechanism defends against, forced deterministically instead of
    // raced against real timing. `openStarts` lets the test await "the
    // client has synchronously reached this decrypt call" instead of
    // guessing a wall-clock margin for wire delivery.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-resync-dedupe',
      initialBackoffMs: 30,
      maxBackoffMs: 40,
      webSocketImpl: recordingSocketCtor(sent, sockets),
      envelopeCrypto: delayedOpenEnvelopeCrypto(createEnvelopeCrypto(amk, accountId), 300, () => {
        openStarts += 1;
      }),
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');
    const initialSessions = await waitForStore(client.sessions, (value) => value.length > 0);

    const transcript = client.transcriptFor(session.id);
    // Same race-avoidance every other test in this file uses — waiting
    // out the (now-slowed) private-meta decrypt this triggers doubles as
    // proof the relay actually subscribed this connection.
    await waitForStoreChange(client.sessions, initialSessions);

    const chunkA = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 't1', messageId: 'm1', text: 'Hello' },
      key,
    );
    // Fanned live to the currently-open connection, and buffered into the
    // relay's resync ring in the same stroke — this ONE ring entry is
    // what both this live delivery AND the reconnect's resync reply
    // (below) will each independently hand to `handleSessionUpdate`. The
    // relay assigns the real `seq` itself (`store.ts`'s own per-session
    // counter, `relay.test.ts`'s resync test relies on the identical
    // behavior) — the placeholder here is never what ends up on the wire.
    const openStartsBeforeLiveChunkA = openStarts;
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 0,
      envelope: chunkA,
    });
    // Deterministic proof the live delivery's decrypt genuinely started
    // (passed `handleSessionUpdate`'s early dedupe check and called
    // `envelopeCrypto.open()`) BEFORE the socket drops below — not a
    // wall-clock guess that the wire frame "probably" arrived in time.
    await waitForCondition(() => openStarts > openStartsBeforeLiveChunkA);

    // An unexpected drop — the live delivery's decrypt above is
    // confirmed in flight and keeps running in the background through
    // the whole reconnect below (a pending promise is never cancelled by
    // its socket closing).
    sockets[0]!.close();
    await waitForCondition(() => sockets.length >= 2);
    await waitForStore(client.status, (status) => status === 'open');

    // A genuinely new update, delivered live on the reconnected
    // connection — proves dedupe never over-suppresses real content
    // alongside the duplicate it is correctly rejecting.
    const chunkB = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 't1', messageId: 'm2', text: ' world' },
      key,
    );
    node.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: session.id,
      seq: 0,
      envelope: chunkB,
    });

    await waitForStore(
      transcript,
      (value) =>
        value.items.some((item) => item.type === 'message' && item.text === 'Hello') &&
        value.items.some((item) => item.type === 'message' && item.text === ' world'),
    );

    // A little extra margin: the duplicate (resync-replayed) decrypt for
    // chunkA started around reconnect time, roughly the same real moment
    // as chunkB's own live delivery above, so by the time both expected
    // items have landed, the duplicate has very likely already resolved
    // too — this closes the small remaining gap. If dedupe were broken,
    // this is exactly where 'Hello' would double to 'HelloHello'.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const finalState = get(transcript);
    expect(finalState.items).toHaveLength(2);
    expect(
      finalState.items.find((item) => item.type === 'message' && item.messageId === 'm1'),
    ).toMatchObject({ text: 'Hello' });
    expect(
      finalState.items.find((item) => item.type === 'message' && item.messageId === 'm2'),
    ).toMatchObject({ text: ' world' });

    // The mechanism, not just the symptom: a resync_request genuinely
    // went out on the reconnected socket.
    expect(sent.some((m) => m.type === 'resync_request' && m.sessionId === session.id)).toBe(true);
  });
});

describe('RelayClient: reloading the page recovers existing history (issue #729)', () => {
  it('a fresh client instance, subscribing to a session for the first time, sees the transcript and status a node already pushed before this client ever connected — the reload case', async () => {
    const amk = generateAmk();
    const accountId = 'acct-resync-reload';

    node = new FakeNode(relay.url, {
      deviceId: 'node-resync-reload',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resync_reload', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(
      session.id,
      { title: 'reload', projectPath: '/proj' },
      key,
    );
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // History built up entirely before any client ever subscribes — the
    // "left it running, closed the tab, came back later" shape a real
    // page reload hits: a message, a completed tool call, and a status
    // push, none of which any client instance has ever seen.
    const messageEnvelope = await nodeSeal(
      session.id,
      { kind: 'agent_message_chunk', turnId: 't1', messageId: 'm1', text: 'Done already' },
      key,
    );
    const toolEnvelope = await nodeSeal(
      session.id,
      {
        kind: 'tool_call',
        id: 'tc1',
        title: 'Edit src/foo.ts',
        toolKind: 'edit',
        status: 'completed',
      },
      key,
    );
    const statusEnvelope = await nodeSeal(
      session.id,
      { kind: 'session_status', status: 'awaiting_input', updatedAt: new Date().toISOString() },
      key,
    );
    for (const envelope of [messageEnvelope, toolEnvelope, statusEnvelope]) {
      node.send({
        type: 'session_update',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        seq: 0,
        envelope,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The reload: a brand-new RelayClient for the same account — this
    // instance has never subscribed to this session before, exactly like
    // a fresh page load.
    client = new RelayClient({
      relayUrl: relay.url,
      amk,
      accountId,
      deviceId: 'client-after-reload',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const transcript = client.transcriptFor(session.id);
    const status = client.statusFor(session.id);

    const state = await waitForStore(transcript, (value) => value.items.length >= 2);
    expect(state.items.find((item) => item.type === 'message')).toMatchObject({
      text: 'Done already',
    });
    expect(state.items.find((item) => item.type === 'tool_call')).toMatchObject({
      id: 'tc1',
      status: 'completed',
    });
    await waitForStore(status, (value) => value === 'awaiting_input');
  });
});

describe('RelayClient: dropped-range resync_marker surfaces as a visible transcript gap (issue #729)', () => {
  let smallRingRelay: StartedRelay | undefined;

  afterEach(async () => {
    await smallRingRelay?.close();
    smallRingRelay = undefined;
  });

  it('a resync that lands behind an evicted range renders a gap item, then resumes with the still-buffered history after it', async () => {
    smallRingRelay = await startRelay({ store: createInMemoryRelayStore({ ringBufferSize: 3 }) });

    const amk = generateAmk();
    const accountId = 'acct-resync-gap';

    node = new FakeNode(smallRingRelay.url, {
      deviceId: 'node-resync-gap',
      devicePublicKey: randomBase64(),
      authToken: accountId,
    });
    await node.ready;

    const session = makeSessionMeta({ id: 'sess_resync_gap', accountId });
    const key = await deriveNodeSessionKey(amk, accountId, session.id);
    const privateEnvelope = await nodeSeal(session.id, { title: 'gap', projectPath: '/proj' }, key);
    node.send({ type: 'session_announce', protocolVersion: PROTOCOL_V1, session, privateEnvelope });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Five updates through a 3-entry ring: the first two are evicted
    // before any client ever subscribes — mirrors `relay.test.ts`'s own
    // "resync replay after a simulated drop" test, one layer up the
    // stack.
    const envelopes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        nodeSeal(
          session.id,
          {
            kind: 'agent_message_chunk',
            turnId: 't1',
            messageId: `m${i + 1}`,
            text: `chunk-${i + 1}`,
          },
          key,
        ),
      ),
    );
    for (let i = 0; i < envelopes.length; i++) {
      node.send({
        type: 'session_update',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        seq: i + 1,
        envelope: envelopes[i]!,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    client = new RelayClient({
      relayUrl: smallRingRelay.url,
      amk,
      accountId,
      deviceId: 'client-resync-gap',
    });
    client.connect();
    await waitForStore(client.status, (status) => status === 'open');

    const transcript = client.transcriptFor(session.id);

    const gapState = await waitForStore(transcript, (value) =>
      value.items.some((item) => item.type === 'gap'),
    );
    expect(gapState.items.find((item) => item.type === 'gap')).toMatchObject({
      type: 'gap',
      fromSeq: 1,
      toSeq: 2,
    });

    // The gap is a visible marker, not a silent skip: the still-buffered
    // history after it (seq 3-5) still arrives and renders too, in order,
    // right after the gap.
    const settled = await waitForStore(transcript, (value) =>
      value.items.some((item) => item.type === 'message' && item.text === 'chunk-5'),
    );
    expect(settled.items.map((item) => (item.type === 'message' ? item.text : item.type))).toEqual([
      'gap',
      'chunk-3',
      'chunk-4',
      'chunk-5',
    ]);
  });
});
