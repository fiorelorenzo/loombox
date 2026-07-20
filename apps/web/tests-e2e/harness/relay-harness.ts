import type { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import { decryptEnvelope, deriveKeyTree, encryptEnvelope, importAesGcmKey } from '@loombox/crypto';
import { PROTOCOL_V1, type EncryptedEnvelope, type WireMessageV1 } from '@loombox/protocol';
import { createRelayAuth, startRelay, type RelayAuth, type StartedRelay } from '@loombox/relay';

/**
 * The Playwright-side counterpart of `apps/web/src/lib/relay-client.test.ts`'s
 * hermetic fixtures (issue #192): a REAL local `@loombox/relay` instance
 * (with Better Auth mounted, `enableEmailPasswordForTests` — the same
 * escape hatch `packages/relay/src/auth.test.ts` and `auth-store.ts`'s
 * `signUpWithEmailPassword` use, never a real GitHub/Google network call)
 * plus a `FakeNode` that speaks the v1 wire protocol exactly like a real
 * `@loombox/node` daemon would. Every Playwright spec under `tests-e2e/`
 * drives the actual built PWA in a real Chromium against this harness —
 * nothing in the app itself is stubbed or mocked.
 */

type CryptoKey = webcrypto.CryptoKey;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** `Uint8Array` AMK -> the base64 string `amk-store.ts`'s `createLocalStorageAmkStorage` persists under `loombox:amk:<accountId>` — seeded into the browser context before the app ever mounts, so this "device" already holds the same AMK the `FakeNode` derives session keys from. */
export function amkToStorageValue(amk: Uint8Array): string {
  return toBase64(amk);
}

/** Same key-tree derivation `packages/node`'s own session-key derivation and `relay-client.test.ts`'s `deriveNodeSessionKey` use (`@loombox/crypto`'s documented v1 path, `['session', accountId, sessionId]`) — reimplemented against the lower-level primitives directly, not imported from `relay-client.ts`, so a passing spec proves two independent parties (the fake node and the real browser client) interoperate. */
export async function deriveNodeSessionKey(
  amk: Uint8Array,
  accountId: string,
  sessionId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['session', accountId, sessionId]);
  return importAesGcmKey(node.key);
}

export async function nodeSeal(
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

export async function nodeOpen<T>(
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

/**
 * A minimal encrypted-node-like peer over Node's own global `WebSocket`
 * (stable since Node 22, no extra dependency), speaking the v1 handshake's
 * `role: 'node'` side — structurally identical to `relay-client.test.ts`'s
 * own `FakeNode`, kept as a separate copy here since `tests-e2e/` (Node-side
 * Playwright test code) has no dependency on `apps/web`'s own `src/lib`
 * test file.
 */
export class FakeNode {
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
            role: 'node',
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
        if (!settled) reject(new Error(`FakeNode: cannot reach ${url}`));
      });
      this.socket.addEventListener('close', () => {
        if (!settled) reject(new Error(`FakeNode: connection to ${url} closed before ready`));
      });
    });
  }

  send(message: WireMessageV1): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: WireMessageV1) => boolean,
    timeoutMs = 10_000,
  ): Promise<WireMessageV1> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('FakeNode: timed out waiting for a message');
      await new Promise((resolve) => setTimeout(resolve, 25));
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

export interface E2eRelay {
  /** ws://…/ws — same shape `RelayClient`/`FakeNode` connect to. */
  url: string;
  /** http://… — where Better Auth's `/api/auth/*` routes are mounted (SPEC §8), the base `AuthStore`/this harness's own fetches use. */
  httpBaseUrl: string;
  close(): Promise<void>;
}

/** ws://host:port/ws -> http://host:port (mirrors `+page.svelte`'s own `relayHttpBaseUrl`). */
function relayHttpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

/**
 * Starts a real, throwaway `@loombox/relay` instance for one spec: an
 * in-memory store, Better Auth mounted against a `better-sqlite3`
 * in-memory database with `enableEmailPasswordForTests` (never a real
 * GitHub/Google call — the exact escape hatch `auth-store.ts`'s own
 * doc comment describes), migrated the same way `main.ts` migrates
 * Postgres in production, so a fresh `sign-up/email` call actually
 * succeeds. Call {@link E2eRelay.close} in the test's `afterEach`/fixture
 * teardown.
 */
