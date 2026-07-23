import { randomUUID, type webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, posix } from 'node:path';

import type {
  AcpMcpServerConfig,
  AcpPermissionOption,
  AcpSessionWireEvent,
  AcpToolCallUpdate,
  AcpTranscriptUpdate,
  AcpTurnEnd,
  ConfigOptionChangeEvent,
} from '@loombox/providers-core';
import {
  AgentSupervisor,
  TerminalSupervisor,
  type AgentSession,
  type AttentionState,
  type AttentionStatus,
  type TerminalSession,
} from '@loombox/supervisor';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';
import {
  PROTOCOL_V1,
  type AmkEpochPendingEnvelope,
  type AttentionHintClass,
  type FileEventPayloadV1,
  type FsListRequest,
  type FsListRequestPayloadV1,
  type FsListResponsePayloadV1,
  type PromptInjectV1,
  type ProvisionProgress,
  type ProvisionTargetResult,
  type SessionCreate,
  type SessionMetaPublic,
  type TargetDescriptor,
  type TerminalClose,
  type TerminalClosedPayloadV1,
  type TerminalClosedReasonV1,
  type TerminalDataPayloadV1,
  type TerminalInput,
  type TerminalOpen,
  type TerminalOpenPayloadV1,
  type TerminalOpenResultPayloadV1,
  type TerminalResize,
  type TerminalResizePayloadV1,
  type WireMessageV1,
  type WrappedAmkEnvelope,
} from '@loombox/protocol';

import { AttachmentResolver, RelayBlobSource, type BlobSource } from './attachments';
import { LocalExecutionTarget } from './local-execution-target';
import { McpConfigStore } from './mcp-config-store';
import { NodeMcpSecretManager } from './mcp-secrets';
import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import { SameFolderGuard } from './same-folder-guard';
import { SessionManager, sessionWorktreeBranch, type Session } from './session-manager';
import { SshExecutionTarget } from './ssh-execution-target';
import { DEFAULT_LOCAL_TARGET, type ExecutionTarget, type SshTargetConfig } from './target';
import { asAcpChildProcess, RemoteAgentChildProcess } from './ssh/remote-agent-child';
import { RemoteProcessRunner } from './ssh/remote-process-runner';
import { createRemoteWorktree } from './ssh/remote-worktree';
import { shQuote, type RemoteTransport } from './ssh/remote-transport';
import { RelayLeaseClient, type RelayLeaseOutcome } from './ssh/relay-lease-client';
import { SessionLeaseManager } from './ssh/session-lease';
import { supportsShellChannel } from './ssh/shell-transport';
import { shellChannelToPty } from './ssh/ssh-pty-adapter';
import { Ssh2Transport } from './ssh/ssh2-transport';
import { SshTransportPool } from './ssh/ssh-transport-pool';
import type { ReconnectingTransportOptions } from './ssh/reconnecting-transport';

type CryptoKey = webcrypto.CryptoKey;

export interface NodeDaemonOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable identity. */
  nodeId: string;
  /** This device's stable id, sent in the `initialize` handshake (SPEC §8). */
  deviceId: string;
  /**
   * This device's ECDH P-256 identity public key, base64-encoded raw form.
   * Generate/persist/reload this from `./identity.ts`'s `NodeIdentityStore`
   * (issue #64: `await new NodeIdentityStore().loadOrCreate()`, then pass
   * `identity.publicKeyBase64` here) — `NodeDaemon` itself still just takes
   * the value directly rather than owning identity bootstrap, so a caller
   * (or a future in-process device-pairing flow) controls exactly when a
   * fresh keypair is generated versus reloaded.
   */
  devicePublicKey: string;
  /** Opaque Better Auth bearer token (SPEC §8). */
  authToken: string;
  /**
   * The account this node's sessions are scoped under (`SessionMetaPublic.accountId`,
   * the relay's routing/listing key). Must currently equal `authToken`: the
   * relay's auth stub (`deriveAccountIdStub`, `packages/relay/src/auth.ts`,
   * TODO #121) treats the raw bearer token as the account id verbatim. A real
   * Better Auth integration will let these diverge.
   */
  accountId: string;
  /**
   * This account's Account Master Key (SPEC §8, §16): every session key this
   * node derives (`@loombox/crypto`'s `deriveSessionKey`) comes from this one
   * 256-bit secret via its key tree. Real AMK distribution is the
   * device-pairing flow (#113/#114/#115, out of scope here); injected
   * directly until this node has its own pairing bootstrap.
   */
  amk: Uint8Array;
  /**
   * The epoch number `amk` above represents (SPEC §8, issue #116's AMK
   * epoch rotation). Defaults to `0` — "the account's original AMK, never
   * rotated." A node restarting after having previously adopted a rotation
   * should pass its last-known epoch here (persistence of that number
   * across restarts is the caller's concern, e.g. `main.ts`/`config.ts` —
   * out of this option's scope); `NodeDaemon` itself only ever tracks it
   * in memory for the lifetime of one connection.
   */
  amkEpoch?: number;
  /** Execution targets this node exposes (SPEC §5.2); defaults to just the `local` target. */
  targets?: TargetDescriptor[];
  /**
   * Connection recipes for this node's `ssh:` targets (issue #80), keyed by
   * matching `TargetDescriptor.id` in `targets`. A target announced with
   * `kind: 'ssh'` but no matching entry here fails session creation with a
   * clear error rather than silently falling back to anything.
   */
  sshTargets?: SshTargetConfig[];
  /** Builds the `RemoteTransport` for a given `ssh:` target; defaults to a real `Ssh2Transport`. Tests inject a `LocalProcessTransport`/`FakeTransport` factory instead. */
  sshTransportFactory?: (config: SshTargetConfig) => RemoteTransport;
  /**
   * Session ownership leasing across nodes (issue #82). Defaults to a fresh
   * in-memory manager, correct for a single-node deployment and for tests;
   * a multi-node deployment shares one `SessionLeaseManager` backed by a
   * distributed `LeaseStore` (e.g. relay-hosted) across every node instance.
   */
  leaseManager?: SessionLeaseManager;
  /**
   * The cross-process half of session-ownership leasing (SPEC §9; issues
   * #82/#104): talks to the relay's own lease arbiter over this node's
   * existing relay connection, so an `ssh:` session's lease is enforced
   * across two different `NodeDaemon` processes (e.g. a Mac node and a
   * devbox node), not just within this one. Defaults to a `RelayLeaseClient`
   * built off this node's own relay connection, gated on `whenConnected()`
   * so a request made before the handshake completes waits rather than
   * being silently dropped. Layered additively alongside `leaseManager`
   * above (never replaces it) — see `RelayLeaseClient`'s own doc comment
   * for why the two are separate. Tests inject a fake with no relay/
   * WebSocket involved, or point two real `NodeDaemon`s at one
   * `startRelay()` instance to exercise real cross-node arbitration.
   */
  relayLeaseClient?: RelayLeaseClient;
  /**
   * How often an `ssh:` session's owning node re-renews its lease, both
   * locally (`leaseManager`) and across the relay (`relayLeaseClient`),
   * while it's running (SPEC §9's "renewable lease"). Defaults to a third of
   * `leaseManager`'s configured `ttlMs` — comfortably inside the TTL even if
   * one renewal is delayed or dropped. Tests lower this to keep
   * heartbeat-observing assertions fast.
   */
  leaseHeartbeatIntervalMs?: number;
  /** Poll interval (ms) for a `RemoteAgentChildProcess` bridge on an `ssh:` target session; defaults to 150ms. Tests lower this to speed up polling-based assertions. */
  remoteChildPollIntervalMs?: number;
  /**
   * Reconnect tuning (backoff, retry classification) for this node's pooled
   * `ssh:` target connections (issue #71). Applies to every target; tests
   * lower the backoff/attempt budget to keep drop-and-reconnect assertions
   * fast. Defaults to `SshTransportPool`'s own (production-sane) defaults.
   */
  sshReconnect?: ReconnectingTransportOptions;
  /** Injected for tests; defaults to a fresh instance. */
  sessionManager?: SessionManager;
  /**
   * Injected for tests (e.g. to register a fixture provider); defaults to a
   * fresh instance. When left default, `NodeDaemon` wires its own
   * `resolveAttachment` in as that instance's `AttachmentChannel` (issue
   * #156); an explicitly-injected `supervisor` keeps whatever channel (or
   * none) the caller already configured on it.
   */
  supervisor?: AgentSupervisor;
  /**
   * Owns every interactive PTY terminal this node opens (SPEC §7.5; issues
   * #172/#173/#174) — the sibling of `supervisor` above, for terminals
   * instead of ACP agent processes. Injected for tests (e.g. a fake
   * `PtySpawnFn` that never touches a real PTY); defaults to a fresh
   * `TerminalSupervisor` (real `node-pty` for `local` targets).
   */
  terminalSupervisor?: TerminalSupervisor;
  /**
   * Fetches attachment blob ciphertext by ref (SPEC §7.25; issue #156).
   * Defaults to a `RelayBlobSource` over this node's own relay connection —
   * never a new one. Tests inject a fake with no relay/WebSocket involved.
   */
  blobSource?: BlobSource;
  /** WebSocket constructor override for tests; defaults to the global WebSocket. */
  webSocketImpl?: WebSocketConstructor;
  reconnect?: { initialBackoffMs?: number; maxBackoffMs?: number };
  /**
   * Where this node's on-disk state lives — MCP server config
   * (`mcpConfigStore`), secret grants/values (`mcpSecretManager`), and (via
   * `main.ts`'s separate `NodeIdentityStore`) the identity keypair all
   * default to the same convention (`./ssh/verify-and-persist.ts`'s
   * `defaultNodeStateDir()`, `~/.loombox/node`) unless overridden here or
   * per-store below. Mirrors `NodeCliConfig.stateDir`.
   */
  stateDir?: string;
  /**
   * This node's MCP server configuration store (SPEC §7.7; issue #187):
   * global + per-project records, resolved to each session's effective set
   * at session start. Injectable for tests; defaults to a fresh
   * `McpConfigStore({ stateDir })`.
   */
  mcpConfigStore?: McpConfigStore;
  /**
   * This node's per-server MCP secret grant ACL + local secret-value storage
   * (SPEC §7.7, §7.17; issue #189), used at session start to resolve
   * `mcpConfigStore`'s effective server set into the plain
   * `AcpMcpServerConfig` list handed to the ACP session. Injectable for
   * tests; defaults to a fresh `NodeMcpSecretManager({ stateDir })`.
   */
  mcpSecretManager?: NodeMcpSecretManager;
}

