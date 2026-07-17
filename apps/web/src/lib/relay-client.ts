import type { webcrypto } from 'node:crypto';
import { get, writable, type Readable, type Writable } from 'svelte/store';
import {
  deriveSessionKey,
  encryptEnvelope,
  envelopeToWire,
  openJson,
  sealJson,
} from '@loombox/crypto';
import {
  cancelAllPermissionRequests,
  createPermissionQueueState,
  createTranscriptState,
  enqueuePermissionRequest,
  reduceTranscript,
  resolvePermissionRequest,
  type AcpConfigOption,
  type AcpPermissionOption,
  type AcpToolCallUpdate,
  type AcpTranscriptUpdate,
  type PermissionQueueState,
  type TranscriptState,
} from '@loombox/providers-core';
import {
  PROTOCOL_V1,
  initializeResult,
  safeParseWireMessageV1,
  type EncryptedEnvelope,
  type Initialize,
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
}

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
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * `reduceTranscript` — the same pure reducer the transcript's real source of
 * truth. `sendPrompt` seals the composer's text into a `prompt_inject`
 * envelope and, since the relay never echoes it back, optimistically reduces
 * the user's own turn into the local transcript so it shows immediately.
 *
 * v1's client core is deliberately minimal, matching this PR's scope (not
 * Wave D.2's rich transcript UX): **online only** (no reconnect-with-backoff,
 * no offline composer outbox) and a **plain append-only transcript render**
 * — tool-call widgets, diff viewers, the plan sidebar, and the
 * permission-queue UI are all out of scope here.
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
  private readonly configOptions = new Map<string, Writable<AcpConfigOption[]>>();
  private readonly subscribed = new Set<string>();
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();
  private readonly attachments = new Map<string, Writable<ComposerAttachment[]>>();
  /** Keyed by attachment id (globally unique, `generateId('att')`), not per-session — an id is only ever used within the one session it was attached to. */
  private readonly attachmentBytesById = new Map<string, CachedAttachment>();
  private socket: WebSocketLike | undefined;
  private awaitingInitializeResult = false;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.amk = options.amk;
    this.accountId = options.accountId;
    this.authToken = options.authToken ?? options.accountId;
    this.deviceId = options.deviceId ?? generateId('device');
    this.devicePublicKey = options.devicePublicKey ?? randomBase64();

    const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    if (!ctor) {
      throw new Error('RelayClient: no global WebSocket available; pass webSocketImpl explicitly');
    }
    this.WebSocketCtor = ctor;

    this.statusStore = writable<ConnectionStatus>('idle');
    this.sessionsStore = writable<ClientSessionMeta[]>([]);
    this.status = this.statusStore;
    this.sessions = this.sessionsStore;
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
   * `mode`/any future category, always the complete current set. Starts `[]`:
   * v1's wire protocol has no node -> client push for this yet (only the
   * client -> node `config_option` selection message exists,
   * `packages/protocol/src/v1/steering.ts`), a real gap tracked in this PR's
   * blockers rather than worked around by touching the protocol.
   */
  configOptionsFor(sessionId: string): Readable<AcpConfigOption[]> {
    const store = this.configOptionStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return store;
  }

  /**
   * Picks a config option in the given category: updates the local list
   * optimistically (replacing that category's `current`) and sends the
   * `config_option` wire message so the owning node can act on it.
   */
  setConfigOption(sessionId: string, category: string, optionId: string): void {
    const store = this.configOptionStoreFor(sessionId);
    store.update((options) =>
      options.map((option) =>
        option.category === category ? { ...option, current: optionId } : option,
      ),
    );
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
   * Seals the composer's text (and any uploaded attachment refs, SPEC
   * §7.25) into a `prompt_inject` envelope (SPEC §7.3) and sends it.
   * Optimistically reduces the user's own turn into the local transcript
   * first (the relay/node never echo `prompt_inject` back as a
   * `session_update`, so without this the user's own message would never
   * appear). Returns the generated `promptId` synchronously; the
   * encrypt-and-send itself is asynchronous (WebCrypto), and a failure is
   * logged rather than thrown, matching `@loombox/node`'s
   * `encryptAndSendUpdate` error-handling style. Referenced attachments are
   * cleared from the composer's pending list once the send goes out, since
   * they now belong to this sent prompt, not a future one.
   */
  sendPrompt(sessionId: string, text: string, attachmentIds: string[] = []): string {
    const promptId = generateId('prompt');
    this.applyUpdate(sessionId, {
      kind: 'user_message_chunk',
      turnId: promptId,
      messageId: promptId,
      text,
    });

    const attachments = this.resolveUploadedAttachmentRefs(sessionId, attachmentIds);

    this.encryptAndSendPrompt(sessionId, promptId, text, attachments).catch((error: unknown) => {
      console.warn(
        `RelayClient: failed to encrypt/send prompt_inject for session ${sessionId}: ${errorMessage(error)}`,
      );
    });

    if (attachmentIds.length > 0) this.clearAttachments(sessionId, attachmentIds);

    return promptId;
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

  private configOptionStoreFor(sessionId: string): Writable<AcpConfigOption[]> {
    let store = this.configOptions.get(sessionId);
    if (!store) {
      store = writable<AcpConfigOption[]>([]);
      this.configOptions.set(sessionId, store);
    }
    return store;
  }

  private applyUpdate(sessionId: string, update: AcpTranscriptUpdate): void {
    const store = this.transcriptStoreFor(sessionId);
    store.update((state) => reduceTranscript(state, update));
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
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt session_announce for ${message.session.id}: ${errorMessage(error)}`,
        );
      });
  }

  private handleSessionUpdate(message: SessionUpdateEnvelopeV1): void {
    this.getSessionKey(message.sessionId)
      .then((key) => openJson<AcpTranscriptUpdate>(message.sessionId, message.envelope, key))
      .then((update) => this.applyUpdate(message.sessionId, update))
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
