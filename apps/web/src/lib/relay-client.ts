import type { webcrypto } from 'node:crypto';
import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
  deriveSessionKey,
  encryptEnvelope,
  envelopeToWire,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  openJson,
  packWrappedAmkForWire,
  sealJson,
  unpackWrappedAmkFromWire,
  unwrapAmkWithRecoveryCode,
  wrapAmkWithRecoveryCode,
  type EcdhKeyPair,
} from '@loombox/crypto';
import {
  cancelAllPermissionRequests,
  createPermissionQueueState,
  createTranscriptState,
  enqueuePermissionRequest,
  headPermissionRequest,
  reduceSessionEvent,
  resolvePermissionRequest,
  type AcpConfigOption,
  type AcpPermissionOption,
  type AcpSessionStatus,
  type AcpSessionWireEvent,
  type AcpToolCallUpdate,
  type PendingPermissionRequest,
  type PermissionQueueState,
  type TranscriptState,
} from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  initializeResult,
  newDeviceBootstrapResponse,
  safeParseWireMessageV1,
  type EncryptedEnvelope,
  type Initialize,
  type NewDeviceBootstrapRequest,
  type PermissionRequest,
  type SessionAnnounceV1,
  type SessionListV1,
  type SessionMetaPublic,
  type SessionUpdateEnvelopeV1,
  type WireMessageV1,
} from '@loombox/protocol';
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  attachmentResourceId,
  validateAttachmentBytes,
  type AttachableFile,
  type ComposerAttachment,
} from './attachments';
import { createDefaultOutboxStorage, type OutboxStorage, type QueuedPrompt } from './outbox';

type CryptoKey = webcrypto.CryptoKey;

/**
 * The subset of the WHATWG `WebSocket` interface this module relies on, kept
 * narrow so tests can inject a fake implementation. Both the browser's global
 * `WebSocket` and Node 22's global `WebSocket` (used by the hermetic tests
 * below) satisfy this — no new dependency (mirrors
 * packages/node/src/relay-connection.ts's approach on the node side).
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

/** Connection lifecycle exposed to the UI. v1 does not auto-reconnect (mirrors v0; see the class docstring). */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** The plaintext a session's private envelope decrypts to (SPEC §8's metadata boundary), mirrored from `@loombox/node`'s `SessionPrivateMeta`. */
interface SessionPrivateMeta {
  title: string;
  projectPath: string;
}

/**
 * An attachment ref carried inside a `prompt_inject` envelope's plaintext
 * (SPEC §7.25), mirrored field-for-field from `@loombox/node`'s
 * `PromptAttachmentRef` (`packages/node/src/node-daemon.ts`) — the node
 * decrypts this same plaintext shape, so the field names/optionality here
 * must match exactly.
 */
interface PromptAttachmentRef {
  ref: string;
  mimeType: string;
  name?: string;
}

/** The plaintext a `prompt_inject` envelope decrypts to, mirrored from `@loombox/node`'s `PromptPayload`. */
interface PromptPayload {
  text: string;
  /** Attachments this turn references (SPEC §7.25); omitted for a plain text prompt. */
  attachments?: PromptAttachmentRef[];
}

/** One attachment's cached plaintext bytes, kept only long enough to (re)encrypt-and-upload without asking the user to re-pick the file (issue #155's retry). */
interface CachedAttachment {
  sessionId: string;
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  /** Set once this attachment has had its one automatic reconnect-triggered retry (issue #155's "auto-retries once on reconnect"), so it is never retried a second time unattended. */
  autoRetried: boolean;
}

/**
 * The plaintext a `permission_request` envelope decrypts to (SPEC §7.24;
 * `packages/protocol/src/v1/steering.ts`'s doc comment: "the permission
 * request's `ToolCallUpdate` ... travel[s] as an opaque `encryptedEnvelope`").
 * Mirrors ACP's own `AcpRequestPermissionParams` minus `sessionId` (already
 * on the envelope's routing fields). No node in this repo emits
 * `permission_request` yet (Wave D.2 is rendering-only, SCOPE forbids
 * touching `packages/node`); this type documents the payload this client is
 * ready to decrypt the moment one does.
 */