export interface CreateNodeSessionOptions {
  /** Absolute path to a local git repository to run the session against. */
  projectPath: string;
  /** Provider id registered on this node's supervisor (default: 'claude'). */
  provider?: string;
  /** Which of this node's targets to run on (default: 'local'). */
  targetId?: string;
  /** Human-readable session title, travels only inside the encrypted private envelope (default: the project directory's basename). */
  title?: string;
  /**
   * Isolate this session in a fresh git worktree rather than running
   * directly in `projectPath` (issue #75, SPEC §6: "the user chooses per
   * session; worktree is not mandatory"). Defaults to this target kind's
   * historical behavior when omitted, so every existing caller is
   * unaffected: `true` for `local` (an isolated worktree, `SessionManager`'s
   * only behavior before this option existed) and `false` for `ssh:` (runs
   * directly in `projectPath` on the remote host, the "deliberate gap"
   * `./target.ts`'s doc comment describes — now closeable per-session by
   * passing `worktree: true` explicitly, backed by `./ssh/remote-worktree.ts`).
   * Only reachable via this direct API in this wave: a relay-driven
   * `session_create` has no wire field for it yet (`SessionCreate` is
   * `@loombox/protocol`, out of this change's scope) and always gets the
   * per-target default.
   */
  worktree?: boolean;
}

/** The plaintext a session's private envelope (`session_create`/`session_announce`) decrypts to — SPEC §8's metadata boundary: title and project path never reach the relay in the clear. */
interface SessionPrivateMeta {
  title: string;
  projectPath: string;
}

/**
 * An attachment ref carried inside a `prompt_inject` envelope's plaintext
 * (SPEC §7.25) — the minimal fields this node needs to fetch and decrypt the
 * blob itself (`ref`, `mimeType`, `name`) plus the client-computed
 * `dimensions`/`thumbhash` this node has no way to derive on its own (it
 * never decodes the image, only fetches+decrypts the ciphertext). Kept
 * self-contained inside `PromptPayload` (this node's own private envelope
 * convention, not a `packages/protocol` schema — see `PromptPayload`'s doc
 * comment) rather than reusing `@loombox/protocol`'s `FileEventPayloadV1`
 * directly, since a prompt's attachment list and a `blob_ref` file event are
 * different wire messages that happen to share a metadata shape.
 *
 * Once this node resolves (fetches+decrypts) the referenced blob —
 * confirming the upload is real, not just a client-claimed ref — it also
 * seals and sends the `blob_ref` file event for it (`sendFileEvent`, issue
 * #154), so every OTHER device subscribed to this session sees the
 * attachment show up without waiting for/being gated by that session's
 * `session_update` fan-out (SPEC §7.16).
 */
export interface PromptAttachmentRef {
  ref: string;
  mimeType: string;
  name?: string;
  dimensions?: { width: number; height: number };
  thumbhash?: string;
}

/** The plaintext a `prompt_inject` envelope decrypts to. */
interface PromptPayload {
  text: string;
  /** Attachments this turn references (SPEC §7.25); omitted/empty for a plain text prompt. */
  attachments?: PromptAttachmentRef[];
}

/**
 * The plaintext a `permission_request` envelope decrypts to (SPEC §7.24;
 * `@loombox/protocol`'s `steering.ts` doc comment: "the permission
 * request's `ToolCallUpdate` ... travel[s] as an opaque `encryptedEnvelope`").
 * Mirrors `apps/web`'s own `PermissionRequestPayload` (`relay-client.ts`) —
 * that client has been ready to decrypt exactly this shape since before this
 * issue; see {@link NodeDaemon.sendPermissionRequest} for the producer this
 * issue (#373) adds.
 */
interface PermissionRequestPayloadV1 {
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

/**
 * Maps a session's live attention status to the relay-visible `attention_hint`
 * class that mirrors it (SPEC §7.11/§7.13; issue #170), or `undefined` when
 * this status isn't inbox-eligible/doesn't need this hint:
 * - `'working'` — not attention-worthy, nothing to notify.
 * - `'permission_required'` — has its own dedicated relay-visible trigger,
 *   the real `permission_request` message ({@link NodeDaemon.sendPermissionRequest};
 *   issue #373), so this hint would be a redundant second signal for the
 *   same event.
 * - `'awaiting_input'` maps to the hint class of the same name;
 *   `'error'`/`'exited'` both map to `'session_outcome'` — SPEC §7.13 groups
 *   a finished/errored session as one inbox class, and this hint mirrors
 *   that grouping rather than leaking which one occurred (see
 *   `@loombox/protocol`'s `attention.ts` doc comment for why).
 */
function attentionHintClassForStatus(status: AttentionStatus): AttentionHintClass | undefined {
  switch (status) {
    case 'awaiting_input':
      return 'awaiting_input';
    case 'error':
    case 'exited':
      return 'session_outcome';
    default:
      return undefined;
  }
}

/**
 * Narrows `AttentionState.detail` (typed `unknown` at its source,
 * `transcript-store.ts`'s `AttentionState`) for a `'permission_required'`
 * transition — `agent-session.ts`'s `setAttention('permission_required',
 * { requestId, toolCallId })` is the only producer of that status, so this
 * is the one shape {@link NodeDaemon.sendPermissionRequest} ever needs to
 * pull a `requestId` out of.
 */
function isPermissionRequestDetail(detail: unknown): detail is { requestId: string } {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    typeof (detail as { requestId?: unknown }).requestId === 'string'
  );
}

