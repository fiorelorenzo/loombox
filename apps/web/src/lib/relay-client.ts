import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  packWrappedAmkForWire,
  unpackWrappedAmkFromWire,
  unwrapAmkWithRecoveryCode,
  type EcdhKeyPair,
} from '@loombox/crypto';
import { isFailingCiConclusion } from '@loombox/shared';
import { createEnvelopeCrypto, type EnvelopeCrypto } from './envelope-crypto-client';
import {
  acpPermissionRequestPayloadSchema,
  acpTranscriptUpdateSchema,
  cancelAllPermissionRequests,
  createPermissionQueueState,
  createTranscriptState,
  enqueuePermissionRequest,
  headPermissionRequest,
  listPermissionRequests,
  reduceResyncGap,
  reduceSessionEvent,
  resolvePermissionRequest,
  type AcpAvailableCommand,
  type AcpMcpServerPromptsEntry,
  type ProjectEnvVarDecl,
  type AcpConfigOption,
  type AcpMcpServerStatusEntry,
  type AcpPermissionOption,
  type AcpSessionStatus,
  type AcpSessionWireEvent,
  type AcpToolCallUpdate,
  type McpServerConfig,
  type PendingPermissionRequest,
  type PermissionQueueState,
  type TranscriptItem,
  type TranscriptState,
} from '@loombox/providers-core/browser';
import {
  HEARTBEAT_CAPABILITY,
  PROTOCOL_V1,
  buildIdentityMismatch,
  initializeResult,
  newDeviceBootstrapResponse,
  parsePermissionPolicyResultPayloadV1,
  parseAgentProfileListResultPayloadV1,
  parseAgentProfileSessionPayloadV1,
  parsePermissionPolicyViolationPayloadV1,
  parseTestRunnerConfigDetectedPayloadV1,
  parseTestRunnerConfigResultPayloadV1,
  parsePrOpenPreviewResultPayloadV1,
  parsePrOpenResultPayloadV1,
  parseCheckpointResultPayloadV1,
  parseCheckpointListResultPayloadV1,
  parseCheckpointRestorePreviewResultPayloadV1,
  parseCheckpointRestoreResultPayloadV1,
  parseCiCheckStatusPayloadV1,
  safeParseSessionLifecycleEventV1,
  safeParseWireMessageV1,
  type AccountPinMapV1,
  type AccountPinResolveOutcome,
  type ConfigOptionResult,
  type ConnectedAccount,
  type ConnectedAccountDisconnectResponse,
  type ConnectedAccountList,
  type KeymapResult,
  type KeymapV1,
  keymapV1,
  type CustomAgentProbeRequestPayloadV1,
  type CustomAgentProbeResponse,
  type CustomAgentProbeResponsePayloadV1,
  type CustomAgentProbeResultV1,
  type CustomAgentRecordV1,
  type CheckpointCreatePayloadV1,
  type CheckpointListResult,
  type CheckpointListResultPayloadV1,
  type CheckpointResult,
  type CheckpointResultPayloadV1,
  type CheckpointRestorePreviewResult,
  type CheckpointRestorePreviewResultPayloadV1,
  type CheckpointRestoreResult,
  type CheckpointRestoreResultPayloadV1,
  trackerSnapshotResponsePayloadV1,
  trackerWriteResponsePayloadV1,
  mcpPromptGetResponsePayloadV1,
  type McpPromptGetRequestPayloadV1,
  type McpPromptGetResponse,
  type DecommissionTargetResponse,
  type EncryptedEnvelope,
  type FsEntryV1,
  type FsListRequestPayloadV1,
  type FsListResponse,
  type FsListResponsePayloadV1,
  type FsReadRequestPayloadV1,
  type FsReadResponse,
  type FsReadResponsePayloadV1,
  type GitDiffResponse,
  type GitDiffResponsePayloadV1,
  type GitHunkActionRequestPayloadV1,
  type GitHunkActionResponse,
  type GitHunkActionResponsePayloadV1,
  type GitHunkDiffResponse,
  type GitHunkDiffResponsePayloadV1,
  type GithubConnectDeviceCode,
  type GithubConnectOutcome,
  type BuildIdentityV1,
  type Initialize,
  type JiraConnectOutcome,
  type NewDeviceBootstrapRequest,
  type PermissionRequest,
  type Pong,
  type ProvisionProgress,
  type ProvisionTargetHostInputV1,
  type ProvisionTargetResult,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionArchiveResponse,
  type SessionForkResponse,
  type SessionListV1,
  type SessionMetaPublic,
  type SessionPrivateMetaV1,
  type SessionUpdateEnvelopeV1,
  type SshDiscoveryResponse,
  type SshDiscoveryResultV1,
  type TargetFsListRequestPayloadV1,
  type TargetFsListResponse,
  type TargetFsListResponsePayloadV1,
  type TargetList,
  type TargetListEntry,
  type TargetUpdateResponse,
  type RunExit,
  type RunExitOutcomeV1,
  type RunExitPayloadV1,
  type RunOutput as RunOutputMessage,
  type RunOutputPayloadV1,
  type RunStarted,
  type RunStartedResultPayloadV1,
  type RunStartPayloadV1,
  type TerminalClosed,
  type TerminalClosedPayloadV1,
  type TerminalDataPayloadV1,
  type TerminalOpened,
  type TerminalOpenPayloadV1,
  type TerminalOpenResultPayloadV1,
  type TerminalOutput as TerminalOutputMessage,
  type TerminalResizePayloadV1,
  type TestRunnerCommandsV1,
  type PermissionPolicyResult,
  type PermissionPolicyV1,
  type PermissionPolicyViolation,
  type PermissionPolicySetPayloadV1,
  type PermissionPolicyViolationPayloadV1,
  type AgentProfileV1,
  type AgentProfileListResult,
  type AgentProfileListSetPayloadV1,
  type AgentProfileSessionResult,
  type AgentProfileSessionPayloadV1,
  type TestRunnerConfigDetected,
  type TestRunnerConfigResult,
  type TestRunnerConfigSetPayloadV1,
  type TrackerMode,
  type TrackerBackendResolutionErrorV1,
  type TrackerRecordV1,
  type TrackerRoleV1,
  type TrackerSnapshotRequestPayloadV1,
  type TrackerSnapshotResponse,
  type TrackerTypeDefinitionV1,
  type TrackerWriteRequestPayloadV1,
  type TrackerWriteResponse,
  type TrackerWriteResponsePayloadV1,
  type SpendReportRowV1,
  type SpendReportResponse,
  spendReportResponsePayloadV1,
  type TestRunnerKindV1,
  type PrOpenOutcome,
  type PrOpenPreviewOutcome,
  type PrOpenPreviewResult,
  type PrOpenRequestPayloadV1,
  type PrOpenResult,
  type CiCheckStateV1,
  type CiCheckStatus,
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
import type { MentionRef } from './mentions';

export type {
  ConnectedAccount,
  BuildIdentityV1,
  TargetHealth,
  TargetListEntry,
} from '@loombox/protocol';
export type {
  PermissionPolicyV1,
  PermissionRuleSetV1,
  ToolRefusalReasonV1,
  AgentProfileV1,
} from '@loombox/protocol';
export { buildIdentityMismatch };
export type {
  ProvisionProgress,
  ProvisionStepIdV1,
  ProvisionStepStatusV1,
  ProvisionTargetHostInputV1,
  ProvisionTargetResult,
} from '@loombox/protocol';
export type {
  SshAgentIdentityV1,
  SshAgentInfoV1,
  SshDiscoveryResultV1,
  SshHostCandidateV1,
} from '@loombox/protocol';
export type {
  DecommissionResultV1,
  DecommissionTargetResponse,
  TargetUpdateResponse,
  TargetVersionStatusV1,
} from '@loombox/protocol';
export type {
  AccountPinErrorType,
  AccountPinMapV1,
  AccountPinResolveOutcome,
  ConnectedAccountCredentialSource,
  ConnectedAccountDisconnectResponse,
  GithubConnectDeviceCode,
  GithubConnectOutcome,
  JiraConnectOutcome,
} from '@loombox/protocol';
export type { CustomAgentProbeResultV1, CustomAgentRecordV1 } from '@loombox/protocol';
export type { PrOpenFailureCategory, PrOpenOutcome, PrOpenPreviewOutcome } from '@loombox/protocol';
export type {
  CheckpointErrorTypeV1,
  CheckpointResultPayloadV1,
  CheckpointListResultPayloadV1,
  CheckpointRestorePreviewResultPayloadV1,
  CheckpointRestoreResultPayloadV1,
  GitCheckpointV1,
  RestorePreviewV1,
  RestoreResultV1,
} from '@loombox/protocol';

/**
 * The relay serves its WebSocket only on `RELAY_WS_PATH` (`/ws`), and both this
 * client and the node connect to the relay URL *directly* — no path is appended
 * downstream, and the HTTP base is derived by stripping a trailing `/ws`. So a
 * relay URL must end in `/ws`. This normalizes any configured or stored value
 * (the built-in default, or a hand-typed "Relay URL") to guarantee it, since a
 * bare `wss://relay.loombox.dev` otherwise opens against the relay's root and
 * 404s — which is exactly what silently broke device pairing and AMK escrow
 * (the browser could sign in over HTTP but never open its session/escrow WS).
 */
export function withRelayWsPath(relayUrl: string): string {
  const trimmed = relayUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`;
}

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

/**
 * A `setTimeout`/`setInterval` handle. Named rather than written inline as
 * `ReturnType<typeof setTimeout>` at each use so every timer field in this
 * class shares one contract; `setTimeout`/`setInterval` return the same
 * handle type as each other in both environments this bundle runs in
 * (`number` in a browser, `NodeJS.Timeout` under Node/SSR), so one alias
 * covers both without committing to either concrete type.
 */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Connection lifecycle exposed to the UI. `'closed'` no longer means dead
 * on arrival: an unexpected drop schedules a reconnect with backoff
 * automatically (see the class docstring), so this value alone doesn't
 * distinguish "retrying" from a deliberate `close()` — only the caller
 * knows which one happened.
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * The plaintext a session's private envelope carries. Re-exported from
 * `@loombox/protocol`'s `sessionPrivateMetaV1` rather than hand-written here:
 * this shape has to match what `@loombox/node` seals and opens, and it used to
 * be two independent interfaces with nothing checking they agreed.
 */
type SessionPrivateMeta = SessionPrivateMetaV1;

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

/**
 * A still-live `@`-mention pill (issue #742, decisions doc C2-3) carried
 * inside a `prompt_inject` envelope's plaintext, mirrored field-for-field
 * from `@loombox/node`'s `PromptMentionRef` (`packages/node/src/node-daemon.ts`)
 * exactly like {@link PromptAttachmentRef} above — the node decrypts this
 * same plaintext shape. `uri`/`name` are `MentionRef.resourceLink`'s own
 * fields (`$lib/mentions.ts`) — ACP's baseline `ContentBlock::ResourceLink`
 * shape, not a loombox-invented one.
 */
interface PromptMentionRef {
  uri: string;
  name: string;
}

/** The plaintext a `prompt_inject` envelope decrypts to, mirrored from `@loombox/node`'s `PromptPayload`. */
interface PromptPayload {
  text: string;
  /** Attachments this turn references (SPEC §7.25); omitted for a plain text prompt. */
  attachments?: PromptAttachmentRef[];
  /** Still-live `@`-mention pills this turn references (issue #742); omitted when there are none. */
  mentions?: PromptMentionRef[];
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

/**
 * Parses and validates a decrypted `session_update` payload against
 * `AcpSessionWireEvent`'s two disjoint halves. `AcpTranscriptUpdate` (the
 * ACP-native `agent_message_chunk`/`tool_call`/`plan_update`/`usage_update`
 * kinds, tried first as the more common case on the wire) is
 * `@loombox/providers-core`'s surface to validate; `AcpSessionLifecycleEvent`
 * (`session_status`/`config_options`/`config_option_update`/`turn_started`/
 * `turn_ended`, loombox's own invention layered on top of ACP) is
 * `@loombox/protocol`'s own "one validated source of truth" for those five
 * kinds (`session-events.ts`'s doc comment) — this module is the one place
 * that already depends on both packages, so it is where the two halves are
 * tried and combined into one `AcpSessionWireEvent`. A payload matching
 * neither throws, with both halves' rejection reasons, and is dropped
 * before ever reaching {@link RelayClient.applyUpdate}'s reducer (issue
 * #593 — closes the hole `openJson<AcpSessionWireEvent>`'s bare cast left
 * open, the root cause behind #548's `id: undefined` symptom).
 */
function parseSessionWireEvent(raw: unknown): AcpSessionWireEvent {
  const transcriptUpdate = acpTranscriptUpdateSchema.safeParse(raw);
  if (transcriptUpdate.success) return transcriptUpdate.data;

  const lifecycleEvent = safeParseSessionLifecycleEventV1(raw);
  if (lifecycleEvent.success) {
    // `session_status.status` is `SessionStatusV1` on the protocol side
    // (its own wider 7-value enum, including 'queued'/'starting' — issues
    // #252/#516) while `AcpSessionStatus` here is still the narrower
    // five-value union; the reducer's `case 'session_status'`
    // (`transcript.ts`) already stores whichever string arrives
    // unchecked either way, so this makes that existing tolerance
    // explicit rather than leaving it an implicit `as T` cast.
    return lifecycleEvent.data as AcpSessionWireEvent;
  }

  throw new Error(
    `matches neither AcpTranscriptUpdate (${transcriptUpdate.error.message}) nor AcpSessionLifecycleEvent (${lifecycleEvent.error.message})`,
  );
}

/** `SessionMetaPublic`'s clear routing fields plus the title/projectPath decrypted from its paired private envelope. */
export type ClientSessionMeta = SessionMetaPublic & SessionPrivateMeta;

/**
 * One directory's fs-list state for the read-only file-tree panel (SPEC
 * §7.4; issue #171) and the `@file` picker (SPEC §7.25; issue #160) that's
 * backed by it. Keyed by its path relative to the session's project root
 * (`''` for the root itself) in {@link RelayClient.fileTreeFor}'s returned
 * `Map`. `'loading'`/`'error'` are the only states before entries land — an
 * `'error'` keeps whatever `entries` it last had (empty on a first load
 * failure) so a retry (calling {@link RelayClient.expandDirectory} again)
 * doesn't have to special-case anything.
 */
export interface FileTreeDirectoryState {
  path: string;
  status: 'loading' | 'loaded' | 'error';
  entries: FsEntryV1[];
  error?: string;
}

/**
 * One project's native tracker state (SPEC §7.10; issue #212, #697), keyed
 * by `projectPath` in {@link RelayClient.trackerSnapshotFor}'s returned
 * store. Project-scoped rather than session-scoped (issue #697): a
 * project's tracker outlives any one session that reads it, and is
 * reachable with none running at all. `'loading'`/`'error'` are the only
 * states before a `records`/`types` pair lands — an `'error'` keeps
 * whatever it last had (empty on a first load failure) so
 * {@link RelayClient.reloadTrackerSnapshot}'s Retry doesn't have to
 * special-case anything, exactly like `FileTreeDirectoryState`'s own
 * contract. A write ({@link RelayClient.createTrackerRecord}/
 * {@link RelayClient.updateTrackerRecord}/{@link RelayClient.defineTrackerType})
 * merges its own returned record/type into `records`/`types` directly
 * rather than re-fetching a full snapshot — the kanban board's
 * drag-to-move stays snappy, and the merge is exactly as authoritative as
 * a re-fetch would be: both read the same `tracker_write_response`,
 * straight from `NativeTrackerStore`.
 */
export interface TrackerSnapshotState {
  status: 'loading' | 'loaded' | 'error';
  records: TrackerRecordV1[];
  types: TrackerTypeDefinitionV1[];
  error?: string;
  /** Set only when `error` came from a `resolveTrackerBackend` resolution failure (SPEC §7.10, issue #631) — never for a native-mode store failure, a decrypt/timeout failure, or a stale connection, none of which has a `TrackerMode` resolution to describe. `TrackerPage.svelte` switches on `errorReason.kind` for the cases it renders specially, falling back to the plain `error` message otherwise. */
  errorReason?: TrackerBackendResolutionErrorV1;
}

/**
 * One project's spend-over-time read model (SPEC §7.9; issue #249), keyed
 * by `projectPath` in {@link RelayClient.spendReportFor}'s returned store —
 * same project-scoped shape as {@link TrackerSnapshotState} and for the
 * identical reason (a project's spend ledger outlives any one session that
 * added to it, reachable with none running at all). `rows` is exactly what
 * `spend_report_response` carried, never re-derived or summed here — every
 * caller (the spend view) reduces it through `@loombox/shared`'s
 * `aggregateSpendLedgerRows`, the identical function `@loombox/node` itself
 * filters `SpendLedgerStore` rows through before sealing the reply, so the
 * client never runs a second, independently-written grouping. An empty
 * `rows` array on `'loaded'` is a legitimate "nothing recorded in this
 * period" answer, not a loading/error state — the view is the one that
 * turns that into an honest "no data" reading (never a fabricated $0.00),
 * per this file's own live-meter convention (`StatusBar.svelte`'s doc
 * comment).
 */
export interface SpendReportState {
  status: 'loading' | 'loaded' | 'error';
  rows: SpendReportRowV1[];
  error?: string;
}

/**
 * One open (or opening/closed/errored) interactive PTY terminal's lifecycle
 * state (SPEC §7.5; issues #172/#173/#174), keyed by `terminalId` in
 * {@link RelayClient.terminalsFor}'s returned `Map`. Deliberately does NOT
 * carry the terminal's actual byte stream — unlike the file tree's contents,
 * a terminal's output is a live, potentially unbounded stream meant to feed
 * an xterm.js buffer directly (`InteractiveTerminal.svelte`), not something
 * this store should also buffer a second copy of; see
 * {@link RelayClient.onTerminalOutput} for that.
 */
export interface TerminalClientState {
  terminalId: string;
  status: 'opening' | 'open' | 'closed' | 'error';
  /** Set when `status` is `'error'` (the node's `terminal_opened` came back with an error outcome, or this client's own encrypt/send failed) or `'closed'` with `reason: 'error'`. */
  error?: string;
  /** Set when `status` is `'closed'` — why (SPEC §7.5's client-close vs. the shell exiting on its own). */
  closedReason?: string;
  /** Set once `status` is `'open'` — the PTY's real working directory (`terminalOpenOkV1.cwd`, issue #669). Real, never a client-side guess. */
  cwd?: string;
  /** Set once `status` is `'open'`, when the node reported one (`terminalOpenOkV1.shell`) — omitted for an `ssh:` target, which never names its remote login shell ahead of time. */
  shell?: string;
}

/**
 * One in-flight (or exited/errored) test/lint/build run's lifecycle state
 * (SPEC §7.15; issue #244), keyed by `runId` in {@link RelayClient.runsFor}'s
 * returned `Map` — the run counterpart of {@link TerminalClientState}.
 * Deliberately does NOT carry the run's own output (a live, potentially
 * unbounded stream); see {@link RelayClient.onRunOutput} for that.
 */
export interface RunClientState {
  runId: string;
  kind: TestRunnerKindV1;
  status: 'starting' | 'running' | 'exited' | 'error';
  /** Set when `status` is `'error'` (the node's `run_started` came back with an error outcome — e.g. nothing configured for this kind — or this client's own encrypt/send failed). */
  error?: string;
  /** Set when `status` is `'exited'` — the run's terminal state (`@loombox/protocol`'s `RunExitPayloadV1`). */
  outcome?: RunExitOutcomeV1;
  exitCode?: number | null;
  reason?: string;
  cancelled?: boolean;
}

/**
 * One row of the cross-project, cross-node attention inbox (SPEC §7.13;
 * issues #167/#168/#169). `kind` discriminates the four classes SPEC §7.13
 * names:
 * - `'permission'` — a session's actionable FIFO-head permission request.
 * - `'awaiting_input'` — a session whose live status is `awaiting_input`.
 * - `'session_outcome'` — a session whose live status settled to `'exited'`
 *   (finished) or `'error'` (errored); see `outcome`/`stopReason`.
 * - `'ci_failure'` — a session whose watched pull request's latest
 *   `ci_check_status` (`packages/node/src/ci-check-watcher.ts`, issue #239)
 *   aggregates to `'failing'`; see `prUrl`/`prNumber`/`failingChecks`
 *   (issue #243).
 * - `'review_request'` — declared here as an extension point ONLY: SPEC
 *   §7.14 says a review request lands in this same inbox too, but it has
 *   no live event source in this client yet (that needs the tracker
 *   integration work, v2). `RelayClient` never constructs one of these in
 *   v1; it exists in the union (and `AttentionInbox.svelte` already
 *   renders it distinctly) purely so wiring a real source later is
 *   additive, not a rendering/type rework.
 *
 * `'permission'`/`'awaiting_input'`/`'session_outcome'`/`'ci_failure'` are
 * the four "needs the user now" classes this client actually wires to live
 * data. See {@link RelayClient.attentionInbox}'s doc comment for why a
 * session with a queue of several pending requests only ever contributes
 * its head as one item, why a session contributes at most one of
 * `awaiting_input`/`session_outcome` (its live status is one or the other,
 * never both), and why `ci_failure` is independent of both (a session can
 * be idle/finished AND have a failing check on its open PR at once).
 */
export interface AttentionInboxItem {
  readonly kind:
    'permission' | 'awaiting_input' | 'session_outcome' | 'ci_failure' | 'review_request';
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly projectPath: string;
  /** The node the originating session runs on (`ClientSessionMeta.nodeId`) — what makes this inbox cross-*node*, not just cross-project, legible in the row itself. */
  readonly nodeId: string;
  /** Epoch ms this item started waiting — a permission request's `enqueuedAt`, or the session's `session_status` transition time; the inbox's own sort key (oldest first). */
  readonly waitingSince: number;
  /** Set only for a `'permission'` item: the actionable FIFO-head request itself, so a renderer can show/act on it without a second lookup. */
  readonly permission?: PendingPermissionRequest;
  /** Set only for a `'session_outcome'` item: which live status this reflects. */
  readonly outcome?: 'exited' | 'error';
  /** Set for a `'session_outcome'` item when there's extra context for why it stopped: the session's last settled turn's own reason (`TranscriptState.lastStopReason`, SPEC §7.24), or — for one whose agent never got that far — the spawn failure/timeout the node reported instead (`TranscriptState.statusReason`, issue #730). At most one of those two is ever actually set for a given session. */
  readonly stopReason?: string;
  /**
   * Set for a `'permission'` or `'awaiting_input'` item: the agent's most
   * recent message in this session's transcript, so a reply/approval from
   * the inbox has the same context replying from the session itself would
   * (issue #662) — the "answer without being able to read the question"
   * gap. Sourced from the transcript already subscribed for every tracked
   * inbox session (`trackSessionForInbox`), never a second fetch; see
   * `lastAgentMessageText`. Raw text, the same shape
   * `TranscriptMessageItem.text` carries elsewhere — a renderer runs it
   * through the same sanitised `/markdown` pipeline the transcript itself
   * uses, never dumped as plain/raw text (issue #662's scope; the renderer
   * is #671, out of scope here). `undefined` when the agent hasn't said
   * anything in this session yet (e.g. a permission request on its very
   * first turn) — not a stale placeholder.
   */
  readonly agentMessage?: string;
  /** Set only for a `'ci_failure'` item: the failing pull request's own URL and number (`CiCheckStateV1.prUrl`/`.prNumber`), so a renderer can link straight to it rather than only naming the session (issue #243). */
  readonly prUrl?: string;
  readonly prNumber?: number;
  /**
   * Set only for a `'ci_failure'` item: the names of the check runs
   * actually responsible (`CiCheckStateV1.checkRuns`, filtered through
   * `@loombox/shared`'s `isFailingCiConclusion` — the same judgment
   * `NodeDaemon.handleCiCheckFailure`'s auto-iterate hook feeds back to
   * the agent, never a second guess in the browser). Never empty when
   * `kind` is `'ci_failure'`: the node's own aggregate `state` only
   * reaches `'failing'` when at least one check run's conclusion matches
   * that exact set (issue #243).
   */
  readonly failingChecks?: readonly string[];
}

/**
 * A permission-resolution attempt this client discarded because it no
 * longer applies (SPEC §7.3 "a stale approve/deny is discarded with a 'no
 * longer applies' note rather than silently applied"; issue #131). Two
 * paths produce one: (1) this device itself tries to resolve a request a
 * second time (a double-tap, or a click that lands after the card already
 * re-rendered without it); (2) another device resolved the request first —
 * v1's relay never broadcasts `permission_response` to sibling clients (only
 * to the owning node, `packages/relay/src/relay.ts`'s `routeToOwningNode`),
 * so this client learns about it indirectly, the same way the transcript
 * itself would: the tool call's own `tool_call_update` (an ordinary,
 * already-fanned-out `session_update`) moving past `'pending'` is the
 * observable evidence the request was already acted on, wherever that
 * happened — see {@link RelayClient} `discardStalePermissionForToolCall`.
 */
export interface PermissionStaleNotice {
  readonly requestId: string;
  readonly message: string;
  readonly at: number;
}

/**
 * A `config_option` this client sent got `outcome: 'error'` back (SPEC
 * §7.24; issue #718) — carries the agent's own rejection reason
 * (`AcpClient.setConfigOption`'s issue #707 `error.data.details` folding,
 * relayed verbatim through `node-daemon.ts`'s `config_option_result`), so a
 * refusal is visible rather than dying in a console warning. One slot per
 * session, overwritten by the latest attempt, same "latest wins, no queue"
 * shape as {@link PermissionStaleNotice}. `category` lets a consumer
 * showing several independent pickers (SPEC §7.24's model/mode/thinking
 * bar) attribute the notice to the right one.
 */
export interface ConfigOptionErrorNotice {
  readonly category: string;
  readonly message: string;
  readonly at: number;
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

/**
 * The agent's most recent message text in a transcript — backs
 * `AttentionInboxItem.agentMessage` (issue #662). Scans from the end:
 * `TranscriptState.items` is append-only by first appearance (SPEC.md
 * §7.24 "Ordered by first appearance; a coalesced chunk update never
 * changes an item's position"), so a chunk that keeps growing never moves,
 * and the last `'agent_message_chunk'` item in list order is also the most
 * recently started one. Thoughts (`'agent_thought_chunk'`) and the user's
 * own turns (`'user_message_chunk'`) are excluded on purpose — this is
 * specifically what the agent said, not what it was thinking or what
 * prompted it. `undefined` when the agent hasn't said anything yet in this
 * session (e.g. a permission request on its very first turn).
 */
function lastAgentMessageText(items: readonly TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && item.kind === 'agent_message_chunk') return item.text;
  }
  return undefined;
}

export interface RelayClientOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /**
   * This account's Account Master Key (SPEC §8, §16): every session/
   * project/target key this client derives comes from this one 256-bit
   * secret via its key tree — the exact same derivation the node uses, so
   * this client decrypts precisely what the node encrypted.
   * `RelayClient` itself stays storage-agnostic and just takes the bytes; a
   * caller generates/persists it on-device via `amk-store.ts`'s
   * `loadOrCreateAmk` (single-device custody, this wave) rather than typing
   * it in by hand. Multi-device recovery-code escrow/QR pairing (#113/#114/
   * #115) is a later wave, layered on top without changing this option.
   *
   * Handed once to `envelope-crypto-client.ts`'s `createEnvelopeCrypto`
   * (issue #756) — the constructor keeps no `this.amk` field of its own;
   * every derived key and AEAD open/seal for session traffic happens inside
   * that worker/engine, not on this class. See that module's doc comment
   * for exactly what crosses the worker boundary and why.
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
   * Overrides the default `EnvelopeCrypto` (worker-backed in a real
   * browser/Electron, in-process in Node/vitest — see
   * `envelope-crypto-client.ts`'s `createEnvelopeCrypto`). Tests inject a
   * fake to assert on request/response shape without a real `Worker`.
   */
  envelopeCrypto?: EnvelopeCrypto;
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
  /**
   * Delay before the first reconnect attempt after an unexpected socket
   * close (issue #511's "same class of bug" as `@loombox/node`'s
   * `RelayConnection`; see the class docstring). Doubles on each further
   * failure up to `maxBackoffMs`, and resets back to this the moment a
   * handshake actually succeeds again. Defaults to 250ms; tests override
   * it to a few ms to stay fast.
   */
  initialBackoffMs?: number;
  /** Cap on the reconnect delay after repeated failures — see `initialBackoffMs`'s doc comment. Defaults to 10s. */
  maxBackoffMs?: number;
  /**
   * How often (ms) to ping a relay that advertised `HEARTBEAT_CAPABILITY`
   * in its handshake, tearing the socket down (triggering the same
   * reconnect as an unexpected drop) if the previous ping's pong hasn't
   * arrived by the next tick — the only way either peer can tell a
   * half-open socket from a live one (`@loombox/protocol`'s
   * `heartbeat.ts` doc comment). Never armed against a relay that didn't
   * advertise the capability: an older relay drops an unknown frame
   * silently rather than replying, so assuming a reply would kill an
   * otherwise-healthy connection every interval instead of ever detecting
   * anything. Defaults to 30s; tests override it to a few ms to stay fast.
   */
  heartbeatIntervalMs?: number;
  /**
   * How often (ms) to retry `session_resume` for a session this client
   * has never successfully subscribed to yet, until the relay's own
   * `session_announce` reply confirms it landed (issue #730). Needed
   * because a `session_resume` for a session the relay doesn't have a
   * record for yet — the announce-vs-subscribe race a freshly created
   * session's own {@link RelayClient.createSession} lands in — is
   * dropped with no ack at all (`packages/relay/src/relay.ts`'s
   * `session_resume` case), so a single fire-and-forget send can lose
   * the subscription permanently. See {@link RelayClient.ensureSubscribed}'s
   * doc comment for the full mechanism. Defaults to 300ms; tests override
   * it to a few ms to stay fast.
   */
  sessionResumeRetryMs?: number;
}

/** Default for {@link RelayClientOptions.turnIdleMs}. */
const DEFAULT_TURN_IDLE_MS = 1500;
/** Default for {@link RelayClientOptions.initialBackoffMs}. */
const DEFAULT_INITIAL_BACKOFF_MS = 250;
/** Default for {@link RelayClientOptions.maxBackoffMs}. */
const DEFAULT_MAX_BACKOFF_MS = 10_000;
/** Default for {@link RelayClientOptions.heartbeatIntervalMs}. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Default for {@link RelayClientOptions.sessionResumeRetryMs}. */
const DEFAULT_SESSION_RESUME_RETRY_MS = 300;
/** Hard cap on {@link RelayClient.retrySessionResume}'s retry count (issue #730) — bounds how long this client keeps re-sending `session_resume` for a session that never gets announced (an unknown target, a bad decrypt, or a missing MCP grant on `handleSessionCreate` — none of which have a wire-level failure notice yet, see that doc comment) instead of retrying forever. At the default interval this is ~9s, comfortably past a real worktree-creation delay. */
const SESSION_RESUME_MAX_ATTEMPTS = 30;

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

/** The inverse of {@link bytesToBase64} — decodes a terminal_output/terminal_input payload's `data` field back into raw bytes, `Buffer`-free for the same reason. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Flattens the `mcp_server_prompts` catalogue (`@loombox/providers-core`'s
 * `AcpMcpServerPromptsEntry[]`) into `AcpAvailableCommand[]` — one row per
 * declared prompt, attributed to its server via `mcpServer`, with
 * `mcpArguments` carrying the argument schema and `input.hint` a
 * display-only rendering of it (mirrors the `<name1> <name2>` shape an
 * agent-declared command's own hint already uses). `undefined` state
 * (no `mcp_server_prompts` push has arrived yet) and an explicit empty
 * push both flatten to `[]` — {@link RelayClient.mcpPromptCommandsFor}'s
 * own doc comment covers why that distinction doesn't matter to a caller
 * here (there's nothing to render either way).
 */
function flattenMcpServerPrompts(
  servers: AcpMcpServerPromptsEntry[] | undefined,
): AcpAvailableCommand[] {
  if (!servers) return [];
  return servers.flatMap((server) =>
    server.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      input: prompt.arguments?.length
        ? { hint: `<${prompt.arguments.map((arg) => arg.name).join('> <')}>` }
        : undefined,
      mcpServer: server.name,
      mcpArguments: prompt.arguments,
    })),
  );
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

  const socket = new ctor(withRelayWsPath(options.relayUrl));
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

/** Options for {@link RelayClient.createSession}. */
export interface CreateSessionOptions {
  /**
   * Which of the account's targets (SPEC §7.1's "choosing a node, a target")
   * this session runs on — picked from {@link RelayClient.listTargets}'s
   * `TargetListEntry.targetId`. The wire's `session_create` carries no
   * separate `nodeId` field; the relay itself resolves `targetId` to its
   * owning node (`packages/relay/src/relay.ts`'s `session_create` case), so
   * this is the only routing input this method needs.
   */
  targetId: string;
  /** SPEC §7.1's provider choice (Claude Code/Codex) — sent verbatim; the node decides how to interpret it. v1 scope only ever wires up `'claude'` (the locked v1 decision), but this method itself stays provider-agnostic. */
  provider: string;
  /** The project folder this session opens in (SPEC §7.1) — travels only inside the encrypted `privateEnvelope` below, never in the clear (SPEC §8's metadata boundary). */
  projectPath: string;
  /**
   * SPEC §7.1's per-session choice: `true` isolates the agent in a fresh git
   * worktree under `<projectPath>/.loombox/worktrees/`, `false` runs it
   * directly in `projectPath`. Travels inside the private envelope alongside
   * `projectPath`, so the relay never learns which one was picked.
   *
   * Omit it to leave the decision to the node's per-target default (`local`
   * isolates, `ssh:` works in place) — which is what every caller did before
   * the field existed. Only meaningful when the folder is a git repo; a UI
   * should offer the choice only on a confirmed `gitRepo` from
   * {@link RelayClient.browseDirectory}.
   */
  worktree?: boolean;
  /** This session's display title (SPEC §7.24's session list). Defaults to `projectPath` itself when omitted — unlike `NodeDaemon.createSession`'s own node-direct API, the relay's `session_create` handler uses this title verbatim with no server-side default. */
  title?: string;
  /** Overrides the generated session id — an escape hatch for a test asserting a fixed id; real callers should omit this and let this method generate one. */
  sessionId?: string;
  /**
   * D1-3's per-project custom ACP agent (`docs/superpowers/specs/
   * 2026-08-05-zed-parity-decisions.md` §4; issue #748): a client-defined
   * binary/args/env, sealed into the SAME private envelope as
   * `title`/`projectPath` — never in the clear `provider` field — and
   * opened by the owning node under the session's derived key exactly
   * like every other piece of session-private metadata. Convention
   * (`@loombox/protocol`'s `sessionPrivateMetaV1.customAgent` doc
   * comment): pair this with `provider: 'custom'` so a human reading the
   * clear routing metadata can tell a custom-agent session apart from a
   * catalogue one — the node itself gates on this field's mere presence,
   * never on the `provider` string.
   *
   * This is convenience only, never a trust decision made here: the node
   * alone decides whether `customAgent.command` may actually run, against
   * its own local allowlist (`@loombox/node`'s `custom-agent.ts`) — a
   * disallowed command still seals and sends cleanly, and is refused later
   * with a `session_status: 'error'` whose `reason` names the allowlist
   * (`RelayClient`'s `transcriptFor`/`sessions` stores surface it exactly
   * like any other session error).
   */
  customAgent?: CustomAgentRecordV1;
  /**
   * This project's declared env-var injection for the spawned agent
   * process itself (SPEC §7.17, §8; issue #258) — `apps/web`'s
   * `project-env-store.ts`'s `localStorage` list for `projectPath`, at
   * the moment of creation. Travels inside the SAME private envelope as
   * `title`/`projectPath`/`customAgent` — never in the clear — and never
   * carries a secret *value*, only a secret *name* reference
   * (`ProjectEnvVarDecl`'s `{ secret }` arm); resolving that into a
   * value stays exclusively node-side (SPEC §7.17), unchanged and
   * unweakened by this field's existence. Omitted or `[]` (an older
   * client, or a project with nothing declared) behaves exactly like
   * before this field existed: no extra env is injected.
   */
  projectEnvDecls?: ProjectEnvVarDecl[];
  /**
   * This client's own per-project, currently-enabled MCP server
   * declarations (issue #750, D2-2; #794) — `apps/web`'s
   * `mcp-server-store.ts`'s `localStorage` list for `projectPath`, at the
   * moment of creation, in the plain `McpServerConfig[]` shape
   * `effectiveMcpServerConfigs` returns. Travels inside the SAME private
   * envelope as `title`/`projectPath`/`customAgent` — never in the clear
   * — and never carries a secret *value*, only a secret *name* reference
   * (`McpServerVarDecl`'s `{ secret }` arm); resolving that into a value
   * stays exclusively node-side (SPEC §7.17), unchanged and unweakened by
   * this field's existence.
   *
   * The owning node's `NodeDaemon.resolveMcpServers` merges this list
   * with its OWN `McpConfigStore` (global + project) — its own record
   * always wins a same-name collision — into the one effective server set
   * the session's agent actually receives (`mergeMcpServerConfigLists`'s
   * own doc comment). Omitted or `[]` (an older client, or a project with
   * nothing declared) behaves exactly like before this field existed:
   * only the node's own store is consulted.
   */
  mcpServerConfigs?: McpServerConfig[];
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
 * `configOptionsFor` below just reads that field), its `commands`
 * catalogue (issue #741, `commandsFor` below just reads that field), and
 * `turnActive`/`lastStopReason` (issue #128) — one reduced state per
 * session, not several parallel stores that could drift out of sync.
 * `sendPrompt` seals the composer's text into a `prompt_inject`
 * envelope and, since the relay never echoes it back, optimistically reduces
 * the user's own turn into the local transcript so it shows immediately —
 * unless a turn is already considered in flight for that session, or there
 * is no open connection, in which case it queues locally and persists to
 * the IndexedDB-backed offline outbox instead (SPEC §7.3, §7.24; issues
 * #128/#130), flushed in order once the turn settles or the connection
 * comes back. An unexpected socket close now schedules a reconnect with
 * capped exponential backoff automatically (`initialBackoffMs`/
 * `maxBackoffMs`), mirroring `@loombox/node`'s `RelayConnection` fix for
 * the identical bug (issue #511): the desktop app (`apps/desktop`,
 * Electron) stays open for days, so a routine relay redeploy used to
 * leave it permanently dead while the header chip's `'closed'` state kept
 * claiming "Reconnecting…" — a label this client had never actually
 * earned. `close()` stays a deliberate, non-retrying user action; every
 * successful (re)connect, automatic or not, still drives
 * `retryFailedAttachmentsOnReconnect`/`flushOutboxOnReconnect` exactly as
 * a manual one would. Once open, and only if the relay's handshake
 * advertised `HEARTBEAT_CAPABILITY`, this client also pings it
 * (`heartbeatIntervalMs`) and reconnects if a pong is ever missing by the
 * following tick, so a half-open socket can't look healthy forever
 * (`@loombox/protocol`'s `heartbeat.ts` doc comment).
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
  /**
   * How many sessions the most recent `session_list` snapshot carried that
   * this device's AMK failed to decrypt (issue #384's "mismatched-AMK
   * failure" state) — reset to the new count on every fresh snapshot, not
   * accumulated across them. `handleSessionList` already dropped those
   * entries silently (a `console.warn` and nothing else) before this store
   * existed; a UI now has something to distinguish "this account genuinely
   * has zero sessions" from "this device's key can't read the sessions that
   * exist" (both render as an empty {@link sessions} list otherwise) without
   * this class throwing or guessing at *why* a decrypt failed.
   */
  readonly sessionDecryptFailures: Readable<number>;
  /** SPEC §7.26's connected-accounts registry (issue #221; the connect/pin/disconnect write path is issue #230) — every `ConnectedAccount` synced under this account, across every node. Requested once alongside `session_list_request` on every fresh `attemptOpen()` (including a reconnect); a full-replace snapshot, never a delta — see {@link handleConnectedAccountList}. Call {@link refreshConnectedAccounts} to re-request it (e.g. right after a connect/disconnect this client itself drove). */
  readonly connectedAccounts: Readable<ConnectedAccount[]>;
  /**
   * Zed-parity F3-3, issue #760: this account's user-editable keymap —
   * `{}` (nothing remapped) until the first `keymap_result` lands. Fetched
   * proactively on every fresh `attemptOpen()` (including a reconnect),
   * alongside `session_list_request`/`connected_account_list_request`, so
   * a brand-new device sees it from first paint. Also updated live
   * whenever ANY tab/device on this account saves a change — see
   * {@link handleKeymapResult}'s own doc comment for why this is a
   * stronger guarantee than {@link connectedAccounts}'s "re-request it
   * yourself" contract. `+page.svelte` threads this straight into
   * `effectiveShortcut`/`matchShortcut`'s `overrides` param, so a remap
   * takes effect the instant this store updates — no reload, and no
   * separate "apply" step.
   */
  readonly keymap: Readable<KeymapV1>;
  /**
   * This RELAY's own build identity (issue #655), from the most recent
   * `initialize_result` — "what is actually being served", the baseline a
   * node's row compares its own `TargetListEntry.build` against
   * (`SettingsPage`/`TargetStatusView`'s `relayBuildIdentity` prop reads
   * this directly). `undefined` before the first successful handshake, and
   * for a relay build that predates #655 (the field is additive/optional
   * on the wire) — either way, "unknown" never gets rendered as "behind".
   */
  readonly relayBuildIdentity: Readable<BuildIdentityV1 | undefined>;

  private readonly options: RelayClientOptions;
  /** Owns all AMK-derived key material and every session-traffic AEAD open/seal (issue #756) — see `envelope-crypto-client.ts`'s `EnvelopeCrypto`. This class keeps no raw AMK of its own. */
  private readonly envelopeCrypto: EnvelopeCrypto;
  private readonly accountId: string;
  private readonly authToken: string;
  private readonly deviceId: string;
  private readonly devicePublicKey: string;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly statusStore: Writable<ConnectionStatus>;
  private readonly sessionsStore: Writable<ClientSessionMeta[]>;
  private readonly sessionDecryptFailuresStore: Writable<number> = writable(0);
  private readonly connectedAccountsStore: Writable<ConnectedAccount[]> = writable([]);
  private readonly keymapStore: Writable<KeymapV1> = writable({});
  private readonly relayBuildIdentityStore: Writable<BuildIdentityV1 | undefined> =
    writable(undefined);
  /** requestId -> the pending `startGithubConnect` call it belongs to (SPEC §7.26, issue #230). `github_connect_device_code` streams once via `onDeviceCode` (kept in the map, not deleted — the terminal `github_connect_result` is what settles and removes it), mirroring `pendingProvisionRequests`' `onProgress`/final-result split. Plain fields only (no envelope), so like `pendingSshDiscoveryRequests` this resolves a Promise directly. */
  private readonly pendingGithubConnectRequests = new Map<
    string,
    {
      onDeviceCode?: (info: GithubConnectDeviceCode) => void;
      resolve: (outcome: GithubConnectOutcome) => void;
      reject: (error: Error) => void;
    }
  >();
  /** requestId -> the pending {@link getKeymap}/{@link setKeymap} call it belongs to (issue #760). Resolved/rejected by {@link handleKeymapResult}, which — unlike this pattern elsewhere in this class — ALSO applies the payload to {@link keymapStore} even when no pending entry matches, since a `keymap_result` this class never asked for is exactly the "another tab/device just saved a change" push (see that method's own doc comment). */
  private readonly pendingKeymapRequests = new Map<
    string,
    { resolve: (keymap: KeymapV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending `connectJiraAccount` call it belongs to (SPEC §7.26, issue #230) — one round trip, no progress step. */
  private readonly pendingJiraConnectRequests = new Map<
    string,
    { resolve: (outcome: JiraConnectOutcome) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending `disconnectAccount` call it belongs to (SPEC §7.26, issue #230). */
  private readonly pendingDisconnectRequests = new Map<
    string,
    {
      resolve: (response: ConnectedAccountDisconnectResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  /** requestId -> the pending `getAccountPins`/`setAccountPin`/`unsetAccountPin` call it belongs to (SPEC §7.26/#227, issue #230) — all three share `account_pin_response`'s shape, so one map covers all three, mirroring `packages/relay/src/relay.ts`'s own `pendingAccountRequests` consolidation for the node-facing side of this same surface. */
  private readonly pendingAccountPinRequests = new Map<
    string,
    { resolve: (pins: AccountPinMapV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending `resolveAccountPin` call it belongs to (SPEC §7.26/#227, issue #230). */
  private readonly pendingAccountPinResolveRequests = new Map<
    string,
    { resolve: (outcome: AccountPinResolveOutcome) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending `getTrackerMode`/`setTrackerMode` call it belongs to (SPEC §7.10, issue #631) — both share `tracker_mode_response`'s shape, mirroring `pendingAccountPinRequests`'s own consolidation immediately above (and `packages/relay/src/relay.ts`'s `pendingAccountRequests`, which routes this alongside the account-pin messages on purpose). */
  private readonly pendingTrackerModeRequests = new Map<
    string,
    { resolve: (mode: TrackerMode | undefined) => void; reject: (error: Error) => void }
  >();
  private readonly transcripts = new Map<string, Writable<TranscriptState>>();
  private readonly permissionQueues = new Map<string, Writable<PermissionQueueState>>();
  /** Backs {@link staleNoticeFor} (issue #131) — one slot per session, overwritten by the latest stale attempt/discard. */
  private readonly staleNotices = new Map<string, Writable<PermissionStaleNotice | undefined>>();
  /** Backs {@link configOptionErrorFor} (issue #718) — one slot per session, overwritten by the latest rejected `config_option`, same shape as {@link staleNotices}. */
  private readonly configOptionErrors = new Map<
    string,
    Writable<ConfigOptionErrorNotice | undefined>
  >();
  /** Categories with an outstanding `config_option` this client itself sent, per session (issue #718) — {@link handleConfigOptionResult}'s "is this reply to my own request" guard, the `category`-keyed counterpart of {@link pendingFsListRequests}'s `requestId`-keyed one (`config_option` carries no request id — see that schema's own doc comment for why category alone is the correlation key). */
  private readonly pendingConfigOptions = new Map<string, Set<string>>();
  private readonly subscribed = new Set<string>();
  /** Backs {@link retrySessionResume}'s pending retry timer, one per session currently mid-retry (issue #730) — cleared the moment `handleSessionAnnounce` acks the subscribe, or on {@link close}. */
  private readonly pendingSessionResumeRetries = new Map<string, TimerHandle>();
  /**
   * The highest `session_update.seq` this client has applied to a
   * session's transcript so far, per session (issue #729) — the resync
   * high-water mark: every `resync_request` this client sends (first
   * subscribe and every reconnect alike, see {@link acknowledgeSessionResume})
   * uses this as `sinceSeq`, so a reconnect only ever asks the relay to
   * replay what happened after the last thing this client instance
   * actually applied, never the whole ring again. Absent (falls back to
   * `0`, "everything") until this session's first `session_update` is
   * applied.
   */
  private readonly lastAppliedSeqBySession = new Map<string, number>();
  /**
   * Every `session_update.seq` already applied to a session's transcript
   * this client instance, per session (issue #729) — the live/replay
   * dedupe guard. A reconnect's `resync_request` reply and this
   * connection's own live fan-out can both deliver the identical `seq`
   * once `session_resume` re-subscribes this connection before the
   * resync round trip completes (`relay.ts`'s `subscribeClientToSession`
   * runs, and live fan-out starts, before the reply is even sent) —
   * {@link handleSessionUpdate} checks membership here before ever
   * running the reducer, so whichever delivery (live or replayed) arrives
   * first wins and the second is a no-op, regardless of which one that
   * is or how their async decrypts happen to resolve. Unbounded, same
   * tradeoff `TranscriptState.items` itself already accepts (issue #755's
   * windowing keeps that cheap to RENDER, not to hold, in memory) — a
   * `seq` is a plain number, orders of magnitude cheaper per entry than
   * the transcript item it guards.
   */
  private readonly appliedSeqsBySession = new Map<string, Set<number>>();
  /**
   * Per-session promise chain backing {@link handleSessionUpdate}'s
   * strict receipt-order application (issue #729) — never awaited by
   * anything outside that method and {@link processSessionUpdate}; a
   * settled (or never-created) entry is equivalent to `Promise.resolve()`.
   */
  private readonly sessionUpdateQueue = new Map<string, Promise<void>>();
  /**
   * Bumped on every successful handshake — first connect and every
   * reconnect alike (issue #729; incremented right where
   * `statusStore.set('open')` is, the same "a real handshake, not just a
   * transport-level 'open'" moment {@link resubscribeSessionsOnReconnect}
   * already keys off). Backs {@link resyncedConnectionGenerationBySession}:
   * "resync on reconnect" means once per (session, connection), not once
   * per `session_announce` — a session's FIRST subscribe can rack up
   * several announces in quick succession (its own retry loop keeps
   * resending `session_resume` every `sessionResumeRetryMs` until one
   * lands, and more than one attempt can land before the client
   * processes the first reply) all on the SAME still-open connection;
   * resyncing on every one of those needlessly multiplies concurrent
   * decrypt races for the identical content instead of the one genuine
   * race issue #729 exists to close.
   */
  private connectionGeneration = 0;
  /**
   * The {@link connectionGeneration} a session was last resynced under —
   * see that field's doc comment. Read/written only by
   * {@link acknowledgeSessionResume}.
   */
  private readonly resyncedConnectionGenerationBySession = new Map<string, number>();
  /** Backs {@link attentionInbox} — see that method's doc comment. */
  private readonly attentionInboxStore: Writable<AttentionInboxItem[]> = writable([]);
  /** True once {@link attentionInbox} has been called at least once (it is lazily activated, like every other per-session subscription in this class). */
  private inboxTrackingActive = false;
  /** Sessions already wired to recompute the inbox on their own transcript/permission-queue changes — see {@link trackSessionForInbox}. */
  private readonly inboxTrackedSessions = new Set<string>();
  /** `sessionId` -> this session's latest known CI check state (SPEC §7.14; issue #243) — backs the attention inbox's `'ci_failure'` class (see {@link recomputeAttentionInbox}), populated by {@link handleCiCheckStatus}. `undefined` (no entry yet) until the node's first `ci_check_status` push for a session arrives: a session with no open PR, or one whose PR hasn't reported yet. */
  private readonly ciCheckStatuses = new Map<string, Writable<CiCheckStateV1 | undefined>>();
  private readonly attachments = new Map<string, Writable<ComposerAttachment[]>>();
  /** Keyed by attachment id (globally unique, `generateId('att')`), not per-session — an id is only ever used within the one session it was attached to. */
  private readonly attachmentBytesById = new Map<string, CachedAttachment>();
  /** The composer outbox's persistence (issues #128/#130); see `RelayClientOptions.outboxStorage`'s doc comment. */
  private readonly outboxStorage: OutboxStorage;
  private readonly turnIdleMs: number;
  /** A session's currently queued-but-not-yet-flushed prompts, oldest first (issues #128/#130). */
  private readonly queuedPrompts = new Map<string, Writable<QueuedPrompt[]>>();
  /** Backs {@link fileTreeFor} (SPEC §7.4; issue #171) — one reactive `Map<path, FileTreeDirectoryState>` per session. */
  private readonly fileTrees = new Map<string, Writable<Map<string, FileTreeDirectoryState>>>();
  /**
   * requestId -> the session/path an in-flight `fs_list_request` this client
   * itself sent is about (issue #171). `fs_list_response` is fanned out to
   * every client subscribed to the session (mirrors `permission_request`/
   * `blob_ref`, `packages/relay/src/relay.ts`'s `fanOutDirect`), so this map
   * is also this client's filter for "is this reply actually to one of MY
   * pending requests" — a sibling device's own in-flight request for the
   * same session is simply not a key here and is ignored.
   */
  private readonly pendingFsListRequests = new Map<string, { sessionId: string; path: string }>();
  /** requestId -> the pending {@link getMcpPromptText} call it belongs to (Zed-parity D5-2; issue #754) — resolves a `Promise` directly, same shape as {@link pendingTrackerWriteRequests}: a caller (the composer's submit path) needs the rendered text directly to decide what to send, not a reactive store update. */
  private readonly pendingMcpPromptRequests = new Map<
    string,
    { sessionId: string; resolve: (text: string) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link readFile} call it belongs to (issue
   * #737's read-only file viewer). Unlike {@link pendingFsListRequests}
   * this resolves a `Promise` directly rather than feeding a reactive
   * store — a one-shot open, not an always-on subscription (mirrors
   * {@link pendingTrackerWriteRequests}'s same shape, for the same
   * "caller needs the outcome directly" reason). `fs_read_response` is
   * still fanned out to every client subscribed to the session, so a
   * requestId not in this map means the reply belongs to a sibling
   * device's own request, not this one — ignored exactly like
   * {@link handleFsListResponse}'s sibling-device awareness.
   */
  private readonly pendingFsReadRequests = new Map<
    string,
    { resolve: (payload: FsReadResponsePayloadV1) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link requestWorktreeDiff} call it belongs
   * to (issue #206's working-tree diff viewer) — the exact same shape as
   * {@link pendingFsReadRequests} above, for the same "caller needs the
   * outcome directly, one-shot, not an always-on subscription" reason.
   * `git_diff_response` is fanned out the same way, so a requestId not in
   * this map means the reply belongs to a sibling device's own request.
   */
  private readonly pendingGitDiffRequests = new Map<
    string,
    { resolve: (payload: GitDiffResponsePayloadV1) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link requestGitHunkDiff} call it belongs
   * to (issue #232's hunk-level staging) — the exact same shape as
   * {@link pendingGitDiffRequests} above, for the same "caller needs the
   * outcome directly, one-shot, not an always-on subscription" reason.
   * `git_hunk_diff_response` is fanned out the same way, so a requestId
   * not in this map means the reply belongs to a sibling device's own
   * request.
   */
  private readonly pendingGitHunkDiffRequests = new Map<
    string,
    { resolve: (payload: GitHunkDiffResponsePayloadV1) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link applyGitHunkAction} call it belongs
   * to (issue #232) — the exact same shape as {@link
   * pendingFsReadRequests} above (enveloped, one-shot, resolves a
   * `Promise` directly). `git_hunk_action_response` is fanned out the
   * same way, so a requestId not in this map means the reply belongs to
   * a sibling device's own request.
   */
  private readonly pendingGitHunkActionRequests = new Map<
    string,
    {
      resolve: (payload: GitHunkActionResponsePayloadV1) => void;
      reject: (error: Error) => void;
    }
  >();
  /** Backs {@link trackerSnapshotFor} (SPEC §7.10; issue #212, #697) — one reactive `TrackerSnapshotState` per project (`projectPath`), not per session: a project's tracker outlives any one session that reads it. */
  private readonly trackerSnapshots = new Map<string, Writable<TrackerSnapshotState>>();
  /** Projects {@link trackerSnapshotFor} has already sent an initial `tracker_snapshot_request` for — mirrors `fileTreeFor`'s own `get(store).has('')` lazy-load-once check, without needing to inspect the store's current value to tell "never requested" apart from "requested and still loading". Keyed by `projectPath` (issue #697): two sessions bound to the same project now share one load instead of each firing (and racing) their own. */
  private readonly trackerSnapshotsRequested = new Set<string>();
  /** requestId -> the project an in-flight `tracker_snapshot_request` this client itself sent is about (issue #212, #697). `tracker_snapshot_response` is routed directly back to the requesting client alone (SPEC §7.10, issue #697 — `nodeId` addresses exactly one node and the relay answers exactly the requester, unlike the old session-fanned `fs_list_response`), so this map exists to decrypt under the right project key and to guard against a stray/duplicate reply arriving after this client's own timeout already cleaned the entry up — the same guard `pendingTargetFsListRequests` documents. */
  private readonly pendingTrackerSnapshotRequests = new Map<string, { projectPath: string }>();
  /** Backs {@link spendReportFor} (SPEC §7.9; issue #249) — one reactive `SpendReportState` per project (`projectPath`), mirroring {@link trackerSnapshots} exactly (same project-not-session addressing, same reason). */
  private readonly spendReports = new Map<string, Writable<SpendReportState>>();
  /** Projects {@link spendReportFor} has already sent an initial `spend_report_request` for — mirrors {@link trackerSnapshotsRequested}'s own lazy-load-once check. */
  private readonly spendReportsRequested = new Set<string>();
  /** requestId -> the project an in-flight `spend_report_request` this client itself sent is about — mirrors {@link pendingTrackerSnapshotRequests} (decrypts under the right project key, ignores a stray/duplicate reply after this client's own reload already replaced the pending entry). */
  private readonly pendingSpendReportRequests = new Map<string, { projectPath: string }>();
  /** requestId -> the pending {@link createTrackerRecord}/{@link updateTrackerRecord}/{@link defineTrackerType} call it belongs to (issue #212, #697) — resolves a `Promise` directly, exactly like `pendingTargetFsListRequests`, carrying `projectPath` for the same reason (decrypting the response under the right project key). */
  private readonly pendingTrackerWriteRequests = new Map<
    string,
    {
      projectPath: string;
      resolve: (payload: TrackerWriteResponsePayloadV1) => void;
      reject: (error: Error) => void;
    }
  >();
  /** Backs {@link terminalsFor} (SPEC §7.5; issues #172/#173/#174) — one reactive `Map<terminalId, TerminalClientState>` per session. */
  private readonly terminals = new Map<string, Writable<Map<string, TerminalClientState>>>();
  /** requestId -> the session/terminal an in-flight `terminal_open` this client itself sent is about — the terminal counterpart of {@link pendingFsListRequests}'s sibling-device-awareness doc comment. */
  private readonly pendingTerminalOpens = new Map<
    string,
    { sessionId: string; terminalId: string }
  >();
  /** `${sessionId}:${terminalId}` -> every listener registered via {@link onTerminalOutput}, fired with each decrypted `terminal_output` chunk as it arrives (never buffered here — see {@link TerminalClientState}'s doc comment for why). */
  private readonly terminalOutputListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
  /** Backs {@link runsFor} (SPEC §7.15; issue #244) — one reactive `Map<runId, RunClientState>` per session, mirroring {@link terminals}. */
  private readonly runs = new Map<string, Writable<Map<string, RunClientState>>>();
  /** requestId -> the session/run an in-flight `run_start` this client itself sent is about — the run counterpart of {@link pendingTerminalOpens}. */
  private readonly pendingRunStarts = new Map<string, { sessionId: string; runId: string }>();
  /** `${sessionId}:${runId}` -> every listener registered via {@link onRunOutput}, fired with each decrypted `run_output` chunk as it arrives (never buffered here — see {@link RunClientState}'s doc comment for why). */
  private readonly runOutputListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
  /** requestId -> the pending {@link listTargets} call it belongs to (issue #383). `target_list` carries routing metadata only (no `privateEnvelope`), so unlike `pendingFsListRequests`/`pendingTerminalOpens` this resolves a `Promise` directly rather than feeding a reactive store — one caller, one answer, no decrypt step needed. */
  private readonly pendingTargetListRequests = new Map<
    string,
    { resolve: (targets: TargetListEntry[]) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link provisionTarget} call it belongs to
   * (issue #408's zero-touch add-target wizard). `provision_progress`/
   * `provision_target_result` carry routing metadata only (no
   * `privateEnvelope` — SPEC §8's boundary: no secret ever crosses the
   * relay for this flow, the AMK handoff happens node<->target over SSH),
   * so like {@link pendingTargetListRequests} this resolves a `Promise`
   * directly and streams progress via a plain callback, no decrypt step
   * needed.
   */
  private readonly pendingProvisionRequests = new Map<
    string,
    {
      onProgress?: (progress: ProvisionProgress) => void;
      resolve: (result: ProvisionTargetResult) => void;
      reject: (error: Error) => void;
    }
  >();
  /**
   * requestId -> the pending {@link browseDirectory} call it belongs to
   * (SPEC §7.25's directory picker; issue #474). Like
   * {@link pendingTargetListRequests} this resolves a `Promise` directly
   * (one caller, one answer — the picker calls it again for every path the
   * user navigates to, rather than a reactive stream), but unlike
   * `target_list`, `target_fs_list_response` DOES carry a sealed envelope
   * (SPEC §8's boundary: a directory listing is private metadata), so the
   * entry also carries `targetId` for the eventual reply's `'target'`-keyed decrypt (`this.envelopeCrypto.open('target', targetId, ...)`).
   */
  private readonly pendingTargetFsListRequests = new Map<
    string,
    {
      targetId: string;
      resolve: (payload: TargetFsListResponsePayloadV1) => void;
      reject: (error: Error) => void;
    }
  >();
  /**
   * requestId -> the pending {@link probeCustomAgent} call it belongs to
   * (D1-3, issue #748's provider-availability-probing bullet) — the
   * custom-agent counterpart of {@link pendingTargetFsListRequests} above,
   * same shape and same reason: one caller, one answer, resolved directly
   * rather than through a reactive store, keyed by `targetId` for the
   * eventual reply's `'target'`-keyed decrypt.
   */
  private readonly pendingCustomAgentProbeRequests = new Map<
    string,
    {
      targetId: string;
      resolve: (result: CustomAgentProbeResultV1) => void;
      reject: (error: Error) => void;
    }
  >();
  /**
   * requestId -> the pending {@link getTestRunnerConfig}/{@link setTestRunnerConfig}
   * call it belongs to (SPEC §7.15; issue #245). Both resolve to the same
   * `test_runner_config_result` reply, so they share this one map — like
   * {@link pendingTargetFsListRequests} this resolves a `Promise` directly
   * (one caller, one answer) and decrypts under the session key.
   */
  private readonly pendingTestRunnerConfigRequests = new Map<
    string,
    { resolve: (commands: TestRunnerCommandsV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link detectTestRunnerConfig} call it belongs to (SPEC §7.15; issue #245) — a separate map from {@link pendingTestRunnerConfigRequests} since its reply is `test_runner_config_detected`, not `test_runner_config_result`. */
  private readonly pendingTestRunnerConfigDetectRequests = new Map<
    string,
    { resolve: (suggestions: TestRunnerCommandsV1) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link getPermissionPolicy}/{@link setPermissionPolicy}
   * call it belongs to (SPEC §7.17; issue #751). Both resolve to the same
   * `permission_policy_result` reply, mirrors {@link pendingTestRunnerConfigRequests}
   * immediately above.
   */
  private readonly pendingPermissionPolicyRequests = new Map<
    string,
    { resolve: (policy: PermissionPolicyV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link previewPrOpen} call it belongs to (SPEC §7.14; issue #238) — resolves with the whole outcome union (`'ok'` or `'failure'`) rather than throwing, since a `'failure'` outcome (no commits, gh missing/unauthenticated, ...) is an expected, renderable result, not a transport error; only a timeout/no-connection rejects. */
  private readonly pendingPrOpenPreviewRequests = new Map<
    string,
    { resolve: (result: PrOpenPreviewOutcome) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link openPr} call it belongs to (SPEC §7.14; issue #238) — a separate map from {@link pendingPrOpenPreviewRequests} since its reply is `pr_open_result`, not `pr_open_preview_result`. Same "resolves the outcome union, never throws for a failure outcome" contract. */
  private readonly pendingPrOpenRequests = new Map<
    string,
    { resolve: (result: PrOpenOutcome) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link createCheckpoint} call it belongs to (SPEC §7.20; issue #268/#603). Resolves the whole `checkpoint_result` outcome union (`'ok'` or `'error'`) rather than throwing for an error outcome — same "expected, renderable result" contract {@link pendingPrOpenPreviewRequests} above documents, since a caller needs to distinguish which named `errorType` (e.g. `unsupported_target` for an ssh: session) rather than only free text. */
  private readonly pendingCheckpointCreateRequests = new Map<
    string,
    { resolve: (result: CheckpointResultPayloadV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link listCheckpoints} call it belongs to (SPEC §7.20; issue #268/#603) — a separate map from {@link pendingCheckpointCreateRequests} since its reply is `checkpoint_list_result`, not `checkpoint_result`. Same "resolves the outcome union, never throws for a named error" contract. */
  private readonly pendingCheckpointListRequests = new Map<
    string,
    { resolve: (result: CheckpointListResultPayloadV1) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link previewCheckpointRestore} call it belongs to (SPEC §7.20; issue #268/#603) — a separate map since its reply is `checkpoint_restore_preview_result`. */
  private readonly pendingCheckpointRestorePreviewRequests = new Map<
    string,
    {
      resolve: (result: CheckpointRestorePreviewResultPayloadV1) => void;
      reject: (error: Error) => void;
    }
  >();
  /** requestId -> the pending {@link restoreCheckpoint} call it belongs to (SPEC §7.20; issue #268/#603) — a separate map since its reply is `checkpoint_restore_result`, whose outcome union adds a third `'confirmation_required'` member on top of `'ok'`/`'error'` ({@link CheckpointRestoreResultPayloadV1}). */
  private readonly pendingCheckpointRestoreRequests = new Map<
    string,
    { resolve: (result: CheckpointRestoreResultPayloadV1) => void; reject: (error: Error) => void }
  >();
  /** sessionId -> every listener registered via {@link onPermissionPolicyViolation}, fired with each decrypted `permission_policy_violation` as it arrives (SPEC §7.17; issue #751) — mirrors {@link terminalOutputListeners}, keyed by session alone since a violation isn't scoped to one terminal/run. */
  private readonly permissionPolicyViolationListeners = new Map<
    string,
    Set<(violation: PermissionPolicyViolationPayloadV1) => void>
  >();
  /**
   * requestId -> the pending {@link listAgentProfiles}/{@link saveAgentProfiles}
   * call it belongs to (design spec `2026-08-05-zed-parity-decisions.md`'s
   * D3-4; issue #752). Both resolve to the same `agent_profile_list_result`
   * reply, mirrors {@link pendingPermissionPolicyRequests} immediately above.
   */
  private readonly pendingAgentProfileListRequests = new Map<
    string,
    { resolve: (profiles: AgentProfileV1[]) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the pending {@link getSessionAgentProfile}/{@link setSessionAgentProfile} call it belongs to (issue #752). Both resolve to the same `agent_profile_session_result` reply. */
  private readonly pendingAgentProfileSessionRequests = new Map<
    string,
    { resolve: (profileId: string | null) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link discoverSshHosts} call it belongs to
   * (redesign v2 §3.2's add-target candidate picker; issue #475).
   * `ssh_discovery_response` carries plain fields only (no envelope — see
   * `@loombox/protocol`'s `ssh-discovery.ts` doc comment), so like
   * {@link pendingTargetListRequests} this resolves a `Promise` directly,
   * no decrypt step needed.
   */
  private readonly pendingSshDiscoveryRequests = new Map<
    string,
    { resolve: (result: SshDiscoveryResultV1) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link decommissionTarget} call it belongs to
   * (redesign v2 §3.3's Remove/Edit actions; issue #476).
   * `decommission_target_response` carries plain fields only (no envelope —
   * see `@loombox/protocol`'s `target-lifecycle.ts` doc comment), so like
   * {@link pendingSshDiscoveryRequests} this resolves a `Promise` directly,
   * no decrypt step needed.
   */
  private readonly pendingDecommissionTargetRequests = new Map<
    string,
    { resolve: (response: DecommissionTargetResponse) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link updateTarget} call it belongs to
   * (redesign v2 §3.3's Update action; issue #476) — same shape as
   * {@link pendingDecommissionTargetRequests} and for the same reason.
   */
  private readonly pendingTargetUpdateRequests = new Map<
    string,
    { resolve: (response: TargetUpdateResponse) => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link archiveSession} call it belongs to
   * (SPEC §7.2's board archive affordance; issue #512).
   * `session_archive_response` carries plain fields only (no envelope —
   * see `@loombox/protocol`'s `session-lifecycle.ts` doc comment), so like
   * {@link pendingTargetUpdateRequests} this resolves a `Promise` directly,
   * no decrypt step needed. Unlike every other pending-request map here,
   * an `outcome: 'ok'` response is also published to every OTHER client of
   * the account (`packages/relay/src/relay.ts`'s account-wide fan-out) —
   * {@link handleSessionArchiveResponse} drops the session from
   * {@link sessionsStore} unconditionally on `'ok'`, independent of
   * whether this map has a matching entry; only the pending promise itself
   * is guarded by `requestId`, exactly like every sibling map here.
   */
  private readonly pendingArchiveRequests = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  /**
   * requestId -> the pending {@link forkSession} call it belongs to
   * (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue
   * #746). Same account-wide broadcast shape `session_archive_response`
   * carries (`packages/relay/src/relay.ts`), but a fork's outcome needs no
   * store-wide side effect on `'ok'` — the new session already reaches
   * every device the ordinary way, via `session_announce` — so unlike
   * {@link pendingArchiveRequests} this map's own resolve/reject is the
   * entire job of {@link handleSessionForkResponse}.
   */
  private readonly pendingForkRequests = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  /** A session's pending "turn considered active" idle timer, present only while that session is within `turnIdleMs` of its last known activity (issue #128's mid-turn-queueing heuristic). */
  private readonly turnTimers = new Map<string, TimerHandle>();
  private socket: WebSocketLike | undefined;
  private awaitingInitializeResult = false;
  /**
   * Backing fields for reconnect-with-backoff (issue #511's "same class of
   * bug" as `@loombox/node`'s `RelayConnection`) — `userClosed` is what
   * tells a deliberate `close()` apart from a drop `scheduleReconnect`
   * should retry.
   */
  private reconnectTimer: TimerHandle | undefined;
  private backoffMs: number;
  private userClosed = false;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  /**
   * Backing fields for the heartbeat (issue #511) — `pendingPingNonce` is
   * the nonce of the ping still awaiting its pong, `undefined` once
   * answered or before this connection has sent its first one.
   */
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: TimerHandle | undefined;
  private pendingPingNonce: string | undefined;
  /** See `RelayClientOptions.sessionResumeRetryMs`'s doc comment (issue #730). */
  private readonly sessionResumeRetryMs: number;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.envelopeCrypto =
      options.envelopeCrypto ?? createEnvelopeCrypto(options.amk, options.accountId);
    this.accountId = options.accountId;
    this.authToken = options.authToken ?? options.accountId;
    this.deviceId = options.deviceId ?? generateId('device');
    this.devicePublicKey = options.devicePublicKey ?? randomBase64();
    this.outboxStorage = options.outboxStorage ?? createDefaultOutboxStorage(this.accountId);
    this.turnIdleMs = options.turnIdleMs ?? DEFAULT_TURN_IDLE_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMs = this.initialBackoffMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.sessionResumeRetryMs = options.sessionResumeRetryMs ?? DEFAULT_SESSION_RESUME_RETRY_MS;

    const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    if (!ctor) {
      throw new Error('RelayClient: no global WebSocket available; pass webSocketImpl explicitly');
    }
    this.WebSocketCtor = ctor;

    this.statusStore = writable<ConnectionStatus>('idle');
    this.sessionsStore = writable<ClientSessionMeta[]>([]);
    this.status = this.statusStore;
    this.sessions = this.sessionsStore;
    this.sessionDecryptFailures = this.sessionDecryptFailuresStore;
    this.connectedAccounts = this.connectedAccountsStore;
    this.keymap = this.keymapStore;
    this.relayBuildIdentity = this.relayBuildIdentityStore;

    // Reloads whatever this account's outbox already had persisted (issue
    // #130's "outbox survives a full page reload") — fire-and-forget since
    // the constructor can't be async; `queuedPromptsFor` simply starts empty
    // and fills in once this resolves. Also opportunistically flushes each
    // session it finds, in case `connect()`/the socket is already open by
    // the time this resolves (see `flushOutboxOnReconnect`'s doc comment).
    void this.hydrateOutbox();
  }

  /**
   * Opens the connection (no-op if already connecting/open) and sends
   * `initialize` once open. Also re-arms auto-reconnect if a prior
   * `close()` had disarmed it, and cancels a pending backoff retry so this
   * always dials immediately rather than waiting out whatever delay was
   * in flight.
   */
  connect(): void {
    this.userClosed = false;
    if (this.socket) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.open();
  }

  /**
   * Creates the socket and wires it up; never throws (issue #511, mirrors
   * `@loombox/node`'s `RelayConnection`). A constructor failure is
   * indistinguishable from a socket that opened and immediately died, so
   * it gets the same treatment: surfaced as `'error'` and followed by a
   * scheduled retry, rather than escaping the bare `setTimeout`
   * `scheduleReconnect` runs this in and killing the retry chain for the
   * life of this client.
   */
  private open(): void {
    this.statusStore.set('connecting');
    try {
      this.attemptOpen();
    } catch {
      this.statusStore.set('error');
      this.scheduleReconnect();
    }
  }

  private attemptOpen(): void {
    const socket = new this.WebSocketCtor(withRelayWsPath(this.options.relayUrl));
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
          // A real handshake, not just a transport-level 'open', is what
          // proves the relay is actually reachable and speaking this
          // protocol version — resetting here (rather than on the
          // socket's 'open' event) means a relay that accepts the TCP
          // connection but keeps rejecting the handshake still backs off,
          // instead of hot-looping at `initialBackoffMs` forever.
          this.backoffMs = this.initialBackoffMs;
          this.connectionGeneration += 1;
          this.statusStore.set('open');
          // Issue #655: this relay's own build identity, so a node's row
          // can be compared against "what is actually being served" — set
          // on every successful handshake (including a reconnect against
          // an upgraded/downgraded relay), `undefined` for a relay build
          // that predates the field.
          this.relayBuildIdentityStore.set(result.data.buildIdentity);
          // The account-scoped snapshot (SPEC §8's OAuth-alone listing) —
          // every session already announced by a node this account owns.
          this.send({ type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
          // SPEC §7.26 (issue #221): the account-scoped connected-account
          // snapshot, requested alongside the session list above so a
          // picker renders from the first paint of any fresh connection.
          this.send({ type: 'connected_account_list_request', protocolVersion: PROTOCOL_V1 });
          // Zed-parity F3-3, issue #760: fire-and-forget — nothing awaits
          // this specific `requestId` (not registered in
          // `pendingKeymapRequests`), since {@link handleKeymapResult}
          // applies whatever comes back straight to `keymapStore`
          // regardless of a pending match. This is what lets a brand-new
          // device see the account's saved keymap from first paint, with
          // no explicit `getKeymap()` call anywhere in `+page.svelte`.
          this.send({
            type: 'keymap_get_request',
            protocolVersion: PROTOCOL_V1,
            requestId: generateId('keymap'),
          });
          // Issue #660: a session already `ensureSubscribed` on a prior
          // connection (or subscribed before this very first handshake
          // finished) lost that relay-side subscription the moment its
          // old connection died — resend now, on every fresh 'open', or
          // its live updates silently stop (see this method's own doc
          // comment for the full failure mode).
          this.resubscribeSessionsOnReconnect();
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
          // Issue #511: only a relay that actually advertised the
          // capability answers a ping at all — see
          // `RelayClientOptions.heartbeatIntervalMs`'s doc comment for why
          // arming this unconditionally would be worse than the bug it
          // fixes.
          if (result.data.capabilities.includes(HEARTBEAT_CAPABILITY)) {
            this.startHeartbeat();
          }
        } else {
          // The relay rejects an incompatible/invalid handshake with an
          // `update_required` notice (or an unparseable frame) then closes
          // the socket (#108) — surface it rather than hanging silently.
          // `onSocketGone` below still runs once that close/error arrives
          // and schedules the actual reconnect.
          this.statusStore.set('error');
        }
        return;
      }

      const message = safeParseWireMessageV1(parsed);
      if (!message.success) return;
      if (message.data.type === 'pong') {
        this.handlePong(message.data);
        return;
      }
      this.handleInbound(message.data);
    });

    // A socket is "gone" on whichever of 'close'/'error' arrives, and only
    // the first one counts. This used to live in the 'close' handler
    // alone, on the strength of a comment claiming "'close' always follows
    // 'error'" — true for the browser's WebSocket this client normally
    // runs under, but false for Node's (undici): a *failed connection
    // attempt*, exactly what every retry hits while the relay is down,
    // fires 'error' with no 'close' at all (the four-hour node outage
    // issue #511 was filed for — see `@loombox/node`'s `RelayConnection`,
    // whose `onSocketGone` this mirrors). This client isn't hit by that
    // specific asymmetry today, but Electron and any future undici-backed
    // path are one refactor away from being, so this is wired the same
    // defensive way here rather than trusting a browser-only guarantee.
    let gone = false;
    const onSocketGone = (): void => {
      if (gone) return;
      gone = true;
      this.stopHeartbeat();
      // Only disown the socket if it is still the current one: a late
      // event from a superseded attempt must never clear a newer live
      // socket.
      if (this.socket === socket) this.socket = undefined;
      this.statusStore.set('closed');
      // The connection is gone, so this client has no way left to observe
      // whether a turn it thought was active actually settled — clearing
      // every pending idle timer treats every session as "unknown, assume
      // ready" rather than gating the local queue on a timer that will
      // never fire again. `flushOutboxOnReconnect` re-attempts each session
      // once the socket reopens, so nothing queued is lost, only its
      // in-flight "settled" bookkeeping resets.
      this.clearAllTurnTimers();
      this.scheduleReconnect();
    };
    socket.addEventListener('close', onSocketGone);
    socket.addEventListener('error', onSocketGone);
  }

  /**
   * Schedules a reconnect with capped exponential backoff after an
   * unexpected close — never after a deliberate `close()` (`userClosed`
   * gates it), matching `@loombox/node`'s `RelayConnection` (issue #511).
   */
  private scheduleReconnect(): void {
    if (this.userClosed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.userClosed) this.open();
    }, delay);
  }

  /**
   * Deliberately closes the connection: unlike an unexpected drop, this
   * never schedules a reconnect (and cancels one if a retry was already
   * pending), so a caller that wants back in has to call `connect()`
   * itself — see the class docstring for why an unexpected drop behaves
   * differently.
   */
  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    this.clearPendingSessionResumeRetries();
    this.socket?.close();
    this.socket = undefined;
  }

  /** Cancels every still-pending {@link retrySessionResume} timer (issue #730) — called on {@link close} so a discarded client never keeps retrying into a socket nobody reads from again. */
  private clearPendingSessionResumeRetries(): void {
    for (const timer of this.pendingSessionResumeRetries.values()) clearTimeout(timer);
    this.pendingSessionResumeRetries.clear();
  }

  /** Starts (or restarts) the heartbeat ping/pong-deadline cycle — see `RelayClientOptions.heartbeatIntervalMs`'s doc comment. Only ever called once a relay has proven it supports it. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.heartbeatIntervalMs);
  }

  /**
   * One heartbeat tick: if the previous ping is still unanswered, the
   * relay has had a full interval to reply and hasn't, so this socket is
   * treated as dead and torn down through the same `onSocketGone` handler
   * an actual drop would hit (issue #511) — otherwise sends a fresh ping and
   * remembers its nonce for the next tick to check.
   */
  private heartbeatTick(): void {
    if (this.pendingPingNonce !== undefined) {
      this.socket?.close();
      return;
    }
    const nonce = generateId('ping');
    this.pendingPingNonce = nonce;
    this.send({ type: 'ping', protocolVersion: PROTOCOL_V1, nonce });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.pendingPingNonce = undefined;
  }

  /** Clears the deadline the matching {@link heartbeatTick} armed — a `nonce` mismatch means this is a late reply to an older ping already given up on, not proof the connection is alive right now (`@loombox/protocol`'s `heartbeat.ts` doc comment), so it's left in place. */
  private handlePong(message: Pong): void {
    if (message.nonce === this.pendingPingNonce) {
      this.pendingPingNonce = undefined;
    }
  }

  /**
   * Asks the relay which nodes/targets exist for this account (issue #383),
   * for a session-creation UI to populate — the client-facing counterpart
   * of `target_announce`, which is node-to-relay only. Routing metadata
   * only (`nodeId`/`targetId`/`label`/`kind`/`reachable`), never encrypted:
   * `target_list` carries no `privateEnvelope`, so unlike `sendPrompt`/
   * `fileTreeFor` there is nothing here to decrypt. Requires an open
   * connection and rejects on a timeout, mirroring `escrowAmk`'s "loud
   * rejection over a silently dropped request" — this is a deliberate,
   * one-shot query a caller awaits, not best-effort live session traffic.
   */
  listTargets(timeoutMs = 5000): Promise<TargetListEntry[]> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot list targets, no open connection'));
    }
    const requestId = generateId('targets');
    return new Promise<TargetListEntry[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTargetListRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for target_list'));
      }, timeoutMs);
      this.pendingTargetListRequests.set(requestId, {
        resolve: (targets) => {
          clearTimeout(timer);
          resolve(targets);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ type: 'target_list_request', protocolVersion: PROTOCOL_V1, requestId });
    });
  }

  /**
   * Asks `nodeId` (the account's already-connected node — e.g. one
   * `listTargets()` already reported) to run its own `discoverSshTargets()`
   * (redesign v2 §3.2; issue #475) — the add-target wizard's candidate-card
   * picker's data source for this PWA client, which has no local
   * filesystem/IPC access of its own to autodetect `~/.ssh/config` +
   * ssh-agent from, unlike the desktop app's direct IPC call to the same
   * underlying `@loombox/node` function (`apps/desktop/src/main/
   * ssh-candidates.ts`).
   *
   * Routing metadata only, same boundary as `listTargets`/`provisionTarget`:
   * nothing here is encrypted — an autodetected alias/hostname/username/
   * identity-file path is no more sensitive than `provisionTarget`'s own
   * `host` input (see `@loombox/protocol`'s `ssh-discovery.ts` doc comment).
   * Requires an open connection and rejects on a timeout, mirroring
   * `listTargets`'s "loud rejection over a silently dropped request" — this
   * is a deliberate, one-shot query the wizard awaits before rendering its
   * first step, not best-effort live session traffic.
   */
  discoverSshHosts(nodeId: string, timeoutMs = 10_000): Promise<SshDiscoveryResultV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot discover SSH hosts, no open connection'),
      );
    }
    const requestId = generateId('sshdisco');
    return new Promise<SshDiscoveryResultV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSshDiscoveryRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for ssh_discovery_response'));
      }, timeoutMs);
      this.pendingSshDiscoveryRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId,
        requestId,
      });
    });
  }

  /**
   * Asks `nodeId` to decommission one of its own `ssh:` targets — Remove, or
   * the teardown half of Edit (redesign v2 §3.3; issue #476):
   * `decommissionSshTarget`'s wire-level counterpart. `removeFiles` mirrors
   * `DecommissionOptions.removeFiles`'s own default of `false` — omit it to
   * only stop/disable the remote unit and revoke the target, opt in to also
   * clean up its staged files.
   *
   * Routing metadata only, same boundary as `discoverSshHosts`/`listTargets`:
   * nothing here is encrypted — which systemd steps ran and whether files
   * were removed is no more sensitive than `provisionTargetResult`'s own
   * step-outcome fields. Resolves with the response whether it succeeded or
   * failed (check `.ok`); only REJECTS for a genuinely unusable call: no
   * open connection, or a timeout with no response at all.
   */
  decommissionTarget(
    options: { nodeId: string; targetId: string; removeFiles?: boolean },
    timeoutMs = 30_000,
  ): Promise<DecommissionTargetResponse> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot decommission a target, no open connection'),
      );
    }
    const requestId = generateId('decommission');
    return new Promise<DecommissionTargetResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDecommissionTargetRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for decommission_target_response'));
      }, timeoutMs);
      this.pendingDecommissionTargetRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: options.nodeId,
        targetId: options.targetId,
        requestId,
        ...(options.removeFiles !== undefined ? { removeFiles: options.removeFiles } : {}),
      });
    });
  }

  /**
   * Asks `nodeId` to run the "Update" one-tap action against one of its own
   * `ssh:` targets (redesign v2 §3.3; issue #476) —
   * `TargetUpdateMonitor.updateTarget`'s wire-level counterpart. Same
   * routing-metadata-only boundary and "resolves either way, rejects only
   * when genuinely unusable" contract as {@link decommissionTarget}; a
   * longer default timeout since a real update re-runs supervisor
   * provisioning (fetch + verify + stage an artifact over `ssh:`), not a
   * quick metadata query.
   */
  updateTarget(
    options: { nodeId: string; targetId: string },
    timeoutMs = 300_000,
  ): Promise<TargetUpdateResponse> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot update a target, no open connection'));
    }
    const requestId = generateId('targetupdate');
    return new Promise<TargetUpdateResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTargetUpdateRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for target_update_response'));
      }, timeoutMs);
      this.pendingTargetUpdateRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'target_update_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: options.nodeId,
        targetId: options.targetId,
        requestId,
      });
    });
  }

  /**
   * Re-requests the account-scoped connected-account snapshot (SPEC §7.26,
   * issue #221) — {@link connectedAccounts} is otherwise only refreshed on
   * a fresh `attemptOpen()`/reconnect, so a caller that just drove a
   * connect or disconnect through this same client (issue #230) calls this
   * to see the result reflected in {@link connectedAccounts} without
   * waiting for the next reconnect. A no-op (not an error) with no open
   * connection — the eventual reconnect's own `attemptOpen()` request
   * covers it.
   */
  refreshConnectedAccounts(): void {
    if (!this.isSocketOpen()) return;
    this.send({ type: 'connected_account_list_request', protocolVersion: PROTOCOL_V1 });
  }

  /**
   * Asks `nodeId` to start SPEC §7.26's GitHub device-flow connect (issue
   * #222's flow, reachable here for #230's UI). Unlike every other method
   * in this class, the request is fire-and-forget from the caller's own
   * perspective (the returned `requestId`/`cancel` let the caller abort);
   * `onDeviceCode` fires once, as soon as GitHub issues the code (never a
   * secret — the whole point of the flow), and `result` settles with the
   * flow's terminal outcome, mirroring `provisionTarget`'s own
   * onProgress-then-final-result split. `result` only REJECTS for a
   * genuinely unusable call (no open connection, or a timeout with no
   * terminal result at all) — an outcome the operator can act on (a wrong
   * code, an expired flow, a cancel) resolves with `outcome: 'failure'`,
   * never a rejection. Defaults to 16 minutes, one past GitHub's own
   * device-flow `expires_in` default (15 minutes), so a slow-but-real
   * approval is never cut off client-side either.
   */
  startGithubConnect(
    nodeId: string,
    onDeviceCode: (info: GithubConnectDeviceCode) => void,
    timeoutMs = 16 * 60_000,
  ): { requestId: string; cancel: () => void; result: Promise<GithubConnectOutcome> } {
    if (!this.isSocketOpen()) {
      return {
        requestId: '',
        cancel: () => {},
        result: Promise.reject(
          new Error('RelayClient: cannot connect a GitHub account, no open connection'),
        ),
      };
    }
    const requestId = generateId('githubconnect');
    const result = new Promise<GithubConnectOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGithubConnectRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for github_connect_result'));
      }, timeoutMs);
      this.pendingGithubConnectRequests.set(requestId, {
        onDeviceCode,
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'github_connect_start_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        nodeId,
      });
    });
    return {
      requestId,
      cancel: () => {
        if (!this.isSocketOpen()) return;
        this.send({
          type: 'github_connect_cancel_request',
          protocolVersion: PROTOCOL_V1,
          requestId,
          nodeId,
        });
      },
      result,
    };
  }

  /**
   * Asks `nodeId` to run SPEC §7.26's Jira API-token connect path (issue
   * #225's flow, reachable here for #230's UI) against
   * `{siteUrl, email, apiToken}` the operator just typed. One round trip;
   * resolves with `outcome: 'failure'` for a bad site/credentials (never a
   * rejection — same "an operator-actionable outcome resolves, only a
   * genuinely unusable call rejects" contract as {@link startGithubConnect}).
   */
  connectJiraAccount(
    nodeId: string,
    credentials: { siteUrl: string; email: string; apiToken: string },
    timeoutMs = 20_000,
  ): Promise<JiraConnectOutcome> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot connect a Jira account, no open connection'),
      );
    }
    const requestId = generateId('jiraconnect');
    return new Promise<JiraConnectOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJiraConnectRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for jira_connect_response'));
      }, timeoutMs);
      this.pendingJiraConnectRequests.set(requestId, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'jira_connect_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        nodeId,
        siteUrl: credentials.siteUrl,
        email: credentials.email,
        apiToken: credentials.apiToken,
      });
    });
  }

  /**
   * Asks `nodeId` (the node holding `accountId`'s local secret) to
   * disconnect it (SPEC §7.26, issue #230) — deletes the local keyring
   * entry; on `outcome: 'ok'` the relay also forgets the synced metadata
   * row (`packages/relay/src/relay.ts`'s own
   * `connected_account_disconnect_response` handler), so a caller should
   * follow a successful disconnect with {@link refreshConnectedAccounts}
   * to see it drop out of {@link connectedAccounts}. Does not itself scan
   * for or warn about project pins referencing this account (issue #229's
   * full scan-and-warn) — the caller (this issue's confirm dialog) is
   * responsible for confirming with the operator first, using whatever pin
   * state it already has loaded.
   */
  disconnectAccount(
    nodeId: string,
    accountId: string,
    timeoutMs = 15_000,
  ): Promise<ConnectedAccountDisconnectResponse> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot disconnect an account, no open connection'),
      );
    }
    const requestId = generateId('acctdisc');
    return new Promise<ConnectedAccountDisconnectResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDisconnectRequests.delete(requestId);
        reject(
          new Error('RelayClient: timed out waiting for connected_account_disconnect_response'),
        );
      }, timeoutMs);
      this.pendingDisconnectRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'connected_account_disconnect_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        nodeId,
        accountId,
      });
    });
  }

  /** Asks `nodeId` for `projectPath`'s full per-capability pin map (SPEC §7.26/#227, issue #230) — `AccountPinStore.get`'s wire counterpart. */
  getAccountPins(
    nodeId: string,
    projectPath: string,
    timeoutMs = 10_000,
  ): Promise<AccountPinMapV1> {
    return this.sendAccountPinRequest(
      { type: 'account_pin_get_request', protocolVersion: PROTOCOL_V1, nodeId, projectPath },
      timeoutMs,
    );
  }

  /** Pins `capability` to `accountId` for `projectPath`, or (when `accountId` is `null`) records an explicit opt-out (SPEC §7.26/#227, issue #230) — `AccountPinStore.setPin`'s wire counterpart. Resolves with the resulting full pin map. */
  setAccountPin(
    nodeId: string,
    projectPath: string,
    capability: string,
    accountId: string | null,
    timeoutMs = 10_000,
  ): Promise<AccountPinMapV1> {
    return this.sendAccountPinRequest(
      {
        type: 'account_pin_set_request',
        protocolVersion: PROTOCOL_V1,
        nodeId,
        projectPath,
        capability,
        accountId,
      },
      timeoutMs,
    );
  }

  /** Reverts `capability` to unconfigured for `projectPath` (SPEC §7.26/#227, issue #230) — `AccountPinStore.unsetPin`'s wire counterpart, distinct from {@link setAccountPin}'s explicit-`null` opt-out. Resolves with the resulting full pin map. */
  unsetAccountPin(
    nodeId: string,
    projectPath: string,
    capability: string,
    timeoutMs = 10_000,
  ): Promise<AccountPinMapV1> {
    return this.sendAccountPinRequest(
      {
        type: 'account_pin_unset_request',
        protocolVersion: PROTOCOL_V1,
        nodeId,
        projectPath,
        capability,
      },
      timeoutMs,
    );
  }

  /** Shared plumbing for {@link getAccountPins}/{@link setAccountPin}/{@link unsetAccountPin} — all three reply with the same `account_pin_response` shape (SPEC §7.26/#227, issue #230). */
  private sendAccountPinRequest(
    message:
      | { type: 'account_pin_get_request'; protocolVersion: 1; nodeId: string; projectPath: string }
      | {
          type: 'account_pin_set_request';
          protocolVersion: 1;
          nodeId: string;
          projectPath: string;
          capability: string;
          accountId: string | null;
        }
      | {
          type: 'account_pin_unset_request';
          protocolVersion: 1;
          nodeId: string;
          projectPath: string;
          capability: string;
        },
    timeoutMs: number,
  ): Promise<AccountPinMapV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error(`RelayClient: cannot send ${message.type}, no open connection`),
      );
    }
    const requestId = generateId('acctpin');
    return new Promise<AccountPinMapV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAccountPinRequests.delete(requestId);
        reject(
          new Error(`RelayClient: timed out waiting for account_pin_response (${message.type})`),
        );
      }, timeoutMs);
      this.pendingAccountPinRequests.set(requestId, {
        resolve: (pins) => {
          clearTimeout(timer);
          resolve(pins);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...message, requestId });
    });
  }

  /**
   * Asks `nodeId` for `projectPath`'s saved `TrackerMode` (SPEC §7.10;
   * issue #631) — `TrackerModeStore.get`'s wire counterpart. Resolves with
   * `undefined` for a project that has never had one chosen (or whose
   * stored value no longer validates on the node); never coerced into
   * `{kind:'native'}` here either — see `tracker.ts`'s `trackerModeResponse`
   * doc comment for why that distinction is load-bearing all the way
   * through this client.
   */
  getTrackerMode(
    nodeId: string,
    projectPath: string,
    timeoutMs = 10_000,
  ): Promise<TrackerMode | undefined> {
    return this.sendTrackerModeRequest(
      { type: 'tracker_mode_get_request', protocolVersion: PROTOCOL_V1, nodeId, projectPath },
      timeoutMs,
    );
  }

  /** Saves `mode` for `projectPath` on `nodeId` (SPEC §7.10; issue #631) — `TrackerModeStore.set`'s wire counterpart. There is deliberately no unset (mirrors `trackerModeSetRequest`'s own doc comment). Resolves with the resulting mode so the caller never needs a second round trip. */
  setTrackerMode(
    nodeId: string,
    projectPath: string,
    mode: TrackerMode,
    timeoutMs = 10_000,
  ): Promise<TrackerMode | undefined> {
    return this.sendTrackerModeRequest(
      { type: 'tracker_mode_set_request', protocolVersion: PROTOCOL_V1, nodeId, projectPath, mode },
      timeoutMs,
    );
  }

  /** Shared plumbing for {@link getTrackerMode}/{@link setTrackerMode} — both reply with the same `tracker_mode_response` shape (SPEC §7.10, issue #631), mirroring {@link sendAccountPinRequest} immediately above. */
  private sendTrackerModeRequest(
    message:
      | {
          type: 'tracker_mode_get_request';
          protocolVersion: 1;
          nodeId: string;
          projectPath: string;
        }
      | {
          type: 'tracker_mode_set_request';
          protocolVersion: 1;
          nodeId: string;
          projectPath: string;
          mode: TrackerMode;
        },
    timeoutMs: number,
  ): Promise<TrackerMode | undefined> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error(`RelayClient: cannot send ${message.type}, no open connection`),
      );
    }
    const requestId = generateId('trackermode');
    return new Promise<TrackerMode | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTrackerModeRequests.delete(requestId);
        reject(
          new Error(`RelayClient: timed out waiting for tracker_mode_response (${message.type})`),
        );
      }, timeoutMs);
      this.pendingTrackerModeRequests.set(requestId, {
        resolve: (mode) => {
          clearTimeout(timer);
          resolve(mode);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...message, requestId });
    });
  }

  /**
   * Asks `nodeId` to preview what `capability` currently resolves to for
   * `projectPath` (SPEC §7.26/#227, issue #230's pin picker) — never
   * performs the write-back action itself, just runs the same
   * `resolveAccountForRead`/`resolveAccountForWrite` a real write-back
   * would, so the picker can render `AccountPinRequiredError`/
   * `AmbiguousAccountError`/`AccountHostMismatchError`/
   * `AccountPinDanglingError`/`AccountPinMalformedError` as real states
   * rather than guessing. `accounts` is normally the caller's own
   * `get(client.connectedAccounts)` snapshot — see `@loombox/protocol`'s
   * `account_pin_resolve_request` doc comment for why this node has no
   * independent copy of that list to consult instead.
   */
  resolveAccountPin(
    nodeId: string,
    params: {
      projectPath: string;
      capability: string;
      mode: 'read' | 'write';
      target: { provider: string; host: string };
      accounts: ConnectedAccount[];
    },
    timeoutMs = 10_000,
  ): Promise<AccountPinResolveOutcome> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot resolve an account pin, no open connection'),
      );
    }
    const requestId = generateId('acctpinresolve');
    return new Promise<AccountPinResolveOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAccountPinResolveRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for account_pin_resolve_response'));
      }, timeoutMs);
      this.pendingAccountPinResolveRequests.set(requestId, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'account_pin_resolve_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        nodeId,
        projectPath: params.projectPath,
        capability: params.capability,
        mode: params.mode,
        target: params.target,
        accounts: params.accounts,
      });
    });
  }

  /**
   * Archives one of this account's sessions (SPEC §7.2's board archive
   * affordance; issue #512) — the row-menu "Archive session…" action.
   * Routing metadata only, same boundary as `decommissionTarget`/
   * `updateTarget` above: nothing here is encrypted (`@loombox/protocol`'s
   * `session-lifecycle.ts` doc comment — `sessionId` already travels in
   * the clear). Unlike those two, this REJECTS on a node-reported failure
   * too (`outcome: 'error'`), not just a transport-level one — there is no
   * `.ok`/`.message` shape for a caller to inspect here, since a failed
   * archive is nothing to react to beyond surfacing the message.
   */
  archiveSession(
    sessionId: string,
    options: { removeWorktree: boolean },
    timeoutMs = 30_000,
  ): Promise<void> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot archive a session, no open connection'));
    }
    const requestId = generateId('archive');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingArchiveRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for session_archive_response'));
      }, timeoutMs);
      this.pendingArchiveRequests.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        sessionId,
        removeWorktree: options.removeWorktree,
      });
    });
  }

  /**
   * Asks `nodeId` (the account's already-connected node — e.g. one
   * `listTargets()` already reported) to provision-and-pair a brand-new
   * `ssh:` target end-to-end (issue #408's zero-touch add-target wizard):
   * `provision()` (#400) + the authenticated node-token mint (#401) + the
   * AMK handoff (#399), behind the ONE confirmation the wizard already
   * showed before calling this — there is no further human checkpoint on
   * this call. `targetId` is caller-generated (mirrors `createSession`'s own
   * client-generated `sessionId`): the id the new target is announced under
   * once pairing succeeds.
   *
   * Routing metadata only, same boundary as `listTargets`/`sessionCreate`:
   * nothing here is encrypted, and no secret (password, private key, the
   * AMK itself) ever crosses the relay — the actual AMK handoff happens
   * node<->target over its own SSH channel (see `@loombox/protocol`'s
   * `provisioning.ts` doc comment).
   *
   * `onProgress` fires once per step as `provision_progress` arrives
   * (`'started'`, then `'ok'`/`'failed'`) — the wizard's live-progress
   * screen renders these directly. The returned promise resolves with the
   * final `provision_target_result` whether it succeeded or failed (check
   * `.ok`); it only REJECTS for a genuinely unusable call: no open
   * connection, or a timeout with no result at all (a slow but eventually
   * clean run must not appear to fail early — defaults to 5 minutes, far
   * longer than `listTargets`' plain metadata query, since this drives a
   * real multi-step SSH provisioning sequence on the node).
   */
  provisionTarget(
    options: {
      nodeId: string;
      targetId: string;
      host: ProvisionTargetHostInputV1;
      onProgress?: (progress: ProvisionProgress) => void;
    },
    timeoutMs = 300_000,
  ): Promise<ProvisionTargetResult> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot provision a target, no open connection'),
      );
    }
    const requestId = generateId('provision');
    return new Promise<ProvisionTargetResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProvisionRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for provision_target_result'));
      }, timeoutMs);
      this.pendingProvisionRequests.set(requestId, {
        onProgress: options.onProgress,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'provision_target_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        nodeId: options.nodeId,
        targetId: options.targetId,
        host: options.host,
      });
    });
  }

  /**
   * Lists a directory on `targetId`'s filesystem, before any session exists
   * there (SPEC §7.25's directory picker; issue #474) — `DirectoryPicker.svelte`'s
   * data source for both a local and a remote (`ssh:`) target, replacing
   * `NewSessionDialog`'s bare `projectPath` text input. Unlike
   * `fileTreeFor`/`expandDirectory`'s reactive per-session file tree (which
   * needs an existing session's project root to bound against), this is a
   * one-shot promise query exactly like {@link listTargets}/
   * {@link provisionTarget}: the picker calls it again for every path the
   * user navigates to. Sealed under a per-target key derived from the AMK
   * (`this.envelopeCrypto`'s `'target'` key family), NOT the session-derived key `fileTreeFor`/
   * `expandDirectory` use — there is no session yet to derive from (mirrors
   * `@loombox/protocol`'s `target-fs.ts` doc comment). Requires an open
   * connection and rejects on a timeout, mirroring `listTargets`'s "loud
   * rejection over a silently dropped request".
   */
  browseDirectory(
    options: { nodeId: string; targetId: string; path: string },
    timeoutMs = 10_000,
  ): Promise<TargetFsListResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot browse a directory, no open connection'),
      );
    }
    const { nodeId, targetId, path } = options;
    const requestId = generateId('dirlist');
    return new Promise<TargetFsListResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTargetFsListRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for target_fs_list_response'));
      }, timeoutMs);
      this.pendingTargetFsListRequests.set(requestId, {
        targetId,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: TargetFsListRequestPayloadV1 = { path };
      this.envelopeCrypto
        .seal('target', targetId, targetId, payload)
        .then((envelope) => {
          this.send({
            type: 'target_fs_list_request',
            protocolVersion: PROTOCOL_V1,
            nodeId,
            targetId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingTargetFsListRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * D1-3's provider-availability probe for a custom agent (issue #748's
   * "provider availability probing for a custom agent on each target, the
   * way registered providers are probed today"): before ever attempting a
   * session, checks whether `command` is both installed on `targetId`'s
   * PATH (`available`) and permitted to run there at all (`allowed`, the
   * owning node's own allowlist) — so `NewSessionDialog`'s custom-agent
   * form can show "not installed" separately from "blocked by this node's
   * operator" rather than a session simply failing later with one
   * undifferentiated error. Mirrors {@link browseDirectory} exactly:
   * `nodeId`+`targetId` routing (no session exists yet to derive a key
   * from), sealed under the same per-target key family, one-shot promise,
   * loud rejection on a closed connection or a timeout.
   */
  probeCustomAgent(
    options: { nodeId: string; targetId: string; command: string },
    timeoutMs = 10_000,
  ): Promise<CustomAgentProbeResultV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot probe a custom agent, no open connection'),
      );
    }
    const { nodeId, targetId, command } = options;
    const requestId = generateId('customagentprobe');
    const { promise, resolve, reject } = Promise.withResolvers<CustomAgentProbeResultV1>();
    const timer = setTimeout(() => {
      this.pendingCustomAgentProbeRequests.delete(requestId);
      reject(new Error('RelayClient: timed out waiting for custom_agent_probe_response'));
    }, timeoutMs);
    this.pendingCustomAgentProbeRequests.set(requestId, {
      targetId,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const payload: CustomAgentProbeRequestPayloadV1 = { command };
    this.envelopeCrypto
      .seal('target', targetId, targetId, payload)
      .then((envelope) => {
        this.send({
          type: 'custom_agent_probe_request',
          protocolVersion: PROTOCOL_V1,
          nodeId,
          targetId,
          requestId,
          envelope,
        });
      })
      .catch((error: unknown) => {
        this.pendingCustomAgentProbeRequests.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    return promise;
  }

  /**
   * Reads `sessionId`'s project's saved permission policy from the owning
   * node (SPEC §7.17; issue #751) — the allow-all default for a project
   * with nothing saved yet. No envelope on the request, same reasoning as
   * {@link getTestRunnerConfig}. Requires an open connection and rejects
   * on a timeout, mirroring {@link getTestRunnerConfig}'s own contract.
   */
  getPermissionPolicy(sessionId: string, timeoutMs = 5000): Promise<PermissionPolicyV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot get permission policy, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('permpolicy');
    return new Promise<PermissionPolicyV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPermissionPolicyRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for permission_policy_result'));
      }, timeoutMs);
      this.pendingPermissionPolicyRequests.set(requestId, {
        resolve: (policy) => {
          clearTimeout(timer);
          resolve(policy);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'permission_policy_get',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Saves (fully replaces — never a partial patch, mirrors
   * `PermissionPolicyStore.save()`'s own contract) `sessionId`'s
   * project's permission policy (SPEC §7.17; issue #751). Resolves with
   * the saved result (the same `permission_policy_result` reply
   * {@link getPermissionPolicy} gets), so a caller's UI can show the saved
   * state without a separate follow-up read. Validating an individual
   * glob rule (non-blank, per issue #751's "an invalid glob is rejected
   * at entry") is the caller's job (`PermissionPolicyPanel.svelte`'s own
   * form) — this method sends whatever `PermissionPolicyV1` it is given.
   */
  setPermissionPolicy(
    sessionId: string,
    policy: PermissionPolicyV1,
    timeoutMs = 5000,
  ): Promise<PermissionPolicyV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot save permission policy, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('permpolicy');
    return new Promise<PermissionPolicyV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPermissionPolicyRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for permission_policy_result'));
      }, timeoutMs);
      this.pendingPermissionPolicyRequests.set(requestId, {
        resolve: (saved) => {
          clearTimeout(timer);
          resolve(saved);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: PermissionPolicySetPayloadV1 = { policy };
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'permission_policy_set',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingPermissionPolicyRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Asks `sessionId`'s owning node what opening a pull request from this
   * session's own branch would do (SPEC §7.14; issue #238) — never
   * pushes, never creates anything itself. Resolves with the whole
   * `pr_open_preview_result` outcome (`'ok'` with branch/base/commitCount,
   * or `'failure'` with a named category — see `PrOpenFailureCategory`)
   * rather than throwing for a `'failure'` outcome, since that is an
   * expected, renderable result a caller's UI shows the operator, not a
   * transport error; only a timeout/no-connection rejects.
   */
  previewPrOpen(sessionId: string, timeoutMs = 15_000): Promise<PrOpenPreviewOutcome> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot preview opening a pull request, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('propenpreview');
    return new Promise<PrOpenPreviewOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrOpenPreviewRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for pr_open_preview_result'));
      }, timeoutMs);
      this.pendingPrOpenPreviewRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'pr_open_preview_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Confirms opening a pull request from `sessionId`'s own branch (SPEC
   * §7.14; issue #238) — the one call in this whole feature with a real
   * side effect on the operator's actual repository: the owning node
   * pushes the branch, then runs `gh pr create` with `title`/`body`
   * verbatim. Send only after showing the operator a
   * {@link previewPrOpen} result and getting their explicit confirmation
   * (`PrOpenPanel.svelte`'s own gate) — this method itself sends
   * unconditionally, whatever it is given. Resolves with the whole
   * `pr_open_result` outcome, same "never throws for a `'failure'`
   * outcome" contract as {@link previewPrOpen}.
   */
  openPr(
    sessionId: string,
    pr: { title: string; body: string },
    timeoutMs = 30_000,
  ): Promise<PrOpenOutcome> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot open a pull request, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('propen');
    return new Promise<PrOpenOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrOpenRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for pr_open_result'));
      }, timeoutMs);
      this.pendingPrOpenRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: PrOpenRequestPayloadV1 = { title: pr.title, body: pr.body };
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'pr_open_request',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingPrOpenRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Takes a checkpoint of `sessionId`'s worktree right now (SPEC §7.20;
   * issue #268's "named or auto-labeled checkpoint on demand", issue
   * #603's own wiring) — the manual counterpart to the owning node's
   * automatic per-turn checkpoint (`auto: before turn <n>`), since that
   * one only ever fires at a turn boundary. `message` is free text (a
   * user-chosen label), sent trimmed and only when non-blank — the wire
   * payload's own `min(1).optional()` contract
   * (`checkpointCreatePayloadV1`) — and enveloped, same reasoning
   * `setTestRunnerConfig` already applies to a command string. Resolves
   * the whole `checkpoint_result` outcome union (`'ok'` with the new
   * {@link GitCheckpointV1}, or `'error'` with a named
   * {@link CheckpointErrorTypeV1}) rather than throwing for an error
   * outcome — an `ssh:` session's `unsupported_target` is an expected,
   * renderable state (`CheckpointPanel.svelte`'s own "unsupported" state),
   * not a transport failure; only a timeout/no-connection rejects.
   */
  createCheckpoint(
    sessionId: string,
    message?: string,
    timeoutMs = 5000,
  ): Promise<CheckpointResultPayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot create checkpoint, no open connection'));
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('checkpoint');
    return new Promise<CheckpointResultPayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCheckpointCreateRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for checkpoint_result'));
      }, timeoutMs);
      this.pendingCheckpointCreateRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const trimmed = message?.trim();
      const payload: CheckpointCreatePayloadV1 = trimmed ? { message: trimmed } : {};
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'checkpoint_create',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingCheckpointCreateRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Reads every checkpoint taken so far for `sessionId` (SPEC §7.20; issue
   * #268/#603), oldest first — `[]` for a session with none yet, never an
   * error by itself. No envelope on the request, same reasoning as
   * {@link getPermissionPolicy}. Resolves the whole `checkpoint_list_result`
   * outcome union rather than throwing for an error outcome — same
   * "unsupported_target is an expected, renderable state" contract
   * {@link createCheckpoint} documents, so `CheckpointPanel.svelte` can
   * render that state distinctly instead of a generic load failure.
   */
  listCheckpoints(sessionId: string, timeoutMs = 5000): Promise<CheckpointListResultPayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot list checkpoints, no open connection'));
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('checkpointlist');
    return new Promise<CheckpointListResultPayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCheckpointListRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for checkpoint_list_result'));
      }, timeoutMs);
      this.pendingCheckpointListRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Asks `sessionId`'s owning node what restoring to `checkpointId` would
   * do, with NO side effects (SPEC §7.20; issue #268/#603) — the read
   * `CheckpointRestoreDialog.svelte` calls the moment it opens, before its
   * "restore" button is ever enabled, same two-phase shape
   * {@link previewPrOpen}/{@link openPr} already establish.
   * `checkpointId` travels as a plain field, no envelope, mirroring the
   * wire message's own shape. Resolves the whole outcome union — same
   * "never throws for a named error" contract {@link createCheckpoint}
   * documents, since `checkpoint_not_found` and `unsupported_target` are
   * both expected, renderable states here, not transport failures.
   */
  previewCheckpointRestore(
    sessionId: string,
    checkpointId: string,
    timeoutMs = 5000,
  ): Promise<CheckpointRestorePreviewResultPayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot preview checkpoint restore, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('checkpointpreview');
    return new Promise<CheckpointRestorePreviewResultPayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCheckpointRestorePreviewRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for checkpoint_restore_preview_result'));
      }, timeoutMs);
      this.pendingCheckpointRestorePreviewRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'checkpoint_restore_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
        checkpointId,
      });
    });
  }

  /**
   * Actually rolls `sessionId`'s worktree back to `checkpointId` —
   * destructive (SPEC §7.20; issue #268/#603). `confirm` is REQUIRED, no
   * default, mirroring `@loombox/protocol`'s own `checkpointRestore`
   * schema: pass `true` only once the caller has shown the human
   * {@link previewCheckpointRestore}'s own `hasUncommittedChangesToDiscard`
   * (`CheckpointRestoreDialog.svelte`'s own gate) — sending `false` when
   * there is something to discard resolves `outcome: 'confirmation_required'`
   * with that same preview instead of actually restoring; the owning node
   * enforces this structurally, this method just sends whatever `confirm`
   * it is given. `outcome: 'error'` covers a real refusal too —
   * `errorType: 'turn_in_progress'` while the session's agent is actively
   * working, `'unsupported_target'` for an `ssh:` session — resolved, not
   * thrown, same "expected, renderable state" contract every checkpoint
   * call here documents. A longer default timeout than the other three
   * calls: a real restore does several `git` subprocess spawns
   * (`GitCheckpointStore.restore`'s own doc comment), not just a read.
   */
  restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
    confirm: boolean,
    timeoutMs = 15_000,
  ): Promise<CheckpointRestoreResultPayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot restore checkpoint, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('checkpointrestore');
    return new Promise<CheckpointRestoreResultPayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCheckpointRestoreRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for checkpoint_restore_result'));
      }, timeoutMs);
      this.pendingCheckpointRestoreRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
        checkpointId,
        confirm,
      });
    });
  }

  /**
   * Registers `listener` to be called with each decrypted
   * `permission_policy_violation` this session receives (SPEC §7.17;
   * issue #751, D3-4's own "the UI must say which of the three layers
   * refused it") — mirrors {@link onTerminalOutput}. Returns an
   * unsubscribe function; call it once the caller stops rendering
   * `sessionId`'s violations (e.g. `PermissionPolicyPanel` unmounting).
   */
  onPermissionPolicyViolation(
    sessionId: string,
    listener: (violation: PermissionPolicyViolationPayloadV1) => void,
  ): () => void {
    let listeners = this.permissionPolicyViolationListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.permissionPolicyViolationListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Reads this account's saved agent-profile catalog from the owning node (design spec `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752) — `[]` for a node with nothing saved yet. No envelope on the request, mirrors {@link getPermissionPolicy}. Requires an open connection and a session to route through; rejects on a timeout. */
  listAgentProfiles(sessionId: string, timeoutMs = 5000): Promise<AgentProfileV1[]> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot list agent profiles, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('agentprofiles');
    return new Promise<AgentProfileV1[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentProfileListRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for agent_profile_list_result'));
      }, timeoutMs);
      this.pendingAgentProfileListRequests.set(requestId, {
        resolve: (profiles) => {
          clearTimeout(timer);
          resolve(profiles);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'agent_profile_list_get',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /** Saves (fully replaces — never a partial patch) this account's agent-profile catalog (issue #752). Resolves with the saved result, mirrors {@link setPermissionPolicy}. */
  saveAgentProfiles(
    sessionId: string,
    profiles: AgentProfileV1[],
    timeoutMs = 5000,
  ): Promise<AgentProfileV1[]> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot save agent profiles, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('agentprofiles');
    return new Promise<AgentProfileV1[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentProfileListRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for agent_profile_list_result'));
      }, timeoutMs);
      this.pendingAgentProfileListRequests.set(requestId, {
        resolve: (saved) => {
          clearTimeout(timer);
          resolve(saved);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: AgentProfileListSetPayloadV1 = { profiles };
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'agent_profile_list_set',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingAgentProfileListRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /** Reads which profile is currently active for `sessionId` (issue #752) — `null` means unrestricted. No envelope on the request. */
  getSessionAgentProfile(sessionId: string, timeoutMs = 5000): Promise<string | null> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot get session profile, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('sessionprofile');
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentProfileSessionRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for agent_profile_session_result'));
      }, timeoutMs);
      this.pendingAgentProfileSessionRequests.set(requestId, {
        resolve: (profileId) => {
          clearTimeout(timer);
          resolve(profileId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'agent_profile_session_get',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Switches `sessionId`'s active profile (`profileId: null` clears it
   * back to unrestricted) — issue #752's "switching profile mid-session
   * applies from the next call, never half-applied" decision: the owning
   * node's `evaluateProfileForSession` resolver reads the new value fresh
   * on the very next `session/request_permission`, never retroactively.
   * Rejects with the node's own reason (via `outcome: 'error'`) when the
   * session has no live agent to apply this to.
   */
  setSessionAgentProfile(
    sessionId: string,
    profileId: string | null,
    timeoutMs = 5000,
  ): Promise<string | null> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot set session profile, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('sessionprofile');
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentProfileSessionRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for agent_profile_session_result'));
      }, timeoutMs);
      this.pendingAgentProfileSessionRequests.set(requestId, {
        resolve: (saved) => {
          clearTimeout(timer);
          resolve(saved);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: AgentProfileSessionPayloadV1 = { profileId };
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'agent_profile_session_set',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingAgentProfileSessionRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Re-requests this account's saved keymap (Zed-parity F3-3, issue #760)
   * — no session/project involved at all, unlike every `get*` method
   * around this one. Resolves with `{}` (never rejects on "nothing saved
   * yet") the moment `keymap_result` lands; `{@link keymap}` itself
   * already reflects the answer by the time this promise settles, since
   * {@link handleKeymapResult} updates the store first. Mostly for tests
   * and an explicit "refresh" affordance — `+page.svelte` never needs to
   * call this itself, since the handshake handler already fetches this
   * proactively on every fresh connection.
   */
  getKeymap(timeoutMs = 5000): Promise<KeymapV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot get keymap, no open connection'));
    }
    const requestId = generateId('keymap');
    return new Promise<KeymapV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingKeymapRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for keymap_result'));
      }, timeoutMs);
      this.pendingKeymapRequests.set(requestId, {
        resolve: (keymap) => {
          clearTimeout(timer);
          resolve(keymap);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ type: 'keymap_get_request', protocolVersion: PROTOCOL_V1, requestId });
    });
  }

  /**
   * Saves (fully replaces — never a partial patch, mirrors
   * `setPermissionPolicy`'s own contract) this account's keymap
   * (Zed-parity F3-3, issue #760). Sealed under `@loombox/crypto`'s
   * `deriveKeymapKey` (the `'keymap'` envelope family, `crypto-worker-
   * engine.ts`) — no sessionId, no node, no project anywhere in this
   * path. Validating `candidate` against the live registry (unknown
   * action id, malformed chord, a conflict) is the CALLER's job
   * (`KeymapPanel.svelte`'s own pre-send `validateKeymapCandidate` call,
   * `$lib/keymap.ts`) — this method sends whatever `KeymapV1` it is
   * given, exactly like `setPermissionPolicy` sends whatever policy it is
   * given. Resolves with the saved result once `keymap_result` lands,
   * same as {@link getKeymap} — by then `{@link keymap}` (and every other
   * open tab/device on this account, per the relay's own fan-out) already
   * reflects it too.
   */
  setKeymap(candidate: KeymapV1, timeoutMs = 5000): Promise<KeymapV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot save keymap, no open connection'));
    }
    const requestId = generateId('keymap');
    return new Promise<KeymapV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingKeymapRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for keymap_result'));
      }, timeoutMs);
      this.pendingKeymapRequests.set(requestId, {
        resolve: (keymap) => {
          clearTimeout(timer);
          resolve(keymap);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.envelopeCrypto
        .seal('keymap', this.accountId, this.accountId, candidate)
        .then((envelope) => {
          this.send({
            type: 'keymap_set_request',
            protocolVersion: PROTOCOL_V1,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingKeymapRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Reads `sessionId`'s project's saved test/lint/build commands from the
   * owning node (SPEC §7.15; issue #245) — `{}` for a project with nothing
   * saved yet. No envelope on the request (nothing to hide about "which
   * session am I asking for"), same reasoning as {@link listTargets}.
   * Requires an open connection and rejects on a timeout, mirroring
   * `listTargets`'s "loud rejection over a silently dropped request".
   */
  getTestRunnerConfig(sessionId: string, timeoutMs = 5000): Promise<TestRunnerCommandsV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot get test runner config, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('runnercfg');
    return new Promise<TestRunnerCommandsV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTestRunnerConfigRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for test_runner_config_result'));
      }, timeoutMs);
      this.pendingTestRunnerConfigRequests.set(requestId, {
        resolve: (commands) => {
          clearTimeout(timer);
          resolve(commands);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'test_runner_config_get',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Saves (merges over the existing saved commands) `sessionId`'s
   * project's test/lint/build commands (SPEC §7.15; issue #245) — the
   * explicit-override path and the "confirm a detected suggestion" path
   * both call this with just the key(s) being changed. Resolves with the
   * merged result (the same `test_runner_config_result` reply
   * {@link getTestRunnerConfig} gets), so a caller's UI can show the saved
   * state without a separate follow-up read.
   */
  setTestRunnerConfig(
    sessionId: string,
    commands: TestRunnerCommandsV1,
    timeoutMs = 5000,
  ): Promise<TestRunnerCommandsV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot save test runner config, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('runnercfg');
    return new Promise<TestRunnerCommandsV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTestRunnerConfigRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for test_runner_config_result'));
      }, timeoutMs);
      this.pendingTestRunnerConfigRequests.set(requestId, {
        resolve: (saved) => {
          clearTimeout(timer);
          resolve(saved);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: TestRunnerConfigSetPayloadV1 = { commands };
      this.envelopeCrypto
        .seal('session', sessionId, sessionId, payload)
        .then((envelope) => {
          this.send({
            type: 'test_runner_config_set',
            protocolVersion: PROTOCOL_V1,
            sessionId,
            requestId,
            envelope,
          });
        })
        .catch((error: unknown) => {
          this.pendingTestRunnerConfigRequests.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Asks the owning node to auto-detect `sessionId`'s project's test/lint/
   * build commands (SPEC §7.15; issue #245) — a SUGGESTION only, never
   * persisted by this call itself; a caller must follow up with
   * {@link setTestRunnerConfig} to actually save any of it (issue #245's
   * "shown ... for confirmation before being saved, not silently
   * applied"). A longer default timeout than {@link getTestRunnerConfig}
   * since detection means the node reading `package.json` on whichever
   * target — `local` or `ssh:` — this session runs on, not just a local
   * JSON-file read.
   */
  detectTestRunnerConfig(sessionId: string, timeoutMs = 15_000): Promise<TestRunnerCommandsV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot detect test runner config, no open connection'),
      );
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('runnercfgdetect');
    return new Promise<TestRunnerCommandsV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTestRunnerConfigDetectRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for test_runner_config_detected'));
      }, timeoutMs);
      this.pendingTestRunnerConfigDetectRequests.set(requestId, {
        resolve: (suggestions) => {
          clearTimeout(timer);
          resolve(suggestions);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'test_runner_config_detect',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
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
    const wrapped = await this.envelopeCrypto.wrapAmkForEscrow(recoveryCode);
    this.send({
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk: packWrappedAmkForWire(wrapped),
    });
  }

  /**
   * Asks the account's node to start a new session (SPEC §7.1; issue #385):
   * seals `{ title, projectPath }` into `session_create`'s `privateEnvelope`
   * (the exact same `SessionPrivateMeta` shape `session_announce`/
   * `session_list` decrypt to) and sends it, addressed by `targetId` — the
   * relay resolves that to the owning node itself
   * (`packages/relay/src/relay.ts`'s `session_create` case), so this method
   * never needs to know which node owns it.
   *
   * `session_create` has no direct acknowledgement on the wire: the node
   * creates the session asynchronously (after its own decrypt), then
   * announces it via `session_announce` to every client subscribed to this
   * account, this one included once its own subscription catches up. This
   * method itself never waits for that announce — it used to poll
   * `session_list_request` until the new id showed up in {@link sessions},
   * but the only reason was timing a starting prompt sent right after
   * (`sendPrompt` on a session id the relay's `prompt_inject` handler
   * doesn't know about yet is silently dropped, `packages/relay/src/relay.ts`).
   * Issue #761 removed that starting prompt — a session is always created
   * empty now, the first thing typed goes through the composer's ordinary
   * {@link sendPrompt} path like any follow-up — so there is nothing left to
   * time, and this method simply returns the id it generated the moment
   * `session_create` is on the wire. A session opened before its own
   * `session_announce` arrives is issue #730's remaining half to fix, not
   * this method's concern.
   *
   * Requires an open connection, same as {@link escrowAmk}/{@link listTargets}:
   * a deliberate one-shot action a caller awaits, not best-effort live
   * session traffic, so a caller that isn't connected gets a loud rejection
   * instead of a silently dropped request.
   */
  async createSession(options: CreateSessionOptions): Promise<string> {
    if (!this.isSocketOpen()) {
      throw new Error('RelayClient.createSession: not connected to the relay');
    }
    const sessionId = options.sessionId ?? generateId('session');
    const privateMeta: SessionPrivateMeta = {
      title: options.title?.trim() || options.projectPath,
      projectPath: options.projectPath,
      // Omitted rather than sent as `undefined`: the field's whole contract is
      // that its absence means "use the node's per-target default", and
      // `JSON.stringify` would drop an explicit `undefined` anyway.
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      // Same omit-rather-than-undefined discipline (D1-3, issue #748): a
      // session with no custom agent must carry no `customAgent` key at
      // all, not an explicit `undefined`, so an older node's schema (which
      // predates this field) parses the envelope unchanged.
      ...(options.customAgent === undefined ? {} : { customAgent: options.customAgent }),
      // Same omit-rather-than-undefined discipline (issue #750/#794): an
      // empty/omitted list is behaviorally identical to omitting the key
      // entirely (`sessionPrivateMetaV1.mcpServerConfigs`'s own doc
      // comment), so this keeps the common "nothing declared" envelope
      // exactly as small as it was before this field existed.
      ...(options.mcpServerConfigs === undefined || options.mcpServerConfigs.length === 0
        ? {}
        : { mcpServerConfigs: options.mcpServerConfigs }),
      ...(options.projectEnvDecls === undefined || options.projectEnvDecls.length === 0
        ? {}
        : { projectEnvDecls: options.projectEnvDecls }),
    };
    const privateEnvelope = await this.envelopeCrypto.seal(
      'session',
      sessionId,
      sessionId,
      privateMeta,
    );
    this.send({
      type: 'session_create',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId: options.targetId,
      provider: options.provider,
      privateEnvelope,
    });

    return sessionId;
  }

  /**
   * Forks `sourceSessionId` from `forkFromTurnId` (inclusive) into a
   * brand-new session (design spec `2026-08-05-zed-parity-decisions.md`
   * §3's C6-2; issue #746) — the transcript row/turn action's own call
   * site. `title`/`projectPath`/`targetId`/`provider` are read straight
   * off `sourceSessionId`'s own already-known {@link ClientSessionMeta}
   * (this client already decrypted it to render the source session at
   * all), so a caller only ever names the source and the turn to diverge
   * from — never re-supplies data it never had reason to duplicate.
   *
   * Unlike {@link createSession} (fire-and-forget, no ack), this awaits
   * `session_fork_response`: forking has real, foreseeable refusal cases
   * — the source has no active agent, or the requested turn was never
   * produced — that must reach the caller as a visible reason, never a
   * silently-dropped request the caller only learns failed by its own
   * timeout guess.
   */
  async forkSession(
    sourceSessionId: string,
    forkFromTurnId: string,
    options: { title?: string } = {},
    timeoutMs = 30_000,
  ): Promise<string> {
    if (!this.isSocketOpen()) {
      throw new Error('RelayClient.forkSession: not connected to the relay');
    }
    const source = get(this.sessionsStore).find((session) => session.id === sourceSessionId);
    if (!source) {
      throw new Error(`RelayClient.forkSession: unknown source session "${sourceSessionId}"`);
    }

    const sessionId = generateId('session');
    const privateMeta: SessionPrivateMeta = {
      title: options.title?.trim() || `${source.title} (fork)`,
      projectPath: source.projectPath,
      forkFromTurnId,
    };
    const privateEnvelope = await this.envelopeCrypto.seal(
      'session',
      sessionId,
      sessionId,
      privateMeta,
    );

    const requestId = generateId('fork');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingForkRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for session_fork_response'));
      }, timeoutMs);
      this.pendingForkRequests.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'session_fork_request',
        protocolVersion: PROTOCOL_V1,
        requestId,
        sessionId,
        sourceSessionId,
        targetId: source.targetId,
        provider: source.provider,
        privateEnvelope,
      });
    });

    return sessionId;
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
   * The reason behind {@link statusFor}'s current value, when it has one
   * (issue #730) — only ever set alongside `'error'` (a spawn that failed
   * or timed out, in words a user can read; see `@loombox/node`'s
   * `sendSessionStatus` doc comment), `undefined` for every other status
   * and before any status has arrived at all. A second `derived` over the
   * exact same store {@link statusFor} already subscribes (see this
   * class's own doc comment), not a heavier separate subscription.
   */
  statusReasonFor(sessionId: string): Readable<string | undefined> {
    const store = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(store, (state) => state.statusReason);
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
   * The latest stale-permission-resolution notice for a session (issue
   * #131) — `undefined` until one has happened. A UI (`PermissionQueueBar`/
   * `PermissionCard`) renders this as a transient "no longer applies" note
   * rather than erroring or acting as if the (already-moot) decision went
   * through. Overwritten by the next stale attempt/discard, not
   * accumulated into a list: only the most recent one is ever relevant to
   * show.
   */
  staleNoticeFor(sessionId: string): Readable<PermissionStaleNotice | undefined> {
    return this.staleNoticeStoreFor(sessionId);
  }

  /**
   * The cross-project, cross-node attention inbox (SPEC §7.13; issues
   * #167/#168/#169): one live, sorted (oldest-waiting first) list of every
   * session-level item that needs the user right now, across every session
   * on this account (every project, every node) — not only the one
   * currently open. Each session contributes at most:
   * - a `'permission'` item for its FIFO-head pending request (issue #146's
   *   nested-visibility rule already means only that head is ever
   *   actionable, so listing the rest would show items the user can't yet
   *   act on — approving the head is what promotes the next one into view,
   *   on both this inbox and the session's own `PermissionQueueBar`);
   * - AND, independently, at most one of:
   *   - an `'awaiting_input'` item while its live `session_status` is
   *     `'awaiting_input'`;
   *   - a `'session_outcome'` item while its live `session_status` has
   *     settled to `'exited'` or `'error'`.
   * - AND, independently again, a `'ci_failure'` item while its watched
   *   PR's latest `ci_check_status` (issue #239) aggregates to `'failing'`
   *   (issue #243) — a session can be idle/finished AND have a failing
   *   check on its open PR at the same time, so this is never mutually
   *   exclusive with the status item above.
   *
   * `'review_request'` is NOT produced here — see
   * {@link AttentionInboxItem}'s doc comment for why that one class is
   * still only a modeled extension point, not live yet.
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
   *
   * SPEC §7.3's stale-discard rule (issue #131): if `requestId` is no longer
   * in this session's queue — already resolved by this same client (a
   * double click, or a click that lands after the card already re-rendered
   * without it), or discarded because {@link discardStalePermissionForToolCall}
   * already learned it was resolved elsewhere — this is a graceful no-op: no
   * `permission_response` is sent (there is nothing left to tell the node),
   * and a {@link PermissionStaleNotice} is published instead of throwing or
   * silently applying a decision the request's owner never asked for.
   */
  resolvePermission(sessionId: string, requestId: string, option: AcpPermissionOption): void {
    const store = this.permissionQueueStoreFor(sessionId);
    let stale = false;
    store.update((state) => {
      const resolved = resolvePermissionRequest(state, requestId, {
        outcome: 'selected',
        optionId: option.optionId,
      });
      stale = resolved.result.status === 'stale';
      return resolved.state;
    });

    if (stale) {
      this.publishStaleNotice(
        sessionId,
        requestId,
        'This request no longer applies — it was already resolved.',
      );
      return;
    }

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
   * The session-level turn Stop/interrupt (SPEC §7.3 "Stop/interrupt any
   * running agent turn with one tap ... distinct from post-hoc rollback",
   * §7.20; issue #129) — deliberately a *different* entry point from
   * {@link cancelPermissionRequests}: that one is the permission queue's own
   * "Multi-request ordering" cleanup (issue #147), only ever reachable
   * through a permission card/bar; this one is the turn-level cancel
   * itself, meant to be reachable from the live session view any time a
   * turn is running, whether or not a permission request happens to be
   * pending right now. Calling it:
   * - cancels every open permission request for the session too (SPEC
   *   §7.24's Multi-request-ordering rule already ties Stop to this — a
   *   spinner must never outlive the press, no matter which Stop control
   *   triggered it);
   * - settles this client's own "turn active" bookkeeping right now
   *   (mirrors the real `turn_ended` path, `settleTurnNow`) so a prompt
   *   already queued behind this turn (issue #128) is free to flush
   *   immediately instead of waiting out `turnIdleMs` for a turn the user
   *   just told the agent to abandon — SPEC §7.24's "interrupting-to-redirect
   *   is just Stop followed by a new prompt" only works if the queue isn't
   *   still gated on the turn Stop just ended;
   * - is deliberately a no-op on workspace/checkpoint state: this never
   *   touches any checkpoint/rollback machinery (SPEC §7.20), which is a
   *   wholly separate, later, explicit user action this method has no
   *   knowledge of.
   *
   * There is still no v1 wire message for the ACP-level `session/cancel`
   * call itself — that needs `packages/protocol` + `packages/relay` +
   * `packages/node` changes, out of this apps/web-only PR's scope (mirrors
   * {@link cancelPermissionRequests}'s own doc comment) — so this is the
   * client-side half of Stop today, structured to send the real
   * cancellation the moment that wire message exists, without changing this
   * method's call sites.
   */
  interruptTurn(sessionId: string): void {
    this.cancelPermissionRequests(sessionId);
    this.settleTurnNow(sessionId);
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
   * The session's agent-declared `/`-command catalogue (SPEC §7.24's
   * slash-command surface; issue #741), always the complete current list.
   * Backed by the same reduced `TranscriptState` `transcriptFor` exposes
   * (its `commands` field, populated by the node's `available_commands_update`
   * session-lifecycle event — see this class's own doc comment), not a
   * separate parallel store, exactly like `configOptionsFor` above. Starts
   * `[]` until the agent's own first `available_commands_update` arrives (a
   * connected agent that declares no commands at all, or a subscription
   * that hasn't received one yet — issue #741's "declares none" acceptance:
   * an empty list, not an error). Plumbing only: no composer UI reads this
   * yet (issue #743).
   */
  commandsFor(sessionId: string): Readable<AcpAvailableCommand[]> {
    const transcript = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(transcript, (state) => state.commands);
  }

  /**
   * The session's latest `mcp_server_status` push (issue #750, D2-2's
   * report/disable lifecycle; issue #794's own client-side surface),
   * always the full set the node last reported — only the servers that
   * failed to start, replaced wholesale on every push, never merged
   * across pushes (`reduceSessionEvent`'s own `mcp_server_status` case).
   * Backed by the same reduced `TranscriptState` `transcriptFor` exposes
   * (its `mcpServerStatuses` field), not a separate parallel store,
   * exactly like `configOptionsFor`/`commandsFor` above. `undefined`
   * until the first push arrives — a session with no MCP servers
   * configured at all stays silent forever, same as the node never
   * sending the event in that case; `[]` is the real, meaningful "every
   * configured server started fine" push.
   */
  mcpServerStatusesFor(sessionId: string): Readable<AcpMcpServerStatusEntry[] | undefined> {
    const transcript = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(transcript, (state) => state.mcpServerStatuses);
  }

  /**
   * Every MCP server's own declared prompts (Zed-parity D5-2; issue #754),
   * flattened into the same `AcpAvailableCommand[]` shape {@link commandsFor}
   * returns so `SlashCommandPicker` can render one merged `/`-list — each
   * entry carries `mcpServer` (the declaring server's name, so the picker
   * can attribute it distinctly from an agent-native command) and
   * `mcpArguments` (the prompt's own declared argument schema, for
   * building the `{name: value}` map {@link getMcpPromptText} sends).
   * Backed by `TranscriptState.mcpServerPrompts` (populated by the node's
   * `mcp_server_prompts` session-lifecycle event) — `[]` until that
   * arrives or if it never carries anything (a project with no MCP
   * servers, or none of them declaring prompts).
   */
  mcpPromptCommandsFor(sessionId: string): Readable<AcpAvailableCommand[]> {
    const transcript = this.transcriptStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    return derived(transcript, (state) => flattenMcpServerPrompts(state.mcpServerPrompts));
  }

  /**
   * Asks the owning node to render one MCP server's declared prompt
   * (Zed-parity D5-2; issue #754's "selecting an MCP prompt sends the
   * server's own definition, with its arguments if it declared any") —
   * seals `{serverName, promptName, arguments}` under this session's key
   * and awaits the matching `mcp_prompt_get_response`, mirroring
   * {@link sendTrackerWriteRequest}'s promise+timeout shape (the caller,
   * the composer's submit path, needs the rendered text directly to know
   * what to actually send — not a reactive store update). Rejects on a
   * timeout, a decrypt failure, or the node's own `outcome: 'error'`
   * (an unreachable server, a missing required argument); the composer
   * falls back to sending the user's raw typed text on any rejection
   * rather than blocking the send outright.
   */
  async getMcpPromptText(
    sessionId: string,
    serverName: string,
    promptName: string,
    args: Record<string, string>,
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!this.isSocketOpen()) {
      throw new Error('RelayClient: cannot fetch an MCP prompt, no open connection');
    }
    // mcp_prompt_get_response is fanned out only to a session's subscribed
    // clients (mirrors fs_list_response) — belt-and-suspenders subscribe,
    // same as openTerminal/sendFsListRequest, for a caller that hasn't
    // already subscribed via mcpPromptCommandsFor/transcriptFor.
    this.ensureSubscribed(sessionId);
    const payload: McpPromptGetRequestPayloadV1 = {
      serverName,
      promptName,
      arguments: Object.keys(args).length > 0 ? args : undefined,
    };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    const requestId = generateId('mcpprompt');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMcpPromptRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for mcp_prompt_get_response'));
      }, timeoutMs);
      this.pendingMcpPromptRequests.set(requestId, {
        sessionId,
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'mcp_prompt_get_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
        envelope,
      });
    });
  }

  /**
   * Picks a config option in the given category: sends the `config_option`
   * wire message so the owning node can act on it, and does NOT touch
   * {@link configOptionsFor}'s local list ahead of any round trip (issue
   * #718).
   *
   * This used to update `current` optimistically before the node could
   * possibly agree — harmless while nothing ever answered `config_option`
   * (`packages/node/src/node-daemon.ts` silently dropped it), but with a
   * real agent now on the other end (issue #707's `AcpClient.
   * setConfigOption`) that guess can be flatly wrong: an unsupported value
   * or an unrecognized option is a real, common rejection, and there is no
   * way to un-optimistically-apply a value without a moment where the UI
   * shows a choice the agent never made. So this waits for the agent's own
   * answer instead of guessing: on success the ordinary `config_options`
   * push (unchanged, already wired since #705/#149) is what actually
   * updates `current`, and on failure {@link handleConfigOptionResult}
   * publishes a {@link ConfigOptionErrorNotice} instead of ever having
   * applied — then had to revert — a wrong value. The round trip is a
   * single local ACP call, not a network hop to a model provider, so the
   * added latency is a beat, not a spinner-worthy wait.
   *
   * Tracked in {@link pendingConfigOptions} so {@link handleConfigOptionResult}
   * can tell "this reply is to my own request" from a sibling device's own
   * attempt for the same category, fanned out to every subscriber exactly
   * like `fs_list_response` (`packages/protocol/src/v1/steering.ts`'s
   * `configOptionResult` doc comment) — which is also why this calls
   * {@link ensureSubscribed} itself (mirrors `openTerminal`'s identical
   * belt-and-suspenders call): a caller that hasn't already subscribed via
   * `configOptionsFor`/`transcriptFor` would otherwise never actually
   * receive the reply this method exists to let land.
   */
  setConfigOption(sessionId: string, category: string, optionId: string): void {
    let pending = this.pendingConfigOptions.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingConfigOptions.set(sessionId, pending);
    }
    pending.add(category);
    this.ensureSubscribed(sessionId);

    this.send({
      type: 'config_option',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      category,
      optionId,
    });
  }

  /**
   * A rejected `config_option` this client itself sent, as a live notice
   * (SPEC §7.24; issue #718) — the `config_option`/model-mode-thinking-bar
   * counterpart of {@link staleNoticeFor}. Carries the agent's own reason
   * ({@link ConfigOptionErrorNotice.message}), so a picker can show why its
   * pick didn't take instead of just quietly not changing. Overwritten by
   * the next rejection for this session, not accumulated — only the most
   * recent one is ever relevant to show.
   */
  configOptionErrorFor(sessionId: string): Readable<ConfigOptionErrorNotice | undefined> {
    return this.configOptionErrorStoreFor(sessionId);
  }

  /**
   * The read-only file-tree panel's live state for one session (SPEC §7.4;
   * issue #171): a `Map` from directory path (relative to the session's
   * project root, `''` for the root) to that directory's
   * {@link FileTreeDirectoryState}. Subscribes this connection to the
   * session (`session_resume`, same as `transcriptFor`) and, the first time
   * this session's tree is asked for, kicks off loading the root directory
   * — lazy beyond that: a nested directory only loads once
   * {@link expandDirectory} is called for it (e.g. the user expanding it in
   * the UI), never eagerly walking the whole tree up front.
   */
  fileTreeFor(sessionId: string): Readable<Map<string, FileTreeDirectoryState>> {
    const store = this.fileTreeStoreFor(sessionId);
    this.ensureSubscribed(sessionId);
    if (!get(store).has('')) this.expandDirectory(sessionId, '');
    return store;
  }

  /**
   * Lists (or re-lists, after an `'error'`) one directory inside a session's
   * project (SPEC §7.4's lazy-expand contract; also the `@file` picker's own
   * on-demand fetch, SPEC §7.25/issue #160, for a path it hasn't seen yet).
   * A no-op while that exact path is already `'loading'`/`'loaded'` — call
   * again (e.g. a manual retry action) to re-fetch a directory that came
   * back `'error'`. `path` is `''` for the project root, or a path relative
   * to it (e.g. `'src/lib'`); never sent to the relay in the clear — see
   * `@loombox/protocol`'s `fs.ts` doc comment.
   */
  expandDirectory(sessionId: string, path: string): void {
    const store = this.fileTreeStoreFor(sessionId);
    const existing = get(store).get(path);
    if (existing?.status === 'loading' || existing?.status === 'loaded') return;

    store.update((map) => {
      const next = new Map(map);
      next.set(path, { path, status: 'loading', entries: existing?.entries ?? [] });
      return next;
    });

    this.ensureSubscribed(sessionId);
    this.sendFsListRequest(sessionId, path).catch((error: unknown) => {
      this.setFileTreeError(sessionId, path, errorMessage(error));
    });
  }

  /**
   * Reads one file's full text content from a session's project (issue
   * #737's read-only file viewer's own data source; `@loombox/protocol`'s
   * `fs.ts` `fs_read_request`/`fs_read_response` pair). Unlike
   * {@link fileTreeFor}'s always-on reactive store, this is a deliberate
   * one-shot request/response the caller awaits — C5-1
   * (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §3)
   * settled the Files panel, and by the same reasoning the viewer it
   * opens, as "a browsing tool, deliberately not a live view of the
   * agent": there is no persistent subscription to hold open here, and
   * re-reading a file (e.g. re-activating an already-open tab) means
   * calling this again with a fresh `requestId`. Resolves with the node's
   * own `ok`/`error` outcome either way; only REJECTS for a genuinely
   * unusable call — no open connection, an unknown session, or a timeout
   * with no response at all — mirroring {@link decommissionTarget}'s same
   * "resolves either way, rejects only when unusable" contract. `path` is
   * relative to the session's project root, never sent to the relay in
   * the clear.
   */
  async readFile(
    sessionId: string,
    path: string,
    timeoutMs = 10_000,
  ): Promise<FsReadResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error('RelayClient: cannot read a file, no open connection'));
    }
    const targetId = get(this.sessionsStore).find((session) => session.id === sessionId)?.targetId;
    if (!targetId) {
      return Promise.reject(new Error(`RelayClient: unknown session ${sessionId}`));
    }
    this.ensureSubscribed(sessionId);
    const payload: FsReadRequestPayloadV1 = { path };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    const requestId = generateId('fsread');
    return new Promise<FsReadResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFsReadRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for fs_read_response'));
      }, timeoutMs);
      this.pendingFsReadRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'fs_read_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        targetId,
        requestId,
        envelope,
      });
    });
  }

  /**
   * The session's current working-tree diff (SPEC §7.4; issue #206's diff
   * viewer) — `@loombox/protocol`'s `git-diff.ts` `git_diff_request`/
   * `git_diff_response` pair, {@link readFile}'s own sibling: a one-shot
   * request/response the caller awaits, not a persistent subscription —
   * there is no live view of the agent's own future edits here, a caller
   * re-requests (a fresh `requestId`) to refresh, exactly like re-reading
   * an already-open file tab. No `path`/`targetId` on the wire, and no
   * envelope on the request at all — the owning node already knows which
   * target a session runs on, and asking "what changed right now" carries
   * no content of its own to filter by or encrypt (see that schema's own
   * doc comment). Resolves with the node's own `ok`/`error` outcome
   * either way; only REJECTS for a genuinely unusable call — no open
   * connection, an unknown session, or a timeout with no response at all
   * — mirroring {@link readFile}'s identical contract.
   */
  async requestWorktreeDiff(
    sessionId: string,
    timeoutMs = 10_000,
  ): Promise<GitDiffResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot request a working-tree diff, no open connection'),
      );
    }
    if (!get(this.sessionsStore).some((session) => session.id === sessionId)) {
      return Promise.reject(new Error(`RelayClient: unknown session ${sessionId}`));
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('gitdiff');
    return new Promise<GitDiffResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGitDiffRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for git_diff_response'));
      }, timeoutMs);
      this.pendingGitDiffRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'git_diff_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * The session's current staged/unstaged hunk breakdown (SPEC §7.6;
   * issue #232's hunk-level staging) — `@loombox/protocol`'s
   * `git-hunks.ts` `git_hunk_diff_request`/`git_hunk_diff_response` pair,
   * {@link requestWorktreeDiff}'s own sibling for the staging surface:
   * same one-shot request/response contract, same "no `path`/envelope on
   * the request, asking carries no content" shape, same "resolves the
   * node's own `ok`/`error` outcome either way, only REJECTS for a
   * genuinely unusable call" behavior. A caller re-issues this (a fresh
   * `requestId`) after every {@link applyGitHunkAction} to see the
   * result, rather than reusing stale hunk indices from an earlier
   * snapshot (that schema's own doc comment).
   */
  async requestGitHunkDiff(
    sessionId: string,
    timeoutMs = 10_000,
  ): Promise<GitHunkDiffResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot request a hunk diff, no open connection'),
      );
    }
    if (!get(this.sessionsStore).some((session) => session.id === sessionId)) {
      return Promise.reject(new Error(`RelayClient: unknown session ${sessionId}`));
    }
    this.ensureSubscribed(sessionId);
    const requestId = generateId('githunkdiff');
    return new Promise<GitHunkDiffResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGitHunkDiffRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for git_hunk_diff_response'));
      }, timeoutMs);
      this.pendingGitHunkDiffRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'git_hunk_diff_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
      });
    });
  }

  /**
   * Stages, unstages, or discards exactly one hunk (SPEC §7.6; issue
   * #232) — {@link readFile}'s own sibling for the enveloped-request
   * shape: `path` is real session content, so the whole request travels
   * sealed (unlike {@link requestGitHunkDiff}'s envelope-less "asking
   * carries no content" request). `hunkIndex` addresses a hunk
   * positionally within whichever side `params.action` implies
   * (`stage`/`discard` read the file's `unstaged[hunkIndex]`, `unstage`
   * reads `staged[hunkIndex]`) against a diff the node computes fresh at
   * action time — never trusting a stale index from an earlier {@link
   * requestGitHunkDiff} snapshot. Resolves with the node's own
   * `ok`/`error` outcome either way; only REJECTS for a genuinely
   * unusable call — no open connection, an unknown session, or a timeout
   * with no response at all — mirroring {@link readFile}'s identical
   * contract. Carries no updated diff of its own; a caller re-issues
   * {@link requestGitHunkDiff} to see the result.
   */
  async applyGitHunkAction(
    sessionId: string,
    params: { path: string; hunkIndex: number; action: 'stage' | 'unstage' | 'discard' },
    timeoutMs = 10_000,
  ): Promise<GitHunkActionResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot apply a hunk action, no open connection'),
      );
    }
    if (!get(this.sessionsStore).some((session) => session.id === sessionId)) {
      return Promise.reject(new Error(`RelayClient: unknown session ${sessionId}`));
    }
    this.ensureSubscribed(sessionId);
    const payload: GitHunkActionRequestPayloadV1 = { ...params };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    const requestId = generateId('githunkaction');
    return new Promise<GitHunkActionResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGitHunkActionRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for git_hunk_action_response'));
      }, timeoutMs);
      this.pendingGitHunkActionRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'git_hunk_action_request',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        requestId,
        envelope,
      });
    });
  }

  /**
   * A project's native tracker snapshot (SPEC §7.10; issue #212, #697),
   * reactive — the kanban board and list view's own read model. Addressed
   * by `nodeId` + `projectPath` (issue #697), not a session: the project's
   * tracker is reachable with no session running for it at all, and even
   * for a project that has never had one. Lazily sends one
   * `tracker_snapshot_request` the first time this is called for a
   * project (mirrors `fileTreeFor`'s lazy root load); call again freely,
   * it never re-requests on its own — use {@link reloadTrackerSnapshot}
   * for a manual reload (Retry, or after a write this client didn't
   * itself make, e.g. another device's edit).
   */
  trackerSnapshotFor(nodeId: string, projectPath: string): Readable<TrackerSnapshotState> {
    const store = this.trackerSnapshotStoreFor(projectPath);
    if (!this.trackerSnapshotsRequested.has(projectPath)) {
      this.reloadTrackerSnapshot(nodeId, projectPath);
    }
    return store;
  }

  /**
   * Re-fetches a project's tracker snapshot from scratch — the Retry
   * action on a board/list stuck in `'error'` (issue #212's "a node that
   * does not answer gets the same retryable `ErrorNotice` treatment #582
   * established for the Files panel" acceptance), and the general-purpose
   * manual reload {@link trackerSnapshotFor}'s doc comment points to.
   */
  reloadTrackerSnapshot(nodeId: string, projectPath: string, includeArchived?: boolean): void {
    this.trackerSnapshotsRequested.add(projectPath);
    this.trackerSnapshotStoreFor(projectPath).update((state) => ({ ...state, status: 'loading' }));
    this.sendTrackerSnapshotRequest(nodeId, projectPath, includeArchived).catch(
      (error: unknown) => {
        this.setTrackerSnapshotError(projectPath, errorMessage(error));
      },
    );
  }

  /**
   * A project's spend-over-time history (SPEC §7.9; issue #249), reactive —
   * the spend view's own read model. Addressed by `nodeId` + `projectPath`,
   * not a session, mirroring {@link trackerSnapshotFor} exactly (see that
   * method's own doc comment for why). Lazily sends one unbounded
   * `spend_report_request` the first time this is called for a project;
   * call again freely, it never re-requests on its own — use
   * {@link reloadSpendReport} to change the requested date range or to
   * retry after an `'error'`.
   */
  spendReportFor(nodeId: string, projectPath: string): Readable<SpendReportState> {
    const store = this.spendReportStoreFor(projectPath);
    if (!this.spendReportsRequested.has(projectPath)) {
      this.reloadSpendReport(nodeId, projectPath);
    }
    return store;
  }

  /**
   * Re-fetches a project's spend report from scratch, optionally bounded to
   * `[sinceDate, untilDate]` (either/both omitted = unbounded on that side,
   * matching `spend_report_request`'s own wire contract) — the period
   * selector's own action, and the general-purpose manual reload/Retry
   * {@link spendReportFor}'s doc comment points to.
   */
  reloadSpendReport(
    nodeId: string,
    projectPath: string,
    filter: { sinceDate?: string; untilDate?: string } = {},
  ): void {
    this.spendReportsRequested.add(projectPath);
    this.spendReportStoreFor(projectPath).update((state) => ({ ...state, status: 'loading' }));
    this.sendSpendReportRequest(nodeId, projectPath, filter.sinceDate, filter.untilDate);
  }

  /**
   * Creates a native tracker record against `projectPath` on `nodeId`
   * (SPEC §7.10; issue #212, #697) — the create dialog's submit action,
   * going through the real `NativeTrackerStore` on the node exactly like
   * an agent's `tracker_create` MCP tool call (#211) would, never local
   * component state. `system.authorId` is stamped by the node from its
   * own bound account, never from this input (mirrors the MCP tool's own
   * "never from tool input" contract). Merges the returned record into
   * {@link trackerSnapshotFor}'s store on success; rejects (never silently
   * drops) on an unknown type or a lost connection, so the dialog has
   * something concrete to show the user.
   */
  async createTrackerRecord(
    nodeId: string,
    projectPath: string,
    input: { primaryType: string; typeTags?: string[]; fields: Record<string, unknown> },
  ): Promise<TrackerRecordV1> {
    const response = await this.sendTrackerWriteRequest(nodeId, projectPath, {
      op: 'create',
      ...input,
    });
    if (response.outcome === 'error') throw new Error(response.message);
    if (!response.record) {
      throw new Error('RelayClient: tracker_write_response(create) carried no record');
    }
    this.mergeTrackerRecord(projectPath, response.record);
    return response.record;
  }

  /**
   * Patches an existing native tracker record (SPEC §7.10; issue #212,
   * #697) — the edit dialog's submit action AND the kanban board's
   * drag-to-move (a `fields` patch setting the moved-to column's
   * `workflowStatus` role value), both going through the real store,
   * never local component state. Omitted fields are left as-is, matching
   * `NativeTrackerStore.update`. See {@link createTrackerRecord}'s doc
   * comment for the merge-on-success/reject-on-failure contract.
   */
  async updateTrackerRecord(
    nodeId: string,
    projectPath: string,
    id: string,
    patch: {
      primaryType?: string;
      typeTags?: string[];
      fields?: Record<string, unknown>;
      archived?: boolean;
    },
  ): Promise<TrackerRecordV1> {
    const response = await this.sendTrackerWriteRequest(nodeId, projectPath, {
      op: 'update',
      id,
      ...patch,
    });
    if (response.outcome === 'error') throw new Error(response.message);
    if (!response.record) {
      throw new Error('RelayClient: tracker_write_response(update) carried no record');
    }
    this.mergeTrackerRecord(projectPath, response.record);
    return response.record;
  }

  /**
   * Registers a project-defined custom tracker type (SPEC §7.10; issue
   * #212, #697) — the "Custom type" dialog's submit action. Once defined,
   * every generic role-driven UI (kanban grouping, priority sort, assignee
   * filter) renders records of this type identically to a built-in one,
   * with no per-type UI code (issue #212's central acceptance) — see
   * `@loombox/protocol`'s `tracker-records.ts` role helpers. See
   * {@link createTrackerRecord}'s doc comment for the merge-on-success/
   * reject-on-failure contract.
   */
  async defineTrackerType(
    nodeId: string,
    projectPath: string,
    type: { id: string; label: string; roles: Partial<Record<TrackerRoleV1, string>> },
  ): Promise<TrackerTypeDefinitionV1> {
    const response = await this.sendTrackerWriteRequest(nodeId, projectPath, {
      op: 'defineType',
      ...type,
    });
    if (response.outcome === 'error') throw new Error(response.message);
    if (!response.typeDefinition) {
      throw new Error('RelayClient: tracker_write_response(defineType) carried no typeDefinition');
    }
    this.mergeTrackerType(projectPath, response.typeDefinition);
    return response.typeDefinition;
  }

  /**
   * Every open (or opening/closed/errored) terminal for one session (SPEC
   * §7.5; issues #172/#173/#174), reactive — `InteractiveTerminal.svelte`
   * reads a single terminal's `status` out of this to know when to actually
   * render xterm.js vs. a connecting/error placeholder. Never auto-opens
   * anything (unlike `fileTreeFor`'s lazy root load): a terminal only starts
   * existing once {@link openTerminal} is called for it.
   */
  terminalsFor(sessionId: string): Readable<Map<string, TerminalClientState>> {
    return this.terminalStoreFor(sessionId);
  }

  /**
   * Opens a new interactive PTY terminal on `sessionId`'s target (SPEC §7.5;
   * issue #172). Returns the generated `terminalId` synchronously (mirrors
   * `attachFile`'s same synchronous-id/async-work split) so a caller can
   * start listening via {@link onTerminalOutput} before the round trip to
   * the node completes; `terminalsFor`'s state for it starts at `'opening'`
   * and flips to `'open'`/`'error'` once the node's `terminal_opened` reply
   * (or a local encrypt/send failure) resolves. Calling this again for the
   * same session opens an ADDITIONAL terminal with its own id — sharing that
   * session's working directory is the node's job (issue #173), not
   * something this client needs to arrange.
   */
  openTerminal(sessionId: string, cols: number, rows: number): string {
    const targetId = get(this.sessionsStore).find((session) => session.id === sessionId)?.targetId;
    const terminalId = generateId('term');
    if (!targetId) {
      this.setTerminalState(sessionId, terminalId, {
        terminalId,
        status: 'error',
        error: `RelayClient: unknown session ${sessionId}`,
      });
      return terminalId;
    }

    this.setTerminalState(sessionId, terminalId, { terminalId, status: 'opening' });
    this.ensureSubscribed(sessionId);

    const requestId = generateId('termreq');
    this.pendingTerminalOpens.set(requestId, { sessionId, terminalId });
    this.sendTerminalOpen(sessionId, targetId, terminalId, requestId, cols, rows).catch(
      (error: unknown) => {
        this.pendingTerminalOpens.delete(requestId);
        this.setTerminalState(sessionId, terminalId, {
          terminalId,
          status: 'error',
          error: errorMessage(error),
        });
      },
    );
    return terminalId;
  }

  /** Streams one chunk of typed input to `terminalId`'s stdin (SPEC §7.5) — the composer/xterm.js keystroke path. Fire-and-forget: a failure is logged, not thrown, since a live keystroke stream has no natural place to surface a rejected promise. */
  sendTerminalInput(sessionId: string, terminalId: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const payload: TerminalDataPayloadV1 = { data: bytesToBase64(bytes) };
    this.envelopeCrypto
      .seal('session', sessionId, sessionId, payload)
      .then((envelope) => {
        this.send({
          type: 'terminal_input',
          protocolVersion: PROTOCOL_V1,
          sessionId,
          terminalId,
          envelope,
        });
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to send terminal_input for session ${sessionId} terminal ${terminalId}: ${errorMessage(error)}`,
        );
      });
  }

  /** Renegotiates `terminalId`'s PTY window size (SPEC §7.5) — xterm.js's own resize event drives this. Fire-and-forget, same as {@link sendTerminalInput}. */
  resizeTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void {
    const payload: TerminalResizePayloadV1 = { cols, rows };
    this.envelopeCrypto
      .seal('session', sessionId, sessionId, payload)
      .then((envelope) => {
        this.send({
          type: 'terminal_resize',
          protocolVersion: PROTOCOL_V1,
          sessionId,
          terminalId,
          envelope,
        });
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to send terminal_resize for session ${sessionId} terminal ${terminalId}: ${errorMessage(error)}`,
        );
      });
  }

  /** Asks the owning node to close `terminalId` (SPEC §7.5). No envelope: closing carries no content, mirroring `@loombox/protocol`'s `terminalClose` schema. */
  closeTerminal(sessionId: string, terminalId: string): void {
    this.send({ type: 'terminal_close', protocolVersion: PROTOCOL_V1, sessionId, terminalId });
  }

  /**
   * Registers `listener` to be called with each decrypted output chunk this
   * terminal receives (SPEC §7.5) — `InteractiveTerminal.svelte` feeds these
   * straight into xterm.js's `Terminal.write()`. Returns an unsubscribe
   * function; call it (e.g. `onDestroy`) once the caller stops rendering
   * this terminal, or listeners accumulate for a terminal a component has
   * already torn down.
   */
  onTerminalOutput(
    sessionId: string,
    terminalId: string,
    listener: (chunk: Uint8Array) => void,
  ): () => void {
    const key = `${sessionId}:${terminalId}`;
    let listeners = this.terminalOutputListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.terminalOutputListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Every in-flight (or exited/errored) test/lint/build run for one session
   * (SPEC §7.15; issue #244), reactive — mirrors {@link terminalsFor}. Never
   * auto-starts anything: a run only starts existing once {@link startRun}
   * is called for it.
   */
  runsFor(sessionId: string): Readable<Map<string, RunClientState>> {
    return this.runStoreFor(sessionId);
  }

  /**
   * Runs `sessionId`'s project's configured `kind` command on its target and
   * streams the result (SPEC §7.15; issue #244). Returns the generated
   * `runId` synchronously (mirrors {@link openTerminal}) so a caller can
   * start listening via {@link onRunOutput} before the round trip to the
   * node completes; `runsFor`'s state for it starts at `'starting'` and
   * flips to `'running'`/`'error'` once the node's `run_started` reply (or a
   * local encrypt/send failure) resolves, then to `'exited'` once its
   * `run_exit` arrives. Calling this again (even for the same `kind`) starts
   * an ADDITIONAL run with its own id.
   */
  startRun(sessionId: string, kind: TestRunnerKindV1): string {
    const targetId = get(this.sessionsStore).find((session) => session.id === sessionId)?.targetId;
    const runId = generateId('run');
    if (!targetId) {
      this.setRunState(sessionId, runId, {
        runId,
        kind,
        status: 'error',
        error: `RelayClient: unknown session ${sessionId}`,
      });
      return runId;
    }

    this.setRunState(sessionId, runId, { runId, kind, status: 'starting' });
    this.ensureSubscribed(sessionId);

    const requestId = generateId('runreq');
    this.pendingRunStarts.set(requestId, { sessionId, runId });
    this.sendRunStart(sessionId, targetId, runId, requestId, kind).catch((error: unknown) => {
      this.pendingRunStarts.delete(requestId);
      this.setRunState(sessionId, runId, {
        runId,
        kind,
        status: 'error',
        error: errorMessage(error),
      });
    });
    return runId;
  }

  /** Asks the owning node to cancel `runId` (SPEC §7.15). No envelope: cancelling carries no content, mirroring `@loombox/protocol`'s `runCancel` schema. Fire-and-forget — the run's own `run_exit` (with `cancelled: true`) is what actually confirms it stopped. */
  cancelRun(sessionId: string, runId: string): void {
    this.send({ type: 'run_cancel', protocolVersion: PROTOCOL_V1, sessionId, runId });
  }

  /**
   * Registers `listener` to be called with each decrypted output chunk this
   * run receives (SPEC §7.15) — mirrors {@link onTerminalOutput}. Returns an
   * unsubscribe function; call it once the caller stops rendering this run.
   */
  onRunOutput(sessionId: string, runId: string, listener: (chunk: Uint8Array) => void): () => void {
    const key = `${sessionId}:${runId}`;
    let listeners = this.runOutputListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.runOutputListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
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
      const envelope = await this.envelopeCrypto.sealBytes(
        'session',
        sessionId,
        attachmentResourceId(sessionId, id),
        cached.bytes,
      );
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
   * §7.25, plus any still-live `@`-mention pill, issue #742) into a
   * `prompt_inject` envelope (SPEC §7.3) and sends it — or, if this session
   * already has a turn considered in flight (issue #128) or there is
   * currently no open connection (issue #130), queues it instead: appended
   * to that session's {@link queuedPromptsFor} list and persisted to the
   * offline outbox, to be flushed in order once the turn settles or the
   * connection comes back (`flushNext`/`flushOutboxOnReconnect`). Always
   * returns the generated `promptId` synchronously, whichever path was
   * taken; referenced attachments are cleared from the composer's pending
   * list either way, since they now belong to this prompt (sent or
   * queued), not a future one. `mentions` is expected already filtered to
   * what's still live — the caller (`+page.svelte`'s `submitPrompt`, via
   * `$lib/mentions.ts`'s `resolveMentionsForSend`) folds a stale one back
   * into `text` before this is ever called, so this method itself never
   * decides what counts as stale.
   */
  sendPrompt(
    sessionId: string,
    text: string,
    attachmentIds: string[] = [],
    mentions: MentionRef[] = [],
  ): string {
    const attachments = this.resolveUploadedAttachmentRefs(sessionId, attachmentIds);
    const mentionRefs = mentions.map((mention) => ({
      uri: mention.resourceLink.uri,
      name: mention.resourceLink.name ?? mention.resourceLink.uri,
    }));
    const item: QueuedPrompt = {
      id: generateId('prompt'),
      sessionId,
      text,
      attachments,
      mentions: mentionRefs,
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
    this.encryptAndSendPrompt(
      item.sessionId,
      item.id,
      item.text,
      item.attachments,
      item.mentions,
    ).catch((error: unknown) => {
      console.warn(
        `RelayClient: failed to encrypt/send prompt_inject for session ${item.sessionId}: ${errorMessage(error)}`,
      );
    });
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
    mentions: PromptMentionRef[],
  ): Promise<void> {
    const payload: PromptPayload = {
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    this.send({
      type: 'prompt_inject',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      promptId,
      envelope,
    });
  }

  /**
   * A relay-side `session_resume` subscribes *this specific WebSocket
   * connection* to a session's live `session_update` fan-out (SPEC §7.24;
   * `relay.ts`'s `subscribeClientToSession` keys off the connection
   * object, not the account/device) — so `this.subscribed` (which
   * dedupes so a session already resumed on the CURRENT connection never
   * sends a redundant `session_resume`) must never survive a reconnect's
   * connection swap unresent. Two related gaps this fixes as one (issue
   * #660): (1) a caller that subscribes (`transcriptFor`/`ensureSubscribed`)
   * before the very first `attemptOpen()` has reached `'open'` at all has
   * its `session_resume` silently dropped by `send()`'s "socket not open"
   * guard, yet `subscribed` is already marked, so it was never retried;
   * (2) after ANY later reconnect (network blip, laptop sleep, heartbeat
   * timeout), the relay's fan-out subscription lived on the now-dead
   * connection and is gone, but this client's own `subscribed` set still
   * says "already resumed" and skips re-sending — so a session open
   * across a reconnect silently stops receiving live updates and a user
   * only sees its next turn complete in one replayed burst on next
   * resync, which reads exactly like "streaming happened all at once at
   * the end". Re-sending `session_resume` for every still-subscribed
   * session on every successful handshake (first connect and reconnect
   * alike) closes both gaps identically — `subscribeClientToSession` and
   * this class's own `ensureSubscribed` dedupe guard are both idempotent,
   * so a resend onto an already-live subscription is a harmless no-op.
   */
  private resubscribeSessionsOnReconnect(): void {
    for (const sessionId of this.subscribed) {
      this.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
    }
  }

  private ensureSubscribed(sessionId: string): void {
    if (this.subscribed.has(sessionId)) return;
    this.subscribed.add(sessionId);
    this.retrySessionResume(sessionId, 0);
  }

  /**
   * Sends `session_resume` for `sessionId` and, unless this is already its
   * `SESSION_RESUME_MAX_ATTEMPTS`th attempt, arms a `sessionResumeRetryMs`
   * timer to try again — cancelled the moment {@link acknowledgeSessionResume}
   * observes the relay's own `session_announce` reply (issue #730).
   *
   * Exists because a `session_resume` for a session the relay has no
   * record for yet is dropped with no ack at all
   * (`packages/relay/src/relay.ts`'s `session_resume` case: `if (!record
   * || ...) { app.log.warn(...); return; }`) — and a freshly created
   * session's very first subscribe lands in exactly that window:
   * `RelayClient.createSession` sends `session_create` and returns the id
   * it generated locally the instant that's on the wire (issue #761/#763),
   * so `selectSession`'s own `ensureSubscribed` call can easily win the
   * race against the owning node's slower `session_announce` round trip.
   * A single fire-and-forget `session_resume` in that state subscribes to
   * nothing and never retries (`subscribed` is already marked) — the
   * session then sits on `undefined` status forever, which is #730's
   * "the client either does not receive them or does not use them" (it's
   * the former): the node's own `'starting'`/`'queued'`/`'error'` pushes
   * (`node-daemon.ts`'s `createSessionInternal`/`launchLocalSession`) go
   * out to a relay fan-out this connection was never registered for.
   *
   * Deliberately scoped to a session's FIRST subscribe only — retrying
   * the initial `session_resume` until it lands is #730's own race, not
   * #729's. {@link resubscribeSessionsOnReconnect} (an already-subscribed
   * session surviving a reconnect) sends exactly one `session_resume`, no
   * retry loop, on every reconnect: the relay already knows this session
   * by then, so the only race left is the resync recovering whatever was
   * missed while disconnected — {@link acknowledgeSessionResume}'s job,
   * fired by the `session_announce` this always gets back.
   */
  private retrySessionResume(sessionId: string, attempt: number): void {
    this.send({ type: 'session_resume', protocolVersion: PROTOCOL_V1, sessionId });
    if (attempt >= SESSION_RESUME_MAX_ATTEMPTS) {
      console.warn(
        `RelayClient: gave up waiting for session ${sessionId} to be announced after ${attempt} attempts (issue #730) — the owning node may never have announced it at all (see handleSessionCreate's doc comment for the unnotified failure modes this can't distinguish from "just slow")`,
      );
      return;
    }
    const timer = setTimeout(() => {
      this.pendingSessionResumeRetries.delete(sessionId);
      this.retrySessionResume(sessionId, attempt + 1);
    }, this.sessionResumeRetryMs);
    this.pendingSessionResumeRetries.set(sessionId, timer);
  }

  /**
   * `session_announce` reaches this client in exactly one way — the
   * direct reply `relay.ts`'s `session_resume` case sends back, which it
   * only does AFTER `subscribeClientToSession` — so receiving one here is
   * this connection's ack that a `session_resume` it sent actually
   * subscribed it (issue #730). Cancels {@link retrySessionResume}'s
   * pending timer for this session, then asks the relay to replay
   * everything since the highest `seq` this client has already applied
   * for it (`resync_request`, `sinceSeq` from
   * {@link lastAppliedSeqBySession} — `0`, "everything buffered", the
   * first time, since nothing is applied yet).
   *
   * That backfill closes the OTHER half of the race
   * {@link retrySessionResume} closes for a session's first-ever
   * subscribe: even once subscribed, this connection only receives
   * fan-out from that moment forward (`session_resume` itself replays
   * nothing — `relay.ts`'s own handler), so a `'starting'`/`'queued'`/
   * `'error'` status the node already pushed (right after its own
   * `announce`, the identical race from the node's side) would otherwise
   * never arrive at all (issue #730). `resync_request` and a live
   * `session_update` share one wire shape and one client-side handler
   * (`handleSessionUpdate`), so replaying needs no separate code path
   * here — {@link appliedSeqsBySession} is what keeps a duplicate
   * delivery (live AND replayed) from ever being applied twice.
   *
   * Fires at most once per (session, connection) — not once per
   * `session_announce` (issue #729's reconnect-resync — this used to be
   * a one-shot, `sinceSeq: 0` only, guarded by a "have I ever resynced
   * this session" set; #772's own doc comment named that as this issue's
   * remaining scope, not its own — but firing on literally every
   * announce over-fired: a session's first-ever subscribe can rack up
   * several announces in quick succession, one per `retrySessionResume`
   * attempt that lands before the client processes the first reply, all
   * on the SAME connection, and resyncing the identical content on every
   * one of those needlessly multiplied concurrent decrypt races for it —
   * see {@link connectionGeneration}'s doc comment). Guarded instead by
   * {@link resyncedConnectionGenerationBySession}: once resynced under
   * the CURRENT connection, further acks on that same connection are a
   * no-op, but a genuine reconnect (a new connection, a new generation)
   * resyncs again. This is what makes reconnect-resync work with ZERO
   * changes to {@link resubscribeSessionsOnReconnect}: every
   * `session_resume` a reconnect sends gets its own `session_announce`
   * reply, and that reply's generation has never been resynced yet.
   */
  private acknowledgeSessionResume(sessionId: string): void {
    const timer = this.pendingSessionResumeRetries.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingSessionResumeRetries.delete(sessionId);
    }
    if (!this.subscribed.has(sessionId)) return;
    if (this.resyncedConnectionGenerationBySession.get(sessionId) === this.connectionGeneration) {
      return;
    }
    this.resyncedConnectionGenerationBySession.set(sessionId, this.connectionGeneration);
    const sinceSeq = this.lastAppliedSeqBySession.get(sessionId) ?? 0;
    this.send({ type: 'resync_request', protocolVersion: PROTOCOL_V1, sessionId, sinceSeq });
  }

  /**
   * Wires one session into the attention inbox: subscribes it (so its
   * `permission_request`/`session_update`/`ci_check_status` traffic
   * actually reaches this client, see `ensureSubscribed`) and recomputes
   * the inbox whenever its transcript (status), permission queue, or CI
   * check state changes. Idempotent per session id, and a no-op before
   * {@link attentionInbox} has ever been called (see `syncInboxTracking`).
   */
  private trackSessionForInbox(sessionId: string): void {
    if (this.inboxTrackedSessions.has(sessionId)) return;
    this.inboxTrackedSessions.add(sessionId);
    this.ensureSubscribed(sessionId);
    this.transcriptStoreFor(sessionId).subscribe(() => this.recomputeAttentionInbox());
    this.permissionQueueStoreFor(sessionId).subscribe(() => this.recomputeAttentionInbox());
    this.ciCheckStatusStoreFor(sessionId).subscribe(() => this.recomputeAttentionInbox());
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
      const transcript = get(this.transcriptStoreFor(session.id));
      const agentMessage = lastAgentMessageText(transcript.items);

      const queue = get(this.permissionQueueStoreFor(session.id));
      const head = headPermissionRequest(queue, session.id);
      if (head) {
        items.push({
          kind: 'permission',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          nodeId: session.nodeId,
          waitingSince: head.enqueuedAt,
          permission: head,
          agentMessage,
        });
      }

      if (transcript.status === 'awaiting_input') {
        items.push({
          kind: 'awaiting_input',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          nodeId: session.nodeId,
          waitingSince: parseStatusTimestamp(transcript.statusUpdatedAt),
          agentMessage,
        });
      } else if (transcript.status === 'exited' || transcript.status === 'error') {
        items.push({
          kind: 'session_outcome',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          nodeId: session.nodeId,
          waitingSince: parseStatusTimestamp(transcript.statusUpdatedAt),
          outcome: transcript.status,
          // `lastStopReason` is set by a real `turn_ended` (SPEC §7.24) —
          // never fired for a session whose agent never got as far as a
          // turn at all. `statusReason` (issue #730) is the OTHER source
          // of "why did this stop": the node's own spawn-failure/timeout
          // message. At most one is ever set for a given session (a turn
          // that ran far enough to end implies the agent started fine),
          // so falling back rather than picking one is never a real
          // choice between two live values.
          stopReason: transcript.lastStopReason ?? transcript.statusReason,
        });
      }

      const ci = get(this.ciCheckStatusStoreFor(session.id));
      if (ci?.state === 'failing') {
        items.push({
          kind: 'ci_failure',
          sessionId: session.id,
          sessionTitle: session.title,
          projectPath: session.projectPath,
          nodeId: session.nodeId,
          waitingSince: ci.updatedAt,
          prUrl: ci.prUrl,
          prNumber: ci.prNumber,
          failingChecks: ci.checkRuns
            .filter((run) => isFailingCiConclusion(run.conclusion))
            .map((run) => run.name),
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

  /** `sessionId` -> {@link ciCheckStatuses}'s backing store, created on first access — same lazy-map pattern as {@link transcriptStoreFor}/{@link permissionQueueStoreFor}. */
  private ciCheckStatusStoreFor(sessionId: string): Writable<CiCheckStateV1 | undefined> {
    let store = this.ciCheckStatuses.get(sessionId);
    if (!store) {
      store = writable<CiCheckStateV1 | undefined>(undefined);
      this.ciCheckStatuses.set(sessionId, store);
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

  private staleNoticeStoreFor(sessionId: string): Writable<PermissionStaleNotice | undefined> {
    let store = this.staleNotices.get(sessionId);
    if (!store) {
      store = writable<PermissionStaleNotice | undefined>(undefined);
      this.staleNotices.set(sessionId, store);
    }
    return store;
  }

  private publishStaleNotice(sessionId: string, requestId: string, message: string): void {
    this.staleNoticeStoreFor(sessionId).set({ requestId, message, at: Date.now() });
  }

  private configOptionErrorStoreFor(
    sessionId: string,
  ): Writable<ConfigOptionErrorNotice | undefined> {
    let store = this.configOptionErrors.get(sessionId);
    if (!store) {
      store = writable<ConfigOptionErrorNotice | undefined>(undefined);
      this.configOptionErrors.set(sessionId, store);
    }
    return store;
  }

  /**
   * The owning node's reply to one of this client's own `config_option`
   * sends (SPEC §7.24; issue #718). Fanned out to every client subscribed
   * to the session, not addressed to the requester alone
   * (`packages/protocol/src/v1/steering.ts`'s `configOptionResult` doc
   * comment) — `category` not being in {@link pendingConfigOptions} for
   * this session means this reply is to a sibling device's own attempt
   * (or one this client already resolved), same "not pending means it
   * isn't mine" guard {@link handleFsListResponse} applies via `requestId`.
   *
   * `outcome: 'ok'` publishes nothing: `setConfigOption`'s own doc comment
   * explains why there is no optimistic value here to reconcile — the
   * ordinary `config_options` push is the actual source of truth for the
   * new value, and it is either already in flight or already applied by
   * the time this arrives. `outcome: 'error'` publishes a
   * {@link ConfigOptionErrorNotice} carrying the agent's own reason,
   * clearing this session's slot on a later success for the same category
   * (`event.category === current?.category`) so a retry that works removes
   * the stale notice rather than leaving it to linger.
   */
  private handleConfigOptionResult(message: ConfigOptionResult): void {
    const pending = this.pendingConfigOptions.get(message.sessionId);
    if (!pending?.has(message.category)) return;
    pending.delete(message.category);

    const store = this.configOptionErrorStoreFor(message.sessionId);
    if (message.result.outcome === 'ok') {
      const current = get(store);
      if (current?.category === message.category) store.set(undefined);
      return;
    }
    store.set({ category: message.category, message: message.result.message, at: Date.now() });
  }

  /**
   * The cross-device half of issue #131's stale-discard rule. v1's relay
   * never broadcasts a `permission_response` to sibling clients (only to
   * the owning node), so a device that isn't the one that resolved a
   * request has no direct signal it happened — but the tool call the
   * request was about eventually gets an ordinary `tool_call`/
   * `tool_call_update` (already fanned out to every subscribed client,
   * `reduceSessionEvent`'s normal path) once the agent acts on whichever
   * device's decision reached it first. A `status` on that update that has
   * moved past `'pending'` while this session's queue still has a
   * request for that same tool-call id is exactly the "resolved elsewhere"
   * case: discard it here (optimistic `'cancelled'`, mirroring Stop's own
   * multi-request-ordering rule) rather than leaving a card that will only
   * ever error or double-apply if the user acts on it.
   */
  private discardStalePermissionForToolCall(sessionId: string, event: AcpSessionWireEvent): void {
    if (event.kind !== 'tool_call' && event.kind !== 'tool_call_update') return;
    if (!event.status || event.status === 'pending') return;
    // The wire cast (`openJson<AcpSessionWireEvent>` below) never validates
    // this against `AcpToolCallUpdate`'s declared `id: string`, so a
    // malformed update can carry `id: undefined` at runtime (issue #548).
    // Without this guard, `undefined === undefined` would match ANY stale
    // permission request whose own `toolCall.id` is equally malformed
    // (the paired `permission_request` payload goes through the same
    // unvalidated cast in `handlePermissionRequest`), cancelling the wrong
    // card and publishing a false "resolved on another device" notice.
    if (event.id === undefined) return;

    const queue = get(this.permissionQueueStoreFor(sessionId));
    const stale = listPermissionRequests(queue, sessionId).find(
      (request) => request.toolCall.id === event.id,
    );
    if (!stale) return;

    this.permissionQueueStoreFor(sessionId).update(
      (state) => resolvePermissionRequest(state, stale.requestId, { outcome: 'cancelled' }).state,
    );
    this.publishStaleNotice(
      sessionId,
      stale.requestId,
      'This request no longer applies — it was already resolved on another device.',
    );
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
      case 'session_archive_response':
        this.handleSessionArchiveResponse(message);
        return;
      case 'session_fork_response':
        this.handleSessionForkResponse(message);
        return;
      case 'session_update':
        this.handleSessionUpdate(message);
        return;
      case 'resync_marker':
        this.handleResyncMarker(message);
        return;
      case 'permission_request':
        this.handlePermissionRequest(message);
        return;
      case 'config_option_result':
        this.handleConfigOptionResult(message);
        return;
      case 'fs_list_response':
        this.handleFsListResponse(message);
        return;
      case 'fs_read_response':
        this.handleFsReadResponse(message);
        return;
      case 'git_diff_response':
        this.handleGitDiffResponse(message);
        return;
      case 'git_hunk_diff_response':
        this.handleGitHunkDiffResponse(message);
        return;
      case 'git_hunk_action_response':
        this.handleGitHunkActionResponse(message);
        return;
      case 'tracker_snapshot_response':
        this.handleTrackerSnapshotResponse(message);
        return;
      case 'tracker_write_response':
        this.handleTrackerWriteResponse(message);
        return;
      case 'spend_report_response':
        this.handleSpendReportResponse(message);
        return;
      case 'mcp_prompt_get_response':
        this.handleMcpPromptGetResponse(message);
        return;
      case 'terminal_opened':
        this.handleTerminalOpened(message);
        return;
      case 'terminal_output':
        this.handleTerminalOutput(message);
        return;
      case 'terminal_closed':
        this.handleTerminalClosed(message);
        return;
      case 'run_started':
        this.handleRunStarted(message);
        return;
      case 'run_output':
        this.handleRunOutput(message);
        return;
      case 'run_exit':
        this.handleRunExit(message);
        return;
      case 'permission_policy_result':
        this.handlePermissionPolicyResult(message);
        return;
      case 'keymap_result':
        this.handleKeymapResult(message);
        return;
      case 'permission_policy_violation':
        this.handlePermissionPolicyViolation(message);
        return;
      case 'agent_profile_list_result':
        this.handleAgentProfileListResult(message);
        return;
      case 'agent_profile_session_result':
        this.handleAgentProfileSessionResult(message);
        return;
      case 'test_runner_config_result':
        this.handleTestRunnerConfigResult(message);
        return;
      case 'test_runner_config_detected':
        this.handleTestRunnerConfigDetected(message);
        return;
      case 'pr_open_preview_result':
        this.handlePrOpenPreviewResult(message);
        return;
      case 'pr_open_result':
        this.handlePrOpenResult(message);
        return;
      case 'checkpoint_result':
        this.handleCheckpointResult(message);
        return;
      case 'checkpoint_list_result':
        this.handleCheckpointListResult(message);
        return;
      case 'checkpoint_restore_preview_result':
        this.handleCheckpointRestorePreviewResult(message);
        return;
      case 'checkpoint_restore_result':
        this.handleCheckpointRestoreResult(message);
        return;
      case 'target_list':
        this.handleTargetList(message);
        return;
      case 'target_fs_list_response':
        this.handleTargetFsListResponse(message);
        return;
      case 'custom_agent_probe_response':
        this.handleCustomAgentProbeResponse(message);
        return;
      case 'provision_progress':
        this.handleProvisionProgress(message);
        return;
      case 'provision_target_result':
        this.handleProvisionTargetResult(message);
        return;
      case 'ssh_discovery_response':
        this.handleSshDiscoveryResponse(message);
        return;
      case 'decommission_target_response':
        this.handleDecommissionTargetResponse(message);
        return;
      case 'target_update_response':
        this.handleTargetUpdateResponse(message);
        return;
      case 'connected_account_list':
        this.handleConnectedAccountList(message);
        return;
      case 'github_connect_device_code': {
        const pending = this.pendingGithubConnectRequests.get(message.requestId);
        pending?.onDeviceCode?.(message);
        return;
      }
      case 'github_connect_result': {
        const pending = this.pendingGithubConnectRequests.get(message.requestId);
        if (!pending) return;
        this.pendingGithubConnectRequests.delete(message.requestId);
        pending.resolve(message.result);
        return;
      }
      case 'jira_connect_response': {
        const pending = this.pendingJiraConnectRequests.get(message.requestId);
        if (!pending) return;
        this.pendingJiraConnectRequests.delete(message.requestId);
        pending.resolve(message.result);
        return;
      }
      case 'connected_account_disconnect_response': {
        const pending = this.pendingDisconnectRequests.get(message.requestId);
        if (!pending) return;
        this.pendingDisconnectRequests.delete(message.requestId);
        pending.resolve(message);
        return;
      }
      case 'account_pin_response': {
        const pending = this.pendingAccountPinRequests.get(message.requestId);
        if (!pending) return;
        this.pendingAccountPinRequests.delete(message.requestId);
        pending.resolve(message.pins);
        return;
      }
      case 'account_pin_resolve_response': {
        const pending = this.pendingAccountPinResolveRequests.get(message.requestId);
        if (!pending) return;
        this.pendingAccountPinResolveRequests.delete(message.requestId);
        pending.resolve(message.result);
        return;
      }
      case 'tracker_mode_response': {
        const pending = this.pendingTrackerModeRequests.get(message.requestId);
        if (!pending) return;
        this.pendingTrackerModeRequests.delete(message.requestId);
        pending.resolve(message.mode);
        return;
      }
      case 'ci_check_status':
        this.handleCiCheckStatus(message);
        return;
      default:
        return;
    }
  }

  /** SPEC §7.26, issue #221: `connected_account_list` carries the full account-scoped snapshot (never a delta), so this replaces {@link connectedAccounts} wholesale — same "always the full list" contract `handleSessionList` follows for `sessions`. Routing metadata only, no decrypt step (see this class's own doc comment). */
  private handleConnectedAccountList(message: ConnectedAccountList): void {
    this.connectedAccountsStore.set([...message.accounts]);
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
        this.sessionDecryptFailuresStore.set(results.length - sessions.length);
        this.syncInboxTracking(sessions);
      })
      .catch(() => {
        // Every per-session decrypt already caught its own error above;
        // Promise.all itself cannot reject here.
      });
  }

  private handleSessionAnnounce(message: SessionAnnounceV1): void {
    // Independent of whether the private meta below decrypts cleanly:
    // the subscribe itself already succeeded the moment this arrived at
    // all (issue #730 — see `acknowledgeSessionResume`'s doc comment).
    this.acknowledgeSessionResume(message.session.id);
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

  /**
   * A `session_archive_response`, fanned out to every client of the
   * account on `outcome: 'ok'` (issue #512's second-device consistency —
   * `packages/relay/src/relay.ts`'s account-wide publish), not only the
   * device that called {@link archiveSession}. So the sessions-store drop
   * below runs on every `'ok'`, independent of whether `requestId` matches
   * one of {@link pendingArchiveRequests}' own entries; only the pending
   * promise's resolve/reject is guarded by that lookup, exactly like
   * {@link handleDecommissionTargetResponse}'s own "requestId not pending
   * means it isn't mine" guard.
   */
  private handleSessionArchiveResponse(message: SessionArchiveResponse): void {
    if (message.result.outcome === 'ok') {
      this.sessionsStore.update((sessions) =>
        sessions.filter((session) => session.id !== message.sessionId),
      );
    }
    const pending = this.pendingArchiveRequests.get(message.requestId);
    if (!pending) return;
    this.pendingArchiveRequests.delete(message.requestId);
    if (message.result.outcome === 'ok') {
      pending.resolve();
    } else {
      pending.reject(new Error(message.result.message));
    }
  }

  /** No `sessionsStore` side effect on `'ok'` unlike {@link handleSessionArchiveResponse}: the fork's new session reaches every device the ordinary way, via `session_announce`. This response only ever settles {@link pendingForkRequests}' own promise. */
  private handleSessionForkResponse(message: SessionForkResponse): void {
    const pending = this.pendingForkRequests.get(message.requestId);
    if (!pending) return;
    this.pendingForkRequests.delete(message.requestId);
    if (message.result.outcome === 'ok') {
      pending.resolve();
    } else {
      pending.reject(new Error(message.result.message));
    }
  }

  /** Records `seq` as applied for `sessionId` — see {@link appliedSeqsBySession}/{@link lastAppliedSeqBySession}'s doc comments. */
  private markSessionUpdateApplied(sessionId: string, seq: number): void {
    let seen = this.appliedSeqsBySession.get(sessionId);
    if (!seen) {
      seen = new Set<number>();
      this.appliedSeqsBySession.set(sessionId, seen);
    }
    seen.add(seq);
    if (seq > (this.lastAppliedSeqBySession.get(sessionId) ?? -1)) {
      this.lastAppliedSeqBySession.set(sessionId, seq);
    }
  }

  /**
   * Decrypts and reduces one `session_update`, one session at a time in
   * the order each was RECEIVED (issue #729). Chained off
   * {@link sessionUpdateQueue} rather than firing its decrypt
   * fire-and-forget: reconnect-resync means more than one
   * `session_update` for the same session can be in flight
   * concurrently (a live delivery racing its own resync-replayed
   * duplicate), and an unserialized decrypt+apply pipeline lets whichever
   * one's crypto happens to resolve first win — fine for an append-style
   * update (a message chunk, keyed by its own id), but wrong for a
   * REPLACE-style one (`session_status`, `config_options`, ...): an
   * older status arriving after a newer one was already applied would
   * silently regress it (e.g. a stale `'starting'` clobbering an
   * already-applied `'error'`). Queuing here guarantees application
   * order matches receipt order regardless of decrypt timing, which a
   * per-`seq` dedupe check alone cannot. Deduped by `seq`
   * ({@link appliedSeqsBySession}'s doc comment): a reconnect's resync
   * reply and this connection's own live fan-out can both deliver the
   * identical `seq` once `session_resume` re-subscribes this connection
   * before the resync round trip completes.
   */
  private handleSessionUpdate(message: SessionUpdateEnvelopeV1): void {
    if (this.appliedSeqsBySession.get(message.sessionId)?.has(message.seq)) return;
    const previous = this.sessionUpdateQueue.get(message.sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.processSessionUpdate(message));
    this.sessionUpdateQueue.set(message.sessionId, next);
  }

  private async processSessionUpdate(message: SessionUpdateEnvelopeV1): Promise<void> {
    // Re-checked after waiting for this session's own queue turn: a
    // duplicate delivery queued behind this one, or this exact message
    // re-queued by a stray retry, may already have been applied by the
    // time its turn comes up.
    if (this.appliedSeqsBySession.get(message.sessionId)?.has(message.seq)) return;
    let event: AcpSessionWireEvent;
    try {
      const raw = await this.envelopeCrypto.open<unknown>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      );
      event = parseSessionWireEvent(raw);
    } catch (error: unknown) {
      console.warn(
        `RelayClient: failed to decrypt/validate session_update for ${message.sessionId}: ${errorMessage(error)}`,
      );
      return;
    }
    if (this.appliedSeqsBySession.get(message.sessionId)?.has(message.seq)) return;
    this.markSessionUpdateApplied(message.sessionId, message.seq);
    this.applyUpdate(message.sessionId, event);
    this.discardStalePermissionForToolCall(message.sessionId, event);
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
  }

  /**
   * A relay `resync_marker` (issue #729, SPEC.md §7.16's bounded-ring
   * drop notice) — surfaced only when `dropped: true` (the only shape
   * `relay.ts` ever actually sends; the schema leaves room for a future
   * non-dropped use it does not yet have). Carries no `seq` of its own
   * (unlike `session_update`), so it bypasses {@link handleSessionUpdate}'s
   * dedupe entirely and needs none of its own:
   * {@link reduceResyncGap}'s `[fromSeq, toSeq]`-keyed idempotent insert
   * already makes a duplicate marker for the identical still-evicted
   * range a no-op. Applied synchronously — a marker is never ciphertext,
   * so there is nothing to decrypt — which is what keeps it ordered
   * ahead of the (async-decrypting) replayed entries that follow it on
   * the wire.
   */
  private handleResyncMarker(message: ResyncMarker): void {
    if (!message.dropped) return;
    this.transcriptStoreFor(message.sessionId).update((state) =>
      reduceResyncGap(state, { fromSeq: message.fromSeq, toSeq: message.toSeq }),
    );
  }

  /**
   * A node asks (via the relay) this client to resolve a tool-call
   * permission request (SPEC §7.24's FIFO queue). Decrypts the envelope and
   * enqueues it onto that session's `PermissionQueueState` store, oldest
   * first — the queue store's own arrival order *is* the FIFO order,
   * matching `PermissionQueue.enqueue`'s contract (`permission-queue.ts`).
   */
  private handlePermissionRequest(message: PermissionRequest): void {
    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((raw): PermissionRequestPayload => acpPermissionRequestPayloadSchema.parse(raw))
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
          `RelayClient: failed to decrypt/validate permission_request for session ${message.sessionId}: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * The owning node's reply to one of this client's own `fs_list_request`s
   * (SPEC §7.4; issue #171). `fs_list_response` is fanned out to every
   * client subscribed to the session (mirrors `permission_request`/
   * `blob_ref`), so `requestId` not being in {@link pendingFsListRequests}
   * means this reply is to a sibling device's own request, not this one —
   * silently ignored, exactly like `discardStalePermissionForToolCall`'s
   * sibling-device awareness elsewhere in this class.
   */
  private handleFsListResponse(message: FsListResponse): void {
    const pending = this.pendingFsListRequests.get(message.requestId);
    if (!pending) return;
    this.pendingFsListRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<FsListResponsePayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => {
        if (payload.outcome === 'ok') {
          this.setFileTreeLoaded(message.sessionId, payload.path, payload.entries);
        } else {
          this.setFileTreeError(message.sessionId, payload.path, payload.message);
        }
      })
      .catch((error: unknown) => {
        this.setFileTreeError(pending.sessionId, pending.path, errorMessage(error));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link readFile}
   * calls (issue #737). `fs_read_response` is fanned out to every client
   * subscribed to the session exactly like `fs_list_response`, so a
   * `requestId` not in {@link pendingFsReadRequests} means this reply is
   * to a sibling device's own request — silently ignored, exactly like
   * {@link handleFsListResponse}'s identical sibling-device awareness.
   */
  private handleFsReadResponse(message: FsReadResponse): void {
    const pending = this.pendingFsReadRequests.get(message.requestId);
    if (!pending) return;
    this.pendingFsReadRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<FsReadResponsePayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link
   * requestWorktreeDiff} calls (issue #206). `git_diff_response` is
   * fanned out to every client subscribed to the session exactly like
   * `fs_read_response`, so a `requestId` not in {@link
   * pendingGitDiffRequests} means this reply is to a sibling device's own
   * request — silently ignored, exactly like {@link
   * handleFsReadResponse}'s identical sibling-device awareness.
   */
  private handleGitDiffResponse(message: GitDiffResponse): void {
    const pending = this.pendingGitDiffRequests.get(message.requestId);
    if (!pending) return;
    this.pendingGitDiffRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<GitDiffResponsePayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link
   * requestGitHunkDiff} calls (issue #232). `git_hunk_diff_response` is
   * fanned out to every client subscribed to the session exactly like
   * `git_diff_response`, so a `requestId` not in {@link
   * pendingGitHunkDiffRequests} means this reply is to a sibling
   * device's own request — silently ignored, exactly like {@link
   * handleGitDiffResponse}'s identical sibling-device awareness.
   */
  private handleGitHunkDiffResponse(message: GitHunkDiffResponse): void {
    const pending = this.pendingGitHunkDiffRequests.get(message.requestId);
    if (!pending) return;
    this.pendingGitHunkDiffRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<GitHunkDiffResponsePayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link
   * applyGitHunkAction} calls (issue #232). `git_hunk_action_response`
   * is fanned out to every client subscribed to the session exactly
   * like `fs_read_response`, so a `requestId` not in {@link
   * pendingGitHunkActionRequests} means this reply is to a sibling
   * device's own request — silently ignored, exactly like {@link
   * handleFsReadResponse}'s identical sibling-device awareness.
   */
  private handleGitHunkActionResponse(message: GitHunkActionResponse): void {
    const pending = this.pendingGitHunkActionRequests.get(message.requestId);
    if (!pending) return;
    this.pendingGitHunkActionRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<GitHunkActionResponsePayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
  }

  /**
   * The addressed node's reply to one of this client's own
   * `tracker_snapshot_request`s (SPEC §7.10; issue #212, #697). Routed
   * directly back to this client alone (issue #697: `nodeId` addresses
   * exactly one node, and the relay answers exactly the requester, unlike
   * the old session-fanned `fs_list_response`) — `pending` still guards
   * against a stray/duplicate reply arriving after this client's own
   * timeout already cleaned the entry up, the same guard
   * {@link handleTargetFsListResponse} documents. The decrypted payload is
   * validated against `trackerSnapshotResponsePayloadV1` (issue #593's
   * decrypt-boundary convention), not a bare generic cast.
   */
  private handleTrackerSnapshotResponse(message: TrackerSnapshotResponse): void {
    const pending = this.pendingTrackerSnapshotRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTrackerSnapshotRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('project', pending.projectPath, pending.projectPath, message.envelope)
      .then((raw) => trackerSnapshotResponsePayloadV1.parse(raw))
      .then((payload) => {
        if (payload.outcome === 'ok') {
          this.trackerSnapshotStoreFor(pending.projectPath).set({
            status: 'loaded',
            records: payload.records,
            types: payload.types,
          });
        } else {
          this.setTrackerSnapshotError(pending.projectPath, payload.message, payload.reason);
        }
      })
      .catch((error: unknown) => {
        this.setTrackerSnapshotError(pending.projectPath, errorMessage(error));
      });
  }

  /**
   * The addressed node's reply to one of this client's own
   * `spend_report_request`s (SPEC §7.9; issue #249). Routed directly back to
   * this client alone, same addressing `handleTrackerSnapshotResponse`
   * documents — `pending` guards against a stray/duplicate reply the same
   * way. The decrypted payload is validated against
   * `spendReportResponsePayloadV1` (issue #593's decrypt-boundary
   * convention), not a bare generic cast. Always a `'loaded'` outcome —
   * unlike `tracker_snapshot_response`, `spend_report_response` has no error
   * union of its own (the node always answers, `rows: []` included; see
   * `spend-report.ts`'s own doc comment) — a rejected/failed decrypt still
   * lands in `'error'` through the `.catch` below, same as a lost
   * connection or timeout would.
   */
  private handleSpendReportResponse(message: SpendReportResponse): void {
    const pending = this.pendingSpendReportRequests.get(message.requestId);
    if (!pending) return;
    this.pendingSpendReportRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('project', pending.projectPath, pending.projectPath, message.envelope)
      .then((raw) => spendReportResponsePayloadV1.parse(raw))
      .then((payload) => {
        this.spendReportStoreFor(pending.projectPath).set({ status: 'loaded', rows: payload.rows });
      })
      .catch((error: unknown) => {
        this.setSpendReportError(pending.projectPath, errorMessage(error));
      });
  }

  /**
   * The addressed node's reply to one of this client's own
   * `tracker_write_request`s (SPEC §7.10; issue #212, #697) — resolves the
   * `Promise` {@link sendTrackerWriteRequest} returned, same
   * "requestId not pending means it isn't mine" guard as
   * {@link handleTargetList}. Validated against
   * `trackerWriteResponsePayloadV1`, same decrypt-boundary convention as
   * {@link handleTrackerSnapshotResponse}.
   */
  private handleTrackerWriteResponse(message: TrackerWriteResponse): void {
    const pending = this.pendingTrackerWriteRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTrackerWriteRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('project', pending.projectPath, pending.projectPath, message.envelope)
      .then((raw) => trackerWriteResponsePayloadV1.parse(raw))
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own `mcp_prompt_get_
   * request`s (Zed-parity D5-2; issue #754) — resolves the `Promise`
   * {@link getMcpPromptText} returned. `mcp_prompt_get_response` is
   * fanned out to every client subscribed to the session (mirrors
   * `fs_list_response`), so `requestId` not being in
   * {@link pendingMcpPromptRequests} means this reply is to a sibling
   * device's own request, not this one — silently ignored. A node-side
   * `outcome: 'error'` payload rejects the promise with that message,
   * exactly like a decrypt failure does.
   */
  private handleMcpPromptGetResponse(message: McpPromptGetResponse): void {
    const pending = this.pendingMcpPromptRequests.get(message.requestId);
    if (!pending) return;
    this.pendingMcpPromptRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', pending.sessionId, pending.sessionId, message.envelope)
      .then((raw) => mcpPromptGetResponsePayloadV1.parse(raw))
      .then((payload) => {
        if (payload.outcome === 'error') {
          pending.reject(new Error(payload.message));
        } else {
          pending.resolve(payload.text);
        }
      })
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The relay's reply to one of this client's own `target_list_request`s
   * (issue #383). Unlike `fs_list_response`/`terminal_opened`, `target_list`
   * is never fanned out to sibling devices (it answers a single client's own
   * request), but the same "requestId not pending means it isn't mine"
   * guard still applies, and matters once a stray/duplicate reply is
   * possible (e.g. a slow relay answering after {@link listTargets}'s own
   * timeout already rejected and cleaned up the entry).
   */
  private handleTargetList(message: TargetList): void {
    const pending = this.pendingTargetListRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTargetListRequests.delete(message.requestId);
    pending.resolve(message.targets);
  }

  /**
   * The relay's reply to this client's own {@link getKeymap}/
   * {@link setKeymap} call — OR an unprompted live push from a
   * `keymap_set_request` some OTHER tab/device on this same account just
   * sent (issue #760's "two tabs" merge story: the relay fans the winning
   * write to every account connection, not just the one that sent it —
   * `packages/relay/src/relay.ts`'s own doc comment on the
   * `keymap_set_request` handler). Unlike {@link handlePermissionPolicyResult}'s
   * "requestId not pending means it isn't mine, drop it" guard, THIS
   * handler always applies the payload to {@link keymapStore} regardless
   * of whether `message.requestId` has a pending entry — deliberately, so
   * a losing tab corrects its live view the instant it is out-voted,
   * rather than silently pressing a chord the UI no longer shows as
   * bound. Only resolves/rejects a pending {@link getKeymap}/
   * {@link setKeymap} promise when this connection actually sent that
   * request.
   */
  private handleKeymapResult(message: KeymapResult): void {
    const pending = this.pendingKeymapRequests.get(message.requestId);
    this.pendingKeymapRequests.delete(message.requestId);

    if (message.envelope === null) {
      this.keymapStore.set({});
      pending?.resolve({});
      return;
    }

    this.envelopeCrypto
      .open<unknown>('keymap', this.accountId, this.accountId, message.envelope)
      .then((decrypted) => {
        const parsed = keymapV1.safeParse(decrypted);
        if (!parsed.success) {
          throw new Error('RelayClient: received a malformed keymap envelope');
        }
        this.keymapStore.set(parsed.data);
        pending?.resolve(parsed.data);
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn(`RelayClient: failed to decrypt keymap_result: ${err.message}`);
        pending?.reject(err);
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link getPermissionPolicy}/{@link setPermissionPolicy} calls (SPEC
   * §7.17; issue #751). `permission_policy_result` is fanned out to
   * every client subscribed to the session (mirrors `fs_list_response`),
   * so the same "requestId not pending means it isn't mine" guard as
   * {@link handleFsListResponse} applies. Validated (not just cast — issue
   * #593's own boundary discipline), same as `handleTestRunnerConfigResult`.
   */
  private handlePermissionPolicyResult(message: PermissionPolicyResult): void {
    const pending = this.pendingPermissionPolicyRequests.get(message.requestId);
    if (!pending) return;
    this.pendingPermissionPolicyRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parsePermissionPolicyResultPayloadV1(decrypted).policy))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /** The owning node's reply to one of this client's own {@link listAgentProfiles}/{@link saveAgentProfiles} calls (issue #752). Mirrors {@link handlePermissionPolicyResult}. */
  private handleAgentProfileListResult(message: AgentProfileListResult): void {
    const pending = this.pendingAgentProfileListRequests.get(message.requestId);
    if (!pending) return;
    this.pendingAgentProfileListRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) =>
        pending.resolve(parseAgentProfileListResultPayloadV1(decrypted).profiles),
      )
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link getSessionAgentProfile}/{@link setSessionAgentProfile} calls
   * (issue #752). An `{outcome:'error', message}` payload (no live agent
   * to apply a `_set` to) rejects the pending promise with that message
   * rather than resolving it — `setSessionAgentProfile`'s own doc comment.
   */
  private handleAgentProfileSessionResult(message: AgentProfileSessionResult): void {
    const pending = this.pendingAgentProfileSessionRequests.get(message.requestId);
    if (!pending) return;
    this.pendingAgentProfileSessionRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => {
        if (
          decrypted &&
          typeof decrypted === 'object' &&
          'outcome' in decrypted &&
          decrypted.outcome === 'error'
        ) {
          const errorPayload = decrypted as { outcome: 'error'; message?: string };
          pending.reject(new Error(errorPayload.message ?? 'agent_profile_session_set failed'));
          return;
        }
        pending.resolve(parseAgentProfileSessionPayloadV1(decrypted).profileId);
      })
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * One live policy denial (SPEC §7.17; issue #751, D3-4's own "the UI
   * must say which of the three layers refused it") — decrypted and
   * fanned out to every listener {@link onPermissionPolicyViolation}
   * registered for this exact `sessionId`, mirroring
   * {@link handleTerminalOutput}. Never buffered by this class itself: a
   * caller mounting after this fired simply never sees it, exactly like
   * `terminalOutputListeners`' own contract (`TerminalClientState`'s doc
   * comment).
   */
  private handlePermissionPolicyViolation(message: PermissionPolicyViolation): void {
    const listeners = this.permissionPolicyViolationListeners.get(message.sessionId);
    if (!listeners || listeners.size === 0) return;

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => {
        const violation = parsePermissionPolicyViolationPayloadV1(decrypted);
        for (const listener of listeners) listener(violation);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`RelayClient: failed to decrypt permission_policy_violation: ${detail}`);
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link getTestRunnerConfig}/{@link setTestRunnerConfig} calls (SPEC
   * §7.15; issue #245). `test_runner_config_result` is fanned out to
   * every client subscribed to the session (mirrors `fs_list_response`),
   * so the same "requestId not pending means it isn't mine" guard as
   * {@link handleFsListResponse} applies. Validated (not just cast — issue
   * #593's own boundary discipline), same as `decryptSessionCreate`'s
   * node-side counterpart.
   */
  private handleTestRunnerConfigResult(message: TestRunnerConfigResult): void {
    const pending = this.pendingTestRunnerConfigRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTestRunnerConfigRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) =>
        pending.resolve(parseTestRunnerConfigResultPayloadV1(decrypted).commands),
      )
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link detectTestRunnerConfig} calls (SPEC §7.15; issue #245) — same
   * shape as {@link handleTestRunnerConfigResult}, against the separate
   * {@link pendingTestRunnerConfigDetectRequests} map since the reply type
   * differs.
   */
  private handleTestRunnerConfigDetected(message: TestRunnerConfigDetected): void {
    const pending = this.pendingTestRunnerConfigDetectRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTestRunnerConfigDetectRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) =>
        pending.resolve(parseTestRunnerConfigDetectedPayloadV1(decrypted).suggestions),
      )
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link previewPrOpen} calls (SPEC §7.14; issue #238). Fanned out to
   * every client subscribed to the session (mirrors
   * `test_runner_config_detected`), so the same "requestId not pending
   * means it isn't mine" guard as {@link handleTestRunnerConfigDetected}
   * applies.
   */
  private handlePrOpenPreviewResult(message: PrOpenPreviewResult): void {
    const pending = this.pendingPrOpenPreviewRequests.get(message.requestId);
    if (!pending) return;
    this.pendingPrOpenPreviewRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parsePrOpenPreviewResultPayloadV1(decrypted).result))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link openPr}
   * calls (SPEC §7.14; issue #238) — a separate map from
   * {@link pendingPrOpenPreviewRequests} since the reply type differs;
   * otherwise mirrors {@link handlePrOpenPreviewResult} exactly.
   */
  private handlePrOpenResult(message: PrOpenResult): void {
    const pending = this.pendingPrOpenRequests.get(message.requestId);
    if (!pending) return;
    this.pendingPrOpenRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parsePrOpenResultPayloadV1(decrypted).result))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's latest CI check-run reading for a session's open
   * pull request (SPEC §7.14; issues #239/#243) — pushed on a fixed
   * interval whatever the resulting state, exactly like
   * {@link handleRunOutput}; no pending-request bookkeeping, since nothing
   * on this client ever asks for it. Decrypts straight into
   * {@link ciCheckStatusStoreFor}, which {@link recomputeAttentionInbox}
   * reads to build (or clear) this session's `'ci_failure'` inbox item —
   * a genuine decrypt failure is logged and otherwise swallowed, the same
   * "best-effort push, never crash the client" contract {@link
   * handleRunOutput} follows.
   */
  private handleCiCheckStatus(message: CiCheckStatus): void {
    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => {
        this.ciCheckStatusStoreFor(message.sessionId).set(
          parseCiCheckStatusPayloadV1(decrypted).status,
        );
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt ci_check_status for session ${message.sessionId}: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link createCheckpoint} calls (SPEC §7.20; issue #268/#603).
   * `checkpoint_result` is fanned out to every client subscribed to the
   * session (mirrors `fs_list_response`), so the same "requestId not
   * pending means it isn't mine" guard as {@link handleFsListResponse}
   * applies. Resolves the whole parsed outcome union, never narrows to
   * just the `'ok'` case — {@link createCheckpoint}'s own doc comment.
   */
  private handleCheckpointResult(message: CheckpointResult): void {
    const pending = this.pendingCheckpointCreateRequests.get(message.requestId);
    if (!pending) return;
    this.pendingCheckpointCreateRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parseCheckpointResultPayloadV1(decrypted)))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link listCheckpoints} calls (SPEC §7.20; issue #268/#603) — a
   * separate map from {@link pendingCheckpointCreateRequests} since the
   * reply type differs; otherwise mirrors {@link handleCheckpointResult}.
   */
  private handleCheckpointListResult(message: CheckpointListResult): void {
    const pending = this.pendingCheckpointListRequests.get(message.requestId);
    if (!pending) return;
    this.pendingCheckpointListRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parseCheckpointListResultPayloadV1(decrypted)))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link previewCheckpointRestore} calls (SPEC §7.20; issue #268/#603) —
   * mirrors {@link handleCheckpointResult} against its own pending map.
   */
  private handleCheckpointRestorePreviewResult(message: CheckpointRestorePreviewResult): void {
    const pending = this.pendingCheckpointRestorePreviewRequests.get(message.requestId);
    if (!pending) return;
    this.pendingCheckpointRestorePreviewRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parseCheckpointRestorePreviewResultPayloadV1(decrypted)))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own
   * {@link restoreCheckpoint} calls (SPEC §7.20; issue #268/#603) —
   * mirrors {@link handleCheckpointResult} against its own pending map.
   * The resolved outcome's third member, `'confirmation_required'`, is
   * `restoreCheckpoint`'s own contract to leave rendering to the caller.
   */
  private handleCheckpointRestoreResult(message: CheckpointRestoreResult): void {
    const pending = this.pendingCheckpointRestoreRequests.get(message.requestId);
    if (!pending) return;
    this.pendingCheckpointRestoreRequests.delete(message.requestId);

    this.envelopeCrypto
      .open<unknown>('session', message.sessionId, message.sessionId, message.envelope)
      .then((decrypted) => pending.resolve(parseCheckpointRestoreResultPayloadV1(decrypted)))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link browseDirectory}
   * calls (issue #474). Unlike `fs_list_response` (fanned out to every
   * client subscribed to a session), this answers a single client's own
   * request — the same "requestId not pending means it isn't mine" guard as
   * {@link handleTargetList}. Decrypts under the request's own per-target key
   * (`this.envelopeCrypto`'s `'target'` key family), not the session key `handleFsListResponse` uses.
   */
  private handleTargetFsListResponse(message: TargetFsListResponse): void {
    const pending = this.pendingTargetFsListRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTargetFsListRequests.delete(message.requestId);
    this.envelopeCrypto
      .open<TargetFsListResponsePayloadV1>(
        'target',
        pending.targetId,
        pending.targetId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The owning node's reply to one of this client's own {@link probeCustomAgent}
   * calls (issue #748). Mirrors {@link handleTargetFsListResponse} exactly:
   * answers a single client's own request (the "requestId not pending
   * means it isn't mine" guard), decrypted under the request's own
   * per-target key. Unwraps `customAgentProbeResponsePayloadV1`'s
   * `{ result }` envelope down to the bare {@link CustomAgentProbeResultV1}
   * a caller actually wants.
   */
  private handleCustomAgentProbeResponse(message: CustomAgentProbeResponse): void {
    const pending = this.pendingCustomAgentProbeRequests.get(message.requestId);
    if (!pending) return;
    this.pendingCustomAgentProbeRequests.delete(message.requestId);
    this.envelopeCrypto
      .open<CustomAgentProbeResponsePayloadV1>(
        'target',
        pending.targetId,
        pending.targetId,
        message.envelope,
      )
      .then((payload) => pending.resolve(payload.result))
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /** One step of an in-flight `provisionTarget()` call streamed back (issue #408) — kept in the pending map (not deleted) since more steps/the final result follow. */
  private handleProvisionProgress(message: ProvisionProgress): void {
    const pending = this.pendingProvisionRequests.get(message.requestId);
    pending?.onProgress?.(message);
  }

  /** The sequence's final outcome (issue #408) — settles and removes the pending call. */
  private handleProvisionTargetResult(message: ProvisionTargetResult): void {
    const pending = this.pendingProvisionRequests.get(message.requestId);
    if (!pending) return;
    this.pendingProvisionRequests.delete(message.requestId);
    pending.resolve(message);
  }

  /**
   * The acting node's reply to one of this client's own {@link discoverSshHosts}
   * calls (issue #475) — same "requestId not pending means it isn't mine"
   * guard as {@link handleTargetList}, no decrypt step (plain fields, no
   * envelope).
   */
  private handleSshDiscoveryResponse(message: SshDiscoveryResponse): void {
    const pending = this.pendingSshDiscoveryRequests.get(message.requestId);
    if (!pending) return;
    this.pendingSshDiscoveryRequests.delete(message.requestId);
    pending.resolve(message.result);
  }

  /**
   * The acting node's reply to one of this client's own {@link decommissionTarget}
   * calls (issue #476) — same "requestId not pending means it isn't mine"
   * guard as {@link handleSshDiscoveryResponse}, no decrypt step (plain
   * fields, no envelope).
   */
  private handleDecommissionTargetResponse(message: DecommissionTargetResponse): void {
    const pending = this.pendingDecommissionTargetRequests.get(message.requestId);
    if (!pending) return;
    this.pendingDecommissionTargetRequests.delete(message.requestId);
    pending.resolve(message);
  }

  /**
   * The acting node's reply to one of this client's own {@link updateTarget}
   * calls (issue #476) — same shape as {@link handleDecommissionTargetResponse}.
   */
  private handleTargetUpdateResponse(message: TargetUpdateResponse): void {
    const pending = this.pendingTargetUpdateRequests.get(message.requestId);
    if (!pending) return;
    this.pendingTargetUpdateRequests.delete(message.requestId);
    pending.resolve(message);
  }

  /** Seals `{ path }` and sends the `fs_list_request` (SPEC §7.4; issue #171), tracking it in {@link pendingFsListRequests} so the eventual `fs_list_response` can be told apart from a sibling device's own request for the same session. */
  private async sendFsListRequest(sessionId: string, path: string): Promise<void> {
    const targetId = get(this.sessionsStore).find((session) => session.id === sessionId)?.targetId;
    if (!targetId) {
      throw new Error(`RelayClient: unknown session ${sessionId}`);
    }
    const payload: FsListRequestPayloadV1 = { path };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    const requestId = generateId('fs');
    this.pendingFsListRequests.set(requestId, { sessionId, path });
    this.send({
      type: 'fs_list_request',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId,
      requestId,
      envelope,
    });
  }

  /** Seals `{ includeArchived }` under `projectPath`'s project key and sends the `tracker_snapshot_request` (SPEC §7.10; issue #212, #697), tracking it in {@link pendingTrackerSnapshotRequests} so the eventual `tracker_snapshot_response` decrypts under the right key and a stray late reply after this client's own timeout is ignored. */
  private async sendTrackerSnapshotRequest(
    nodeId: string,
    projectPath: string,
    includeArchived?: boolean,
  ): Promise<void> {
    const payload: TrackerSnapshotRequestPayloadV1 = { includeArchived };
    const envelope = await this.envelopeCrypto.seal('project', projectPath, projectPath, payload);
    const requestId = generateId('trackersnap');
    this.pendingTrackerSnapshotRequests.set(requestId, { projectPath });
    this.send({
      type: 'tracker_snapshot_request',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      projectPath,
      requestId,
      envelope,
    });
  }

  /** Sends the `spend_report_request` (SPEC §7.9; issue #249), tracking it in {@link pendingSpendReportRequests} so the eventual `spend_report_response` decrypts under the right project key and a stray late reply is ignored. No envelope on this side — `spend-report.ts`'s own doc comment: a date range is a query parameter, not project content, exactly like `spend_cap_get`'s own reasoning. */
  private sendSpendReportRequest(
    nodeId: string,
    projectPath: string,
    sinceDate?: string,
    untilDate?: string,
  ): void {
    const requestId = generateId('spendreport');
    this.pendingSpendReportRequests.set(requestId, { projectPath });
    this.send({
      type: 'spend_report_request',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      projectPath,
      requestId,
      sinceDate,
      untilDate,
    });
  }

  /**
   * Seals `payload` under `projectPath`'s project key and sends the
   * `tracker_write_request` (SPEC §7.10; issue #212, #697), resolving once
   * the matching `tracker_write_response` arrives — mirrors
   * {@link decommissionTarget}'s promise+timeout shape (a deliberate,
   * one-shot write a caller awaits), not {@link sendFsListRequest}'s
   * fire-and-let-the-store-update shape, since a write's caller
   * ({@link createTrackerRecord}/{@link updateTrackerRecord}/
   * {@link defineTrackerType}) needs the outcome directly to know whether
   * to close its dialog or show an error.
   */
  private async sendTrackerWriteRequest(
    nodeId: string,
    projectPath: string,
    payload: TrackerWriteRequestPayloadV1,
    timeoutMs = 10_000,
  ): Promise<TrackerWriteResponsePayloadV1> {
    if (!this.isSocketOpen()) {
      return Promise.reject(
        new Error('RelayClient: cannot write tracker record, no open connection'),
      );
    }
    const envelope = await this.envelopeCrypto.seal('project', projectPath, projectPath, payload);
    const requestId = generateId('trackerwrite');
    return new Promise<TrackerWriteResponsePayloadV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTrackerWriteRequests.delete(requestId);
        reject(new Error('RelayClient: timed out waiting for tracker_write_response'));
      }, timeoutMs);
      this.pendingTrackerWriteRequests.set(requestId, {
        projectPath,
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({
        type: 'tracker_write_request',
        protocolVersion: PROTOCOL_V1,
        nodeId,
        projectPath,
        requestId,
        envelope,
      });
    });
  }

  /**
   * The owning node's reply to one of this client's own `terminal_open`s
   * (SPEC §7.5; issue #172). `terminal_opened` is fanned out to every client
   * subscribed to the session, so `requestId` not being in
   * {@link pendingTerminalOpens} means this reply is to a sibling device's
   * own request — silently ignored, exactly like `handleFsListResponse`'s
   * identical sibling-device awareness.
   */
  private handleTerminalOpened(message: TerminalOpened): void {
    const pending = this.pendingTerminalOpens.get(message.requestId);
    if (!pending) return;
    this.pendingTerminalOpens.delete(message.requestId);

    this.envelopeCrypto
      .open<TerminalOpenResultPayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => {
        if (payload.outcome === 'ok') {
          this.setTerminalState(message.sessionId, message.terminalId, {
            terminalId: message.terminalId,
            status: 'open',
            cwd: payload.cwd,
            shell: payload.shell,
          });
        } else {
          this.setTerminalState(message.sessionId, message.terminalId, {
            terminalId: message.terminalId,
            status: 'error',
            error: payload.message,
          });
        }
      })
      .catch((error: unknown) => {
        this.setTerminalState(pending.sessionId, pending.terminalId, {
          terminalId: pending.terminalId,
          status: 'error',
          error: errorMessage(error),
        });
      });
  }

  /** One chunk of an open terminal's output (SPEC §7.5) — decrypted and fanned out to every listener {@link onTerminalOutput} registered for this exact `sessionId`/`terminalId`, never buffered by this class itself (see `TerminalClientState`'s doc comment). */
  private handleTerminalOutput(message: TerminalOutputMessage): void {
    this.envelopeCrypto
      .open<TerminalDataPayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => {
        const listeners = this.terminalOutputListeners.get(
          `${message.sessionId}:${message.terminalId}`,
        );
        if (!listeners) return;
        const bytes = base64ToBytes(payload.data);
        for (const listener of listeners) listener(bytes);
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt terminal_output for session ${message.sessionId} terminal ${message.terminalId}: ${errorMessage(error)}`,
        );
      });
  }

  /** A terminal closed — either this client asked to (SPEC §7.5's `closed_by_client`) or its shell exited on its own. */
  private handleTerminalClosed(message: TerminalClosed): void {
    this.envelopeCrypto
      .open<TerminalClosedPayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => {
        this.setTerminalState(message.sessionId, message.terminalId, {
          terminalId: message.terminalId,
          status: 'closed',
          closedReason: payload.reason,
          error: payload.message,
        });
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt terminal_closed for session ${message.sessionId} terminal ${message.terminalId}: ${errorMessage(error)}`,
        );
      });
  }

  /** Seals `{ cols, rows }` and sends the `terminal_open` (SPEC §7.5; issue #172). */
  private async sendTerminalOpen(
    sessionId: string,
    targetId: string,
    terminalId: string,
    requestId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const payload: TerminalOpenPayloadV1 = { cols, rows };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    this.send({
      type: 'terminal_open',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId,
      terminalId,
      requestId,
      envelope,
    });
  }

  private terminalStoreFor(sessionId: string): Writable<Map<string, TerminalClientState>> {
    let store = this.terminals.get(sessionId);
    if (!store) {
      store = writable<Map<string, TerminalClientState>>(new Map());
      this.terminals.set(sessionId, store);
    }
    return store;
  }

  private setTerminalState(
    sessionId: string,
    terminalId: string,
    state: TerminalClientState,
  ): void {
    this.terminalStoreFor(sessionId).update((map) => {
      const next = new Map(map);
      next.set(terminalId, state);
      return next;
    });
  }

  /** The owning node's reply to one of this client's own {@link startRun} calls (SPEC §7.15; issue #244) — mirrors `handleTerminalOpened`. */
  private handleRunStarted(message: RunStarted): void {
    const pending = this.pendingRunStarts.get(message.requestId);
    if (!pending) return;
    this.pendingRunStarts.delete(message.requestId);

    const current = this.runStoreFor(message.sessionId);
    const kind = get(current).get(message.runId)?.kind;
    if (!kind) return; // the local starting state was already overwritten/removed somehow

    this.envelopeCrypto
      .open<RunStartedResultPayloadV1>(
        'session',
        message.sessionId,
        message.sessionId,
        message.envelope,
      )
      .then((payload) => {
        if (payload.outcome === 'ok') {
          this.setRunState(message.sessionId, message.runId, {
            runId: message.runId,
            kind,
            status: 'running',
          });
        } else {
          this.setRunState(message.sessionId, message.runId, {
            runId: message.runId,
            kind,
            status: 'error',
            error: payload.message,
          });
        }
      })
      .catch((error: unknown) => {
        this.setRunState(pending.sessionId, pending.runId, {
          runId: pending.runId,
          kind,
          status: 'error',
          error: errorMessage(error),
        });
      });
  }

  /** One chunk of a run's output (SPEC §7.15) — decrypted and fanned out to every listener {@link onRunOutput} registered for this exact `sessionId`/`runId`, never buffered by this class itself (see `RunClientState`'s doc comment). */
  private handleRunOutput(message: RunOutputMessage): void {
    this.envelopeCrypto
      .open<RunOutputPayloadV1>('session', message.sessionId, message.sessionId, message.envelope)
      .then((payload) => {
        const listeners = this.runOutputListeners.get(`${message.sessionId}:${message.runId}`);
        if (!listeners) return;
        const bytes = base64ToBytes(payload.data);
        for (const listener of listeners) listener(bytes);
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt run_output for session ${message.sessionId} run ${message.runId}: ${errorMessage(error)}`,
        );
      });
  }

  /** A run reached its terminal state (SPEC §7.15) — mirrors `handleTerminalClosed`. */
  private handleRunExit(message: RunExit): void {
    const current = this.runStoreFor(message.sessionId);
    const kind = get(current).get(message.runId)?.kind;
    if (!kind) return;

    this.envelopeCrypto
      .open<RunExitPayloadV1>('session', message.sessionId, message.sessionId, message.envelope)
      .then((payload) => {
        this.setRunState(message.sessionId, message.runId, {
          runId: message.runId,
          kind,
          status: 'exited',
          outcome: payload.outcome,
          exitCode: payload.exitCode,
          reason: payload.reason,
          cancelled: payload.cancelled,
        });
      })
      .catch((error: unknown) => {
        console.warn(
          `RelayClient: failed to decrypt run_exit for session ${message.sessionId} run ${message.runId}: ${errorMessage(error)}`,
        );
      });
  }

  /** Seals `{ kind }` and sends the `run_start` (SPEC §7.15; issue #244). */
  private async sendRunStart(
    sessionId: string,
    targetId: string,
    runId: string,
    requestId: string,
    kind: TestRunnerKindV1,
  ): Promise<void> {
    const payload: RunStartPayloadV1 = { kind };
    const envelope = await this.envelopeCrypto.seal('session', sessionId, sessionId, payload);
    this.send({
      type: 'run_start',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      targetId,
      runId,
      requestId,
      envelope,
    });
  }

  private runStoreFor(sessionId: string): Writable<Map<string, RunClientState>> {
    let store = this.runs.get(sessionId);
    if (!store) {
      store = writable<Map<string, RunClientState>>(new Map());
      this.runs.set(sessionId, store);
    }
    return store;
  }

  private setRunState(sessionId: string, runId: string, state: RunClientState): void {
    this.runStoreFor(sessionId).update((map) => {
      const next = new Map(map);
      next.set(runId, state);
      return next;
    });
  }

  private fileTreeStoreFor(sessionId: string): Writable<Map<string, FileTreeDirectoryState>> {
    let store = this.fileTrees.get(sessionId);
    if (!store) {
      store = writable<Map<string, FileTreeDirectoryState>>(new Map());
      this.fileTrees.set(sessionId, store);
    }
    return store;
  }

  private setFileTreeLoaded(sessionId: string, path: string, entries: FsEntryV1[]): void {
    this.fileTreeStoreFor(sessionId).update((map) => {
      const next = new Map(map);
      next.set(path, { path, status: 'loaded', entries });
      return next;
    });
  }

  private setFileTreeError(sessionId: string, path: string, message: string): void {
    this.fileTreeStoreFor(sessionId).update((map) => {
      const next = new Map(map);
      const existing = next.get(path);
      next.set(path, { path, status: 'error', entries: existing?.entries ?? [], error: message });
      return next;
    });
  }

  private trackerSnapshotStoreFor(projectPath: string): Writable<TrackerSnapshotState> {
    let store = this.trackerSnapshots.get(projectPath);
    if (!store) {
      store = writable<TrackerSnapshotState>({ status: 'loading', records: [], types: [] });
      this.trackerSnapshots.set(projectPath, store);
    }
    return store;
  }

  private spendReportStoreFor(projectPath: string): Writable<SpendReportState> {
    let store = this.spendReports.get(projectPath);
    if (!store) {
      store = writable<SpendReportState>({ status: 'loading', rows: [] });
      this.spendReports.set(projectPath, store);
    }
    return store;
  }

  /** Sets a project's spend report store to `'error'`, same shape as {@link setTrackerSnapshotError} (no `reason` union to carry — `spend_report_response` has none). */
  private setSpendReportError(projectPath: string, message: string): void {
    this.spendReportStoreFor(projectPath).update((state) => ({
      ...state,
      status: 'error',
      error: message,
    }));
  }

  /** `reason` mirrors `trackerSnapshotErrorV1`'s own optional `reason` (SPEC §7.10, issue #631) — set only for a `resolveTrackerBackend` resolution failure. Every field here is assigned explicitly (never spread from a possibly-stale prior value), so an error with no `reason` of its own (a decrypt failure, a timeout, a corrupt native store) correctly clears any `errorReason` a PRIOR error on this same project might have left behind. */
  private setTrackerSnapshotError(
    projectPath: string,
    message: string,
    reason?: TrackerBackendResolutionErrorV1,
  ): void {
    this.trackerSnapshotStoreFor(projectPath).update((state) => ({
      ...state,
      status: 'error',
      error: message,
      errorReason: reason,
    }));
  }

  /** Merges a written record into a project's snapshot store — replaces the existing entry by `id`, or appends a new one. See `TrackerSnapshotState`'s doc comment for why a write merges rather than re-fetching. */
  private mergeTrackerRecord(projectPath: string, record: TrackerRecordV1): void {
    this.trackerSnapshotStoreFor(projectPath).update((state) => {
      const index = state.records.findIndex((existing) => existing.id === record.id);
      const records =
        index === -1
          ? [...state.records, record]
          : state.records.map((existing, i) => (i === index ? record : existing));
      return { ...state, records };
    });
  }

  /** Merges a defined type into a project's snapshot store — same replace-or-append shape as {@link mergeTrackerRecord}. */
  private mergeTrackerType(projectPath: string, type: TrackerTypeDefinitionV1): void {
    this.trackerSnapshotStoreFor(projectPath).update((state) => {
      const index = state.types.findIndex((existing) => existing.id === type.id);
      const types =
        index === -1
          ? [...state.types, type]
          : state.types.map((existing, i) => (i === index ? type : existing));
      return { ...state, types };
    });
  }

  private async decryptSessionMeta(
    session: SessionMetaPublic,
    privateEnvelope: EncryptedEnvelope,
  ): Promise<ClientSessionMeta> {
    const privateMeta = await this.envelopeCrypto.open<SessionPrivateMeta>(
      'session',
      session.id,
      session.id,
      privateEnvelope,
    );
    return { ...session, ...privateMeta };
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