export async function startE2eRelay(): Promise<E2eRelay> {
  const database = new Database(':memory:');
  const auth: RelayAuth = createRelayAuth({
    database,
    baseURL: 'http://127.0.0.1:0',
    secret: 'e2e-harness-secret-e2e-harness-secret',
    enableEmailPasswordForTests: true,
    // The app is served from a different origin than this relay, so its
    // origin must be trusted or Better Auth 403s the sign-up (CSRF/Origin
    // check). Matches playwright.config.ts's baseURL/preview port.
    trustedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
  });
  // Same migration call `packages/relay/src/main.ts` and
  // `packages/relay/src/auth.test.ts` use — `migrateBetterAuth` itself is
  // an internal helper (not part of `@loombox/relay`'s public surface), so
  // this calls the same public `better-auth/db/migration` API directly
  // rather than reaching into the package's `src/`.
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const relay: StartedRelay = await startRelay({ auth });
  return {
    url: relay.url,
    httpBaseUrl: relayHttpBaseUrl(relay.url),
    close: relay.close,
  };
}

export interface E2eTestUser {
  token: string;
  accountId: string;
}

/**
 * Signs a fresh user up against a real `startE2eRelay()` instance over real
 * HTTP (never a mock) — the direct-`fetch` counterpart of
 * `auth-store.ts`'s `signUpWithEmailPassword` and `auth.test.ts`'s
 * `bearerTokenForNewUser`, used here (rather than constructing an
 * `AuthStore`) because this runs in the Node-side Playwright test process,
 * not inside the browser page. Captures the bearer token Better Auth's
 * Bearer plugin returns via the `set-auth-token` response header, then
 * resolves the account id (`user.id`) the exact same way
 * `resolveAccountIdViaBetterAuth` does server-side — so a client seeded
 * with this pair always agrees with the relay on which account it is.
 */
export async function signUpTestUser(httpBaseUrl: string, email: string): Promise<E2eTestUser> {
  const signUpResponse = await fetch(`${httpBaseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (!signUpResponse.ok) {
    throw new Error(`signUpTestUser: sign-up failed (${signUpResponse.status})`);
  }
  const token = signUpResponse.headers.get('set-auth-token');
  if (!token) throw new Error('signUpTestUser: sign-up response carried no bearer token');

  const sessionResponse = await fetch(`${httpBaseUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!sessionResponse.ok) {
    throw new Error(`signUpTestUser: get-session failed (${sessionResponse.status})`);
  }
  const body = (await sessionResponse.json()) as { user?: { id?: string } };
  const accountId = body.user?.id;
  if (!accountId) throw new Error('signUpTestUser: get-session response carried no user id');

  return { token, accountId };
}

export interface AnnouncedSession {
  sessionId: string;
  key: CryptoKey;
}

/**
 * Has `node` tell the relay a session exists (`session_announce`) with its
 * `title`/`projectPath` sealed under the session key this `accountId`'s
 * `amk` derives for it — the exact envelope shape `relay-client.test.ts`
 * exercises. Returns the derived key so the caller can seal further
 * `session_update`/`permission_request` traffic on the same session.
 */
export async function announceSession(
  node: FakeNode,
  opts: {
    amk: Uint8Array;
    accountId: string;
    sessionId: string;
    nodeId: string;
    targetId: string;
    provider: string;
    title: string;
    projectPath: string;
  },
): Promise<AnnouncedSession> {
  const key = await deriveNodeSessionKey(opts.amk, opts.accountId, opts.sessionId);
  const privateEnvelope = await nodeSeal(
    opts.sessionId,
    { title: opts.title, projectPath: opts.projectPath },
    key,
  );
  node.send({
    type: 'session_announce',
    protocolVersion: PROTOCOL_V1,
    session: {
      id: opts.sessionId,
      nodeId: opts.nodeId,
      targetId: opts.targetId,
      accountId: opts.accountId,
      provider: opts.provider,
      createdAt: Date.now(),
    },
    privateEnvelope,
  });
  return { sessionId: opts.sessionId, key };
}

let updateSeq = 0;

/** Seals `update` (an `AcpUpdate`-shaped plain object — see `@loombox/providers-core`'s `transcript.ts` reducer for the recognized `kind`s) and sends it as a `session_update` on `session`. */
export async function sendSessionUpdate(
  node: FakeNode,
  session: AnnouncedSession,
  update: Record<string, unknown>,
): Promise<void> {
  updateSeq += 1;
  const envelope = await nodeSeal(session.sessionId, update, session.key);
  node.send({
    type: 'session_update',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.sessionId,
    seq: updateSeq,
    envelope,
  });
}

/** Seals a `permission_request` (ACP's `ToolCallUpdate` + `options[]` shape) and sends it on `session`. */
export async function sendPermissionRequest(
  node: FakeNode,
  session: AnnouncedSession,
  opts: {
    requestId: string;
    toolCall: Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  },
): Promise<void> {
  const envelope = await nodeSeal(
    session.sessionId,
    { toolCall: opts.toolCall, options: opts.options },
    session.key,
  );
  node.send({
    type: 'permission_request',
    protocolVersion: PROTOCOL_V1,
    sessionId: session.sessionId,
    requestId: opts.requestId,
    envelope,
  });
}