/** Thrown by {@link resolveSessionRelativePath} for a request that would read outside the session's project root. */
class PathTraversalError extends Error {
  constructor(readonly requestedPath: string) {
    super(`path escapes the session's project root: ${requestedPath}`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolves `requestedPath` (an `fs_list_request`'s decrypted `path`, relative
 * to the session's project root) against `root` (the session's
 * `worktreePath` — its actual working directory, worktree or not), and
 * refuses to resolve outside `root` (SPEC §7.4's read-only file-tree panel
 * must never let a client browse anywhere but its own session's project;
 * issue #171). Always POSIX path semantics (`node:path`'s `posix`), matching
 * `./ssh/remote-fs.ts`'s own POSIX assumption for a remote host — every
 * `local`/`ssh:` target this node runs against is a POSIX machine. Throws
 * {@link PathTraversalError} for an absolute requested path or one whose
 * normalized `..` segments walk past `root`.
 */
function resolveSessionRelativePath(root: string, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (posix.isAbsolute(trimmed)) {
    throw new PathTraversalError(requestedPath);
  }
  const normalizedRoot = posix.normalize(root);
  const resolved = posix.normalize(posix.join(normalizedRoot, trimmed));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new PathTraversalError(requestedPath);
  }
  return resolved;
}

/**
 * Emitted once per attachment after {@link NodeDaemon.resolveAttachment}
 * fetches and decrypts it while handling an inbound `prompt_inject` (SPEC
 * §7.25 "Deliver to the executing host"; issue #156) — the plaintext bytes
 * made available on this host. Handing these to the agent as an ACP content
 * block ("Hand off to the agent", the next SPEC §7.25 bullet) is a separate,
 * provider-adapted concern out of this issue's scope: `AgentSession.prompt()`
 * is text-only in v1. This event is this wave's observable seam for that
 * future wiring (and for tests) rather than a silent no-op.
 */
export interface ResolvedAttachment {
  sessionId: string;
  ref: string;
  mimeType: string;
  name: string | undefined;
  bytes: Uint8Array;
}

interface SessionBridge {
  session: Session;
  agentSession: AgentSession;
  targetId: string;
  title: string;
  /** Local monotonic counter for the `seq` field this node stamps on outgoing session updates; the relay reassigns the authoritative seq on receipt (`store.sessions.nextSeq`), so this only needs to satisfy the wire schema, not be globally authoritative. */
  seq: number;
  /**
   * Chains every `encryptAndSendUpdate` call for this session so concurrent
   * `crypto.subtle.encrypt` calls can never resolve — and so get sent to the
   * relay — out of the order their updates actually happened in.
   */
  sendQueue: Promise<void>;
  /**
   * This bridge's own turn-id namespace for the `turn_started`/`turn_ended`
   * wire signals (SPEC §7.24; issue #128) — set right before this node hands
   * a prompt to `agentSession.prompt()` and echoed back on the matching
   * `turn_ended` once `AgentSession`'s `'turn_end'` fires. Independent of
   * `AcpClient`'s own internal turn-id counter (a different layer's private
   * bookkeeping, not exposed) — this is loombox's own wire-facing id, purely
   * for a client to correlate a session's `turn_started`/`turn_ended` pair.
   */
  currentTurnId?: string;
  /**
   * Set only for an `ssh:` target's session (issue #80): the local bridge
   * object polling the remote run. `close()` must reach this directly
   * (rather than going through `AgentSupervisor.stop()`, which always kills)
   * so this node exiting stops *this local bridge* without terminating the
   * still-running remote agent process.
   */
  remoteChild?: RemoteAgentChildProcess;
}

/**
 * Ties `SessionManager` + `AgentSupervisor` + the v1 `RelayConnection`
 * together into one E2E-encrypted node (SPEC.md §5.1, §5.6, §8, §12 v1;
 * `docs/v1-plan.md`; issues #65, #66). Creating a session spawns a worktree
 * and an agent, announces it to the relay as clear `SessionMetaPublic`
 * routing metadata plus an encrypted `{title, projectPath}` envelope, and
 * every subsequent agent transcript update is sealed under that session's
 * derived key and pumped to the relay tagged with a monotonic `seq`. An
 * inbound `prompt_inject` for one of this node's sessions is decrypted and
 * delivered to that session's agent. The relay never sees plaintext: it only
 * ever forwards/stores `EncryptedEnvelope`s and the clear routing fields
 * `SessionMetaPublic` deliberately allows (id, nodeId, targetId, accountId,
 * provider, timestamps).
 *
 * On every fresh connection (including a reconnect), this node also asks the
 * relay whether a rewrapped-AMK-epoch envelope is waiting for it (SPEC §8's
 * wrap-fan-out delivery leg, issue #116's "fetch on next connect"). This
 * class deliberately never holds this device's own ECDH private key (only
 * `devicePublicKey`, a string, is ever passed in — see that option's doc
 * comment), so it cannot unwrap the envelope itself: on a pending reply
 * ahead of its own tracked epoch, it emits `'amk-epoch-pending'` with the
 * raw `{ epoch, fromDeviceId, fromDevicePublicKey, envelope }` for a caller
 * that *does* hold the private key (e.g. `main.ts` plus `identity.ts`'s
 * `NodeIdentityStore`) to unwrap via `@loombox/crypto`'s
 * `unwrapAmkEpochForDevice` and hand back via {@link NodeDaemon.adoptAmkEpoch}.
 * Adopting fires `'amk-epoch-adopted'` with `{ epoch }`.
 *
 * Emits `'connected'` once the relay handshake completes and this node has
 * (re-)announced its targets and sessions (including on every reconnect) —
 * useful for a caller/test that needs to know the node is actually routable
 * before, say, asking it to create a session via a client-initiated
 * `session_create`.
 */
export class NodeDaemon extends EventEmitter {
  readonly nodeId: string;

  private readonly accountId: string;
  private readonly deviceId: string;
  /** Mutable (unlike every other identity field here): {@link adoptAmkEpoch} replaces this in place once a rotation is adopted (#116). */
  private amk: Uint8Array;
  /** This node's currently-adopted AMK epoch (#116); see `NodeDaemonOptions.amkEpoch`'s doc comment. */
  private amkEpoch: number;
  private readonly targets: TargetDescriptor[];
  private readonly sessionManager: SessionManager;
  private readonly relay: RelayConnection;
  private readonly attachmentResolver: AttachmentResolver;
  private readonly supervisor: AgentSupervisor;
  private readonly terminalSupervisor: TerminalSupervisor;
  /** `terminalId`s this node itself asked to close (`handleTerminalClose`), consulted the moment the underlying PTY's `onExit` fires so `sendTerminalClosed`'s `reason` can say `'closed_by_client'` instead of `'exited'` — see {@link wireTerminalSession}'s doc comment. */
  private readonly clientInitiatedTerminalCloses = new Set<string>();
  /** Chains every `terminal_output` send per terminal (mirrors `SessionBridge.sendQueue`) so concurrent `crypto.subtle.encrypt` calls can never resolve — and so get sent to the relay — out of the order their chunks actually arrived in. */
  private readonly terminalSendQueues = new Map<string, Promise<void>>();
  private readonly bridges = new Map<string, SessionBridge>();
  private _connected = false;
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();

  private readonly sshTargetConfigs = new Map<string, SshTargetConfig>();
  private readonly sshTransportFactory: (config: SshTargetConfig) => RemoteTransport;
  private readonly leaseManager: SessionLeaseManager;
  private readonly relayLeaseClient: RelayLeaseClient;
  private readonly leaseHeartbeatIntervalMs: number;
  /** One heartbeat-renew interval per currently-owned `ssh:` session (SPEC §9) — cleared on `close()`, which also releases each one's lease (local + relay). */
  private readonly leaseHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private readonly remoteChildPollIntervalMs: number | undefined;
  /**
   * One pooled, auto-reconnecting `RemoteTransport` per `ssh:` target id,
   * reused across every session on that target rather than reconnecting per
   * session (SPEC §5.2/§7.23's "pooled ... SSH transport"; issue #71's
   * mid-session reconnect-with-backoff lives inside `SshTransportPool`
   * itself, so nothing here has to know a drop ever happened).
   */
  private readonly sshTransportPool: SshTransportPool;
  /** One `RemoteProcessRunner` per `ssh:` target id, wrapping that target's pooled transport — kept separate from the pool since a runner also caches its resolved remote base directory (`RemoteProcessRunner.resolveBaseDir`), which should outlive any individual reconnect. */
  private readonly remoteRunners = new Map<string, RemoteProcessRunner>();
  /**
   * One {@link LocalExecutionTarget}, shared by every caller (it's stateless
   * besides a `kind` tag), and one {@link SshExecutionTarget} per `ssh:`
   * target id, wrapping that target's pooled transport (issue #69) — the
   * unified exec/filesystem seam a future editor/terminal drives through,
   * built without opening any connection beyond what session creation
   * already needs.
   */
  private readonly localExecutionTarget = new LocalExecutionTarget();
  private readonly sshExecutionTargets = new Map<string, SshExecutionTarget>();
  /** SPEC §7.7/§7.17; issues #187/#189 — see `NodeDaemonOptions.mcpConfigStore`/`mcpSecretManager`'s doc comments. */
  private readonly mcpConfigStore: McpConfigStore;
  private readonly mcpSecretManager: NodeMcpSecretManager;
  /**
   * Same-folder safety (issue #68, SPEC §7.2) for this node's `ssh:`
   * sessions — a separate instance from `SessionManager`'s own guard
   * (`local` sessions never route through `createSshSessionInternal`, so
   * there's nothing to share). Keyed by `` `${targetId}:${projectPath}` ``,
   * since the same path string can genuinely name different folders on
   * different remote hosts.
   */
  private readonly sshSameFolderGuard = new SameFolderGuard();

  constructor(options: NodeDaemonOptions) {
    super();
    this.nodeId = options.nodeId;
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.amk = options.amk;
    this.amkEpoch = options.amkEpoch ?? 0;
    this.targets = options.targets ?? [DEFAULT_LOCAL_TARGET];
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.relay = new RelayConnection({
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
      devicePublicKey: options.devicePublicKey,
      authToken: options.authToken,
      webSocketImpl: options.webSocketImpl,
      initialBackoffMs: options.reconnect?.initialBackoffMs,
      maxBackoffMs: options.reconnect?.maxBackoffMs,
    });
    // Built off `this.relay` (constructed just above) rather than a new
    // connection — issue #156's "no new direct supervisor-to-relay
    // connection". `options.blobSource` lets a test fake the transport with
    // no relay/WebSocket involved at all.
    this.attachmentResolver = new AttachmentResolver(
      options.blobSource ?? new RelayBlobSource(this.relay),
    );
    this.supervisor = options.supervisor ?? new AgentSupervisor();
    this.terminalSupervisor = options.terminalSupervisor ?? new TerminalSupervisor();
    // Always wired in, whether `this.supervisor` was just built above or
    // injected by a caller (e.g. to register a fixture provider): this node
    // is the only thing holding the account's AMK and the relay connection
    // an `AttachmentChannel` implementation actually needs (SPEC §8), so it
    // is always the authority for how *its* supervisor resolves an
    // attachment ref, never something a caller supplies its own competing
    // implementation of via `AgentSupervisorOptions.attachmentChannel`.
    this.supervisor.setAttachmentChannel({
      resolveAttachment: (sessionId, ref) => this.resolveAttachment(sessionId, ref),
    });
    for (const config of options.sshTargets ?? []) {
      this.sshTargetConfigs.set(config.id, config);
    }
    this.sshTransportFactory =
      options.sshTransportFactory ??
      ((config) =>
        new Ssh2Transport({
          host: config.host,
          port: config.port,
          username: config.user ?? 'root',
          privateKeyPath: config.privateKeyPath,
          passphrase: config.passphrase,
          password: config.password,
          agent: config.agent,
        }));
    this.leaseManager = options.leaseManager ?? new SessionLeaseManager();
    // Built off `this.relay` (constructed above), never a new connection —
    // same rationale as `attachmentResolver`/`blobSource` above. Gated on
    // `whenConnected()` so a request made before this node's relay handshake
    // completes waits instead of being silently dropped by
    // `RelayConnection.send()`.
    this.relayLeaseClient =
      options.relayLeaseClient ??
      new RelayLeaseClient(this.relay, { whenReady: () => this.whenConnected() });
    this.leaseHeartbeatIntervalMs =
      options.leaseHeartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseManager.ttlMs / 3));
    this.remoteChildPollIntervalMs = options.remoteChildPollIntervalMs;
    this.sshTransportPool = new SshTransportPool({ reconnect: options.sshReconnect });
    this.mcpConfigStore =
      options.mcpConfigStore ?? new McpConfigStore({ stateDir: options.stateDir });
    this.mcpSecretManager =
      options.mcpSecretManager ?? new NodeMcpSecretManager({ stateDir: options.stateDir });

    // The relay drops a node's targets/sessions from its registry the
    // moment that node's socket closes, so every fresh 'open' (including
    // reconnects) must re-announce everything this node still holds.
    this.relay.on('open', () => {
      this._connected = true;
      this.reannounceAll();
      this.sendAmkEpochFetchRequest();
      this.emit('connected');
    });
    this.relay.on('close', () => {
      this._connected = false;
    });
    this.relay.on('message', (message: WireMessageV1) => this.handleInbound(message));
    // A rejected handshake (#108's "update required") is surfaced as an
    // 'error' event by RelayConnection; EventEmitter throws on an
    // unhandled 'error' event, so this must always have a listener.
    this.relay.on('error', (error: Error) => {
      console.warn(`NodeDaemon(${this.nodeId}): relay connection error: ${error.message}`);
    });
  }

  /** True once the relay handshake has completed; false again after a disconnect. */
  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Resolves as soon as this node is connected to the relay: immediately if it
   * already is, otherwise on the next `'connected'` event. Callers (and tests)
   * must use this rather than a bare `once('connected')`, which races when the
   * handshake completes before the listener is attached.
   */
  whenConnected(): Promise<void> {
    if (this._connected) return Promise.resolve();
    return new Promise((resolve) => this.once('connected', resolve));
  }

  /** Opens the outbound connection to the relay. */
  connect(): void {
    this.relay.connect();
  }

  /**
   * Closes the relay connection (no further reconnect attempts follow) and
   * stops every session's agent process — except an `ssh:` target session's
   * remote agent, which this node deliberately does *not* terminate: it
   * detaches this node's local bridge only, leaving the setsid/tmux-detached
   * remote process running (issue #80's "the driving node exiting entirely
   * does not kill the remote agent process").
   */
  close(): void {
    for (const [sessionId, bridge] of this.bridges) {
      bridge.remoteChild?.detachLocal();
      this.supervisor.stop(sessionId);
      // SPEC §9's "release on stop/exit": this node is no longer driving
      // the session (the remote agent process itself keeps running, per
      // issue #80, above), so its lease is freed immediately rather than
      // left to expire on its own TTL — letting a reattach (by this node
      // again, or another) acquire right away instead of waiting it out.
      this.stopLeaseHeartbeat(sessionId);
    }
    this.bridges.clear();
    this.terminalSupervisor.closeAll();
    this.remoteRunners.clear();
    this.sshExecutionTargets.clear();
    this.sshTransportPool.closeAll().catch(() => {});
    this.relay.close();
  }

  /** Test-only: see {@link RelayConnection.simulateDrop}. */
  simulateRelayDrop(): void {
    this.relay.simulateDrop();
  }

  /**
   * Creates a session directly on this node (worktree via `SessionManager`,
   * agent via `AgentSupervisor`), wires the agent's transcript updates to
   * the relay, and announces it — the node-initiated path (as opposed to a
   * client's `session_create` routed in over the relay, handled by
   * {@link handleInbound}).
   */
  async createSession(options: CreateNodeSessionOptions): Promise<Session> {
    return this.createSessionInternal({
      projectPath: options.projectPath,
      provider: options.provider ?? 'claude',
      targetId: options.targetId ?? 'local',
      title: options.title ?? basename(options.projectPath),
      worktree: options.worktree,
    });
  }

  /** Submits a prompt directly into a session this node owns (bypassing the relay). */
  async promptSession(sessionId: string, text: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) {
      throw new Error(`NodeDaemon: no session with id ${sessionId}`);
    }
    await this.assertStillLeaseholder(bridge);
    this.beginTurn(bridge);
    await bridge.agentSession.prompt(text);
  }