interface PermissionRequestPayload {
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

/** `SessionMetaPublic`'s clear routing fields plus the title/projectPath decrypted from its paired private envelope. */
export type ClientSessionMeta = SessionMetaPublic & SessionPrivateMeta;

/**
 * One row of the cross-project attention inbox (SPEC §7.13; issues
 * #167/#168/#169): either a session's actionable FIFO-head permission
 * request, or a session whose live status is `awaiting_input` — the two
 * "needs the user now" classes this v1 slice covers (session outcomes/CI/
 * review-request classes from the full §7.13 scope are later work, not
 * implemented here). See {@link RelayClient.attentionInbox}'s doc comment
 * for why a session with a queue of several pending requests only ever
 * contributes its head as one item.
 */
export interface AttentionInboxItem {
  readonly kind: 'permission' | 'awaiting_input';
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly projectPath: string;
  /** Epoch ms this item started waiting — a permission request's `enqueuedAt`, or the session's `session_status` transition time; the inbox's own sort key (oldest first). */
  readonly waitingSince: number;
  /** Set only for a `'permission'` item: the actionable FIFO-head request itself, so a renderer can show/act on it without a second lookup. */
  readonly permission?: PendingPermissionRequest;
}

/**
 * `AcpSessionStatusEvent.updatedAt` (an ISO string the node supplies) as a
 * sortable epoch-ms value. A missing or unparseable timestamp falls back to
 * "now" rather than throwing or sorting as `NaN` — a malformed value should
 * degrade to "just happened", not corrupt the whole inbox's ordering.
 */
function parseStatusTimestamp(updatedAt: string | undefined): number {
  if (!updatedAt) return Date.now();
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export interface RelayClientOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /**
   * This account's Account Master Key (SPEC §8, §16): every session key this
   * client derives (`@loombox/crypto`'s `deriveSessionKey`) comes from this
   * one 256-bit secret via its key tree — the exact same derivation the node
   * uses, so this client decrypts precisely what the node encrypted.
   * `RelayClient` itself stays storage-agnostic and just takes the bytes; a
   * caller generates/persists it on-device via `amk-store.ts`'s
   * `loadOrCreateAmk` (single-device custody, this wave) rather than typing
   * it in by hand. Multi-device recovery-code escrow/QR pairing (#113/#114/
   * #115) is a later wave, layered on top without changing this option.
   */
  amk: Uint8Array;
  /**
   * The account this client's sessions are scoped under — Better Auth's
   * `user.id` (SPEC §8), which a caller resolves via `auth-store.ts`'s
   * `AuthStore` (`StoredAuthSession.accountId`) rather than typing in by
   * hand. Also doubles as the `authToken` sent in `initialize` unless
   * `authToken` is given explicitly: the relay's dev/hermetic-test stub
   * (`deriveAccountIdStub`) treats the raw bearer token as the account id
   * verbatim, matching `@loombox/node`'s `NodeDaemonOptions.accountId`
   * contract; a real deployment (Better Auth configured on the relay) always
   * passes a real bearer as `authToken` alongside this.
   */
  accountId: string;
  /**
   * The WS handshake's `authToken` (SPEC §8): a real Better Auth bearer
   * token (`auth-store.ts`'s `AuthStore`, `StoredAuthSession.token`) once
   * the relay has Better Auth configured, which the relay resolves to an
   * account via `resolveAccountIdViaBetterAuth` — the same account this
   * option's sibling `accountId` must already equal, or this client would
   * derive session keys under one account while the relay scopes/routes
   * under another. Defaults to `accountId` (the relay's dev/hermetic-test
   * stub mode, see above) when omitted.
   */
  authToken?: string;
  /** This client's stable device identity, sent in the `initialize` handshake; generated if omitted. */
  deviceId?: string;
  /**
   * This device's ECDH P-256 identity public key, base64-encoded raw form
   * (SPEC §8). Real per-device keypair generation/persistence is the pairing
   * flow (out of scope here, mirrors `@loombox/node`'s `devicePublicKey`
   * option); a random placeholder is generated if omitted.
   */
  devicePublicKey?: string;
  /** WebSocket constructor override; defaults to the global `WebSocket`. Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
  /**
   * Persistence for the offline/mid-turn composer outbox (SPEC §7.3, §7.24;
   * issues #128/#130). Defaults to `createDefaultOutboxStorage(accountId)`
   * (IndexedDB when available, in-memory otherwise, see `outbox.ts`); tests
   * inject an isolated one so different accounts/instances in the same test
   * process never share a database.
   */
  outboxStorage?: OutboxStorage;
  /**
   * How long (ms) a session must go without any inbound `session_update`
   * (or an outbound prompt this client just sent) before its turn is
   * considered settled and the next queued prompt, if any, is flushed
   * (issue #128). This is now only the FALLBACK path: a `turn_ended`
   * lifecycle event (SPEC §7.24; `@loombox/node`'s `node-daemon.ts` forwards
   * one deterministically once the agent's turn actually settles) flushes
   * immediately and resets this timer, so the idle-quiet heuristic below
   * only ever fires for an older node that doesn't yet emit `turn_ended`, or
   * a race where it's lost. Deliberately generous by default so a real
   * agent's natural pauses between tokens/tool calls don't trip a premature
   * flush on that fallback path. Defaults to 1500ms; tests override it to a
   * few ms to stay fast.
   */
  turnIdleMs?: number;
}

/** Default for {@link RelayClientOptions.turnIdleMs}. */
const DEFAULT_TURN_IDLE_MS = 1500;

function generateId(prefix: string): string {
  const hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const unique = hasRandomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}_${unique}`;
}

/**
 * `Buffer`-free on purpose: `Buffer` is a Node builtin Vite does not
 * polyfill for the browser build, so `Buffer.from(...)` here would throw
 * the moment a real browser called `connect()` without an explicit
 * `devicePublicKey` (this constructed a placeholder unconditionally,
 * so every real page load hit it) — `btoa`/`atob` are globals in the
 * browser, jsdom, and Node 22 alike, so this runs identically everywhere
 * this module does (mirrors `amk-store.ts`'s identical fix/rationale).
 */
function randomBase64(byteLength = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** `Buffer`-free base64 encoding — see {@link randomBase64}'s doc comment for why. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Options for {@link bootstrapAmkFromRecoveryCode}. */
export interface BootstrapAmkFromRecoveryCodeOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /**
   * The account being bootstrapped — SPEC §8's "OAuth login (proves
   * identity, no QR, no other device involved)"; this must be the signed-in
   * account's own id (`auth-store.ts`'s `StoredAuthSession.accountId`), the
   * same value {@link unwrapAmkWithRecoveryCode}'s AAD binding checks
   * against.
   */
  accountId: string;
  /** The WS handshake's `authToken` — see `RelayClientOptions.authToken`'s doc comment. Defaults to `accountId` (the relay's dev/hermetic-test stub mode). */
  authToken?: string;
  /** This new device's id, sent in the `initialize`/`new_device_bootstrap_request` handshake; generated if omitted. */
  deviceId?: string;
  /**
   * Skips generating a fresh ECDH P-256 identity keypair and uses this raw
   * base64 public key instead — an escape hatch for a test asserting on a
   * fixed device identity; real callers should omit this and let
   * {@link bootstrapAmkFromRecoveryCode} generate one (SPEC §8: "generates
   * its own device ECDH P-256 keypair and registers into the device
   * registry"), since the whole point of this function is standing up a
   * brand-new device's identity, not reusing someone else's.
   */
  devicePublicKey?: string;
  /** The Recovery Code the user was shown (and confirmed saving) on their first device. */
  recoveryCode: string;
  /** WebSocket constructor override; defaults to the global `WebSocket`. Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
  /** How long to wait for the relay's `new_device_bootstrap_response` before giving up. Defaults to 10s. */
  timeoutMs?: number;
}

/** What {@link bootstrapAmkFromRecoveryCode} recovers: the account's AMK, plus the fresh device identity it registered along the way. */
export interface BootstrapAmkResult {
  /** This account's Account Master Key, recovered by unwrapping the relay's escrowed blob with the Recovery Code. Pass straight into `RelayClientOptions.amk`. */
  amk: Uint8Array;
  /** The device id this bootstrap registered under (SPEC §8's device registry, `owner_account_id` set from the OAuth session) — pass into `RelayClientOptions.deviceId` so the follow-up `RelayClient` connection reuses the same registered identity rather than registering a second device. */
  deviceId: string;
  /**
   * This new device's freshly generated ECDH P-256 identity keypair (SPEC
   * §8: "generates its own device ECDH P-256 keypair"), non-extractable —
   * `undefined` only when the caller explicitly opted out via
   * `devicePublicKey` (see that option's doc comment), since in that case
   * there is no keypair this function generated to hand back.
   */
  deviceKeyPair: EcdhKeyPair | undefined;
  /** The raw base64 public key half of `deviceKeyPair` (or the caller-supplied override) — what was actually sent to the relay and registered. */
  devicePublicKey: string;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * New-device bootstrap (SPEC §8 path 2 "New-device bootstrap"; issue #115):
 * a brand-new device, holding only OAuth identity and the account's Recovery
 * Code, recovers the account's AMK with **no previously-trusted device
 * online**, and generates+registers its own ECDH P-256 device identity along
 * the way. Opens its own short-lived connection — deliberately not a
 * {@link RelayClient}, since that class requires an AMK up front to derive
 * session keys, which is exactly what this function doesn't have yet — sends
 * `initialize` (which is what actually registers the device, `owner_account_id`
 * set from this connection's own OAuth-resolved account) then
 * `new_device_bootstrap_request`, and unwraps whatever wrapped-AMK blob the
 * relay hands back with `recoveryCode` (rejects, AEAD tag failure, if the
 * code is wrong). Does not persist the AMK or construct a `RelayClient`
 * itself: callers do both afterward (mirrors `amk-store.ts`'s
 * `loadOrCreateAmk`/`AmkStorage.set`), so this function has no storage side
 * effects of its own and stays trivially testable. The socket is always
 * closed before this resolves or rejects.
 */
export async function bootstrapAmkFromRecoveryCode(
  options: BootstrapAmkFromRecoveryCodeOptions,
): Promise<BootstrapAmkResult> {
  const deviceId = options.deviceId ?? generateId('device');
  const authToken = options.authToken ?? options.accountId;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;

  // SPEC §8: a new device generates its own ECDH P-256 identity keypair as
  // part of bootstrapping — only skipped when the caller explicitly hands
  // in its own `devicePublicKey` (see that option's doc comment).
  const deviceKeyPair = options.devicePublicKey ? undefined : await generateEcdhKeyPair();
  const devicePublicKey =
    options.devicePublicKey ??
    bytesToBase64(await exportPublicKeyRaw((deviceKeyPair as EcdhKeyPair).publicKey));

  const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
  if (!ctor) {
    throw new Error(
      'bootstrapAmkFromRecoveryCode: no global WebSocket available; pass webSocketImpl explicitly',
    );
  }

  const socket = new ctor(options.relayUrl);
  try {
    const wrappedAmkWire = await new Promise<string>((resolve, reject) => {
      let awaitingInitializeResult = true;
      const timer = setTimeout(() => {
        reject(new Error('bootstrapAmkFromRecoveryCode: timed out waiting for the relay'));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        const initialize: Initialize = {
          type: 'initialize',
          protocolVersion: PROTOCOL_V1,
          role: 'client',
          authToken,
          deviceId,
          devicePublicKey,
        };
        socket.send(JSON.stringify(initialize));
      });

      socket.addEventListener('message', (event: { data: unknown }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (awaitingInitializeResult) {
          awaitingInitializeResult = false;
          const result = initializeResult.safeParse(parsed);
          if (!result.success) {
            clearTimeout(timer);
            reject(new Error('bootstrapAmkFromRecoveryCode: relay rejected the handshake'));
            return;
          }
          const request: NewDeviceBootstrapRequest = {
            type: 'new_device_bootstrap_request',
            protocolVersion: PROTOCOL_V1,
            deviceId,
            devicePublicKey,
          };
          socket.send(JSON.stringify(request));
          return;
        }

        const response = newDeviceBootstrapResponse.safeParse(parsed);
        if (response.success) {
          clearTimeout(timer);
          resolve(response.data.wrappedAmk);
        }
      });

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`bootstrapAmkFromRecoveryCode: cannot reach ${options.relayUrl}`));
      });
    });

    const blob = unpackWrappedAmkFromWire(wrappedAmkWire);
    const amk = await unwrapAmkWithRecoveryCode(blob, options.recoveryCode, options.accountId);
    return { amk, deviceId, deviceKeyPair, devicePublicKey };
  } finally {
    if (socket.readyState === 0 /* CONNECTING */ || socket.readyState === WS_OPEN) {
      socket.close();
    }
  }
}

/**
 * Seals raw attachment bytes (not JSON, unlike `sealJson`) under the
 * session key, bound to `attachmentResourceId(sessionId, ref)` — the exact
 * AAD the relay's blob store keys by and `@loombox/node`'s
 * `AttachmentResolver` decrypts against (see `attachments.ts`'s doc
 * comment), so this client's upload and the node's later download+decrypt
 * agree on the binding without this package depending on `@loombox/node`.
 */
async function sealAttachmentEnvelope(
  sessionId: string,
  ref: string,
  bytes: Uint8Array,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const envelope = await encryptEnvelope(attachmentResourceId(sessionId, ref), bytes, key);
  return envelopeToWire(envelope);
}

/**
 * `URL.createObjectURL` for the instant local attachment preview (SPEC
 * §7.25). Guarded rather than assumed: real browsers and Node 22 (the
 * hermetic tests below) both have it, but nothing here should throw for an
 * environment that doesn't (e.g. an older jsdom in a component test) — a
 * missing preview is a cosmetic gap, not a broken upload.
 */
function safeCreateObjectUrl(file: AttachableFile): string | undefined {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
    return URL.createObjectURL(file as unknown as Blob);
  } catch {
    return undefined;
  }
}

function safeRevokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // best-effort cleanup only
  }
}

/**
 * Owns one outbound WebSocket connection from the PWA to the v1 relay (SPEC
 * §5.4 "list sessions ... view live output", §7.3 "send follow-up prompts",
 * §8/§16's E2E-encrypted wire; `docs/v1-plan.md`; issue #315). Sends
 * `initialize` (role `'client'`) as the first frame, requests the
 * account-scoped session snapshot once handshaken, and keeps a reactive
 * session list fed by that `session_list` snapshot plus subsequent
 * `session_announce`es (the relay's reply to this client's own
 * `session_resume` calls) — **decrypting** each session's private envelope
 * under its derived session key (`@loombox/crypto`'s `deriveSessionKey`,
 * the identical derivation `@loombox/node` uses) to recover `title`/
 * `projectPath`, which the relay itself never sees in the clear.
 *
 * For a session the UI selects, `transcriptFor` subscribes to its live
 * updates (`session_resume`) and decrypts + reduces every inbound
 * `session_update` envelope through `@loombox/providers-core`'s
 * `reduceSessionEvent` — the same pure reducer this codebase's real source
 * of truth uses, additive to the transcript-only `reduceTranscript`: the
 * same `TranscriptState` also carries the session's live `status`
 * (SPEC §7.13/§7.24; issue #126), its `configOptions` catalog (issue #149,
 * `configOptionsFor` below just reads that field), and `turnActive`/
 * `lastStopReason` (issue #128) — one reduced state per session, not
 * several parallel stores that could drift out of sync. `sendPrompt` seals
 * the composer's text into a `prompt_inject`
 * envelope and, since the relay never echoes it back, optimistically reduces
 * the user's own turn into the local transcript so it shows immediately —
 * unless a turn is already considered in flight for that session, or there
 * is no open connection, in which case it queues locally and persists to
 * the IndexedDB-backed offline outbox instead (SPEC §7.3, §7.24; issues
 * #128/#130), flushed in order once the turn settles or the connection
 * comes back. This client still does not itself auto-reconnect with backoff
 * (a caller decides when to call `connect()` again).
 *
 * All state is exposed as plain `svelte/store` readables (the `subscribe`
 * contract), which has no DOM dependency, so this whole module is unit
 * tested here against a real in-process `@loombox/relay` plus a fake,
 * independently-keyed "node" over the global `WebSocket` — no browser, no
 * jsdom.
 */
export class RelayClient {
  readonly status: Readable<ConnectionStatus>;
  readonly sessions: Readable<ClientSessionMeta[]>;

  private readonly options: RelayClientOptions;
  private readonly amk: Uint8Array;
  private readonly accountId: string;
  private readonly authToken: string;
  private readonly deviceId: string;
  private readonly devicePublicKey: string;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly statusStore: Writable<ConnectionStatus>;
  private readonly sessionsStore: Writable<ClientSessionMeta[]>;
  private readonly transcripts = new Map<string, Writable<TranscriptState>>();
  private readonly permissionQueues = new Map<string, Writable<PermissionQueueState>>();
  private readonly subscribed = new Set<string>();
  /** Backs {@link attentionInbox} — see that method's doc comment. */
  private readonly attentionInboxStore: Writable<AttentionInboxItem[]> = writable([]);
  /** True once {@link attentionInbox} has been called at least once (it is lazily activated, like every other per-session subscription in this class). */
  private inboxTrackingActive = false;
  /** Sessions already wired to recompute the inbox on their own transcript/permission-queue changes — see {@link trackSessionForInbox}. */
  private readonly inboxTrackedSessions = new Set<string>();
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();
  private readonly attachments = new Map<string, Writable<ComposerAttachment[]>>();
  /** Keyed by attachment id (globally unique, `generateId('att')`), not per-session — an id is only ever used within the one session it was attached to. */
  private readonly attachmentBytesById = new Map<string, CachedAttachment>();
  /** The composer outbox's persistence (issues #128/#130); see `RelayClientOptions.outboxStorage`'s doc comment. */
  private readonly outboxStorage: OutboxStorage;
  private readonly turnIdleMs: number;
  /** A session's currently queued-but-not-yet-flushed prompts, oldest first (issues #128/#130). */
  private readonly queuedPrompts = new Map<string, Writable<QueuedPrompt[]>>();
  /** A session's pending "turn considered active" idle timer, present only while that session is within `turnIdleMs` of its last known activity (issue #128's mid-turn-queueing heuristic). */
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private socket: WebSocketLike | undefined;
  private awaitingInitializeResult = false;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.amk = options.amk;
    this.accountId = options.accountId;
    this.authToken = options.authToken ?? options.accountId;
    this.deviceId = options.deviceId ?? generateId('device');
    this.devicePublicKey = options.devicePublicKey ?? randomBase64();
    this.outboxStorage = options.outboxStorage ?? createDefaultOutboxStorage(this.accountId);
    this.turnIdleMs = options.turnIdleMs ?? DEFAULT_TURN_IDLE_MS;

    const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    if (!ctor) {
      throw new Error('RelayClient: no global WebSocket available; pass webSocketImpl explicitly');
    }
    this.WebSocketCtor = ctor;

    this.statusStore = writable<ConnectionStatus>('idle');
    this.sessionsStore = writable<ClientSessionMeta[]>([]);
    this.status = this.statusStore;
    this.sessions = this.sessionsStore;

    // Reloads whatever this account's outbox already had persisted (issue
    // #130's "outbox survives a full page reload") — fire-and-forget since
    // the constructor can't be async; `queuedPromptsFor` simply starts empty
    // and fills in once this resolves. Also opportunistically flushes each
    // session it finds, in case `connect()`/the socket is already open by
    // the time this resolves (see `flushOutboxOnReconnect`'s doc comment).
    void this.hydrateOutbox();
  }

  /** Opens the connection (no-op if already connecting/open) and sends `initialize` once open. */
  connect(): void {
    if (this.socket) return;
    this.statusStore.set('connecting');

    const socket = new this.WebSocketCtor(this.options.relayUrl);
    this.socket = socket;
    this.awaitingInitializeResult = true;

    socket.addEventListener('open', () => {
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'client',
        authToken: this.authToken,
        deviceId: this.deviceId,
        devicePublicKey: this.devicePublicKey,
      };
      socket.send(JSON.stringify(initialize));
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const parsed = this.parseRaw(event.data);
      if (parsed === undefined) return;

      if (this.awaitingInitializeResult) {
        this.awaitingInitializeResult = false;
        const result = initializeResult.safeParse(parsed);
        if (result.success) {
          this.statusStore.set('open');
          // The account-scoped snapshot (SPEC §8's OAuth-alone listing) —
          // every session already announced by a node this account owns.
          this.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
          // Issue #155: a dropped connection mid-upload gets exactly one
          // automatic retry once the connection is back — harmless on the
          // very first connect too, since no attachment can be in a
          // 'failed' state before any upload has ever been attempted.
          this.retryFailedAttachmentsOnReconnect();
          // Issue #130: flush whatever this account's outbox is still
          // holding (composed offline, or hydrated from a prior page load)
          // now that the connection is back — harmless on the very first
          // connect too, since nothing can be queued before any prompt has
          // ever been sent.
          this.flushOutboxOnReconnect();
        } else {
          this.statusStore.set('error');
        }
        return;
      }

      const message = safeParseWireMessageV1(parsed);
      if (message.success) this.handleInbound(message.data);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.awaitingInitializeResult = false;
      this.statusStore.set('closed');
      // The connection is gone, so this client has no way left to observe
      // whether a turn it thought was active actually settled — clearing
      // every pending idle timer treats every session as "unknown, assume
      // ready" rather than gating the local queue on a timer that will
      // never fire again. `flushOutboxOnReconnect` re-attempts each session
      // once the socket reopens, so nothing queued is lost, only its
      // in-flight "settled" bookkeeping resets.
      this.clearAllTurnTimers();
    });

    // 'close' always follows 'error' for the WHATWG WebSocket, so status is
    // set there too; this listener just keeps an error from going unhandled
    // and surfaces the 'error' status a beat sooner for the UI.
    socket.addEventListener('error', () => {
      this.statusStore.set('error');
    });
  }

  /** Deliberately closes the connection. v1's client core does not auto-reconnect (Wave D.2/later). */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Uploads this account's AMK to the relay, wrapped under a key derived
   * from `recoveryCode` (SPEC §8 path 2 "recovery-code escrow"; issue #114).
   * The relay only ever stores the single opaque blob
   * `@loombox/crypto`'s `packWrappedAmkForWire` produces — see that
   * module's doc comment. Meant to run once, right after the Recovery Code
   * is generated and shown with its "I saved this" confirmation (out of
   * scope here, the PWA client epic's concern) on the account's first
   * device. Requires an open connection: unlike `send()`'s best-effort
   * fire-and-forget for live session traffic, this is a deliberate one-time
   * setup action, so a caller that isn't connected gets a loud rejection
   * instead of a silently dropped upload.
   */
  async escrowAmk(recoveryCode: string): Promise<void> {
    if (!this.isSocketOpen()) {
      throw new Error('RelayClient.escrowAmk: not connected to the relay');
    }
    const wrapped = await wrapAmkWithRecoveryCode(this.amk, recoveryCode, this.accountId);
    this.send({
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk: packWrappedAmkForWire(wrapped),
    });
  }

  /**
   * The append-only transcript store for one session (created empty on
   * first access) — subscribing (`session_resume`) this connection to that
   * session's live `session_update` fan-out the first time it's requested,
   * per the relay's subscription model (`packages/relay/src/relay.ts`).
   */
  transcriptFor(sessionId: string): Readable<TranscriptState> {
    const store = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return store;
  }

  /**
   * This session's live status (SPEC §7.13/§7.24; issue #126's status
   * badge) — `undefined` until the node's `session_status` snapshot arrives.
   * Derived from the same reduced `TranscriptState` `transcriptFor` exposes,
   * not a separate store (see this class's own doc comment).
   */
  statusFor(sessionId: string): Readable<AcpSessionStatus | undefined> {
    const store = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(store, (state) => state.status);
  }

  /**
   * The session-scoped permission FIFO queue store (SPEC §7.24, issues
   * #144/#145/#146/#147) — the single client-side source of truth a
   * session's permission-card UI and (once it exists) the cross-project
   * attention inbox (#145) both render from. Backed by
   * `@loombox/providers-core`'s pure `permission-queue-state.ts` functions
   * rather than its `EventEmitter`-based `PermissionQueue` class: that class
   * extends `node:events`, which externalizes to an empty stub in a
   * client-side Vite build (`class X extends EventEmitter {}` then throws at
   * module-evaluation time — confirmed empirically while building this PR),
   * so this store re-derives the exact same FIFO/nested-visibility/cancel-
   * all rules through the shared pure functions instead of re-implementing
   * them.
   */
  permissionQueueFor(sessionId: string): Readable<PermissionQueueState> {
    const store = this.permissionQueueStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return store;
  }

  /**
   * The cross-project attention inbox (SPEC §7.13; issues #167/#168/#169):
   * one live, sorted (oldest-waiting first) list of every session-level item
   * that needs the user right now, across every session on this account —
   * not only the one currently open. Each session contributes at most:
   * - a `'permission'` item for its FIFO-head pending request (issue #146's
   *   nested-visibility rule already means only that head is ever
   *   actionable, so listing the rest would show items the user can't yet
   *   act on — approving the head is what promotes the next one into view,
   *   on both this inbox and the session's own `PermissionQueueBar`);
   * - an `'awaiting_input'` item while its live `session_status` is
   *   `'awaiting_input'`.
   *
   * Reads straight off the exact same `permissionQueueStoreFor`/
   * `transcriptStoreFor` stores {@link permissionQueueFor}/{@link statusFor}
   * do — never a second copy of queue/status state — so resolving a
   * request via {@link resolvePermission}, whether the caller is this
   * inbox's own "approve" button or the session's own composer-site queue
   * bar, converges on the one store both read, and each reflects the
   * other's resolution immediately (issue #169).
   *
   * Unlike `transcriptFor`/`permissionQueueFor`/`configOptionsFor`
   * (subscribed per-session, only once a caller actually opens that
   * session), this subscribes to EVERY currently-known session the first
   * time it's called, and every session announced afterwards — the whole
   * point of a cross-session inbox is surfacing a session's attention state
   * without the user having opened it first. Still lazy in the sense that
   * nothing here runs until this method is called at least once.
   */
  attentionInbox(): Readable<AttentionInboxItem[]> {
    if (!this.inboxTrackingActive) {
      this.inboxTrackingActive = true;
      for (const session of get(this.sessionsStore)) this.trackSessionForInbox(session.id);
      this.recomputeAttentionInbox();
    }
    return this.attentionInboxStore;
  }

  /**
   * Resolves a pending permission request with the user's chosen option:
   * updates the local queue optimistically (so the UI reflects it before any
   * round trip) and sends the clear (unencrypted routing) `permission_response`
   * carrying ACP's own `option.kind` vocabulary as `decision` — the wire
   * schema has no raw `optionId` field (`packages/protocol/src/v1/steering.ts`).
   */
  resolvePermission(sessionId: string, requestId: string, option: AcpPermissionOption): void {
    const store = this.permissionQueueStoreFor(sessionId);
    store.update(
      (state) =>
        resolvePermissionRequest(state, requestId, {
          outcome: 'selected',
          optionId: option.optionId,
        }).state,
    );
    this.send({
      type: 'permission_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      decision: option.kind,
    });
  }

  /**
   * A session-level Stop (SPEC §7.24 "Multi-request ordering"): every open
   * permission request for this session resolves as cancelled immediately,
   * optimistically, so no card's spinner survives past the press. There is
   * no v1 wire message for the ACP-level turn interrupt itself yet
   * (out of this PR's protocol-touching scope) — this only clears the
   * permission queue's own state, which is what issue #147's acceptance
   * criteria are actually about.
   */
  cancelPermissionRequests(sessionId: string): void {
    const store = this.permissionQueueStoreFor(sessionId);
    store.update((state) => cancelAllPermissionRequests(state, sessionId).state);
  }

  /**
   * The session's negotiated ACP config-option list (SPEC §7.24 "Model, mode
   * & reasoning effort", issue #149) — `model`/`model_config`/`thought_level`/
   * `mode`/any future category, always the complete current set. Backed by
   * the same reduced `TranscriptState` `transcriptFor` exposes (its
   * `configOptions` field, populated by the node's `config_options`/
   * `config_option_update` session-lifecycle events — see this class's own
   * doc comment), not a separate parallel store, so the two can never drift.
   * Starts `[]` until the first push arrives (a node running against an
   * agent that advertises no config options at all, or a subscription that
   * hasn't received one yet).
   */
  configOptionsFor(sessionId: string): Readable<AcpConfigOption[]> {
    const transcript = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(transcript, (state) => state.configOptions);
  }

  /**
   * Picks a config option in the given category: updates the local list
   * optimistically (replacing that category's `current`, in the same
   * reduced `TranscriptState` `configOptionsFor` reads) and sends the
   * `config_option` wire message so the owning node can act on it.
   */
  setConfigOption(sessionId: string, category: string, optionId: string): void {
    const store = this.transcriptStoreFor(sessionId);
    store.update((state) => ({
      ...state,
      configOptions: state.configOptions.map((option) =>
        option.category === category ? { ...option, current: optionId } : option,
      ),
    }));
    this.send({
      type: 'config_option',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      category,
      optionId,
    });
  }

  /**
   * The composer's pending attachment list for one session (SPEC §7.25;
   * issues #151/#153/#155) — every image currently attached, uploading,
   * uploaded, failed, or rejected, in attach order. Starts empty; populated
   * only by {@link attachFile}. Unlike `transcriptFor`/`permissionQueueFor`/
   * `configOptionsFor`, this never subscribes anything on the relay — it is
   * pure client-local composer state, no wire traffic until a file is
   * actually attached.
   */
  attachmentsFor(sessionId: string): Readable<ComposerAttachment[]> {
    return this.attachmentStoreFor(sessionId);
  }

  /**
   * Attaches an image to the given session's next prompt (SPEC §7.25;
   * issues #151/#152/#153): validates the file's sniffed magic bytes and
   * size synchronously-fast-pathed where possible, rejecting an oversized,
   * unsupported, or HEIC/HEIF file with a clear message before any upload
   * is attempted; otherwise starts the encrypt-and-upload the moment this
   * is called, not deferred until send. Returns the generated attachment id
   * synchronously (also the blob's opaque `ref` on the wire) so the caller
   * can render it immediately; the read/validate/encrypt/upload pipeline
   * itself is asynchronous.
   */
  attachFile(sessionId: string, file: AttachableFile): string {
    const id = generateId('att');
    const existing = get(this.attachmentStoreFor(sessionId));
    const activeCount = existing.filter((a) => a.status !== 'rejected').length;

    if (activeCount >= MAX_ATTACHMENTS_PER_PROMPT) {
      this.pushAttachment(sessionId, {
        id,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        previewUrl: undefined,
        status: 'rejected',
        error: `You can attach up to ${MAX_ATTACHMENTS_PER_PROMPT} images per prompt.`,
      });
      return id;
    }

    this.pushAttachment(sessionId, {
      id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: undefined,
      status: 'uploading',
      error: undefined,
    });

    this.processAttachment(sessionId, id, file).catch((error: unknown) => {
      console.warn(
        `RelayClient: failed to process attachment ${id} for session ${sessionId}: ${errorMessage(error)}`,
      );
      this.updateAttachment(sessionId, id, {
        status: 'failed',
        error: `Upload failed: ${errorMessage(error)}`,
      });
    });

    return id;
  }

  /**
   * Retries a `'failed'` attachment's upload (issue #155's manual retry
   * control) using the same plaintext bytes already read/validated on the
   * first attempt — the user never has to re-pick the file. A no-op if this
   * attachment's bytes were never cached (e.g. it was `'rejected'`, which
   * has nothing to retry).
   */
  retryAttachment(sessionId: string, id: string): void {
    if (!this.attachmentBytesById.has(id)) return;
    this.uploadAttachment(sessionId, id).catch((error: unknown) => {
      console.warn(
        `RelayClient: retry failed for attachment ${id} in session ${sessionId}: ${errorMessage(error)}`,
      );
    });
  }

  /** Removes an attachment from the composer (a rejected file, or one the user no longer wants to send) and revokes its preview object URL. */
  removeAttachment(sessionId: string, id: string): void {
    this.clearAttachments(sessionId, [id]);
  }

  private async processAttachment(
    sessionId: string,
    id: string,
    file: AttachableFile,
  ): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const validation = validateAttachmentBytes(bytes);
    if (!validation.ok) {
      this.updateAttachment(sessionId, id, { status: 'rejected', error: validation.message });
      return;
    }

    this.attachmentBytesById.set(id, {
      sessionId,
      bytes,
      mimeType: validation.mimeType,
      name: file.name,
      autoRetried: false,
    });
    this.updateAttachment(sessionId, id, {
      mimeType: validation.mimeType,
      previewUrl: safeCreateObjectUrl(file),
      error: undefined,
    });

    await this.uploadAttachment(sessionId, id);
  }

  /**
   * Encrypts this attachment's cached bytes under the session's derived key
   * (SPEC §7.25: "the same per-device E2E scheme as everything else") and
   * uploads the ciphertext via the existing `blob_upload` wire message —
   * the relay only ever receives/stores this opaque envelope, addressed by
   * `id` as its `ref`. `'uploaded'` here means the encrypt-and-send round
   * trip to an open socket completed (there is no server-side upload ack in
   * v1's wire protocol, matching every other outbound message in this
   * class, e.g. `prompt_inject`); a socket that isn't open, or an
   * encryption failure, marks the attachment `'failed'` instead so issue
   * #155's retry control has something to act on.
   */
  private async uploadAttachment(sessionId: string, id: string): Promise<void> {
    const cached = this.attachmentBytesById.get(id);
    if (!cached) return;

    this.updateAttachment(sessionId, id, { status: 'uploading', error: undefined });
    try {
      if (!this.socket || this.socket.readyState !== WS_OPEN) {
        throw new Error('not connected to the relay');
      }
      const key = await this.getSessionKey(sessionId);
      const envelope = await sealAttachmentEnvelope(sessionId, id, cached.bytes, key);
      this.send({
        type: 'blob_upload',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        ref: id,
        envelope,
      });
      this.updateAttachment(sessionId, id, { status: 'uploaded', error: undefined });
    } catch (error) {
      this.updateAttachment(sessionId, id, {
        status: 'failed',
        error: `Upload failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  }

  /**
   * Issue #155's "a dropped connection mid-upload... auto-retries once on
   * reconnect": runs on every successful `initialize_result` (including the
   * very first connect, where it is a no-op since nothing can be `'failed'`
   * yet). Marks each retried attachment `autoRetried` first so a second
   * reconnect — or a retry that itself fails again — never retries it a
   * second time unattended; the manual retry control remains available
   * regardless.
   */
  private retryFailedAttachmentsOnReconnect(): void {
    for (const [id, cached] of this.attachmentBytesById) {
      if (cached.autoRetried) continue;
      const store = this.attachments.get(cached.sessionId);
      const current = store ? get(store).find((a) => a.id === id) : undefined;
      if (current?.status !== 'failed') continue;
      cached.autoRetried = true;
      this.retryAttachment(cached.sessionId, id);
    }
  }

  private attachmentStoreFor(sessionId: string): Writable<ComposerAttachment[]> {
    let store = this.attachments.get(sessionId);
    if (!store) {
      store = writable<ComposerAttachment[]>([]);
      this.attachments.set(sessionId, store);
    }
    return store;
  }

  private pushAttachment(sessionId: string, attachment: ComposerAttachment): void {
    this.attachmentStoreFor(sessionId).update((list) => [...list, attachment]);
  }

  private updateAttachment(
    sessionId: string,
    id: string,
    patch: Partial<Omit<ComposerAttachment, 'id'>>,
  ): void {
    this.attachmentStoreFor(sessionId).update((list) =>
      list.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  }

  private clearAttachments(sessionId: string, ids: string[]): void {
    const idSet = new Set(ids);
    this.attachmentStoreFor(sessionId).update((list) =>
      list.filter((a) => {
        if (!idSet.has(a.id)) return true;
        if (a.previewUrl) safeRevokeObjectUrl(a.previewUrl);
        this.attachmentBytesById.delete(a.id);
        return false;
      }),
    );
  }

  /**
   * Resolves attachment ids to the `PromptAttachmentRef`s actually sent
   * with a prompt — only ever an attachment whose upload has itself
   * completed. SPEC §7.25: "The file event for that attachment is only
   * ever sent once the blob upload has confirmed — a broken ref must never
   * reach the agent," so a `'uploading'`/`'failed'`/`'rejected'` id (issue
   * #155's send-gate should already prevent this from being reachable, but
   * this is the actual enforcement) is silently dropped rather than sent.
   */
  private resolveUploadedAttachmentRefs(
    sessionId: string,
    attachmentIds: string[],
  ): PromptAttachmentRef[] {
    const current = get(this.attachmentStoreFor(sessionId));
    const refs: PromptAttachmentRef[] = [];
    for (const id of attachmentIds) {
      const attachment = current.find((a) => a.id === id);
      if (attachment?.status !== 'uploaded') continue;
      refs.push({ ref: attachment.id, mimeType: attachment.mimeType, name: attachment.name });
    }
    return refs;
  }

  /**
   * The composer's currently queued-but-unsent prompts for one session, in
   * flush order (oldest first) — SPEC §7.24's "shown in the transcript in a
   * pending 'queued' state" (issue #128) and SPEC §7.3's "a follow-up
   * prompt composed offline queues ... shown as pending in the composer/
   * transcript" (issue #130). Starts empty; hydrated asynchronously from
   * `outboxStorage` (survives a reload) and updated by every
   * {@link sendPrompt} call this session queues rather than sends
   * immediately. Like `attachmentsFor`, this never itself subscribes
   * anything on the relay.
   */
  queuedPromptsFor(sessionId: string): Readable<QueuedPrompt[]> {
    return this.queuedPromptStoreFor(sessionId);
  }

  /**
   * Seals the composer's text (and any uploaded attachment refs, SPEC
   * §7.25) into a `prompt_inject` envelope (SPEC §7.3) and sends it — or, if
   * this session already has a turn considered in flight (issue #128) or
   * there is currently no open connection (issue #130), queues it instead:
   * appended to that session's {@link queuedPromptsFor} list and persisted
   * to the offline outbox, to be flushed in order once the turn settles or
   * the connection comes back (`flushNext`/`flushOutboxOnReconnect`).
   * Always returns the generated `promptId` synchronously, whichever path
   * was taken; referenced attachments are cleared from the composer's
   * pending list either way, since they now belong to this prompt (sent or
   * queued), not a future one.
   */
  sendPrompt(sessionId: string, text: string, attachmentIds: string[] = []): string {
    const attachments = this.resolveUploadedAttachmentRefs(sessionId, attachmentIds);
    const item: QueuedPrompt = {
      id: generateId('prompt'),
      sessionId,
      text,
      attachments,
      queuedAt: Date.now(),
    };

    const alreadyQueued = get(this.queuedPromptStoreFor(sessionId)).length > 0;
    const turnActive = this.turnTimers.has(sessionId);
    if (alreadyQueued || turnActive || !this.isSocketOpen()) {
      this.enqueuePrompt(item);
    } else {
      this.dispatchPrompt(item);
    }

    if (attachmentIds.length > 0) this.clearAttachments(sessionId, attachmentIds);

    return item.id;
  }

  /**
   * Actually sends a prompt (immediate `sendPrompt`, or one just dequeued
   * by `flushNext`/`flushOutboxOnReconnect`): the optimistic local
   * transcript update, the real encrypt-and-send, marking this session's
   * turn active again (so a prompt queued right behind this one waits its
   * own turn), and — idempotently, a no-op if `item` was never queued —
   * removing it from the local queue and the persisted outbox.
   */
  private dispatchPrompt(item: QueuedPrompt): void {
    this.removeFromQueue(item.sessionId, item.id);
    this.applyUpdate(item.sessionId, {
      kind: 'user_message_chunk',
      turnId: item.id,
      messageId: item.id,
      text: item.text,
    });
    this.encryptAndSendPrompt(item.sessionId, item.id, item.text, item.attachments).catch(
      (error: unknown) => {
        console.warn(
          `RelayClient: failed to encrypt/send prompt_inject for session ${item.sessionId}: ${errorMessage(error)}`,
        );
      },
    );
    this.markTurnActive(item.sessionId);
  }

  /** Appends to the local queue and persists to the outbox (fire-and-forget; a persistence failure is logged, not thrown — mirrors this class's other best-effort wire/storage writes). */
  private enqueuePrompt(item: QueuedPrompt): void {
    this.queuedPromptStoreFor(item.sessionId).update((list) => [...list, item]);
    this.outboxStorage.put(item).catch((error: unknown) => {
      console.warn(
        `RelayClient: failed to persist queued prompt ${item.id} to the offline outbox: ${errorMessage(error)}`,
      );
    });
  }

  /** Removes `id` from the local queue and the persisted outbox — a no-op (including no outbox write) if `id` was never queued, so dispatching a fresh, never-queued prompt never touches storage. */
  private removeFromQueue(sessionId: string, id: string): void {
    const store = this.queuedPromptStoreFor(sessionId);
    if (!get(store).some((p) => p.id === id)) return;
    store.update((list) => list.filter((p) => p.id !== id));
    this.outboxStorage.delete(id).catch((error: unknown) => {
      console.warn(
        `RelayClient: failed to remove flushed prompt ${id} from the offline outbox: ${errorMessage(error)}`,
      );
    });
  }

  /**
   * (Re)starts this session's `turnIdleMs` idle-timeout FALLBACK timer —
   * called both when this client sends a prompt and whenever any
   * `session_update` arrives for this session other than a `turn_ended`
   * (including one triggered by another device's prompt on the same
   * session), since either is equally good evidence a turn is still active.
   * `turnTimers.has(sessionId)` is this class's "is a turn in flight" signal
   * for the fallback path (issue #128's original heuristic); the primary
   * path is {@link settleTurnNow}, called on the real `turn_ended` event
   * instead — see `RelayClientOptions.turnIdleMs`'s doc comment.
   */
  private markTurnActive(sessionId: string): void {
    const existing = this.turnTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => this.onTurnSettled(sessionId), this.turnIdleMs);
    this.turnTimers.set(sessionId, timer);
  }

  private onTurnSettled(sessionId: string): void {
    this.turnTimers.delete(sessionId);
    this.flushNext(sessionId);
  }

  /**
   * Settles a turn deterministically, right now, on this session's real
   * `turn_ended` event (SPEC §7.24; issue #128) — clears the idle-timeout
   * fallback timer (it would otherwise still fire later and redundantly call
   * `flushNext`, which is harmless but pointless) and flushes the next
   * queued prompt immediately instead of waiting out `turnIdleMs`.
   */
  private settleTurnNow(sessionId: string): void {
    const existing = this.turnTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    this.turnTimers.delete(sessionId);
    this.flushNext(sessionId);
  }

  private clearAllTurnTimers(): void {
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
  }

  /** Dispatches this session's oldest queued prompt, if any, the connection is open, and no turn is currently considered active for it — otherwise a no-op (the queue is left exactly as it was, to be retried by the next settle/reconnect). */
  private flushNext(sessionId: string): void {
    if (this.turnTimers.has(sessionId)) return;
    if (!this.isSocketOpen()) return;
    const next = get(this.queuedPromptStoreFor(sessionId))[0];
    if (!next) return;
    this.dispatchPrompt(next);
  }

  /**
   * Issue #130's "on reconnect, queued prompts send in order automatically":
   * runs on every successful `initialize_result` (including the very first
   * connect, where it is a no-op since nothing can be queued before any
   * prompt has ever been sent). Attempts every session this client
   * currently knows has queued prompts — `flushNext` itself is the
   * exactly-once gate (a prompt already dispatched is no longer in the
   * queue, so a second reconnect finds nothing left to resend for it).
   */
  private flushOutboxOnReconnect(): void {
    for (const sessionId of this.queuedPrompts.keys()) {
      this.flushNext(sessionId);
    }
  }

  /**
   * Loads whatever this account's outbox already had persisted — from a
   * prior page load, or a previous `RelayClient` instance in the same
   * process — into the local per-session queue stores (issue #130's
   * "outbox survives a full page reload"). Runs once, fired from the
   * constructor; also opportunistically flushes each session it populates,
   * in case the socket is already open by the time this (inherently async)
   * read resolves — `connect()` is typically called right after
   * construction, so `flushOutboxOnReconnect`'s own `initialize_result`-
   * triggered pass can race ahead of this one and find the queue still
   * empty otherwise.
   */
  private async hydrateOutbox(): Promise<void> {
    try {
      const persisted = await this.outboxStorage.list();
      const bySession = new Map<string, QueuedPrompt[]>();
      for (const item of persisted) {
        const list = bySession.get(item.sessionId) ?? [];
        list.push(item);
        bySession.set(item.sessionId, list);
      }
      for (const [sessionId, items] of bySession) {
        this.queuedPromptStoreFor(sessionId).update((existing) => {
          const knownIds = new Set(existing.map((p) => p.id));
          const merged = [...existing, ...items.filter((p) => !knownIds.has(p.id))];
          return merged.sort((a, b) => a.queuedAt - b.queuedAt);
        });
        this.flushNext(sessionId);
      }
    } catch (error) {
      console.warn(`RelayClient: failed to hydrate the offline outbox: ${errorMessage(error)}`);
    }
  }

  private queuedPromptStoreFor(sessionId: string): Writable<QueuedPrompt[]> {
    let store = this.queuedPrompts.get(sessionId);
    if (!store) {
      store = writable<QueuedPrompt[]>([]);
      this.queuedPrompts.set(sessionId, store);
    }
    return store;
  }

  private isSocketOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === WS_OPEN;
  }

  private async encryptAndSendPrompt(
    sessionId: string,
    promptId: string,
    text: string,
    attachments: PromptAttachmentRef[],
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const payload: PromptPayload = attachments.length > 0 ? { text, attachments } : { text };
    const envelope = await sealJson(sessionId, payload, key);
    this.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      promptId,
      envelope,
    });
  }

  private ensureSubscribed(sessionId: string): void {
    if (this.subscribed.has(sessionId)) return;
    this.subscribed.add(sessionId);
    this.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
  }

  /**
   * Wires one session into the attention inbox: subscribes it (so its
   * `permission_request`/`session_update` traffic actually reaches this
   * client, see `ensureSubscribed`) and recomputes the inbox whenever
   * either its transcript (status) or its permission queue changes.
   * Idempotent per session id, and a no-op before {@link attentionInbox}
   * has ever been called (see `syncInboxTracking`).
   */
  private trackSessionForInbox(sessionId: string): void {
    if (this.inboxTrackedSessions.has(sessionId)) return;
    this.inboxTrackedSessions.add(sessionId);
    this.ensureSubscribed(sessionId);
    this.transcriptStoreFor(sessionId).subscribe(() => this.recomputeAttentionInbox());
    this.permissionQueueStoreFor(sessionId).subscribe(() => this.recomputeAttentionInbox());
  }

  /** Tracks every session in `sessions` for the inbox — a no-op until {@link attentionInbox} has been called at least once, and per-session idempotent thereafter (see `trackSessionForInbox`). Called whenever the session list gains an entry. */
  private syncInboxTracking(sessions: readonly ClientSessionMeta[]): void {
    if (!this.inboxTrackingActive) return;
    for (const session of sessions) this.trackSessionForInbox(session.id);
  }

  /** Rebuilds the whole attention-inbox list from current state — see {@link attentionInbox}'s doc comment for what qualifies and the sort order. */
  private recomputeAttentionInbox(): void {
    const items: AttentionInboxItem[] = [];
    for (const session of get(this.sessionsStore)) {
      const queue = get(this.permissionQueueStoreFor(session.id));
      const head = headPermissionRequest(queue, session.id);
      if (head) {
        items.push({
          kind: 'permission',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          waitingSince: head.enqueuedAt,
          permission: head,
        });
      }

      const transcript = get(this.transcriptStoreFor(session.id));
      if (transcript.status === 'awaiting_input') {
        items.push({
          kind: 'awaiting_input',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          waitingSince: parseStatusTimestamp(transcript.statusUpdatedAt),
        });
      }
    }
    items.sort((a, b) => a.waitingSince - b.waitingSince);
    this.attentionInboxStore.set(items);
  }

  private transcriptStoreFor(sessionId: string): Writable<TranscriptState> {
    let store = this.transcripts.get(sessionId);
    if (!store) {
      store = writable<TranscriptState>(createTranscriptState());
      this.transcripts.set(sessionId, store);
    }
    return store;
  }

  private permissionQueueStoreFor(sessionId: string): Writable<PermissionQueueState> {
    let store = this.permissionQueues.get(sessionId);
    if (!store) {
      store = writable<PermissionQueueState>(createPermissionQueueState());
      this.permissionQueues.set(sessionId, store);
    }
    return store;
  }

  private applyUpdate(sessionId: string, event: AcpSessionWireEvent): void {
    const store = this.transcriptStoreFor(sessionId);
    store.update((state) => reduceSessionEvent(state, event));
  }

  private handleInbound(message: WireMessageV1): void {
    switch (message.type) {
      case 'session_list':
        this.handleSessionList(message);
        return;
      case 'session_announce':
        this.handleSessionAnnounce(message);
        return;
      case 'session_update':
        this.handleSessionUpdate(message);
        return;
      case 'permission_request':
        this.handlePermissionRequest(message);
        return;
      default:
        return;
    }
  }

  private handleSessionList(message: SessionListV1): void {
    Promise.all(
      message.sessions.map((entry) =>
        this.decryptSessionMeta(entry.session, entry.privateEnvelope).catch((error: unknown) => {
          console.warn(
            `RelayClient: failed to decrypt session ${entry.session.id}: ${errorMessage(error)}`,
          );
          return undefined;
        }),
      ),
    )
      .then((results) => {
        const sessions = results.filter(
          (session): session is ClientSessionMeta => session !== undefined,
        );
        this.sessionsStore.set(sessions);
        this.syncInboxTracking(sessions);
      })
      .catch(() => {
        // Every per-session decrypt already caught its own error above;
        // Promise.all itself cannot reject here.
      });
  }

  private handleSessionAnnounce(message: SessionAnnounceV1): void {
    this.decryptSessionMeta(message.session, message.privateEnvelope)
      .then((session) => {
        this.sessionsStore.update((sessions) => {
          const index = sessions.findIndex((existing) => existing.id === session.id);
          if (index === -1) return [...sessions, session];
          const next = [...sessions];
          next[index] = session;
          return next;
        });
        this.syncInboxTracking([session]);
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt session_announce for ${message.session.id}: ${errorMessage(error)}`,
        );
      });
  }

  private handleSessionUpdate(message: SessionUpdateEnvelopeV1): void {
    this.getSessionKey(message.sessionId)
      .then((key) => openJson<AcpSessionWireEvent>(message.sessionId, message.envelope, key))
      .then((event) => {
        this.applyUpdate(message.sessionId, event);
        if (event.kind === 'turn_ended') {
          // The deterministic signal (SPEC §7.24; issue #128): settle and
          // flush right now instead of waiting out the idle-timeout fallback.
          this.settleTurnNow(message.sessionId);
        } else {
          // Any other live activity on this session — this client's own
          // turn, or another device's — is evidence a turn is still in
          // flight (issue #128's idle-timeout fallback; see
          // `markTurnActive`'s doc comment).
          this.markTurnActive(message.sessionId);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt session_update for ${message.sessionId}: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * A node asks (via the relay) this client to resolve a tool-call
   * permission request (SPEC §7.24's FIFO queue). Decrypts the envelope and
   * enqueues it onto that session's `PermissionQueueState` store, oldest
   * first — the queue store's own arrival order *is* the FIFO order,
   * matching `PermissionQueue.enqueue`'s contract (`permission-queue.ts`).
   */
  private handlePermissionRequest(message: PermissionRequest): void {
    this.getSessionKey(message.sessionId)
      .then((key) => openJson<PermissionRequestPayload>(message.sessionId, message.envelope, key))
      .then((payload) => {
        const store = this.permissionQueueStoreFor(message.sessionId);
        store.update(
          (state) =>
            enqueuePermissionRequest(state, {
              requestId: message.requestId,
              sessionId: message.sessionId,
              toolCall: payload.toolCall,
              options: payload.options,
            }).state,
        );
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt permission_request for session ${message.sessionId}: ${errorMessage(error)}`,
        );
      });
  }

  private async decryptSessionMeta(
    session: SessionMetaPublic,
    privateEnvelope: EncryptedEnvelope,
  ): Promise<ClientSessionMeta> {
    const key = await this.getSessionKey(session.id);
    const privateMeta = await openJson<SessionPrivateMeta>(session.id, privateEnvelope, key);
    return { ...session, ...privateMeta };
  }

  private getSessionKey(sessionId: string): Promise<CryptoKey> {
    let key = this.sessionKeys.get(sessionId);
    if (!key) {
      key = deriveSessionKey(this.amk, this.accountId, sessionId);
      this.sessionKeys.set(sessionId, key);
    }
    return key;
  }

  private send(message: WireMessageV1): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private parseRaw(data: unknown): unknown {
    try {
      return JSON.parse(String(data));
    } catch {
      return undefined;
    }
  }
}