  /**
   * Synthesizes and forwards this turn's `turn_started` wire signal (SPEC
   * §7.24; issue #128), right before handing the prompt to
   * `agentSession.prompt()` — regardless of which device's composer (or a
   * node-direct `promptSession()` call) originated it, so every subscribed
   * client can flip its own "turn in flight" state deterministically. Records
   * the generated turn id on the bridge so the matching `turn_ended` (fired
   * from `agentSession`'s own `'turn_end'` event, wired in
   * {@link wireAgentSession}) can echo it back.
   */
  private beginTurn(bridge: SessionBridge): void {
    const turnId = `turn_${randomUUID()}`;
    bridge.currentTurnId = turnId;
    this.forwardSessionEvent(bridge.session.id, { kind: 'turn_started', turnId });
  }

  /**
   * Enforces issue #82's "only the current leaseholder node may send
   * prompts/control to a session's supervisor" for an `ssh:` target session
   * (identified by `bridge.remoteChild` being set — a `local` session has no
   * cross-node contention to guard against, since no other node can reach
   * this machine's own child process). A no-op for a `local` bridge.
   */
  private async assertStillLeaseholder(bridge: SessionBridge): Promise<void> {
    if (!bridge.remoteChild) return;
    const stillHeld = await this.leaseManager.isLeaseholder(bridge.session.id, this.nodeId);
    if (!stillHeld) {
      throw new Error(
        `NodeDaemon: lost the ownership lease for session ${bridge.session.id}; refusing to drive it further (issue #82)`,
      );
    }
  }

  private async createSessionInternal(opts: {
    sessionId?: string;
    projectPath: string;
    provider: string;
    targetId: string;
    title: string;
    worktree?: boolean;
  }): Promise<Session> {
    const target = this.targets.find((candidate) => candidate.id === opts.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${opts.targetId}"`);
    }

    // Resolved before any worktree/lease/child is touched (issues #187/#189's
    // "fails clearly on an ungranted/missing secret... before any session
    // opens"): a session that would fail on a missing MCP secret grant fails
    // right here, not after this node has already created a worktree or
    // acquired an ssh: lease for it.
    const mcpServers = await this.resolveMcpServers(opts.projectPath);

    if (target.kind === 'ssh') {
      return this.createSshSessionInternal(target.id, opts, mcpServers);
    }

    const session = await this.sessionManager.createSession({
      id: opts.sessionId,
      projectPath: opts.projectPath,
      provider: opts.provider,
      nodeId: this.nodeId,
      targetId: opts.targetId,
      // `undefined`/`true` here means an isolated worktree (`workInPlace:
      // false`) — `local`'s historical default, unchanged for every caller
      // that doesn't pass `worktree` at all. Only an explicit `worktree:
      // false` opts into running directly in `projectPath`.
      workInPlace: opts.worktree === false,
    });
    const agentSession = await this.supervisor.start({
      workspacePath: session.worktreePath,
      providerId: opts.provider,
      mcpServers,
    });

    return this.finishSessionCreation(session, agentSession, opts);
  }

  /**
   * `projectPath`'s effective MCP server set (SPEC §7.7; issue #187), with
   * every declared secret substituted from this node's local grant/secret
   * storage (SPEC §7.17; issue #189) — the exact list a session's
   * `AcpClient.newSession` call receives as `mcpServers`. Throws
   * `McpServerSecretMissingError` (from `@loombox/providers-core`) the
   * moment a required secret is ungranted or has no stored value, naming the
   * server and variable — before this method returns anything, so a caller
   * never gets a partially-resolved list. Returns `[]` (skipping secret
   * resolution entirely) when the project has no effective servers at all,
   * the common case, rather than doing pointless keyring I/O for an empty
   * `requiredSecretsForList`.
   */
  private async resolveMcpServers(projectPath: string): Promise<AcpMcpServerConfig[]> {
    const effective = this.mcpConfigStore.effectiveServers(projectPath);
    if (effective.length === 0) return [];
    return this.mcpSecretManager.resolveForSession(projectPath, effective);
  }

  /**
   * The `ssh:` target path (issue #80): acquires this session's ownership
   * lease (#82), deploys-and-launches the provider's agent detached on the
   * remote host via the pooled `RemoteProcessRunner` for this target — with
   * a tmux/screen fallback when the native mechanism isn't available (#81)
   * — bridges it into an `AcpChildProcess` (`RemoteAgentChildProcess`), and
   * hands that to `AgentSupervisor.startWithChild()`. From here on this
   * session is driven through `AgentSession`/`AgentSupervisor` exactly like
   * a `local` one: {@link finishSessionCreation} is the same shared tail
   * both paths use to wire transcript forwarding and announce to the relay.
   */
  private async createSshSessionInternal(
    targetId: string,
    opts: {
      sessionId?: string;
      projectPath: string;
      provider: string;
      title: string;
      worktree?: boolean;
    },
    mcpServers: AcpMcpServerConfig[],
  ): Promise<Session> {
    const sessionId = opts.sessionId ?? randomUUID();

    // Same-folder safety (issue #68, SPEC §7.2): an ssh: session defaults to
    // running in-place (see the `worktree`-defaulting comment below) — only
    // an explicit `worktree: true` opts out of the restriction. Reserved
    // before the lease/deploy/spawn machinery below ever runs, so a refusal
    // here is cheap and leaves nothing to unwind; released in the `catch`
    // if anything after this point throws, and again once the agent process
    // itself exits (see `wireAgentSession`'s `'exit'` handler).
    const inPlace = !opts.worktree;
    const sameFolderKey = `${targetId}:${opts.projectPath}`;
    if (inPlace) {
      this.sshSameFolderGuard.reserve(sameFolderKey, sessionId);
    }

    try {
      const lease = await this.leaseManager.acquire(sessionId, this.nodeId);
      if (!lease.granted) {
        throw new Error(
          `NodeDaemon: cannot create session ${sessionId} on ssh: target "${targetId}": ` +
            `lease already held by node "${lease.heldBy}" (expires ${new Date(lease.expiresAt).toISOString()})`,
        );
      }
      // Cross-node lease right after the local grant (SPEC §9; #82/#104); a
      // relay denial rolls the local grant back and throws, and the `catch`
      // below releases the same-folder reservation, so nothing leaks.
      await this.acquireRelayLeaseOrRollback(sessionId, targetId);

      const provider = this.supervisor.getProvider(opts.provider);
      if (!provider) {
        throw new Error(`NodeDaemon: no provider registered for id "${opts.provider}"`);
      }

      // `ssh:` defaults to `worktree: false` (unchanged from before this
      // option existed: run directly in `projectPath`, see target.ts's doc
      // comment on the historical gap this closes per-session) — only an
      // explicit `worktree: true` creates one, via `./ssh/remote-worktree.ts`
      // over this target's own pooled transport (issue #75).
      let worktreePath = opts.projectPath;
      let branch = '';
      if (opts.worktree) {
        const transport = await this.getSshTransport(targetId);
        const created = await createRemoteWorktree(transport, {
          projectPath: opts.projectPath,
          sessionId,
          branch: sessionWorktreeBranch(sessionId),
        });
        worktreePath = created.worktreePath;
        branch = created.branch;
      }

      const runner = await this.getRemoteRunner(targetId);
      const spawnConfig = provider.spawnConfig({ cwd: worktreePath });
      const command = [spawnConfig.command, ...(spawnConfig.args ?? [])].map(shQuote).join(' ');

      const { mode, usedFallback, handle } = await runner.launchWithFallback(sessionId, command);
      if (usedFallback) {
        console.warn(
          `NodeDaemon: ssh target "${targetId}" has no setsid+mkfifo available; session ${sessionId} launched under the ${mode} fallback (#81)`,
        );
      }

      const remoteChild = new RemoteAgentChildProcess(runner, handle, {
        pollIntervalMs: this.remoteChildPollIntervalMs,
      });
      remoteChild.start();

      const agentSession = await this.supervisor.startWithChild({
        workspacePath: worktreePath,
        providerId: opts.provider,
        child: asAcpChildProcess(remoteChild),
        mcpServers,
      });

      const session: Session = {
        id: sessionId,
        projectPath: opts.projectPath,
        worktreePath,
        target: 'ssh',
        provider: opts.provider,
        branch,
        createdAt: Date.now(),
        state: 'running',
        nodeId: this.nodeId,
        targetId,
      };

      this.startLeaseHeartbeat(sessionId);
      return await this.finishSessionCreation(
        session,
        agentSession,
        { targetId, title: opts.title },
        remoteChild,
      );
    } catch (error) {
      // Nothing after the reservation above ever ran to completion — undo
      // it so a subsequent attempt on this same folder isn't stuck refused
      // by a session that never actually came to exist.
      if (inPlace) {
        this.sshSameFolderGuard.release(sameFolderKey, sessionId);
      }
      throw error;
    }
  }

  /**
   * The relay half of session-ownership leasing (SPEC §9; issues #82/#104),
   * called right after the local `leaseManager` grants an `ssh:` session's
   * lease. A denial rolls the local grant back (so this node never believes
   * it owns a session the relay says another node holds) and refuses session
   * creation with a clear reason, exactly like the local-only refusal above.
   * A relay round-trip failure (unreachable/timed out, rather than an actual
   * denial) is logged and swallowed rather than blocking session creation —
   * an honest v1 trade-off: the local lease and the eventual next heartbeat
   * still keep this session correctly arbitrated once the relay is reachable
   * again, so a transient relay hiccup does not make session creation
   * unavailable.
   */
  private async acquireRelayLeaseOrRollback(sessionId: string, targetId: string): Promise<void> {
    let outcome: RelayLeaseOutcome;
    try {
      outcome = await this.relayLeaseClient.acquire(
        sessionId,
        this.nodeId,
        this.leaseManager.ttlMs,
      );
    } catch (error) {
      console.warn(
        `NodeDaemon: could not reach the relay to acquire session ${sessionId}'s cross-node lease (issue #82/#104); proceeding on the local lease alone: ${(error as Error).message}`,
      );
      return;
    }
    if (outcome.granted) return;

    await this.leaseManager.release(sessionId, this.nodeId);
    const heldBy = outcome.heldBy ? ` held by node "${outcome.heldBy}"` : '';
    const expiry = outcome.expiresAt
      ? ` (expires ${new Date(outcome.expiresAt).toISOString()})`
      : '';
    throw new Error(
      `NodeDaemon: cannot create session ${sessionId} on ssh: target "${targetId}": ` +
        `the relay refused this session's ownership lease —${heldBy}${expiry} (issues #82/#104)`,
    );
  }

  /**
   * Starts this `ssh:` session's renewal heartbeat (SPEC §9's "renewable
   * lease"): re-renews both the local lease (`leaseManager`) and the relay's
   * (`relayLeaseClient`) on `leaseHeartbeatIntervalMs`, comfortably inside
   * the lease TTL, for as long as this node keeps driving the session.
   * Stopped (and the lease released) by `close()` — there is no per-session
   * stop API yet, so that is the only place a heartbeat ever ends today. A
   * relay renewal denial (this node's lease actually lost, e.g. to an
   * expiry-then-reclaim by another node) proactively releases the local
   * lease too, so the very next `promptSession()` call fails fast on
   * `assertStillLeaseholder`'s local, no-network check rather than only
   * discovering the loss once its own local TTL separately expires.
   */
  private startLeaseHeartbeat(sessionId: string): void {
    const timer = setInterval(() => {
      void this.leaseManager.renew(sessionId, this.nodeId);
      void this.relayLeaseClient
        .renew(sessionId, this.nodeId, this.leaseManager.ttlMs)
        .then((outcome) => {
          if (!outcome.granted) {
            void this.leaseManager.release(sessionId, this.nodeId);
          }
        })
        .catch((error: Error) => {
          console.warn(
            `NodeDaemon: relay lease heartbeat failed for session ${sessionId} (issue #82/#104): ${error.message}`,
          );
        });
    }, this.leaseHeartbeatIntervalMs);
    timer.unref?.();
    this.leaseHeartbeats.set(sessionId, timer);
  }

  /**
   * Stops a session's heartbeat (if any) and releases its lease, both
   * locally and on the relay. Idempotent: called for every bridge on
   * `close()`, including `local` ones that never had a heartbeat at all.
   *
   * Uses {@link RelayLeaseClient.releaseBestEffort} rather than its awaited
   * `release()` — `close()` (this method's only caller) is a synchronous
   * teardown path that closes the underlying relay connection immediately
   * afterward in the same call stack; an awaited release's `send()` is
   * deferred behind at least one microtask even when already connected,
   * which would then race — and could lose to — that synchronous close.
   */
  private stopLeaseHeartbeat(sessionId: string): void {
    const timer = this.leaseHeartbeats.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.leaseHeartbeats.delete(sessionId);
    void this.leaseManager.release(sessionId, this.nodeId);
    this.relayLeaseClient.releaseBestEffort(sessionId, this.nodeId);
  }

  /**
   * Gets (or opens) the pooled, auto-reconnecting `RemoteProcessRunner` for
   * an `ssh:` target, reused across every session on it. The transport
   * itself comes from `sshTransportPool`, so a mid-session drop on one
   * session's connection is invisible to every other session sharing this
   * same target (issue #71) — this method never sees the drop at all.
   */
  private async getRemoteRunner(targetId: string): Promise<RemoteProcessRunner> {
    const existing = this.remoteRunners.get(targetId);
    if (existing) return existing;

    const transport = await this.getSshTransport(targetId);
    const runner = new RemoteProcessRunner(transport);
    this.remoteRunners.set(targetId, runner);
    return runner;
  }

  /** Gets (opening on first use) this `ssh:` target's pooled, reconnecting transport — shared by {@link getRemoteRunner} and {@link getExecutionTarget} so neither opens a second connection for the same target id. */
  private async getSshTransport(targetId: string): Promise<RemoteTransport> {
    const config = this.sshTargetConfigs.get(targetId);
    if (!config) {
      throw new Error(
        `NodeDaemon: no ssh target config for target "${targetId}" (pass it via NodeDaemonOptions.sshTargets)`,
      );
    }
    return this.sshTransportPool.get(targetId, () => this.sshTransportFactory(config));
  }

  /**
   * Returns the {@link ExecutionTarget} for one of this node's target ids
   * (issue #69) — the unified exec/filesystem seam a future editor/terminal
   * drives through, shared by `local` and `ssh:` alike. For an `ssh:` target
   * this reuses the same pooled transport session creation already relies on
   * (see {@link getSshTransport}) rather than opening a second connection.
   * Throws if `targetId` doesn't name one of this node's declared targets.
   */
  async getExecutionTarget(targetId: string): Promise<ExecutionTarget> {
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${targetId}"`);
    }
    if (target.kind === 'local') {
      return this.localExecutionTarget;
    }

    const existing = this.sshExecutionTargets.get(targetId);
    if (existing) return existing;

    const transport = await this.getSshTransport(targetId);
    const executionTarget = new SshExecutionTarget(transport);
    this.sshExecutionTargets.set(targetId, executionTarget);
    return executionTarget;
  }

  private async finishSessionCreation(
    session: Session,
    agentSession: AgentSession,
    opts: { targetId: string; title: string },
    remoteChild?: RemoteAgentChildProcess,
  ): Promise<Session> {
    const bridge: SessionBridge = {
      session,
      agentSession,
      targetId: opts.targetId,
      title: opts.title,
      seq: 0,
      sendQueue: Promise.resolve(),
      remoteChild,
    };
    this.bridges.set(session.id, bridge);
    this.wireAgentSession(bridge);
    // The relay drops a session_update for a session it hasn't seen a
    // session_announce for yet (`relay.ts`'s "unknown session" guard) — so
    // announce MUST land first. `wireAgentSession` only registers listeners
    // above (no send happens synchronously), and `forwardInitialSessionState`
    // below — which does send — runs only once announce has actually gone
    // out.
    await this.announce(bridge);
    this.forwardInitialSessionState(bridge);

    return session;
  }

  private wireAgentSession(bridge: SessionBridge): void {
    bridge.agentSession.on('transcript_update', (update: AcpTranscriptUpdate) => {
      this.forwardSessionEvent(bridge.session.id, update);
    });

    // v1: session_status / config_options / turn_ended (SPEC §7.13/§7.24/§8;
    // issues #126/#128/#149) — additive to the transcript_update path above,
    // riding the exact same session_update envelope + sendQueue ordering.
    bridge.agentSession.on('attention', (state: AttentionState) => {
      this.forwardSessionEvent(bridge.session.id, {
        kind: 'session_status',
        status: state.status,
        updatedAt: state.updatedAt,
      });
      if (state.status === 'permission_required') {
        // #373: this class's OWN dedicated relay-visible trigger — the real
        // `permission_request` message — rather than the `attention_hint`
        // mirror `sendAttentionHint` sends for every other inbox-eligible
        // class below (see `attentionHintClassForStatus`'s doc comment for
        // why `permission_required` maps to `undefined` there).
        this.sendPermissionRequest(bridge, state.detail).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: failed to send permission_request for ${bridge.session.id}: ${message}`,
          );
        });
      } else {
        // #170: the relay-visible push trigger mirroring the encrypted
        // session_status event just forwarded above — see
        // `sendAttentionHint`'s doc comment.
        this.sendAttentionHint(bridge.session.id, state.status);
      }
    });

    bridge.agentSession.on('turn_end', (turnEnd: AcpTurnEnd) => {
      this.forwardSessionEvent(bridge.session.id, {
        kind: 'turn_ended',
        turnId: bridge.currentTurnId,
        stopReason: turnEnd.stopReason,
      });
    });

    bridge.agentSession.configOptions.on('changed', (event: ConfigOptionChangeEvent) => {
      // `ConfigOptionChangeEvent.sessionId` is the ACP-level session id
      // (`AgentSession.id`/`AcpClient`'s own key), NOT this bridge's
      // loombox-level `session.id` (a separate, node-generated id) — compare
      // against the right one, or a same-process sibling AgentSession's
      // config change (a different ACP session id, sharing nothing but this
      // process) could otherwise be misrouted onto this bridge.
      if (event.sessionId !== bridge.agentSession.id) return;
      this.forwardSessionEvent(bridge.session.id, {
        kind: event.unprompted ? 'config_option_update' : 'config_options',
        options: event.options,
      });
    });

    // Error/exit stay node-local observability (the session's terminal
    // status already reaches the wire via the 'attention' handler above,
    // which fires 'error'/'exited' too — see AgentSession.handleTerminal()).
    bridge.agentSession.on('error', (error: Error) => {
      console.warn(`NodeDaemon: session ${bridge.session.id} agent error: ${error.message}`);
    });
    bridge.agentSession.on('exit', (code: number | null) => {
      console.warn(
        `NodeDaemon: session ${bridge.session.id} agent exited (code ${code ?? 'unknown'})`,
      );
      // Same-folder safety (issue #68): an in-place ssh: session (`branch
      // === ''`, this bridge's own `remoteChild` marker) frees its folder
      // reservation once the agent process genuinely stops, so a new
      // in-place session on the same target+folder can start. A `local`
      // in-place session's release is handled by `SessionManager`'s own
      // guard instead (see `endSession`/`removeSession` there) — nothing to
      // do here for it.
      if (bridge.remoteChild && !bridge.session.branch) {
        this.sshSameFolderGuard.release(
          `${bridge.targetId}:${bridge.session.projectPath}`,
          bridge.session.id,
        );
      }
    });
  }

  /**
   * Forwards this session's CURRENT status/config-option snapshot (SPEC
   * §7.13/§7.24; issues #126/#149), once, right after `announce()` — the
   * `'attention'`/config `'changed'` listeners `wireAgentSession` just
   * registered only fire on a *future* transition, but by the time this
   * bridge exists `AgentSession.spawn()`/`AcpClient.newSession()` have
   * already set the session's initial `awaiting_input` attention and seeded
   * its config-option catalog, so that snapshot is sent explicitly here
   * instead of only ever reaching a client that happens to be subscribed for
   * the next real transition. Must run after `announce()`, not before: the
   * relay drops a `session_update` for a session it hasn't seen a
   * `session_announce` for yet.
   */
  private forwardInitialSessionState(bridge: SessionBridge): void {
    const attention = bridge.agentSession.getAttentionState();
    this.forwardSessionEvent(bridge.session.id, {
      kind: 'session_status',
      status: attention.status,
      updatedAt: attention.updatedAt,
    });
    // #170: a session that comes up already `awaiting_input` (the normal
    // case right after creation) is just as inbox-eligible as one that
    // transitions there later (`apps/web`'s `recomputeAttentionInbox`
    // doesn't distinguish the two) — so this initial snapshot needs the same
    // push trigger the 'attention' listener above sends for every later
    // transition, or an account's other devices would silently miss the
    // very first notification of a freshly created session.
    this.sendAttentionHint(bridge.session.id, attention.status);

    // Keyed by the ACP-level session id (`bridge.agentSession.id`), not this
    // bridge's loombox-level `session.id` — same distinction as the
    // 'changed' listener above.
    const options = bridge.agentSession.configOptions.get(bridge.agentSession.id);
    if (options.length > 0) {
      this.forwardSessionEvent(bridge.session.id, { kind: 'config_options', options });
    }
  }

  /** Encrypts and pumps one session-lifecycle/transcript event to the relay, preserving arrival order (see `SessionBridge.sendQueue`'s doc comment). */
  private forwardSessionEvent(sessionId: string, event: AcpSessionWireEvent): void {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return;

    bridge.sendQueue = bridge.sendQueue
      .then(() => this.encryptAndSendUpdate(bridge, event))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to encrypt/send session_update for ${sessionId}: ${message}`,
        );
      });
  }

  private async encryptAndSendUpdate(
    bridge: SessionBridge,
    event: AcpSessionWireEvent,
  ): Promise<void> {
    const key = await this.getSessionKey(bridge.session.id);
    const envelope = await sealJson(bridge.session.id, event, key);
    bridge.seq += 1;
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId: bridge.session.id,
      seq: bridge.seq,
      envelope,
    });
  }

  private async announce(bridge: SessionBridge): Promise<void> {
    const key = await this.getSessionKey(bridge.session.id);
    const privateMeta: SessionPrivateMeta = {
      title: bridge.title,
      projectPath: bridge.session.projectPath,
    };
    const privateEnvelope = await sealJson(bridge.session.id, privateMeta, key);
    const meta: SessionMetaPublic = {
      id: bridge.session.id,
      nodeId: this.nodeId,
      targetId: bridge.targetId,
      accountId: this.accountId,
      provider: bridge.session.provider,
      createdAt: bridge.session.createdAt,
    };
    this.relay.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope,
    });
  }

  private sendTargetAnnounce(): void {
    this.relay.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: this.nodeId,
      targets: this.targets,
    });
  }

  private reannounceAll(): void {
    this.sendTargetAnnounce();
    for (const bridge of this.bridges.values()) {
      this.announce(bridge).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`NodeDaemon: failed to re-announce session ${bridge.session.id}: ${message}`);
      });
    }
  }

  /** SPEC §8 / issue #116: on every fresh connection, ask whether a rewrapped-AMK-epoch envelope is waiting for this device. */
  private sendAmkEpochFetchRequest(): void {
    this.relay.send({
      type: 'amk_epoch_fetch_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: this.deviceId,
    });
  }

  /**
   * A pending rewrapped-AMK-epoch envelope arrived (or didn't). Ignored if
   * there's nothing pending, or if it's for an epoch this node has already
   * adopted (e.g. a duplicate reply after a reconnect churn) — otherwise
   * emits `'amk-epoch-pending'` for a caller holding this device's private
   * key to unwrap (this class never holds it itself; see the class doc
   * comment).
   */
  private handleAmkEpochFetchResponse(pending: AmkEpochPendingEnvelope | undefined): void {
    if (!pending || pending.epoch <= this.amkEpoch) return;
    this.emit('amk-epoch-pending', pending);
  }

  /**
   * A caller (holding this device's private key) has unwrapped a pending
   * envelope and hands back the recovered AMK for this node to actually
   * adopt. No-op (returns `false`) if `epoch` isn't strictly ahead of what
   * this node already has — the same "only if ahead" guard
   * `handleAmkEpochFetchResponse` applies before ever emitting, re-checked
   * here since adoption is the security-relevant step and callers should
   * never be trusted to skip a stale epoch on their own. Clears every
   * cached session key so any *new* session created after this call derives
   * from the new epoch; already-cached keys for sessions created before
   * rotation are left alone for this process's remaining lifetime (see
   * `session-keys.ts`'s doc comment for why the AMK is the sole root of
   * derivation — there is no separate per-epoch history kept across a
   * restart in this wave).
   */
  adoptAmkEpoch(newAmk: Uint8Array, epoch: number): boolean {
    if (epoch <= this.amkEpoch) return false;
    this.amk = newAmk;
    this.amkEpoch = epoch;
    this.sessionKeys.clear();
    this.emit('amk-epoch-adopted', { epoch });
    return true;
  }

  /** This node's currently-adopted AMK epoch (#116); `0` means "the account's original AMK, never rotated." */
  get currentAmkEpoch(): number {
    return this.amkEpoch;
  }

  /**
   * This node's own currently-held Account Master Key (SPEC §8). Exposed
   * (unlike this device's ECDH private key, which this class never holds at
   * all — see the class doc comment) for `./wire-provision-and-pair.ts`
   * (issue #408): the zero-touch add-target flow wraps THIS same AMK for a
   * freshly-provisioned target's device pubkey
   * (`./ssh/amk-handoff-provision.ts`'s `writeWrappedAmkHandoff`) entirely
   * within this process, over the target's own SSH transport — never sent
   * to the relay in any form (SPEC §8's boundary).
   */
  get currentAmk(): Uint8Array {
    return this.amk;
  }

  /**
   * Streams one step's progress for an in-flight `provision_target_request`
   * (issue #408) back to the relay, which fans it out to the requesting
   * client — the wire-level counterpart to `./ssh/provision-and-pair.ts`'s
   * own `onProgress` callback, called once per step by `./wire-provision-
   * and-pair.ts`.
   */
  sendProvisionProgress(progress: Omit<ProvisionProgress, 'type' | 'protocolVersion'>): void {
    this.relay.send({ type: 'provision_progress', protocolVersion: PROTOCOL_V1, ...progress });
  }

  /** The provision-and-pair sequence's final outcome (issue #408), sent once. */
  sendProvisionResult(result: Omit<ProvisionTargetResult, 'type' | 'protocolVersion'>): void {
    this.relay.send({ type: 'provision_target_result', protocolVersion: PROTOCOL_V1, ...result });
  }

  /**
   * Sends `device_revoke` (SPEC §8's revoke-and-rotate action). The caller
   * is responsible for the crypto: minting the new epoch
   * (`@loombox/crypto`'s `generateAmkEpoch`) and ECDH-wrapping it per
   * surviving device (`wrapAmkEpochForDevice`) — this method only forwards
   * the already-built wire payload, exactly like `announce`/
   * `sendTargetAnnounce` above forward theirs. `newEpoch` must be exactly
   * one past whatever the acting device/account currently believes the
   * epoch to be (the relay rejects anything else, #116).
   */
  revokeDevice(deviceId: string, newEpoch: number, rewrappedAmk: WrappedAmkEnvelope[]): void {
    this.relay.send({
      type: 'device_revoke',
      protocolVersion: PROTOCOL_V1,
      deviceId,
      newEpoch,
      rewrappedAmk,
    });
  }

  private handleInbound(message: WireMessageV1): void {
    switch (message.type) {
      case 'session_create':
        this.handleSessionCreate(message);
        return;
      case 'prompt_inject':
        this.handlePromptInject(message);
        return;
      case 'fs_list_request':
        this.handleFsListRequest(message);
        return;
      case 'terminal_open':
        this.handleTerminalOpen(message);
        return;
      case 'terminal_input':
        this.handleTerminalInput(message);
        return;
      case 'terminal_resize':
        this.handleTerminalResize(message);
        return;
      case 'terminal_close':
        this.handleTerminalClose(message);
        return;
      case 'amk_epoch_fetch_response':
        this.handleAmkEpochFetchResponse(message.pending);
        return;
      case 'provision_target_request':
        // Issue #408's zero-touch add-target wizard: this node itself never
        // owns the provisioning sequence (it needs this node's own ECDH
        // private key to wrap the AMK handoff, which — like
        // `'amk-epoch-pending'` above — this class deliberately never holds;
        // see the class doc comment) — a caller wired up outside this class
        // (`./wire-provision-and-pair.ts`, holding `NodeIdentityStore`'s
        // identity) subscribes to this event and drives `./ssh/provision-
        // and-pair.ts`, reporting back via `sendProvisionProgress`/
        // `sendProvisionResult`. A no-op (message simply dropped) if nothing
        // is listening, exactly like `'attachment_resolved'` above.
        this.emit('provision_target_request', message);
        return;
      default:
        // Every other v1 message type (permission_response, config_option,
        // presence, blob_ref, ...) is out of this wave's scope; ignore
        // rather than crash on a message this node doesn't yet act on.
        // `blob_download_response` also lands here and is likewise ignored
        // by this switch — it's consumed separately, by the `AttachmentResolver`'s
        // own listener on this same relay connection (`RelayBlobSource`,
        // issue #156), not routed through `handleInbound`.
        return;
    }
  }

  /** A client asked (via the relay) for this node to start a new session on one of its targets. */
  private handleSessionCreate(message: SessionCreate): void {
    if (!this.targets.some((target) => target.id === message.targetId)) {
      console.warn(`NodeDaemon: session_create for unknown target "${message.targetId}"`);
      return;
    }

    this.decryptSessionCreate(message)
      .then((privateMeta) =>
        this.createSessionInternal({
          sessionId: message.sessionId,
          projectPath: privateMeta.projectPath,
          provider: message.provider,
          targetId: message.targetId,
          title: privateMeta.title,
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to create session ${message.sessionId} from session_create: ${detail}`,
        );
      });
  }

  private async decryptSessionCreate(message: SessionCreate): Promise<SessionPrivateMeta> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<SessionPrivateMeta>(message.sessionId, message.privateEnvelope, key);
  }

  /** A client injected a follow-up prompt (via the relay) into one of this node's sessions. */
  private handlePromptInject(message: PromptInjectV1): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.assertStillLeaseholder(bridge)
      .then(() => this.decryptPromptInject(message))
      .then((payload) => this.deliverPrompt(bridge, payload))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle prompt_inject for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptPromptInject(message: PromptInjectV1): Promise<PromptPayload> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<PromptPayload>(message.sessionId, message.envelope, key);
  }

  /**
   * Resolves every attachment this prompt references (SPEC §7.25; issue
   * #156) before delivering the prompt text to the agent, so a fetch/decrypt
   * failure surfaces as this prompt failing (caught by `handlePromptInject`'s
   * caller) rather than the agent being prompted without an attachment it
   * was supposed to see. Runs through `this.supervisor.resolveAttachment()`
   * — the injected `AttachmentChannel` path (SPEC §7.25 "the existing
   * node↔supervisor control channel") — identically whether `bridge` is a
   * `local` or an `ssh:` target session: resolution never touches the
   * execution target at all.
   *
   * Once an attachment resolves (the blob genuinely exists and decrypts —
   * this node's own confirmation that the upload is real, SPEC §7.25's "only
   * ever sent once the blob upload has confirmed"), this also seals and
   * sends its `blob_ref` file event (issue #154) *before* handing the prompt
   * to the agent: a broken/unresolvable ref aborts the whole prompt (same as
   * before this change) rather than ever reaching either the agent or this
   * side channel. `sendFileEvent` is on its own wire message type, never
   * `bridge.sendQueue`/`session_update` — see that method's doc comment.
   */
  private async deliverPrompt(bridge: SessionBridge, payload: PromptPayload): Promise<void> {
    for (const attachment of payload.attachments ?? []) {
      const bytes = await this.supervisor.resolveAttachment(bridge.session.id, attachment.ref);
      const resolved: ResolvedAttachment = {
        sessionId: bridge.session.id,
        ref: attachment.ref,
        mimeType: attachment.mimeType,
        name: attachment.name,
        bytes,
      };
      this.emit('attachment_resolved', resolved);
      await this.sendFileEvent(bridge.session.id, {
        ref: attachment.ref,
        mimeType: attachment.mimeType,
        name: attachment.name,
        dimensions: attachment.dimensions,
        thumbhash: attachment.thumbhash,
      });
    }
    this.beginTurn(bridge);
    await bridge.agentSession.prompt(payload.text);
  }

  /**
   * Seals and sends one attachment's `blob_ref` file event (SPEC §7.25;
   * issue #154) — metadata only (`FileEventPayloadV1`: ref, mimeType, name,
   * dimensions, thumbhash), never the attachment bytes, which this node
   * never even holds past `deliverPrompt`'s local `bytes` variable above.
   * Deliberately calls `this.relay.send` directly with `type: 'blob_ref'`
   * rather than going through `forwardSessionEvent`/`bridge.sendQueue` (the
   * `session_update` chain `encryptAndSendUpdate` feeds): the relay fans a
   * `blob_ref` out via its direct/unbounded control path (`relay.ts`'s
   * `fanOutDirect`), not the bounded per-client `session_update` queue
   * (§7.16) — so a large attachment can never starve, or be starved/gated
   * by, that session's live transcript stream. See
   * `attachments-e2e.test.ts` for a test proving this concretely under a
   * saturated `session_update` queue.
   */
  /**
   * Sends this session's relay-visible `attention_hint` (SPEC §7.11/§7.13;
   * issue #170) for `status`, mirroring how `sendFileEvent` below sends
   * `blob_ref` on its own top-level wire message rather than through
   * `bridge.sendQueue`/`session_update` — no-op for a status
   * {@link attentionHintClassForStatus} maps to `undefined`. Deliberately
   * plaintext, metadata-only (`sessionId` + `class`, no `detail`, no
   * `stopReason`): the relay must learn just enough to decide whether to
   * push (`packages/relay/src/relay.ts`'s `maybeSendAttentionPush`), never
   * anything a subscribed client doesn't already get, encrypted, over the
   * `session_status` event this rides alongside — see `@loombox/protocol`'s
   * `attention.ts` doc comment for the full rationale, and `push.ts`'s
   * `PushPayload` doc comment for the relay side.
   */
  private sendAttentionHint(sessionId: string, status: AttentionStatus): void {
    const hintClass = attentionHintClassForStatus(status);
    if (!hintClass) return;
    this.relay.send({
      type: 'attention_hint',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      class: hintClass,
    });
  }

  /**
   * Sends the real, top-level `permission_request` wire message (SPEC
   * §7.24; `@loombox/protocol`'s `steering.ts`) for a live tool-call
   * approval — issue #373's gap: that message, and the relay's fan-out +
   * presence-aware push on it, already existed (#163/`relay.ts`'s `case
   * 'permission_request'`), and `apps/web` was already ready to decrypt and
   * render one (`relay-client.ts`'s `PermissionRequestPayload` doc comment:
   * "No node in this repo emits `permission_request` yet"), but no node
   * ever actually constructed one. Sent alongside — never instead of — the
   * encrypted `session_status: 'permission_required'` event the caller (the
   * `'attention'` listener in `wireAgentSession`) already forwarded over
   * `session_update`; the relay never opens this envelope, only routes on
   * its clear `sessionId`/`requestId`.
   *
   * `detail` is that same event's `AttentionState.detail` — narrowed by
   * {@link isPermissionRequestDetail} down to the `requestId`
   * `agent-session.ts`'s `setAttention('permission_required', ...)` stamped
   * it with — looked up against this session's own live `permissions` FIFO
   * queue (`AgentSession.permissions`) for the full `toolCall`/`options`
   * this message actually needs to carry (SPEC §7.24's approval UI, once a
   * client acts on it — resolving it back is a separate, later concern).
   * A no-op when `detail` doesn't carry a `requestId`, when that specific
   * request has already resolved by the time this async encrypt runs (a
   * fast allow/deny racing it), or when this session has no live agent
   * process at all (a replay-only session can never be mid-approval).
   */
  private async sendPermissionRequest(bridge: SessionBridge, detail: unknown): Promise<void> {
    if (!bridge.agentSession.isLive) return;
    if (!isPermissionRequestDetail(detail)) return;
    const { requestId } = detail;
    const pending = bridge.agentSession.permissions
      .list(bridge.agentSession.id)
      .find((request) => request.requestId === requestId);
    if (!pending) return;

    const payload: PermissionRequestPayloadV1 = {
      toolCall: pending.toolCall,
      options: pending.options,
    };
    const key = await this.getSessionKey(bridge.session.id);
    const envelope = await sealJson(bridge.session.id, payload, key);
    this.relay.send({
      type: 'permission_request',
      protocolVersion: PROTOCOL_V1,
      sessionId: bridge.session.id,
      requestId,
      envelope,
    });
  }

  private async sendFileEvent(sessionId: string, payload: FileEventPayloadV1): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'blob_ref',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      ref: payload.ref,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to list a directory inside one
   * of its sessions' projects (SPEC §7.4; issue #171). Ignored if `sessionId`
   * isn't one of this node's own bridges (mirrors `handlePromptInject`'s same
   * guard). A decrypt failure is logged and dropped (there is no path to
   * reply about); everything past that point — path-traversal refusal, a
   * missing/permission-denied directory, an `ssh:` transport failure — is
   * turned into an `outcome: 'error'` response instead of silently dropping,
   * per `@loombox/protocol`'s `fsListResponsePayloadV1` doc comment.
   */
  private handleFsListRequest(message: FsListRequest): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptFsListRequest(message)
      .then((payload) => this.listDirectoryForBridge(bridge, payload.path))
      .then((responsePayload) =>
        this.sendFsListResponse(bridge.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle fs_list_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptFsListRequest(message: FsListRequest): Promise<FsListRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<FsListRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Resolves `requestedPath` against `bridge`'s session root and lists it via
   * that session's `ExecutionTarget` (local or `ssh:`, issue #69's shared
   * seam — identical code path for both target kinds, per SPEC §7.4's "works
   * over the same transport the session already uses"). Never throws: a
   * path-traversal attempt or a filesystem failure both become an
   * `outcome: 'error'` payload rather than an unhandled rejection, so
   * {@link handleFsListRequest} always has a response to seal and send back.
   */
  private async listDirectoryForBridge(
    bridge: SessionBridge,
    requestedPath: string,
  ): Promise<FsListResponsePayloadV1> {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSessionRelativePath(bridge.session.worktreePath, requestedPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }

    try {
      const target = await this.getExecutionTarget(bridge.targetId);
      const entries = await target.readdirDetailed(resolvedPath);
      return {
        outcome: 'ok',
        path: requestedPath,
        // `readdirDetailed`'s `'other'` (socket/device/fifo) collapses to
        // `'file'` on the wire — `@loombox/protocol`'s `fsEntryKindV1` only
        // distinguishes file/dir/symlink (see that schema's doc comment).
        entries: entries.map((entry) => ({
          name: entry.name,
          kind: entry.type === 'other' ? ('file' as const) : entry.type,
          size: entry.size,
        })),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }
  }

  private async sendFsListResponse(
    sessionId: string,
    requestId: string,
    payload: FsListResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'fs_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to open a new interactive PTY
   * terminal on one of its sessions' targets (SPEC §7.5; issues #172/#173).
   * Ignored if `sessionId` isn't one of this node's own bridges (mirrors
   * `handleFsListRequest`'s same guard). Always replies with `terminal_opened`
   * — `outcome: 'ok'` once the PTY is spawned and streaming, or
   * `outcome: 'error'` for a decrypt failure, an unknown target, or a spawn
   * failure — so the client never hangs waiting for a reply that never
   * comes, per `@loombox/protocol`'s `terminalOpenResultPayloadV1` doc
   * comment.
   */
  private handleTerminalOpen(message: TerminalOpen): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptTerminalOpenPayload(message)
      .then((payload) => this.openTerminalForBridge(bridge, message.terminalId, payload))
      .then(() =>
        this.sendTerminalOpened(bridge.session.id, message.terminalId, message.requestId, {
          outcome: 'ok',
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle terminal_open for session ${message.sessionId} terminal ${message.terminalId}: ${detail}`,
        );
        this.sendTerminalOpened(bridge.session.id, message.terminalId, message.requestId, {
          outcome: 'error',
          message: detail,
        }).catch(() => {
          /* best-effort error reply; nothing further to do if even this fails */
        });
      });
  }

  private async decryptTerminalOpenPayload(message: TerminalOpen): Promise<TerminalOpenPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<TerminalOpenPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Spawns `terminalId`'s PTY on `bridge`'s target and wires its output/exit
   * back to the relay (issue #172's "the same terminal works identically
   * whether the target is `local` or `ssh:`"): a `local` target gets a real
   * `node-pty` process (`TerminalSupervisor.open`) running this node's own
   * shell; an `ssh:` target gets a `Client.shell()` channel on that target's
   * already-pooled transport (`./ssh/ssh2-transport.ts`), adapted into the
   * same `PtyLike` contract (`./ssh/ssh-pty-adapter.ts`) and adopted via
   * `TerminalSupervisor.openWithPty` — from here on both look identical to
   * every caller. Both start in `bridge.session.worktreePath` — the session's
   * project root/worktree — so a second terminal opened for the same session
   * shares that same directory automatically (issue #173).
   */
  private async openTerminalForBridge(
    bridge: SessionBridge,
    terminalId: string,
    payload: TerminalOpenPayloadV1,
  ): Promise<void> {
    const target = this.targets.find((candidate) => candidate.id === bridge.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${bridge.targetId}"`);
    }

    let session: TerminalSession;
    if (target.kind === 'local') {
      session = this.terminalSupervisor.open({
        terminalId,
        file: process.env.SHELL ?? '/bin/bash',
        cwd: bridge.session.worktreePath,
        cols: payload.cols,
        rows: payload.rows,
      });
    } else {
      const transport = await this.getSshTransport(bridge.targetId);
      if (!supportsShellChannel(transport)) {
        throw new Error(
          `NodeDaemon: ssh target "${bridge.targetId}" transport does not support shell channels`,
        );
      }
      const channel = await transport.openShellChannel({ cols: payload.cols, rows: payload.rows });
      // `ssh2`'s `Client.shell()` has no `cwd` option (unlike `node-pty`'s
      // local spawn): the remote PTY always starts in the login shell's own
      // default directory. Typing a `cd` as the very first input lands this
      // terminal in the session's worktree exactly like a local one, at the
      // cost of that one line briefly appearing before `clear` wipes it —
      // an accepted, documented tradeoff (SPEC §16 grounding notes this is
      // the same channel primitive an interactive `ssh host` uses, which has
      // this same limitation).
      channel.write(`cd ${shQuote(bridge.session.worktreePath)} && clear\n`);
      session = this.terminalSupervisor.openWithPty(terminalId, shellChannelToPty(channel));
    }

    this.wireTerminalSession(bridge.session.id, session);
  }

  /**
   * Streams a just-opened terminal's output/exit to the relay for the
   * lifetime of the PTY. Registered exactly once per terminal, right after
   * {@link openTerminalForBridge} spawns it.
   */
  private wireTerminalSession(sessionId: string, session: TerminalSession): void {
    session.onData((chunk) => {
      this.queueTerminalOutput(sessionId, session.terminalId, chunk);
    });
    session.onExit((event) => {
      const closedByClient = this.clientInitiatedTerminalCloses.delete(session.terminalId);
      const reason: TerminalClosedReasonV1 = closedByClient ? 'closed_by_client' : 'exited';
      this.sendTerminalClosed(sessionId, session.terminalId, {
        reason,
        exitCode: event.exitCode,
        signal: event.signal !== undefined ? String(event.signal) : undefined,
      }).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send terminal_closed for session ${sessionId} terminal ${session.terminalId}: ${detail}`,
        );
      });
    });
  }

  /** Chains this terminal's `terminal_output` sends (mirrors `forwardSessionEvent`'s `bridge.sendQueue`) so concurrent encrypts can never resolve, and so get sent to the relay, out of the order their chunks arrived in. */
  private queueTerminalOutput(sessionId: string, terminalId: string, chunk: Uint8Array): void {
    const queueKey = `${sessionId}:${terminalId}`;
    const previous = this.terminalSendQueues.get(queueKey) ?? Promise.resolve();
    const next = previous
      .then(() => this.sendTerminalOutput(sessionId, terminalId, chunk))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to encrypt/send terminal_output for session ${sessionId} terminal ${terminalId}: ${detail}`,
        );
      });
    this.terminalSendQueues.set(queueKey, next);
  }

  private async sendTerminalOutput(
    sessionId: string,
    terminalId: string,
    chunk: Uint8Array,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const payload: TerminalDataPayloadV1 = { data: Buffer.from(chunk).toString('base64') };
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'terminal_output',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      terminalId,
      envelope,
    });
  }

  private async sendTerminalOpened(
    sessionId: string,
    terminalId: string,
    requestId: string,
    payload: TerminalOpenResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'terminal_opened',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      terminalId,
      requestId,
      envelope,
    });
  }

  private async sendTerminalClosed(
    sessionId: string,
    terminalId: string,
    payload: TerminalClosedPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'terminal_closed',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      terminalId,
      envelope,
    });
  }

  /** A client streamed one chunk of typed input to an open terminal's stdin (SPEC §7.5). Ignored if `sessionId` isn't one of this node's own bridges. */
  private handleTerminalInput(message: TerminalInput): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptTerminalDataPayload(message)
      .then((payload) => {
        this.terminalSupervisor.write(message.terminalId, Buffer.from(payload.data, 'base64'));
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle terminal_input for session ${message.sessionId} terminal ${message.terminalId}: ${detail}`,
        );
      });
  }

  private async decryptTerminalDataPayload(message: TerminalInput): Promise<TerminalDataPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<TerminalDataPayloadV1>(message.sessionId, message.envelope, key);
  }

  /** A client asked to renegotiate an open terminal's PTY window size (SPEC §7.5). Ignored if `sessionId` isn't one of this node's own bridges. */
  private handleTerminalResize(message: TerminalResize): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptTerminalResizePayload(message)
      .then((payload) => {
        this.terminalSupervisor.resize(message.terminalId, payload.cols, payload.rows);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle terminal_resize for session ${message.sessionId} terminal ${message.terminalId}: ${detail}`,
        );
      });
  }

  private async decryptTerminalResizePayload(
    message: TerminalResize,
  ): Promise<TerminalResizePayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<TerminalResizePayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * A client asked to close one of its open terminals (SPEC §7.5). Marks
   * `terminalId` as client-initiated before closing it (see
   * {@link clientInitiatedTerminalCloses}'s doc comment) so the
   * `TerminalSession.onExit` this triggers reports `reason: 'closed_by_client'`
   * rather than `'exited'` in the `terminal_closed` this sends. Ignored if
   * `sessionId` isn't one of this node's own bridges; a silent no-op if
   * `terminalId` is already closed or unknown (`TerminalSupervisor.close`'s
   * own no-op contract).
   */
  private handleTerminalClose(message: TerminalClose): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.clientInitiatedTerminalCloses.add(message.terminalId);
    this.terminalSupervisor.close(message.terminalId);
  }

  /**
   * This node's concrete `AttachmentChannel` implementation (SPEC §7.25;
   * issue #156): fetches the blob's ciphertext over this node's *existing*
   * relay connection (`this.attachmentResolver`, built off `this.relay` in
   * the constructor — never a new connection) and decrypts it under this
   * session's derived key, which only this node holds (SPEC §8's AMK). This
   * is the method a default-constructed `this.supervisor` is handed as its
   * `attachmentChannel.resolveAttachment`.
   */
  private async resolveAttachment(sessionId: string, ref: string): Promise<Uint8Array> {
    const key = await this.getSessionKey(sessionId);
    return this.attachmentResolver.resolve(sessionId, ref, key);
  }

  private getSessionKey(sessionId: string): Promise<CryptoKey> {
    let key = this.sessionKeys.get(sessionId);
    if (!key) {
      key = deriveSessionKey(this.amk, this.accountId, sessionId);
      this.sessionKeys.set(sessionId, key);
    }
    return key;
  }
}

/** Convenience composition: builds a `NodeDaemon` and immediately connects it to the relay. */
export function createNode(options: NodeDaemonOptions): NodeDaemon {
  const node = new NodeDaemon(options);
  node.connect();
  return node;
}
