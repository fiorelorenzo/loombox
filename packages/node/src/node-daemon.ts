import { randomUUID, type webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, posix } from 'node:path';

import {
  buildInlineImageContentBlock,
  McpServerSecretMissingError,
  fetchMcpPromptText,
  fetchMcpServerPrompts,
  mergeMcpServerConfigLists,
  parseMcpServerConfig,
  ProjectEnvVarMissingError,
  type AcpMcpServerConfig,
  type AcpPermissionOption,
  type AcpProvider,
  type AcpPromptContentBlock,
  type AcpSessionWireEvent,
  type AcpToolCallUpdate,
  type AcpToolKind,
  type AcpTranscriptUpdate,
  type AcpTurnEnd,
  type AvailableCommandsChangeEvent,
  type ConfigOptionChangeEvent,
  type InlineImageHandoffFailureReason,
  type McpServerConfig,
  type McpServerPromptsResult,
  type ProjectEnvVarDecl,
} from '@loombox/providers-core';
import {
  AgentSupervisor,
  CheckpointNotFoundError,
  defaultPtySpawn,
  DetachedHeadError,
  DirtySubmoduleError,
  GitCheckpointStore,
  NotAGitWorktreeError,
  TerminalSupervisor,
  type AgentSession,
  type AgentSupervisorStartOptions,
  type AttentionState,
  type AttentionStatus,
  type GitCheckpoint,
  type PtyLike,
  type RestorePreview,
  type TerminalSession,
  type ToolProfileDenial,
} from '@loombox/supervisor';
import {
  deriveKeyTree,
  deriveProjectKey,
  deriveSessionKey,
  importAesGcmKey,
  openJson,
  sealJson,
} from '@loombox/crypto';
import {
  connectedAccountSecretRef,
  parseConnectedAccountId,
  parseCustomAgentProbeRequestPayloadV1,
  parseSessionPrivateMetaV1,
  PROTOCOL_V1,
  type AccountPinGetRequest,
  type AccountPinMapV1,
  type AccountPinResolveOutcome,
  type AccountPinResolveRequest,
  type AccountPinSetRequest,
  type AccountPinUnsetRequest,
  type AgentInstructionsGetRequest,
  type AgentInstructionsGetResponsePayloadV1,
  type AgentInstructionsSetRequest,
  type AgentInstructionsSetRequestPayloadV1,
  type AgentInstructionsSetResponsePayloadV1,
  type AgentProfileListGet,
  type AgentProfileListResultPayloadV1,
  type AgentProfileListSet,
  type AgentProfileListSetPayloadV1,
  type AgentProfileSessionErrorPayloadV1,
  type AgentProfileSessionGet,
  type AgentProfileSessionPayloadV1,
  type AgentProfileSessionSet,
  type AgentProfileV1,
  type AmkEpochPendingEnvelope,
  type AttentionHintClass,
  type BuildIdentityV1,
  type CheckpointCreate,
  type CheckpointCreatePayloadV1,
  type CheckpointErrorTypeV1,
  type CheckpointList,
  type CheckpointListResultPayloadV1,
  type CheckpointRestore,
  type CheckpointRestorePreview,
  type CheckpointRestorePreviewResultPayloadV1,
  type CheckpointRestoreResultPayloadV1,
  type CheckpointResultPayloadV1,
  type CiAutoIterateStatusPayloadV1,
  type CiAutoIterateStop,
  type CiCheckStateV1,
  type CiCheckStatusPayloadV1,
  type ConfigOption,
  type ConfigOptionSetResult,
  type ConnectedAccount,
  type ConnectedAccountDisconnectRequest,
  type ConnectedAccountList,
  type CustomAgentProbeRequest,
  type CustomAgentProbeRequestPayloadV1,
  type CustomAgentProbeResultV1,
  type CustomAgentRecordV1,
  type DecommissionResultV1,
  type DecommissionTargetRequest,
  type FileEventPayloadV1,
  type FsListRequest,
  type FsListRequestPayloadV1,
  type FsListResponsePayloadV1,
  type FsReadRequest,
  type FsReadRequestPayloadV1,
  type FsReadResponsePayloadV1,
  type GitBranchCreateRequest,
  type GitBranchCreateRequestPayloadV1,
  type GitBranchCreateResponsePayloadV1,
  type GitBranchListRequest,
  type GitBranchListResponsePayloadV1,
  type GitBranchMergeAbortRequest,
  type GitBranchMergeAbortResponsePayloadV1,
  type GitBranchMergeRequest,
  type GitBranchMergeRequestPayloadV1,
  type GitBranchMergeResponsePayloadV1,
  type GitBranchSwitchRequest,
  type GitBranchSwitchRequestPayloadV1,
  type GitBranchSwitchResponsePayloadV1,
  type GitCheckpointV1,
  type GitCommitDraftRequest,
  type GitCommitDraftResponsePayloadV1,
  type GitCommitRequest,
  type GitCommitRequestPayloadV1,
  type GitCommitResponsePayloadV1,
  type GitDiffRequest,
  type GitDiffResponsePayloadV1,
  type GitGraphRequest,
  type GitGraphRequestPayloadV1,
  type GitGraphResponsePayloadV1,
  type GithubConnectCancelRequest,
  type GithubConnectOutcome,
  type GithubConnectStartRequest,
  type GitHunkActionRequest,
  type GitHunkActionRequestPayloadV1,
  type GitHunkActionResponsePayloadV1,
  type GitHunkDiffRequest,
  type GitHunkDiffResponsePayloadV1,
  type GitStashDropRequest,
  type GitStashDropRequestPayloadV1,
  type GitStashDropResponsePayloadV1,
  type GitStashListRequest,
  type GitStashListResponsePayloadV1,
  type GitStashPopRequest,
  type GitStashPopRequestPayloadV1,
  type GitStashPopResponsePayloadV1,
  type GitStashSaveRequest,
  type GitStashSaveRequestPayloadV1,
  type GitStashSaveResponsePayloadV1,
  type JiraConnectOutcome,
  type JiraConnectRequest,
  type McpPromptGetRequest,
  type McpPromptGetRequestPayloadV1,
  type McpPromptGetResponsePayloadV1,
  type McpServerConfigV1,
  type McpServerFailureCategoryV1,
  type McpServerStatusEntryV1,
  type PermissionPolicyGet,
  type PermissionPolicyResultPayloadV1,
  type PermissionPolicySet,
  type PermissionPolicySetPayloadV1,
  type PermissionPolicyV1,
  type PermissionPolicyViolationPayloadV1,
  type PromptInjectV1,
  type PrOpenFailureCategory,
  type PrOpenPreviewRequest,
  type PrOpenPreviewResultPayloadV1,
  type PrOpenRequest,
  type PrOpenRequestPayloadV1,
  type PrOpenResultPayloadV1,
  type ProvisionProgress,
  type ProvisionTargetResult,
  type RestorePreviewV1,
  type RewindErrorTypeV1,
  type RewindPreviewV1,
  type RunCancel,
  type RunExitPayloadV1,
  type RunOutputPayloadV1,
  type RunStart,
  type RunStartedResultPayloadV1,
  type RunStartPayloadV1,
  type SessionArchiveRequest,
  type SessionArchiveResult,
  type SessionCreate,
  type SessionForkRequest,
  type SessionForkResult,
  type SessionMetaPublic,
  type SessionPrivateMetaV1,
  type SessionRewind,
  type SessionRewindPreview,
  type SessionRewindPreviewResultPayloadV1,
  type SessionRewindResultPayloadV1,
  type SessionSpendCapResume,
  type SessionStatusV1,
  type SpendCapGet,
  type SpendCapResultPayloadV1,
  type SpendCapSet,
  type SpendCapSetPayloadV1,
  type SpendReportRequest,
  type SpendReportResponsePayloadV1,
  type SshDiscoveryRequest,
  type SshDiscoveryResultV1,
  type TargetDescriptor,
  type TargetFsListRequest,
  type TargetFsListRequestPayloadV1,
  type TargetFsListResponsePayloadV1,
  type TargetResourceSample,
  type TargetUpdateRequest,
  type TargetVersionStatusV1,
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
  type TestRunnerConfigDetect,
  type TestRunnerConfigDetectedPayloadV1,
  type TestRunnerConfigGet,
  type TestRunnerConfigResultPayloadV1,
  type TestRunnerConfigSet,
  type TestRunnerConfigSetPayloadV1,
  type TrackerMode,
  type TrackerModeGetRequest,
  type TrackerModeSetRequest,
  type TrackerSnapshotRequest,
  type TrackerSnapshotRequestPayloadV1,
  type TrackerSnapshotResponsePayloadV1,
  type TrackerWriteRequest,
  type TrackerWriteRequestPayloadV1,
  type TrackerWriteResponsePayloadV1,
  type WireMessageV1,
  type WrappedAmkEnvelope,
} from '@loombox/protocol';
import type { TrackerBackend, TrackerBinding } from '@loombox/shared';

import {
  AccountHostMismatchError,
  AccountPinDanglingError,
  AccountPinMalformedError,
  AccountPinRequiredError,
  AmbiguousAccountError,
  resolveAccountForRead,
  resolveAccountForWrite,
  type AccountPinMap,
} from './account-pin';
import { readAgentInstructionsFiles, writeAgentInstructionsFile } from './agent-instructions';
import { AccountPinStore } from './account-pin-store';
import { AttachmentResolver, RelayBlobSource, type BlobSource } from './attachments';
import {
  abortMerge,
  applyGitHunkAction,
  computeCommitGraph,
  computeHunkDiff,
  computeWorktreeDiff,
  createBranch,
  GitBranchAlreadyExistsError,
  GitBranchNotFoundError,
  GitDiffError,
  GitDirtyWorktreeError,
  GitGraphError,
  GitHunkActionError,
  GitMergeConflictError,
  GitStashNotFoundError,
  GitStashPopConflictError,
  listBranches,
  listStashes,
  mergeBranch,
  stashDrop,
  stashPop,
  stashSave,
  switchBranch,
} from './git-diff';
import {
  buildCommitDraftPrompt,
  commitStaged,
  computeStagedDiffText,
  GitCommitError,
} from './git-commit';
import {
  assertCustomAgentAllowed,
  createCustomAgentProvider,
  CustomAgentNotAllowedError,
  isCustomAgentCommandAllowed,
} from './custom-agent';
import { renderPromptTextWithMentions, type PromptMentionRef } from './prompt-mentions';
import { GithubDeviceFlowError } from './github-device-flow';
import { GithubConnectService, resolveGithubConnectClientId } from './github-connect';
import { JiraConnectService } from './jira-connect';

import { LocalExecutionTarget } from './local-execution-target';
import { McpConfigStore } from './mcp-config-store';
import { NativeTrackerStore, NativeTrackerStoreError } from './native-tracker-store';
import { NodeMcpSecretManager } from './mcp-secrets';
import { NodeProjectEnvManager } from './project-env-secrets';
import {
  evaluateCommandLine,
  logPolicyViolation,
  type PermissionPolicy,
  type PolicyViolation,
} from './permission-policy';
import { PermissionPolicyStore } from './permission-policy-store';
import { SpendCapStore } from './spend-cap-store';
import { SpendLedgerStore } from './spend-ledger-store';
import { filterSpendLedgerRows } from '@loombox/shared';
import {
  evaluateAgentProfile,
  filterMcpServersForProfile,
  type AgentProfile,
} from './agent-profile';
import { AgentProfileStore } from './agent-profile-store';
import {
  PolicyEnforcedExecutionTarget,
  resolveRealBasename,
} from './policy-enforced-execution-target';
import { PolicyEnforcedPty } from './policy-enforced-pty';
import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import { sampleLocalResources, sampleRemoteResources } from './resource-sampler';
import { SameFolderGuard } from './same-folder-guard';
import { resolveSessionSandbox } from './session-sandbox';
import { SessionConcurrencyGate } from './session-concurrency-gate';
import {
  CannotForkSessionError,
  InvalidSessionTransitionError,
  SessionManager,
  sessionWorktreeBranch,
  type Session,
} from './session-manager';
import { cutTranscriptAtTurn } from './session-fork';
import {
  AUTO_CHECKPOINT_MESSAGE_PREFIX,
  orderedTurnIds,
  resolveRewindCheckpoint,
  turnIdForTurnNumber,
} from './session-rewind';
import { resolveSessionBranch } from './session-branch';
import { openPr, previewPrOpen, PrOpenError, type OpenPrResult } from './pr-open';
import {
  CiCheckWatcher,
  isFailingConclusion,
  parseGithubPullRequestUrl,
  type CiWatchEntry,
} from './ci-check-watcher';
import { CiWatchStore } from './ci-watch-store';
import { CiAutoIterateController } from './ci-auto-iterate';
import { SessionStore } from './session-store';
import { SshExecutionTarget } from './ssh-execution-target';
import { decommissionSshTarget } from './ssh/decommission';
import { discoverSshTargets, type DiscoverSshTargetsOptions } from './ssh/host-candidates';
import {
  DEFAULT_LOCAL_TARGET,
  DEFAULT_SSH_MAX_CONCURRENT_SESSIONS,
  defaultLocalMaxConcurrentSessions,
  type ExecutionTarget,
  type SshTargetConfig,
} from './target';
import {
  probeProviderAvailability,
  type ProviderAvailabilityCandidate,
} from './provider-availability';
import { TargetHealthSampler } from './target-health-sampler';
import { TestRunnerConfigStore } from './test-runner-config-store';
import { detectTestRunnerCommands } from './test-runner-detect';
import { isSafeRunId, startLocalRun, startSshRun, type RunExitResult } from './test-runner-process';
import { TrackerModeStore } from './tracker-mode-store';
import {
  resolveTrackerBackend,
  type TrackerBackendIntent,
  type TrackerBackendResolutionError,
} from './tracker-backend-composition';
import {
  liveItemToTrackerRecord,
  liveTrackerTypeDefinition,
  trackerResolutionErrorPayload,
  type LiveTrackerProvider,
} from './tracker-live-bridge';
import { asAcpChildProcess, RemoteAgentChildProcess } from './ssh/remote-agent-child';
import { RemoteProcessRunner } from './ssh/remote-process-runner';
import { createRemoteWorktree } from './ssh/remote-worktree';
import { shQuote, type RemoteTransport } from './ssh/remote-transport';
import { RelayLeaseClient, type RelayLeaseOutcome } from './ssh/relay-lease-client';
import { SessionLeaseManager } from './ssh/session-lease';
import { supportsShellChannel } from './ssh/shell-transport';
import { shellChannelToPty } from './ssh/ssh-pty-adapter';
import { Ssh2Transport } from './ssh/ssh2-transport';
import type { SupervisorArtifactSource } from './ssh/supervisor-artifact';
import { TargetUpdateMonitor } from './ssh/target-update-monitor';
import { SshTransportPool } from './ssh/ssh-transport-pool';
import { SshTargetStore } from './ssh/verify-and-persist';
import type { ReconnectingTransportOptions } from './ssh/reconnecting-transport';

type CryptoKey = webcrypto.CryptoKey;

/**
 * {@link NodeDaemon.resolveTrackerDispatch}'s result — the one seam both
 * `readTrackerSnapshot` and `applyTrackerWrite` (SPEC §7.10; issue #631;
 * project-addressed rather than bridge-addressed by issue #697) branch on,
 * so a project's mode/account/pin state can never be read differently by
 * the two dispatch paths. `'live'` carries everything `tracker-live-
 * bridge.ts`'s conversions need (`provider`/`connectionId`, alongside the
 * composed `backend`/`binding` `@loombox/shared`'s `TrackerBackend` itself
 * takes).
 */
type TrackerBridgeDispatch =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'live';
      readonly backend: TrackerBackend;
      readonly binding: TrackerBinding;
      readonly provider: LiveTrackerProvider;
      readonly connectionId: string;
    }
  | { readonly kind: 'error'; readonly error: TrackerBackendResolutionError };

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
   * This node's own build identity (issue #655): its `package.json`
   * version plus, when honestly recoverable, the commit it's running from
   * — see `./build-identity.ts`'s `readNodeBuildIdentity()`, which
   * `main.ts` resolves once at startup and passes here. Forwarded verbatim
   * to `RelayConnection`, sent on every `initialize`. Omitted (every
   * existing test) means no field on the wire at all, exactly the
   * pre-#655 shape a node without this option produces.
   */
  buildIdentity?: BuildIdentityV1;
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
  /**
   * This node's `local` target's concurrency cap (SPEC §7.16, issue #252):
   * starting more than this many sessions on it queues the excess FIFO
   * instead of launching them (see `SessionConcurrencyGate`). Defaults to
   * {@link defaultLocalMaxConcurrentSessions} — this host's own CPU core
   * count — when omitted; every `ssh:` target's own cap instead comes from
   * its own `SshTargetConfig.maxConcurrentSessions` (or
   * `DEFAULT_SSH_MAX_CONCURRENT_SESSIONS` when that's unset too), a
   * deliberately different, lower default — see that field's doc comment
   * for why a remote target's capacity can't be inferred the same way a
   * local one's can.
   */
  localMaxConcurrentSessions?: number;
  /** Builds the `RemoteTransport` for a given `ssh:` target; defaults to a real `Ssh2Transport`. Tests inject a `LocalProcessTransport`/`FakeTransport` factory instead. */
  sshTransportFactory?: (config: SshTargetConfig) => RemoteTransport;
  /**
   * The provider CLIs this node checks for on each target's own PATH
   * before announcing `TargetDescriptor.providers` (SPEC §5.5;
   * `./provider-availability.ts`). Each candidate names a provider id and
   * the vendor CLI its ACP bridge needs on PATH — `AcpProviderModule.
   * requiredCommand`, once `@loombox/providers-core` grows one per real
   * provider module; this node has no compile-time dependency on that
   * package's module shape, only this minimal `{ id, requiredCommand }`
   * structural type, so a real registered-module list is already
   * assignable here with no import. Defaults to `[]`: with nothing to
   * check for, every target simply announces `providers: []` (a
   * legitimate, empty-but-reachable result) and no target is ever probed.
   */
  providerCandidates?: ProviderAvailabilityCandidate[];
  /**
   * D1-3's node-side security boundary for custom ACP agents (`docs/
   * superpowers/specs/2026-08-05-zed-parity-decisions.md` §4; issue #748)
   * — see `./config.ts`'s `NodeCliConfig.customAgentAllowlist` for the full
   * "how it is edited" story (`main.ts`'s `start()` is what actually
   * threads that config field through to here). Defaults to `[]`: a fresh
   * `NodeDaemon` refuses every custom agent until an operator explicitly
   * allowlists one, never trust-on-first-use.
   */
  customAgentAllowlist?: readonly string[];
  /**
   * Per-target CPU/RAM/disk sampling (SPEC §7.16/§7.21; issues #253/#269).
   * `enabled` defaults to `false`: constructing a `NodeDaemon` never spins up
   * a background timer or proactively opens an `ssh:` target's pooled
   * transport (`getSshTransport`, connecting it if not already) just to
   * sample it — every existing test that builds a `NodeDaemon` (and doesn't
   * ask for this) sees no new background work or connection attempts.
   * `main.ts`'s real `createNode()` call turns this on explicitly. When
   * enabled, a `local`-kind target samples via `sampleLocalResources`; an
   * `ssh:`-kind target with a matching `sshTargets` entry samples via
   * `sampleRemoteResources` over that same pooled transport (never a second
   * connection); an `ssh:`-kind target with no connection recipe is simply
   * never sampled (mirrors `getExecutionTarget`'s own "no target config"
   * case, just skipped rather than thrown). `intervalMs`/`timeoutMs` tune
   * `TargetHealthSampler`'s own defaults (30s / 10s).
   */
  resourceSampling?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
  };
  /**
   * Namespace/bind-mount sandboxing for a `local` session's agent process
   * (SPEC §7.17; issue #257) — see `./session-sandbox.ts`'s
   * `resolveSessionSandbox()` doc comment for what "confined" means, the
   * Linux-only reach, and why an `ssh:` session never goes through it.
   * `enabled` defaults to `false`, the same off-by-default-in-tests shape
   * as `resourceSampling` above and for an analogous reason: turning this
   * on unconditionally would wrap every existing test's fixture-agent
   * spawn in `bwrap` too — most of this suite's fixture providers point
   * `command` at `process.execPath` with a fixture script living outside
   * the session's ephemeral worktree by design (they exist to exercise
   * ACP wiring, not containment) — and the sandbox would then correctly
   * deny that fixture the read access it needs to even start, breaking
   * hundreds of unrelated tests. `main.ts`'s real `createNode()` call
   * turns this on explicitly for every real node (same pattern as
   * `resourceSampling`); `node-daemon-sandbox.test.ts` exercises the real
   * end-to-end wiring, including the fail-closed path, with this
   * explicitly enabled. When enabled, `launchLocalSession` calls
   * `resolveSessionSandbox()` before ever spawning: on Linux with a
   * working sandbox it wires `AgentSupervisorStartOptions.wrapSpawnConfig`
   * so the agent process is genuinely confined to the session worktree; on
   * Linux without one (missing `bwrap`, or a kernel that refuses
   * unprivileged user namespaces) `resolveSessionSandbox` throws and the
   * existing spawn-failure path reports it to the client via
   * `sendSessionStatus(id, 'error', …)` — the session is refused, never
   * silently run unsandboxed. On a non-Linux host it is a no-op today:
   * SPEC's documented weaker macOS fallback is a separate, not-yet-built
   * concern, not something this flag pretends to provide.
   */
  sessionSandbox?: { enabled?: boolean };
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
  /**
   * Injected for tests; defaults to a `SessionManager` backed by a fresh
   * `SessionStore({ stateDir })` (issue #515) — every node persists its
   * session records across a restart unless a caller injects its own
   * `SessionManager` (e.g. a bare in-memory one, matching every pre-#515
   * test in `session-manager.test.ts`).
   */
  sessionManager?: SessionManager;
  /**
   * Ceiling on how long `AgentSupervisor.start()` may take before a `local`
   * session's creation gives up on it (issue #516). Defaults to 120_000
   * (120s): the observed real-world worst case — a cold `npm exec` registry
   * install plus a stalled ACP handshake — ran for nine minutes with no
   * ceiling at all; 120s is comfortably past a warm-cache spawn (normally
   * well under a second) while still failing fast enough that a client
   * isn't left staring at a spinner for minutes on a genuinely stuck agent.
   * The session's worktree is never torn down when this fires — see
   * {@link createSessionInternal}'s doc comment for why an `error` status
   * the user can see and archive is the honest outcome, not a silent
   * rollback. Not (yet) applied to `launchReservedSshSession`'s
   * `startWithChild()` call — issue #516 flagged that path as sharing the
   * same unbounded-spawn shape, but bounding it needs its own decision
   * about what "give up" means for a remote, possibly-detached process,
   * which is out of this option's scope.
   */
  sessionStartTimeoutMs?: number;
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
  /**
   * This node's per-secret direct-agent-env-injection grant ACL (SPEC
   * §7.17, §8; issue #258), used at session start to resolve a project's
   * declared env-var list (`SessionPrivateMetaV1.projectEnvDecls`) into
   * the plain env `AgentSupervisor.start()` merges into the spawned
   * agent process — reuses `mcpSecretManager`'s own secret-value storage
   * rather than a second one (see `NodeProjectEnvManager`'s doc
   * comment). Injectable for tests; defaults to a fresh
   * `NodeProjectEnvManager({ stateDir, secrets: this.mcpSecretManager })`.
   */
  projectEnvManager?: NodeProjectEnvManager;
  /**
   * This node's per-project permission policy store (SPEC §7.17; issue
   * #256): allow/deny command and network-destination glob rules, checked
   * at `getExecutionTarget()` (when called with a `projectPath`) and at
   * every interactive terminal this node opens — see
   * `./permission-policy.ts`'s doc comment for the enforcement model.
   * Injectable for tests; defaults to a fresh
   * `PermissionPolicyStore({ stateDir })`.
   */
  permissionPolicyStore?: PermissionPolicyStore;
  /**
   * This node's per-project spend cap store (SPEC §7.16; issue #251):
   * the project-scoped half of the two-scope resolution
   * `effectiveSpendCapUsd` performs — the session-scoped half lives
   * directly on `SessionManager`'s own `Session.spendCapUsd`, not here.
   * Injectable for tests; defaults to a fresh `SpendCapStore({ stateDir })`.
   */
  spendCapStore?: SpendCapStore;
  /**
   * This node's persisted spend-over-time ledger (SPEC §7.9; issue
   * #249): every `usage_update` cost increase this daemon has ever
   * observed, grouped by day/project/provider, fed into
   * `spend_report_request`'s reply — see `spend-ledger-store.ts`'s own
   * doc comment for why this is a separate store from `spendCapStore`
   * above rather than derived from it (a cap is a configured limit; this
   * is the actual spend history, at a different granularity and with a
   * different lifetime). Injectable for tests; defaults to a fresh
   * `SpendLedgerStore({ stateDir })`.
   */
  spendLedgerStore?: SpendLedgerStore;
  /**
   * This node's named agent-profile catalog (design spec
   * `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752): the
   * account-scoped sibling of `permissionPolicyStore` above — see
   * `./agent-profile.ts`'s doc comment for the "profiles gate existence,
   * the glob policy gates approval mode" split, and `./agent-profile-store.ts`'s
   * for why this is one flat catalog with no `projectPath` key at all.
   * Injectable for tests; defaults to a fresh `AgentProfileStore({ stateDir })`.
   */
  agentProfileStore?: AgentProfileStore;
  /**
   * This node's per-project test/lint/build command config store (SPEC
   * §7.15; issue #245): what `test_runner_config_get`/`_set`/`_detect`
   * read/write, keyed by `bridge.session.projectPath` exactly like
   * `permissionPolicyStore` above. Injectable for tests; defaults to a
   * fresh `TestRunnerConfigStore({ stateDir })`.
   */
  testRunnerConfigStore?: TestRunnerConfigStore;
  /**
   * This node's native tracker store (SPEC §7.10; issue #212, on top of
   * #210's `NativeTrackerStore`): backs `tracker_snapshot_request`/
   * `tracker_write_request` — the kanban/list UI's own read/write path,
   * keyed directly by the wire message's own `projectPath` (issue #697's
   * node-addressing: no session/bridge required to read or write a
   * project's records). The same store #211's (not-yet-hosted, #627) MCP
   * tools bind to, so a human's UI edit and an agent's `tracker_update`
   * tool call land in the same on-disk file. Injectable for tests;
   * defaults to a fresh `NativeTrackerStore({ stateDir })`.
   */
  nativeTrackerStore?: NativeTrackerStore;
  /**
   * Passed straight through to `discoverSshTargets` (SPEC §7.23 step 1;
   * redesign v2 §3.2; issue #475) when this node handles an
   * `ssh_discovery_request` — the add-target wizard's candidate-card picker
   * asking THIS node to autodetect from its own `~/.ssh/config` + ssh-agent,
   * for a client (e.g. the PWA) with no local filesystem/IPC access of its
   * own. Tests override `homeDir`/`configPath`/`env`, mirroring
   * `wire-provision-and-pair.ts`'s own `discoverOptions`.
   */
  sshDiscoveryOptions?: DiscoverSshTargetsOptions;
  /** Injectable for tests; defaults to the real `discoverSshTargets`. */
  discoverSshTargetsImpl?: typeof discoverSshTargets;
  /**
   * Where a `decommission_target_request` (Remove, or the teardown half of
   * Edit — redesign v2 §3.3; issue #476) persists a target's removal.
   * Defaults to a fresh `SshTargetStore({ stateDir })`, exactly like
   * `mcpConfigStore`/`mcpSecretManager`'s own default-construction
   * convention above.
   */
  sshTargetStore?: SshTargetStore;
  /**
   * Configures the "Update" action (redesign v2 §3.3; issue #476):
   * `TargetUpdateMonitor.updateTarget`'s own `PlanSupervisorProvisioningOptions`
   * inputs, minus `targetVersion` (the monitor supplies that itself from
   * `pinnedVersion`). Left `undefined` by default — no real
   * `SupervisorArtifactSource` exists yet in this codebase
   * (`./ssh/supervisor-artifact.ts`'s own doc comment: "a real fetch
   * implementation is a follow-up"), so a `target_update_request` against a
   * node with none configured replies `ok: false` with an explanatory
   * message rather than pretending to update anything real. Tests inject a
   * fake `artifactSource` to exercise the real update path.
   */
  targetUpdate?: {
    /** This node's pinned supervisor version — every target this node updates is brought to exactly this version. */
    pinnedVersion: string;
    artifactSource: SupervisorArtifactSource;
    /** This node's pinned Ed25519 public key (raw 32 bytes), checked against every fetched artifact before it's staged. */
    publicKey: Uint8Array;
    /** Overrides the remote supervisor base directory; defaults to `$HOME/.loombox/supervisor` (see `supervisor-provisioning.ts`). */
    baseDir?: string;
  };
  /** SPEC §7.26, issue #230 — see `NodeDaemonOptions.jiraConnectService`/`accountPinStore`'s doc comments for the sibling stores this shares its convention with. Defaults to `new GithubConnectService({stateDir: options.stateDir})`. */
  githubConnectService?: GithubConnectService;
  /** Overrides `resolveGithubConnectClientId()`'s env lookup (`LOOMBOX_GITHUB_CONNECT_CLIENT_ID`) — tests inject a fixed id so they never depend on the real env. `undefined` (no client id configured, in production or a test) makes `github_connect_start_request` reply with a named `'error'` failure rather than attempting a device-flow call GitHub would just reject. */
  githubConnectClientId?: string;
  /** SPEC §7.26, issue #230 — see `NodeDaemonOptions.mcpConfigStore`'s own default-construction convention above. Defaults to `new JiraConnectService({stateDir: options.stateDir})`. */
  jiraConnectService?: JiraConnectService;
  /** SPEC §7.26, issue #227/#230 — this node's per-project, per-capability account pin map. Defaults to `new AccountPinStore({stateDir: options.stateDir})`, same convention as `mcpConfigStore`/`permissionPolicyStore` above. */
  accountPinStore?: AccountPinStore;
  /** SPEC §7.10, issue #631 — this node's per-project `TrackerMode` (see `tracker-mode-store.ts`'s doc comment for why this exists at all: it replaces the browser-`localStorage`-only version that made the node structurally unable to honour a project's `live` choice). Defaults to `new TrackerModeStore({stateDir: options.stateDir})`, same convention as `accountPinStore` above. */
  trackerModeStore?: TrackerModeStore;
  /** Injectable for tests; defaults to each composed `GithubTrackerBackend`/`JiraTrackerBackend`'s own default (the global `fetch`) — see `resolveTrackerBackend`'s own `fetchImpl` doc comment. Issue #631's acceptance: a live-mode bridge test must stub this, never hit a real GitHub/Jira API. */
  trackerBackendFetchImpl?: typeof fetch;
  /** SPEC §7.14, issue #239 — persists which sessions' open PRs `CiCheckWatcher` polls, across a restart. Defaults to `new CiWatchStore({stateDir: options.stateDir})`, same convention as `accountPinStore`/`spendCapStore` above. */
  ciCheckWatchStore?: CiWatchStore;
  /** SPEC §7.14, issue #239 — the whole polling engine, injectable wholesale (rather than just its `fetchImpl`, like `trackerBackendFetchImpl` above) so a test can fully control both the stubbed GitHub responses AND `resolveToken`, decoupled from this daemon's real `accountPinStore`/`githubConnectService` composition, which is proven separately by `resolveCiCheckGithubToken`'s own test. Defaults to a real `CiCheckWatcher` wired to `resolveCiCheckGithubToken`/`sendCiCheckStatus`/`handleCiCheckFailure`. */
  ciCheckWatcher?: CiCheckWatcher;
  /** SPEC §7.14/§7.15, issue #246 — decides whether a new CI failure actually drives a new agent turn, and tracks the resulting auto-iterate loop's state; see `ci-auto-iterate.ts`'s own doc comment. Injectable wholesale, same convention as `ciCheckWatcher` above (a test can control `maxAttempts`/`now` directly, or inject a fully custom instance). Defaults to `new CiAutoIterateController()`. */
  ciAutoIterateController?: CiAutoIterateController;
}

export interface CreateNodeSessionOptions {
  /** Absolute path to the project folder to run the session against — does not have to be a git repository (SPEC §6); only isolating into a worktree (see `worktree` below) requires one. */
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
   * Reachable two ways, both landing on this same option: this direct API,
   * and a relay-driven `session_create`, whose private envelope carries the
   * identical per-session choice (`SessionPrivateMetaV1.worktree`,
   * `@loombox/protocol`) that `handleSessionCreate` reads and threads
   * straight through — omitting it there falls back to the same
   * per-target default this option applies when omitted here.
   */
  worktree?: boolean;
  /** D1-3's custom ACP agent for this session (issue #748) — mirrors `SessionPrivateMetaV1.customAgent`'s doc comment; still gated by this node's own `customAgentAllowlist` at spawn time, exactly like the relay-driven `session_create` path. */
  customAgent?: CustomAgentRecordV1;
  /**
   * `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752) gates this
   * session's tool set, applied from the moment it spawns. `undefined`
   * (every existing caller) means unrestricted, unchanged from before
   * this option existed. An id this account has no profile for degrades
   * quietly to unrestricted rather than failing session creation — see
   * `./agent-profile.ts`'s doc comment.
   */
  profileId?: string;
  /**
   * MCP server declarations to merge into this session's effective set
   * (issue #750, D2-2), already parsed/validated — mirrors this node's
   * own `McpConfigStore` records, but scoped to this one call rather than
   * persisted. This is the direct-API counterpart to `session_create`'s
   * `SessionPrivateMetaV1.mcpServerConfigs`: `handleSessionCreate` parses
   * that wire field into exactly this shape before calling through to
   * `createSessionInternal`, so both entry points share the one
   * resolution path in `resolveMcpServers`.
   */
  mcpServerConfigs?: McpServerConfig[];
  /**
   * This project's declared env-var injection for the spawned agent
   * process itself (SPEC §7.17, §8; issue #258) — mirrors
   * `mcpServerConfigs`'s own doc comment: the direct-API counterpart to
   * `session_create`'s `SessionPrivateMetaV1.projectEnvDecls`, sharing
   * the one resolution path in `NodeProjectEnvManager.resolveForSession`.
   * A missing/ungranted referenced secret fails session creation outright
   * (see `createSessionInternal`'s own doc comment) rather than starting
   * an agent quietly missing a credential it declared it needed.
   */
  projectEnvDecls?: ProjectEnvVarDecl[];
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
  /** Still-live `@`-mention pills this turn references (issue #742); omitted/empty for a prompt with none. */
  mentions?: PromptMentionRef[];
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

/**
 * Thrown by {@link NodeDaemon}'s internal `startAgentWithTimeout` when
 * `AgentSupervisor.start()` doesn't resolve within
 * `NodeDaemonOptions.sessionStartTimeoutMs` (issue #516). Never surfaces to
 * the relay/client directly — `createSessionInternal` catches it, reports
 * the session as `'error'` (see {@link NodeDaemon.sendSessionStatus}), and
 * rethrows only to the direct in-process caller of `createSession()`.
 */
class SessionStartTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `NodeDaemon: agent spawn for session ${sessionId} did not complete within ${timeoutMs}ms (issue #516)`,
    );
    this.name = 'SessionStartTimeoutError';
  }
}

class PathTraversalError extends Error {
  constructor(readonly requestedPath: string) {
    super(`path escapes the session's project root: ${requestedPath}`);
    this.name = 'PathTraversalError';
  }
}

interface McpFailureAttribution {
  readonly name: string;
  readonly category: McpServerFailureCategoryV1;
  readonly reason: string;
}

/**
 * Attributes an `AcpClient.newSession` rejection to one specific `servers`
 * entry by name (issue #750, D2-2) — verified against a real `omp acp`
 * binary: a server it cannot start rejects with `"<name>: <detail>"`
 * inside the JSON-RPC error's own message, for both an absent binary
 * (`Executable not found in $PATH: "..."`) and a failed MCP handshake
 * (`MCP error -32601: ...`) — so this matches `": <name>: "` against
 * every currently-attempted server's own name and classifies whichever
 * one matches by whether its detail names a missing executable. Returns
 * `undefined` for an error that names none of `servers` — a failure this
 * node cannot pin on any specific MCP server, so {@link
 * NodeDaemon.startAgentWithMcpFallback} rethrows it unchanged rather than
 * swallowing it as if it were one more bad server.
 */
function attributeMcpFailure(
  error: unknown,
  servers: readonly AcpMcpServerConfig[],
): McpFailureAttribution | undefined {
  if (!(error instanceof Error)) return undefined;
  for (const server of servers) {
    const marker = `: ${server.name}: `;
    const index = error.message.indexOf(marker);
    if (index === -1) continue;
    const reason = error.message.slice(index + marker.length);
    const category: McpServerFailureCategoryV1 = /executable not found|enoent/i.test(reason)
      ? 'missing_binary'
      : 'handshake_failed';
    return { name: server.name, category, reason };
  }
  return undefined;
}

/**
 * Re-validates a decrypted `SessionPrivateMetaV1.mcpServerConfigs` list
 * (already `@loombox/protocol`'s own zod-shaped, issue #750, D2-2) through
 * `@loombox/providers-core`'s `parseMcpServerConfig` — the canonical,
 * domain-level `McpServerConfig` type `resolveMcpServers` actually merges,
 * and the one place a var-decl invariant `mcpServerConfigV1`'s own schema
 * doesn't itself enforce would still be caught. A single malformed entry
 * is dropped (logged, not thrown) rather than failing the whole list —
 * the same forgiving, degrade-one-entry convention `mcp-server-store.ts`'s
 * `parseStoredRecord` already uses client-side for this exact list, so a
 * client one release ahead (a config shape this node doesn't understand
 * yet) never blocks every other, understood server in the same list.
 */
function parseClientDeclaredMcpServers(
  raw: readonly McpServerConfigV1[] | undefined,
): McpServerConfig[] {
  if (!raw) return [];
  const result: McpServerConfig[] = [];
  for (const entry of raw) {
    try {
      result.push(parseMcpServerConfig(entry));
    } catch (error) {
      console.warn(
        `NodeDaemon: dropping a malformed client-declared MCP server config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
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
 * Derives one target's symmetric key from the account's AMK (SPEC §7.25's
 * directory picker; issue #474) — the crypto boundary a `target_fs_list_
 * request`/`target_fs_list_response` is sealed under, NOT
 * `deriveSessionKey`'s session-derived key, since there is no session yet
 * when browsing a target. Path: `['target', accountId, targetId]`,
 * namespaced under its own `'target'` segment exactly like
 * `deriveSessionKey`'s `'session'` segment (`packages/crypto/src/session-
 * keys.ts`'s doc comment), so it can never collide with a session key even
 * for the same account.
 *
 * Lives here rather than in `@loombox/crypto` (unlike `deriveSessionKey`)
 * because this issue's scope doesn't touch that package — duplicated
 * verbatim in `apps/web/src/lib/relay-client.ts`'s own `deriveTargetKey` so
 * both sides derive the identical key from the same already-exported
 * `deriveKeyTree`/`importAesGcmKey` primitives (see that copy's doc comment
 * for the same reasoning). Any future third caller of this exact derivation
 * should be the trigger to promote it into `@loombox/crypto` alongside
 * `deriveSessionKey`, rather than growing a third copy.
 */
async function deriveTargetKey(
  amk: Uint8Array,
  accountId: string,
  targetId: string,
): Promise<CryptoKey> {
  const node = await deriveKeyTree(amk, ['target', accountId, targetId]);
  return importAesGcmKey(node.key);
}

/**
 * Emitted once per attachment after {@link NodeDaemon.resolveAttachment}
 * fetches and decrypts it while handling an inbound `prompt_inject` (SPEC
 * §7.25 "Deliver to the executing host"; issue #156) — the plaintext bytes
 * made available on this host, before {@link NodeDaemon.deliverPrompt}
 * hands them to `buildInlineImageContentBlock` (SPEC §7.25 "Hand off to the
 * agent"; issue #158) for this turn's actual ACP content block. This event
 * fires regardless of whether the inline hand-off succeeds — see
 * {@link AttachmentHandoffDeclined} for the companion event when it
 * doesn't.
 */
export interface ResolvedAttachment {
  sessionId: string;
  ref: string;
  mimeType: string;
  name: string | undefined;
  bytes: Uint8Array;
}

/**
 * Emitted from {@link NodeDaemon.deliverPrompt} when a resolved
 * attachment's bytes did NOT become an inline ACP image block for this
 * turn (SPEC §7.25 "Hand off to the agent"; issue #158) —
 * `buildInlineImageContentBlock`'s own `InlineImageHandoffFailureReason`
 * (`@loombox/providers-core`), verbatim: `'capability-not-negotiated'` for
 * a session whose agent never advertised the `image` prompt capability (the
 * common, expected case for a provider without it — not itself an error),
 * `'oversize'` for a payload over the inline cap, or `'unsupported-format'`
 * for bytes that don't re-sniff as one of the four allowed image formats.
 * Never blocks the turn: the prompt still reaches the agent as text (plus
 * whatever other attachments DID build a block), and this attachment's
 * `blob_ref` file event already went out to every other subscribed client
 * regardless — only the live agent doesn't receive these particular bytes
 * inline this turn.
 */
export interface AttachmentHandoffDeclined {
  sessionId: string;
  ref: string;
  reason: InlineImageHandoffFailureReason;
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
   * Per-bridge counter of prompts sent so far (issue #603) — incremented
   * by {@link NodeDaemon.autoCheckpointBeforeTurn} right before each
   * turn's checkpoint, purely to label that checkpoint's `message`
   * (`auto: before turn <n>`) distinctly; nothing reads this back as an
   * authoritative turn index (that's `currentTurnId`'s own wire-facing
   * id, above). Resets every time this bridge is (re)constructed — a
   * live session's own lifetime, never persisted across a node restart.
   */
  turnCount?: number;
  /**
   * Chains every {@link NodeDaemon.autoCheckpointBeforeTurn} call for this
   * bridge (mirrors `sendQueue` just above) so two turns fired close
   * together — each with its own, otherwise-independent `deliverPrompt`/
   * `handlePromptInject` call, since neither is awaited by its own caller
   * — can never run `GitCheckpointStore.checkpoint()` concurrently
   * against the same worktree — `checkpoint()` is a dozen-plus sequential
   * `git` plumbing calls building on the SAME ref/object graph
   * (`write-tree`/`commit-tree`/`update-ref`), and interleaving two of
   * those sequences was observed to intermittently fail with git errors
   * like "trying to write ref ... with nonexistent object".
   */
  checkpointQueue?: Promise<void>;
  /**
   * Set only for an `ssh:` target's session (issue #80): the local bridge
   * object polling the remote run. `close()` must reach this directly
   * (rather than going through `AgentSupervisor.stop()`, which always kills)
   * so this node exiting stops *this local bridge* without terminating the
   * still-running remote agent process.
   */
  remoteChild?: RemoteAgentChildProcess;
  /**
   * This session's live cumulative cost in USD (SPEC §7.9/§7.16; issue
   * #251), accumulated from every `usage_update.costUsd` this bridge has
   * seen (`wireAgentSession`'s `'transcript_update'` listener), as a
   * running max — mirrors `@loombox/providers-core`'s `reduceUsage`
   * exactly, since ACP's `cost.amount` is the agent's own cumulative
   * total, not a delta. `undefined` until the agent reports a real cost
   * at least once — see `maybeApplySpendCap`'s own doc comment for why
   * that silence must never be read as $0 spend.
   */
  spendCumulativeCostUsd?: number;
  /**
   * The highest `spendCumulativeCostUsd` this session has been explicitly
   * resumed through (SPEC §7.16; issue #251) — `undefined` (treated as
   * `0`) until the first spend-cap pause/resume cycle. `maybeApplySpendCap`
   * only re-fires the SAME cap once spend grows past this watermark
   * again, so an explicit resume (`handleSessionSpendCapResume`) or a
   * cap-raise that covers current spend (`maybeAutoResumeAfterCapChange`)
   * — both of which advance it to the spend at that moment — never
   * immediately re-triggers the pause it just resolved.
   */
  spendCapAcknowledgedThroughUsd?: number;
}

/**
 * The subset of a {@link SessionBridge} that a handler needing only the
 * session record and which target it runs on actually touches — never
 * `agentSession`, `sendQueue`, or any of the bridge's other live-agent
 * bookkeeping. See {@link NodeDaemon.resolveSessionRouting}'s doc comment
 * for exactly which handlers that is, and why (issue #702).
 */
interface SessionRouting {
  session: Session;
  targetId: string;
}

/** Maps a `GithubConnectService.connect` rejection to `github_connect_result`'s failure outcome — `GithubDeviceFlowError`'s own named `reason` (`'expired_token'` / `'access_denied'` / `'cancelled'`) passes straight through; anything else (no client id, `GithubIdentityError`, a network failure) becomes `'error'`. */
function githubConnectFailureFromError(error: unknown): GithubConnectOutcome {
  if (error instanceof GithubDeviceFlowError) {
    return { outcome: 'failure', reason: error.reason, message: error.message };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { outcome: 'failure', reason: 'error', message: detail };
}

/** Maps one of `account-pin.ts`'s five `AccountResolutionError` subclasses to `account_pin_resolve_response`'s error outcome, field-for-field. `undefined` for anything else — `account-pin.ts`'s own contract is that its resolvers never throw anything but one of these five, so the caller treats that case as a defensive "should not happen" rather than a labelable response. */
function accountPinResolveErrorFromException(error: unknown): AccountPinResolveOutcome | undefined {
  if (error instanceof AccountPinRequiredError) {
    return {
      outcome: 'error',
      errorType: 'AccountPinRequiredError',
      message: error.message,
      capability: error.capability,
    };
  }
  if (error instanceof AccountPinMalformedError) {
    return {
      outcome: 'error',
      errorType: 'AccountPinMalformedError',
      message: error.message,
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
    };
  }
  if (error instanceof AccountHostMismatchError) {
    return {
      outcome: 'error',
      errorType: 'AccountHostMismatchError',
      message: error.message,
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
      expectedHost: error.expectedHost,
      actualHost: error.actualHost,
    };
  }
  if (error instanceof AccountPinDanglingError) {
    return {
      outcome: 'error',
      errorType: 'AccountPinDanglingError',
      message: error.message,
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
    };
  }
  if (error instanceof AmbiguousAccountError) {
    return {
      outcome: 'error',
      errorType: 'AmbiguousAccountError',
      message: error.message,
      capability: error.capability,
      candidateAccountIds: [...error.candidateAccountIds],
    };
  }
  return undefined;
}

/** `AccountPinStore.get`'s `AccountPinMap` (`string | null | undefined` values — `undefined` meaning "never iterated," never actually stored) narrowed to the wire's `AccountPinMapV1` (`string | null` only), by construction rather than a cast: drops any key whose value is `undefined` instead of asserting the type away. */
function toWireAccountPinMap(map: AccountPinMap): AccountPinMapV1 {
  const result: AccountPinMapV1 = {};
  for (const [capability, value] of Object.entries(map)) {
    if (value !== undefined) result[capability] = value;
  }
  return result;
}

/** `PermissionPolicy`'s allow/deny arrays are `readonly` (its own module's own immutability contract); `PermissionPolicyV1`'s are plain wire arrays — this is the one place that boundary gets crossed, so it's named rather than reasserted inline at both call sites in `handlePermissionPolicyGet`/`handlePermissionPolicySet`. */
function toPermissionPolicyV1(policy: PermissionPolicy): PermissionPolicyV1 {
  return {
    command: { allow: [...policy.command.allow], deny: [...policy.command.deny] },
    network: { allow: [...policy.network.allow], deny: [...policy.network.deny] },
  };
}

/** `checkpoint_create`/`_list`/`_restore_preview`/`_restore`'s shared refusal reason for any session but a `local`-target one — `GitCheckpointStore` spawns `git` as a LOCAL child process (its own module doc comment), so an `ssh:` session's `worktreePath` (a path on the remote host) is not reachable from this node at all. See `@loombox/protocol`'s `checkpoint.ts` doc comment for the full "refuse the one you do not support" reasoning. */
const CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE =
  'Checkpoint/rollback needs a local git worktree this node can reach directly; this session runs on an ssh: target, whose files live on a different host (issue #603).';

/** `checkpoint_restore`'s own refusal while the session's agent is actively mid-turn (`AttentionStatus.status === 'working'`) — restoring underneath a live write would race it, leaving the worktree in a state that matches neither the checkpoint nor the turn's own result. Asks the caller to wait for the turn to finish (or stop it) first. */
const CHECKPOINT_TURN_IN_PROGRESS_MESSAGE =
  "This session's agent is actively working on a turn; wait for it to finish (or stop it) before rolling back.";

/** Maps a `GitCheckpointStore` failure to `@loombox/protocol`'s `checkpoint.ts` named `errorType` vocabulary — every checkpoint handler funnels its `catch` through this rather than repeating the same four `instanceof` checks per call site. */
function checkpointErrorOutcome(error: unknown): {
  outcome: 'error';
  errorType: CheckpointErrorTypeV1;
  message: string;
} {
  if (error instanceof CheckpointNotFoundError) {
    return { outcome: 'error', errorType: 'checkpoint_not_found', message: error.message };
  }
  if (error instanceof NotAGitWorktreeError) {
    return { outcome: 'error', errorType: 'not_git_worktree', message: error.message };
  }
  if (error instanceof DetachedHeadError) {
    return { outcome: 'error', errorType: 'detached_head', message: error.message };
  }
  if (error instanceof DirtySubmoduleError) {
    return { outcome: 'error', errorType: 'dirty_submodule', message: error.message };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { outcome: 'error', errorType: 'unknown', message: detail };
}

/** `GitCheckpoint` (`@loombox/supervisor`) → `GitCheckpointV1` (`@loombox/protocol`) — adds `isWorkInPlace`, this wiring's own answer to issue #603's "worktree-isolated and in-place sessions behave differently here" (`checkpoint.ts`'s own doc comment). Derived from `Session.branch === ''`, the same test the `Session` doc comment itself uses to mean "no isolated worktree". */
function toGitCheckpointV1(checkpoint: GitCheckpoint, session: Session): GitCheckpointV1 {
  return { ...checkpoint, isWorkInPlace: session.branch === '' };
}

/** `RestorePreview` (`@loombox/supervisor`) → `RestorePreviewV1` (`@loombox/protocol`) — mirrors {@link toGitCheckpointV1}. */
function toRestorePreviewV1(preview: RestorePreview, session: Session): RestorePreviewV1 {
  return { ...preview, isWorkInPlace: session.branch === '' };
}

/** `AgentProfile`'s three denied-lists are `readonly AcpToolKind[]`/`readonly string[]` (its own module's immutability + ACP-typed contract); `AgentProfileV1`'s are plain, ACP-agnostic wire `string[]`s (`@loombox/protocol` never re-declares ACP's own vocabulary — see that module's doc comment). Named, mirroring `toPermissionPolicyV1` immediately above, rather than reasserted inline at both `handleAgentProfileListGet`/`Set` call sites. */
function toAgentProfileV1(profile: AgentProfile): AgentProfileV1 {
  return {
    id: profile.id,
    name: profile.name,
    deniedToolKinds: [...profile.deniedToolKinds],
    deniedToolNamePatterns: [...profile.deniedToolNamePatterns],
    deniedMcpServers: [...profile.deniedMcpServers],
  };
}

/** The inverse of {@link toAgentProfileV1} — narrows the wire's opaque `string[]` back down to `AcpToolKind[]` for `deniedToolKinds`. Deliberately NOT validated against the real `AcpToolKind` enum here: an unrecognized value (a future ACP kind this build predates, or a client typo) is kept as-is and simply never matches anything at evaluation time — `evaluateAgentProfile`'s own "quiet degrade, never an error" contract, not a place for `agent_profile_list_set` to start rejecting requests. */
function fromAgentProfileV1(profile: AgentProfileV1): AgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    deniedToolKinds: profile.deniedToolKinds as AcpToolKind[],
    deniedToolNamePatterns: [...profile.deniedToolNamePatterns],
    deniedMcpServers: [...profile.deniedMcpServers],
  };
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
  /** See `NodeDaemonOptions.sessionStartTimeoutMs`'s doc comment. */
  private readonly sessionStartTimeoutMs: number;
  private readonly relay: RelayConnection;
  private readonly attachmentResolver: AttachmentResolver;
  private readonly supervisor: AgentSupervisor;
  private readonly terminalSupervisor: TerminalSupervisor;
  /** `terminalId`s this node itself asked to close (`handleTerminalClose`), consulted the moment the underlying PTY's `onExit` fires so `sendTerminalClosed`'s `reason` can say `'closed_by_client'` instead of `'exited'` — see {@link wireTerminalSession}'s doc comment. */
  private readonly clientInitiatedTerminalCloses = new Set<string>();
  /** Chains every `terminal_output` send per terminal (mirrors `SessionBridge.sendQueue`) so concurrent `crypto.subtle.encrypt` calls can never resolve — and so get sent to the relay — out of the order their chunks actually arrived in. */
  private readonly terminalSendQueues = new Map<string, Promise<void>>();
  /** Every currently in-flight test/lint/build run this node started (SPEC §7.15; issue #244), keyed by `runId` — `handleRunCancel` and `close()` are the two things that reach into this map; `executeRun` removes an entry the instant its `run_exit` is sent, whatever the outcome. */
  private readonly activeRuns = new Map<
    string,
    { sessionId: string; cancel: () => Promise<void> }
  >();
  /** Chains every `run_output` send per run (mirrors `terminalSendQueues` above) so concurrent `crypto.subtle.encrypt` calls can never resolve — and so get sent to the relay — out of the order their chunks actually arrived in. */
  private readonly runSendQueues = new Map<string, Promise<void>>();
  private readonly bridges = new Map<string, SessionBridge>();
  /** This session's actually-launched, effective MCP server set (issue #750's fallback loop already excludes any that failed to start) — kept for the lifetime of the bridge so a later `mcp_prompt_get_request` (Zed-parity D5-2, issue #754) can open a fresh connection to the named server without re-resolving secrets/config. Populated by {@link finishSessionCreation}, deleted alongside the bridge itself (see the `'exit'` handler in {@link wireAgentSession} — "the one place a bridge ever leaves the map"). A session reloaded after a node restart (no live bridge) has no entry here, so its `mcp_prompt_get_request`s fail cleanly (`outcome: 'error'`) rather than being served from stale config. */
  private readonly mcpServersBySession = new Map<string, AcpMcpServerConfig[]>();
  private _connected = false;
  private readonly sessionKeys = new Map<string, Promise<CryptoKey>>();
  /** Backs {@link getTargetKey} (SPEC §7.25's directory picker; issue #474) — a target's key is derived once per process, same caching shape as {@link sessionKeys}. */
  private readonly targetKeys = new Map<string, Promise<CryptoKey>>();
  /** Backs {@link getProjectKey} (SPEC §8; issue #697's project-addressed tracker records) — a project's key is derived once per process, same caching shape as {@link sessionKeys}/{@link targetKeys}, keyed by `projectPath`. */
  private readonly projectKeys = new Map<string, Promise<CryptoKey>>();

  private readonly sshTargetConfigs = new Map<string, SshTargetConfig>();
  /** Per-target concurrency caps + overflow queue (SPEC §7.16, issue #252) — the one chokepoint every session's launch (`local` or `ssh:`) passes through; see `./session-concurrency-gate.ts`. */
  private readonly concurrencyGate: SessionConcurrencyGate;
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
  /** SPEC §7.17, §8; issue #258 — see `NodeDaemonOptions.projectEnvManager`'s doc comment. */
  private readonly projectEnvManager: NodeProjectEnvManager;
  /** Per-process (never persisted) consecutive-failure streak for an MCP server that failed to start, keyed by `${projectPath}\u0000${serverName}` — see {@link recordMcpServerOutcome}'s own doc comment (issue #750, D2-2's "disable" lifecycle action). */
  private readonly mcpFailureStreaks = new Map<string, number>();
  /** Consecutive start failures before {@link recordMcpServerOutcome} auto-disables an MCP server (issue #750, D2-2). */
  private static readonly MCP_AUTO_DISABLE_THRESHOLD = 3;
  /** SPEC §7.17; issue #256 — see `NodeDaemonOptions.permissionPolicyStore`'s doc comment. */
  private readonly permissionPolicyStore: PermissionPolicyStore;
  /** SPEC §7.16; issue #251 — see `NodeDaemonOptions.spendCapStore`'s doc comment. */
  private readonly spendCapStore: SpendCapStore;
  /** SPEC §7.9; issue #249 — see `NodeDaemonOptions.spendLedgerStore`'s doc comment. */
  private readonly spendLedgerStore: SpendLedgerStore;
  /** SPEC design spec `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752 — see `NodeDaemonOptions.agentProfileStore`'s doc comment. */
  private readonly agentProfileStore: AgentProfileStore;
  /**
   * A live session's currently active profile id, `undefined` for
   * "unrestricted" (issue #752). Set at session-create time from
   * `CreateNodeSessionOptions.profileId`, and mutable thereafter via
   * `agent_profile_session_set` — the resolver closure
   * {@link evaluateProfileForSession} passes into `AgentSession.spawn()`
   * reads this map fresh on every call, so a mid-session switch applies
   * starting with the very next tool call (never cached, mirrors
   * `PolicyEnforcedPty`'s own policy-resolver contract). Only ever holds
   * an entry for a session with a LIVE bridge — deleted alongside the
   * bridge itself in `wireAgentSession`'s `'exit'` handler, so a
   * reloaded-`'disconnected'` session has nothing stale to read.
   */
  private readonly sessionProfiles = new Map<string, string | undefined>();
  /** SPEC §7.15; issue #245 — see `NodeDaemonOptions.testRunnerConfigStore`'s doc comment. */
  private readonly testRunnerConfigStore: TestRunnerConfigStore;
  /** SPEC §7.10; issue #212 — see `NodeDaemonOptions.nativeTrackerStore`'s doc comment. */
  private readonly nativeTrackerStore: NativeTrackerStore;
  /**
   * Same-folder safety (issue #68, SPEC §7.2) for this node's `ssh:`
   * sessions — a separate instance from `SessionManager`'s own guard
   * (`local` sessions never route through `scheduleSshSession`, so
   * there's nothing to share). Keyed by `` `${targetId}:${projectPath}` ``,
   * since the same path string can genuinely name different folders on
   * different remote hosts.
   */
  private readonly sshSameFolderGuard = new SameFolderGuard();
  /** Per-target CPU/RAM/disk sampling (issues #253/#269) — see `NodeDaemonOptions.resourceSampling`'s doc comment for why it's opt-in. */
  private readonly targetHealthSampler: TargetHealthSampler;
  private readonly resourceSamplingEnabled: boolean;
  /** See `NodeDaemonOptions.sessionSandbox`'s doc comment. */
  private readonly sessionSandboxEnabled: boolean;
  /** Redesign v2 §3.2; issue #475 — see `NodeDaemonOptions.sshDiscoveryOptions`/`discoverSshTargetsImpl`'s doc comments. */
  private readonly sshDiscoveryOptions?: DiscoverSshTargetsOptions;
  private readonly discoverSshTargetsImpl: typeof discoverSshTargets;
  /** Redesign v2 §3.3; issue #476 — see `NodeDaemonOptions.sshTargetStore`'s doc comment. */
  private readonly sshTargetStore: SshTargetStore;
  /** Redesign v2 §3.3; issue #476 — see `NodeDaemonOptions.targetUpdate`'s doc comment; `undefined` until a caller configures it. */
  private readonly targetUpdateOptions?: NodeDaemonOptions['targetUpdate'];
  private readonly targetUpdateMonitor?: TargetUpdateMonitor;
  /** See `NodeDaemonOptions.providerCandidates`'s doc comment. */
  private readonly providerCandidates: ProviderAvailabilityCandidate[];
  /** See `NodeDaemonOptions.customAgentAllowlist`'s doc comment. */
  private readonly customAgentAllowlist: readonly string[];
  /**
   * Latest probed `TargetDescriptor.providers` per target id (SPEC §5.5) —
   * refreshed by {@link refreshProviderAvailability} on this node's first
   * connect and every reconnect thereafter (never on
   * `targetHealthSampler`'s hot resource-sample interval). Cleared for a
   * target the instant {@link forgetSshTarget} drops it, same as every
   * other per-target index this class keeps.
   */
  private readonly providerAvailability = new Map<string, string[]>();

  /** SPEC §7.26, issue #230's GitHub device-flow connect path. */
  private readonly githubConnectService: GithubConnectService;
  /** `resolveGithubConnectClientId()`'s result (or `NodeDaemonOptions.githubConnectClientId`'s test override) — `undefined` means this node has no GitHub OAuth App client id configured, so `handleGithubConnectStartRequest` fails immediately rather than attempting a call GitHub would reject. */
  private readonly githubConnectClientId: string | undefined;
  /** One `AbortController` per in-flight `github_connect_start_request`'s `requestId` — `handleGithubConnectCancelRequest` aborts through it; the entry is removed the moment the flow settles (success, failure, or cancellation), never left to leak. */
  private readonly githubConnectFlows = new Map<string, AbortController>();
  /** SPEC §7.26, issue #230's Jira API-token connect path. */
  private readonly jiraConnectService: JiraConnectService;
  /** SPEC §7.26, issue #227/#230's per-project, per-capability account pin map. */
  private readonly accountPinStore: AccountPinStore;
  /** SPEC §7.10, issue #631's per-project `TrackerMode` — `handleTrackerModeGetRequest`/`handleTrackerModeSetRequest`'s backing store, and ALSO this daemon's own synchronous read surface for other daemon code that needs a project's mode with no wire round trip: read `this.trackerModeStore.get(projectPath)` directly (mirrors `readTrackerSnapshot` already reading `this.nativeTrackerStore` directly, no wrapper needed for a field private to this same class). Consumed by {@link resolveTrackerDispatch}, the shared seam both `readTrackerSnapshot` and `applyTrackerWrite` dispatch through. */
  private readonly trackerModeStore: TrackerModeStore;
  /** SPEC §7.26, issue #631: this node's own view of the connected-account registry, which lives relay-side (`connected_accounts` table, migration `0011_connected_accounts`) — a node has no local copy of its own, exactly like a client. Requested on every fresh relay connection ({@link sendConnectedAccountListRequest}, mirroring {@link sendAmkEpochFetchRequest}) and replaced wholesale on every `connected_account_list` reply ({@link handleConnectedAccountList}) — the wire message carries no `requestId` to correlate (`@loombox/protocol`'s `connectedAccountList` doc comment), so this also transparently picks up a future relay-initiated push, not just this node's own request. Empty until that first reply lands, which is a safe default: `resolveTrackerBackend` sees no accounts and fails closed (`accountNotConnected`), never a stale or fabricated match. `readTrackerSnapshot`/`applyTrackerWrite` (via {@link resolveTrackerDispatch}) are the first consumers. */
  private connectedAccounts: readonly ConnectedAccount[] = [];
  /** `NodeDaemonOptions.trackerBackendFetchImpl`'s stored value — see that field's own doc comment. */
  private readonly trackerBackendFetchImpl: typeof fetch | undefined;
  /** SPEC §7.14, issue #239's persisted watch registry — see `NodeDaemonOptions.ciCheckWatchStore`'s doc comment. */
  private readonly ciCheckWatchStore: CiWatchStore;
  /** SPEC §7.14, issue #239's polling engine — see `NodeDaemonOptions.ciCheckWatcher`'s doc comment. */
  private readonly ciCheckWatcher: CiCheckWatcher;
  /** SPEC §7.14/§7.15, issue #246's failure-decision-and-loop-state tracker — see `NodeDaemonOptions.ciAutoIterateController`'s doc comment. */
  private readonly ciAutoIterateController: CiAutoIterateController;

  constructor(options: NodeDaemonOptions) {
    super();
    this.nodeId = options.nodeId;
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.amk = options.amk;
    this.amkEpoch = options.amkEpoch ?? 0;
    this.targets = options.targets ?? [DEFAULT_LOCAL_TARGET];
    this.sessionManager =
      options.sessionManager ??
      new SessionManager({ store: new SessionStore({ stateDir: options.stateDir }) });
    this.sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? 120_000;
    this.relay = new RelayConnection({
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
      devicePublicKey: options.devicePublicKey,
      authToken: options.authToken,
      webSocketImpl: options.webSocketImpl,
      initialBackoffMs: options.reconnect?.initialBackoffMs,
      maxBackoffMs: options.reconnect?.maxBackoffMs,
      buildIdentity: options.buildIdentity,
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
    const concurrencyLimits: Record<string, number> = {};
    for (const target of this.targets) {
      if (target.kind === 'local') {
        concurrencyLimits[target.id] =
          options.localMaxConcurrentSessions ?? defaultLocalMaxConcurrentSessions();
      } else {
        concurrencyLimits[target.id] =
          this.sshTargetConfigs.get(target.id)?.maxConcurrentSessions ??
          DEFAULT_SSH_MAX_CONCURRENT_SESSIONS;
      }
    }
    this.concurrencyGate = new SessionConcurrencyGate({
      limits: concurrencyLimits,
      defaultMax: DEFAULT_SSH_MAX_CONCURRENT_SESSIONS,
    });
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
    this.projectEnvManager =
      options.projectEnvManager ??
      new NodeProjectEnvManager({ stateDir: options.stateDir, secrets: this.mcpSecretManager });
    this.permissionPolicyStore =
      options.permissionPolicyStore ?? new PermissionPolicyStore({ stateDir: options.stateDir });
    this.spendCapStore = options.spendCapStore ?? new SpendCapStore({ stateDir: options.stateDir });
    this.spendLedgerStore =
      options.spendLedgerStore ?? new SpendLedgerStore({ stateDir: options.stateDir });
    this.agentProfileStore =
      options.agentProfileStore ?? new AgentProfileStore({ stateDir: options.stateDir });
    this.testRunnerConfigStore =
      options.testRunnerConfigStore ?? new TestRunnerConfigStore({ stateDir: options.stateDir });
    this.nativeTrackerStore =
      options.nativeTrackerStore ?? new NativeTrackerStore({ stateDir: options.stateDir });
    this.sshDiscoveryOptions = options.sshDiscoveryOptions;
    this.discoverSshTargetsImpl = options.discoverSshTargetsImpl ?? discoverSshTargets;
    this.sshTargetStore =
      options.sshTargetStore ?? new SshTargetStore({ stateDir: options.stateDir });
    this.targetUpdateOptions = options.targetUpdate;
    this.targetUpdateMonitor = options.targetUpdate
      ? new TargetUpdateMonitor({ pinnedVersion: options.targetUpdate.pinnedVersion })
      : undefined;
    this.providerCandidates = options.providerCandidates ?? [];
    this.customAgentAllowlist = options.customAgentAllowlist ?? [];
    this.githubConnectService =
      options.githubConnectService ?? new GithubConnectService({ stateDir: options.stateDir });
    this.githubConnectClientId = options.githubConnectClientId ?? resolveGithubConnectClientId();
    this.jiraConnectService =
      options.jiraConnectService ?? new JiraConnectService({ stateDir: options.stateDir });
    this.accountPinStore =
      options.accountPinStore ?? new AccountPinStore({ stateDir: options.stateDir });
    this.trackerModeStore =
      options.trackerModeStore ?? new TrackerModeStore({ stateDir: options.stateDir });
    this.trackerBackendFetchImpl = options.trackerBackendFetchImpl;

    this.resourceSamplingEnabled = options.resourceSampling?.enabled ?? false;
    this.sessionSandboxEnabled = options.sessionSandbox?.enabled ?? false;
    this.targetHealthSampler = new TargetHealthSampler({
      intervalMs: options.resourceSampling?.intervalMs,
      timeoutMs: options.resourceSampling?.timeoutMs,
      onSample: () => this.sendTargetStatus(),
    });
    for (const target of this.targets) {
      this.registerHealthProbe(target);
    }
    if (this.resourceSamplingEnabled) {
      this.targetHealthSampler.start();
    }

    // SPEC §7.14, issue #239: re-registers every session whose PR was
    // still being watched before this node last restarted. A session no
    // longer known to `sessionManager` (archived, or its record otherwise
    // gone) has its stale watch entry dropped rather than re-registered —
    // mirrors `SessionManager`'s own reload-then-prune convention for
    // every other per-session store.
    this.ciCheckWatchStore =
      options.ciCheckWatchStore ?? new CiWatchStore({ stateDir: options.stateDir });
    this.ciAutoIterateController = options.ciAutoIterateController ?? new CiAutoIterateController();
    this.ciCheckWatcher =
      options.ciCheckWatcher ??
      new CiCheckWatcher({
        resolveToken: (entry) => this.resolveCiCheckGithubToken(entry.projectPath),
        onUpdate: (sessionId, state) => {
          this.sendCiCheckStatus(sessionId, state).catch((error: unknown) => {
            console.warn(
              `NodeDaemon: failed to send ci_check_status for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          if (state.state === 'passing') {
            const next = this.ciAutoIterateController.onGreen(sessionId);
            if (next) {
              this.sendCiAutoIterateStatus(sessionId, next).catch((error: unknown) => {
                console.warn(
                  `NodeDaemon: failed to send ci_auto_iterate_status for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
            }
          }
        },
        onFailure: (sessionId, state) => {
          this.handleCiCheckFailure(sessionId, state).catch((error: unknown) => {
            console.warn(
              `NodeDaemon: failed to deliver CI failure prompt for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
      });
    for (const record of this.ciCheckWatchStore.list()) {
      if (this.sessionManager.getSession(record.sessionId)) {
        this.ciCheckWatcher.watch(record.sessionId, record);
      } else {
        this.ciCheckWatchStore.remove(record.sessionId);
      }
    }
    this.ciCheckWatcher.start();

    // The relay drops a node's targets/sessions from its registry the
    // moment that node's socket closes, so every fresh 'open' (including
    // reconnects) must re-announce everything this node still holds.
    this.relay.on('open', () => {
      this._connected = true;
      this.sendAmkEpochFetchRequest();
      this.sendConnectedAccountListRequest();
      void this.reannounceAll().then(() => {
        this.emit('connected');
      });
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
   * does not kill the remote agent process"). Also withdraws every session
   * still sitting in {@link concurrencyGate}'s overflow queue (SPEC §7.16,
   * issue #252) — *before* stopping any bridge, deliberately: releasing a
   * bridge's slot can hand it straight to the next queued entry
   * (`SessionConcurrencyGate.release`), and an `ssh:` bridge's local exit
   * can fire synchronously (`RemoteAgentChildProcess.detachLocal()`/`.kill()`
   * are local-only, no real process to wait on) — so cancelling the queue
   * first is the only ordering that can't let a stop-in-progress dequeue and
   * launch a brand-new agent process after this node has already started
   * tearing everything else down.
   */
  close(): void {
    for (const target of this.targets) {
      for (const sessionId of this.concurrencyGate.queuedSessionIds(target.id)) {
        this.concurrencyGate.cancel(sessionId);
      }
    }
    for (const sessionId of [...this.bridges.keys()]) {
      this.stopBridgeIfActive(sessionId);
    }
    this.bridges.clear();
    this.targetHealthSampler.stop();
    this.ciCheckWatcher.stop();
    this.terminalSupervisor.closeAll();
    // Unlike a session's remote agent (issue #80's deliberate "this node
    // exiting does not kill it" — a later reattach still works), a
    // test/lint/build run has no reattach concept at all: best-effort
    // cancel every one still in flight so closing this node never leaves a
    // dangling `sleep`/test-runner process behind (issue #244's own "no
    // leftover process" acceptance). Fire-and-forget — `close()` itself is
    // synchronous — but for `local` the kill signal is sent synchronously
    // inside `cancel()` regardless of whether this promise is awaited.
    for (const active of this.activeRuns.values()) {
      active.cancel().catch(() => {});
    }
    this.activeRuns.clear();
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
   * {@link handleInbound}). Subject to this target's concurrency cap (SPEC
   * §7.16, issue #252): this may resolve with the returned `Session`
   * sitting in the wire's `'queued'` status rather than a live agent yet —
   * see {@link createSessionInternal}.
   */
  async createSession(options: CreateNodeSessionOptions): Promise<Session> {
    return this.createSessionInternal({
      projectPath: options.projectPath,
      provider: options.provider ?? 'claude',
      targetId: options.targetId ?? 'local',
      title: options.title ?? basename(options.projectPath),
      worktree: options.worktree,
      profileId: options.profileId,
      customAgent: options.customAgent,
      mcpServerConfigs: options.mcpServerConfigs,
      projectEnvDecls: options.projectEnvDecls,
    });
  }

  /**
   * Forks `sourceSessionId` from `forkFromTurnId` directly on this node
   * (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue
   * #746) — the node-initiated counterpart to {@link createSession} above,
   * as opposed to a client's `session_fork_request` routed in over the
   * relay ({@link handleSessionForkRequest}). Both paths converge on
   * {@link forkSessionInternal}; see its doc comment for the full set of
   * refusal cases.
   */
  async forkSession(
    sourceSessionId: string,
    forkFromTurnId: string,
    options: { title?: string; provider?: string; targetId?: string } = {},
  ): Promise<Session> {
    const source = this.sessionManager.getSession(sourceSessionId);
    if (!source) {
      throw new Error(`NodeDaemon: no session with id ${sourceSessionId}`);
    }
    return this.forkSessionInternal({
      sessionId: randomUUID(),
      sourceSessionId,
      forkFromTurnId,
      projectPath: source.projectPath,
      provider: options.provider ?? source.provider,
      targetId: options.targetId ?? source.targetId ?? 'local',
      title: options.title ?? basename(source.projectPath),
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
    await this.autoCheckpointBeforeTurn(bridge);
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

  /**
   * Creates a `local` (or routes to {@link scheduleSshSession} for an
   * `ssh:`) session, gated by this target's per-target concurrency cap
   * (SPEC §7.16, issue #252) via {@link concurrencyGate} — the one
   * chokepoint every session's launch passes through, `local` and `ssh:`
   * alike, rather than each target kind reimplementing its own accounting.
   * For `local`: cuts the git worktree via `SessionManager` and announces
   * the session (issue #516's `session_announce`) *before* the cap is even
   * checked, so the board shows the session — `'queued'` or `'starting'`,
   * whichever applies — the instant its worktree exists, extending the
   * exact honesty #516 already established for the worktree-vs-spawn gap
   * one state further back. Under the cap, this proceeds straight through
   * {@link launchLocalSession} to the spawn; over it, it returns
   * immediately with the session in its `'queued'` state, and the actual
   * launch happens later, fire-and-forget, once {@link concurrencyGate}
   * hands it a slot.
   */
  private async createSessionInternal(opts: {
    sessionId?: string;
    projectPath: string;
    provider: string;
    targetId: string;
    title: string;
    worktree?: boolean;
    profileId?: string;
    customAgent?: CustomAgentRecordV1;
    /** The client's own per-project `localStorage` MCP server declarations (issue #750, D2-2), merged into resolution alongside this node's own `McpConfigStore` — see {@link resolveMcpServers}'s doc comment. Omitted/`[]` behaves exactly like before this option existed. */
    mcpServerConfigs?: readonly McpServerConfig[];
    /** This project's declared env-var injection for the spawned agent process itself (SPEC §7.17, §8; issue #258) — see {@link CreateNodeSessionOptions.projectEnvDecls}'s doc comment. Omitted/`[]` behaves exactly like before this option existed. */
    projectEnvDecls?: readonly ProjectEnvVarDecl[];
  }): Promise<Session> {
    const target = this.targets.find((candidate) => candidate.id === opts.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${opts.targetId}"`);
    }

    // Direct agent-env injection (issue #258) is scoped to `local` targets
    // for now: the "Depends on" sandboxing issue (#257) this feature's own
    // issue names is still open, and unlike `mcpServerConfigs` there is no
    // existing mechanism at all for threading extra env into the remote
    // shell command `launchReservedSshSession` builds. Refusing loudly here
    // — before any worktree, lease, or child — is the honest choice over
    // silently starting an `ssh:` agent quietly missing a credential it
    // declared it needed (this issue's own explicit acceptance bar).
    if (target.kind === 'ssh' && (opts.projectEnvDecls?.length ?? 0) > 0) {
      throw new Error(
        `NodeDaemon: project env-var injection (issue #258) is not yet supported for ssh: ` +
          `targets (target "${opts.targetId}") — remove the project's declared env vars, or ` +
          `use a local target, until ssh: support lands.`,
      );
    }

    const sessionId = opts.sessionId ?? randomUUID();

    // Resolved before any worktree/lease/child is touched, and before this
    // session can even be queued (issues #187/#189's "fails clearly on an
    // ungranted/missing secret... before any session opens"): a session
    // that would fail on a missing MCP secret grant, or a missing/ungranted
    // project env-var secret (issue #258), fails right here, not after
    // this node created a worktree, acquired an ssh: lease, or made some
    // other queued session wait behind a request that was always going to
    // fail. An unknown/deleted `profileId` degrades quietly to `undefined`
    // (unrestricted) here — see `./agent-profile.ts`'s doc comment —
    // rather than failing session creation over a stale id. A resulting
    // `McpServerSecretMissingError`/`ProjectEnvVarMissingError` never gets
    // a bridge, or even a `Session`, to hang a normal `sendSessionStatus`
    // off of — `reportMcpPreflightFailure`/`reportProjectEnvPreflightFailure`
    // announce a minimal phantom session record themselves, purely so this
    // failure is visible at all (issue #750, D2-2's "a revoked secret
    // grant... produce a distinct, visible reason"); the worktree/lease
    // cost this comment describes avoiding is still avoided — only a
    // `session_announce` plus a `session_status: 'error'` (and, for the MCP
    // case, an `mcp_server_status`) go out.
    let mcpServers: AcpMcpServerConfig[];
    let projectEnv: Record<string, string>;
    try {
      const profile = opts.profileId ? this.agentProfileStore.get(opts.profileId) : undefined;
      mcpServers = filterMcpServersForProfile(
        await this.resolveMcpServers(opts.projectPath, opts.mcpServerConfigs ?? []),
        profile,
      );
      projectEnv = await this.projectEnvManager.resolveForSession(
        opts.projectPath,
        opts.projectEnvDecls ?? [],
      );
    } catch (error) {
      if (error instanceof McpServerSecretMissingError) {
        await this.reportMcpPreflightFailure(sessionId, opts, error);
      } else if (error instanceof ProjectEnvVarMissingError) {
        await this.reportProjectEnvPreflightFailure(sessionId, opts, error);
      }
      throw error;
    }

    // Recorded before any launch path below, so `evaluateProfileForSession`
    // (the resolver `launchLocalSession`/`launchReservedSshSession` pass
    // into `AgentSession.spawn()`) already has an answer the moment this
    // session's first `session/request_permission` can possibly arrive.
    this.sessionProfiles.set(sessionId, opts.profileId);

    if (target.kind === 'ssh') {
      return this.scheduleSshSession({ ...opts, sessionId }, mcpServers);
    }

    const session = await this.sessionManager.createSession({
      id: sessionId,
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
    await this.announce(session, opts.targetId, opts.title);

    if (this.concurrencyGate.tryAcquire(target.id)) {
      return this.launchLocalSession(session, opts, mcpServers, projectEnv);
    }

    // Over the cap (SPEC §7.16, issue #252): queue rather than launch.
    // `launchLocalSession` runs later, fire-and-forget, once a slot frees —
    // its errors are logged rather than thrown, since by then nothing is
    // left awaiting this call (mirrors `handleSessionCreate`'s own
    // fire-and-forget `.catch`).
    await this.sendSessionStatus(session.id, 'queued');
    this.concurrencyGate.enqueue(target.id, session.id, () => {
      this.launchLocalSession(session, opts, mcpServers, projectEnv).catch((error: unknown) => {
        console.warn(
          `NodeDaemon: queued session ${session.id} failed to start after dequeuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    return session;
  }

  /**
   * The `local` launch itself, split out of {@link createSessionInternal} so
   * it can run either immediately (its target wasn't at its concurrency
   * cap) or later (dequeued by {@link concurrencyGate} once a running
   * session's slot frees — SPEC §7.16, issue #252). The caller must already
   * hold this session's concurrency slot ({@link SessionConcurrencyGate.tryAcquire}
   * having returned `true`, or an `onDequeue` callback) before calling
   * this. On a spawn failure this releases that slot itself (handing it
   * straight to the next queued session on this target, if any) before
   * rethrowing — a slot must never outlive the launch attempt that
   * reserved it, or it leaks (SPEC §7.16's "the leak that would make the
   * feature worse than nothing"). On success the slot instead lives on for
   * as long as the session runs, released only once its agent exits — a
   * crash, a kill, or an explicit stop (see {@link wireAgentSession}'s
   * `'exit'` handler and {@link stopBridgeIfActive}). `seedTranscriptUpdates`
   * is set only by {@link forkSessionInternal}: once the freshly spawned
   * agent's own bridge exists, {@link finishSessionCreation} replays them
   * onto it as this fork's copied history (design spec
   * `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746) — `undefined`
   * for every ordinary creation, which is a no-op.
   */
  private async launchLocalSession(
    session: Session,
    opts: {
      provider: string;
      targetId: string;
      title: string;
      customAgent?: CustomAgentRecordV1;
    },
    mcpServers: AcpMcpServerConfig[],
    /** This project's already-resolved env (issue #258) — see {@link CreateNodeSessionOptions.projectEnvDecls}'s doc comment. `{}` behaves exactly like before this parameter existed. */
    env: Record<string, string>,
    seedTranscriptUpdates?: readonly AcpTranscriptUpdate[],
  ): Promise<Session> {
    await this.sendSessionStatus(session.id, 'starting');

    let agentSession: AgentSession;
    let failedMcpServers: McpServerStatusEntryV1[];
    try {
      const providerId = this.resolveLaunchProviderId(session.id, opts.provider, opts.customAgent);
      // Resolved once per launch attempt, outside the MCP-fallback retry
      // closure below — a real `resolveSessionSandbox()` call spawns a
      // process (bwrap's own self-test, cached process-lifetime after the
      // first) and this session's worktree/target never change between
      // retries, so there is nothing for a second call to catch that the
      // first didn't already. A throw here (Linux, sandbox unavailable —
      // SPEC §7.17's fail-closed requirement) is caught by this method's
      // own `catch` below exactly like a spawn failure already is: the
      // session never reaches `startAgentWithTimeout` at all.
      const wrapSpawnConfig = this.sessionSandboxEnabled
        ? resolveSessionSandbox({ workspacePath: session.worktreePath }).wrapSpawnConfig
        : undefined;
      const outcome = await this.startAgentWithMcpFallback(
        session.projectPath,
        mcpServers,
        (servers) =>
          this.startAgentWithTimeout({
            workspacePath: session.worktreePath,
            providerId,
            mcpServers: servers,
            env,
            evaluateToolProfile: (toolCall) => this.evaluateProfileForSession(session.id, toolCall),
            wrapSpawnConfig,
          }),
      );
      agentSession = outcome.result;
      failedMcpServers = outcome.failedServers;
    } catch (error) {
      this.concurrencyGate.release(opts.targetId);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`NodeDaemon: session ${session.id} failed to start: ${message}`);
      await this.sendSessionStatus(session.id, 'error', message).catch((sendError: unknown) => {
        console.warn(
          `NodeDaemon: failed to report session ${session.id}'s start failure to the relay: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      });
      throw error;
    }

    await this.sendMcpServerStatus(session.id, failedMcpServers);
    return this.finishSessionCreation(
      session,
      agentSession,
      opts,
      mcpServers,
      undefined,
      seedTranscriptUpdates,
    );
  }

  /**
   * Resolves the `providerId` `AgentSupervisor.start()`/`startWithChild()`
   * should spawn for this session (D1-3, issue #748): the registered id
   * verbatim for an ordinary catalogue agent, or — when `customAgent` is
   * set — a freshly-registered, session-scoped provider once this node's
   * own allowlist accepts its `command`. Registered under
   * `` `custom:${sessionId}` `` rather than a shared id, so two concurrent
   * custom-agent sessions can never clobber each other's spawn recipe on
   * `AgentSupervisor`'s single provider map.
   *
   * Throws {@link CustomAgentNotAllowedError} — never silently falls back
   * to `provider` — when `command` isn't allowlisted: this is the one call
   * every custom-agent launch path (`local` and `ssh:` alike) makes before
   * ever touching `AgentSupervisor`, which is what makes the allowlist the
   * actual security boundary rather than a client-trusted hint. A
   * disallowed command never reaches `AgentSupervisor.registerProvider`/
   * `spawnConfig()` at all — nothing here ever executes it "to check".
   */
  private resolveLaunchProviderId(
    sessionId: string,
    provider: string,
    customAgent: CustomAgentRecordV1 | undefined,
  ): string {
    if (!customAgent) return provider;
    assertCustomAgentAllowed(customAgent.command, this.customAgentAllowlist);
    const providerId = `custom:${sessionId}`;
    this.supervisor.registerProvider(createCustomAgentProvider(providerId, customAgent));
    return providerId;
  }

  /**
   * Races `AgentSupervisor.start()` against `sessionStartTimeoutMs`,
   * rejecting with {@link SessionStartTimeoutError} if the spawn hasn't
   * resolved in time (issue #516). A late resolution after the timeout has
   * already fired is not left running unsupervised: nothing else will ever
   * hold this `AgentSession` (the caller already reported `'error'` and
   * moved on), so it's stopped immediately rather than becoming an orphaned
   * process this node has forgotten about — the exact failure mode #516
   * and #515 both describe, just for the agent process instead of the
   * worktree.
   */
  private async startAgentWithTimeout(
    startOptions: AgentSupervisorStartOptions,
  ): Promise<AgentSession> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(
          new SessionStartTimeoutError(startOptions.workspacePath, this.sessionStartTimeoutMs),
        );
      }, this.sessionStartTimeoutMs);
      timer.unref?.();
    });
    const startPromise = this.supervisor.start(startOptions).then(
      (agentSession) => {
        clearTimeout(timer);
        if (timedOut) {
          this.supervisor.stop(agentSession.id);
        }
        return agentSession;
      },
      (error: unknown) => {
        clearTimeout(timer);
        // A spawn that fails AFTER the timeout already lost the race is
        // dropped on the floor by `Promise.race` - handled, since race
        // subscribed to this promise, but invisible. Silently swallowing
        // "the agent died" is how #511 and #516 both stayed hidden for so
        // long, so it gets said out loud here. Rethrowing is deliberate and
        // safe: race has settled, so this goes nowhere, and the pre-timeout
        // path still needs the rejection to propagate.
        if (timedOut) {
          console.warn(
            `NodeDaemon: agent spawn for ${startOptions.workspacePath} failed after it had already timed out: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw error;
      },
    );
    return Promise.race([startPromise, timeoutPromise]);
  }

  /**
   * Wraps one agent-start attempt (`start`) with issue #750's (D2-2) MCP
   * fallback: if the agent's own `session/new` rejection can be
   * attributed to one specific declared server by name — a missing binary
   * or a failed MCP handshake, see {@link attributeMcpFailure} — this
   * retries with that server excluded rather than failing the whole
   * session: "a server that cannot start reports that to the client by
   * name, rather than producing a session with quietly fewer tools" means
   * the session still opens, degraded and honest, not that it must fail
   * outright. A revoked-secret failure never reaches here at all —
   * {@link resolveMcpServers} already rejected it before any spawn
   * attempt, back in `createSessionInternal`. Bounded by construction:
   * each retry strictly shrinks `remaining`, so this terminates within
   * `mcpServers.length + 1` attempts even in the worst case (every server
   * bad) — the final attempt, with `remaining: []`, either succeeds (an
   * agent that needs no MCP servers at all) or fails on something
   * `attributeMcpFailure` can no longer attribute to any server, which
   * rethrows unchanged, exactly like a spawn failure unrelated to MCP
   * always has. Every excluded server's consecutive-failure streak is
   * recorded via {@link recordMcpServerOutcome} (three in a row
   * auto-disables it — see that method's own doc comment), and every
   * server that actually started is recorded as a success, resetting its
   * streak.
   */
  private async startAgentWithMcpFallback<T>(
    projectPath: string,
    mcpServers: AcpMcpServerConfig[],
    start: (servers: AcpMcpServerConfig[]) => Promise<T>,
  ): Promise<{ result: T; failedServers: McpServerStatusEntryV1[] }> {
    let remaining = mcpServers;
    const failedServers: McpServerStatusEntryV1[] = [];
    for (;;) {
      try {
        const result = await start(remaining);
        for (const server of remaining) {
          this.recordMcpServerOutcome(projectPath, server.name, true);
        }
        return { result, failedServers };
      } catch (error) {
        const attribution = attributeMcpFailure(error, remaining);
        if (!attribution) throw error;
        // Recorded BEFORE the push below (issue #794): the streak crossing
        // the auto-disable threshold on THIS failure is exactly what
        // `disabled: true` on the pushed entry reports — see
        // `recordMcpServerOutcome`'s own doc comment.
        const disabled = this.recordMcpServerOutcome(projectPath, attribution.name, false);
        failedServers.push({
          name: attribution.name,
          ok: false,
          category: attribution.category,
          reason: attribution.reason,
          ...(disabled ? { disabled: true } : {}),
        });
        remaining = remaining.filter((server) => server.name !== attribution.name);
      }
    }
  }

  /**
   * `projectPath`'s effective MCP server set (SPEC §7.7; issue #187),
   * merged with `clientDeclared` — the client's own per-project
   * `localStorage` declarations, forwarded at `session_create` time
   * (issue #750, D2-2's "the two config stores stop being two: one
   * resolution path") — via `mergeMcpServerConfigLists`: this node's own
   * `McpConfigStore` record wins outright on a name collision, since it's
   * the one path that can inject a server the user never had to hand-add
   * (a future in-process tracker MCP host, issue #627, is exactly that
   * shape). Every declared secret is then substituted from this node's
   * local grant/secret storage (SPEC §7.17; issue #189) — the exact list
   * a session's `AcpClient.newSession` call receives as `mcpServers`.
   * Throws `McpServerSecretMissingError` (from `@loombox/providers-core`)
   * the moment a required secret is ungranted or has no stored value,
   * naming the server and variable — before this method returns anything,
   * so a caller never gets a partially-resolved list. Returns `[]`
   * (skipping secret resolution entirely) when the merged set is empty,
   * the common case, rather than doing pointless keyring I/O for an empty
   * `requiredSecretsForList`.
   */
  private async resolveMcpServers(
    projectPath: string,
    clientDeclared: readonly McpServerConfig[],
  ): Promise<AcpMcpServerConfig[]> {
    const nodeStoreServers = this.mcpConfigStore.effectiveServers(projectPath);
    const effective = mergeMcpServerConfigLists(nodeStoreServers, clientDeclared);
    if (effective.length === 0) return [];
    return this.mcpSecretManager.resolveForSession(projectPath, effective);
  }

  /**
   * The `AgentSessionSpawnOptions.evaluateToolProfile` closure every live
   * session's `AgentSession.spawn()` call is given (issue #752) — called
   * fresh on every incoming `session/request_permission`, so it re-reads
   * {@link sessionProfiles} and {@link agentProfileStore} from scratch each
   * time rather than closing over a snapshot; that's what makes a
   * mid-session `agent_profile_session_set` apply starting with the very
   * next call. A missing `sessionId` entry, or an id `agentProfileStore`
   * no longer has, both resolve to "no profile" (unrestricted) — the same
   * quiet-degrade contract `evaluateAgentProfile` itself already
   * documents, one layer up.
   */
  private evaluateProfileForSession(
    sessionId: string,
    toolCall: { readonly toolKind?: AcpToolKind; readonly title?: string },
  ): ToolProfileDenial | undefined {
    const profileId = this.sessionProfiles.get(sessionId);
    if (!profileId) return undefined;
    const profile = this.agentProfileStore.get(profileId);
    if (!profile) return undefined;
    const denial = evaluateAgentProfile(profile, toolCall);
    if (!denial) return undefined;
    return {
      profileId: profile.id,
      profileName: profile.name,
      matchedBy: denial.matchedBy,
      rule: denial.matchedBy === 'tool-kind' ? denial.toolKind : denial.rule,
    };
  }

  /**
   * The `ssh:` counterpart to {@link createSessionInternal}'s local branch
   * (SPEC §7.16, issue #252): reserves this session's same-folder slot and
   * cross-node lease FIRST, synchronously with the caller, exactly like
   * before this option existed — a lease conflict or same-folder refusal
   * must still fail immediately with no trace on the board (SPEC §9; issue
   * #82's own tests depend on this: a denied session never
   * `session_announce`s at all). Only once that reservation actually
   * succeeds does this start the lease heartbeat, announce the session, and
   * check {@link concurrencyGate} — under the cap,
   * {@link launchReservedSshSession} runs immediately; over it, this
   * returns right away with the session in its `'queued'` state, and the
   * actual deploy-and-launch happens later, fire-and-forget, once a slot
   * frees.
   */
  private async scheduleSshSession(
    opts: {
      sessionId?: string;
      projectPath: string;
      provider: string;
      targetId: string;
      title: string;
      worktree?: boolean;
      customAgent?: CustomAgentRecordV1;
    },
    mcpServers: AcpMcpServerConfig[],
  ): Promise<Session> {
    const targetId = opts.targetId;
    const sessionId = opts.sessionId ?? randomUUID();

    // Same-folder safety (issue #68, SPEC §7.2): an ssh: session defaults to
    // running in-place (see `launchReservedSshSession`'s `worktree`-
    // defaulting comment) — only an explicit `worktree: true` opts out of
    // the restriction. Reserved before the lease machinery below ever runs,
    // so a refusal here is cheap and leaves nothing to unwind; released in
    // the `catch` if anything after this point throws, and again once the
    // agent process itself exits (see `wireAgentSession`'s `'exit'`
    // handler).
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

      // D1-3 (issue #748): a custom-agent session's `opts.provider` is the
      // `'custom'` wire sentinel, never a registered provider id —
      // `launchReservedSshSession` registers its own session-scoped
      // provider (`custom:${sessionId}`) only once its allowlist check
      // clears, so there is nothing to look up here yet. Skipping this
      // check for that case is not itself a security gap: the actual
      // allowlist enforcement is `launchReservedSshSession`'s
      // `assertCustomAgentAllowed` call, which still runs unconditionally
      // before any spawn recipe is ever built for either session kind.
      if (!opts.customAgent && !this.supervisor.getProvider(opts.provider)) {
        throw new Error(`NodeDaemon: no provider registered for id "${opts.provider}"`);
      }
    } catch (error) {
      // Nothing after the reservation above ever ran to completion — undo
      // it so a subsequent attempt on this same folder isn't stuck refused
      // by a session that never actually came to exist.
      if (inPlace) {
        this.sshSameFolderGuard.release(sameFolderKey, sessionId);
      }
      throw error;
    }

    // The lease is granted from here on — start renewing it immediately
    // (SPEC §9's "renewable lease"), even while this session might still be
    // sitting in the concurrency queue below: nothing else renews it during
    // that wait, and a queue can genuinely take a while to drain.
    this.startLeaseHeartbeat(sessionId);

    const provisional: Session = {
      id: sessionId,
      projectPath: opts.projectPath,
      worktreePath: opts.projectPath,
      target: 'ssh',
      provider: opts.provider,
      branch: '',
      createdAt: Date.now(),
      state: 'running',
      nodeId: this.nodeId,
      targetId,
      spendCapUsd: undefined,
    };
    await this.announce(provisional, targetId, opts.title);

    if (this.concurrencyGate.tryAcquire(targetId)) {
      return this.launchReservedSshSession({ ...opts, sessionId }, mcpServers);
    }

    // Over the cap (SPEC §7.16, issue #252): queue rather than launch.
    // `launchReservedSshSession` runs later, fire-and-forget, once a slot
    // frees — its errors are logged rather than thrown, since by then
    // nothing is left awaiting this call (mirrors `launchLocalSession`'s
    // own queued path).
    await this.sendSessionStatus(sessionId, 'queued');
    this.concurrencyGate.enqueue(targetId, sessionId, () => {
      this.launchReservedSshSession({ ...opts, sessionId }, mcpServers).catch((error: unknown) => {
        console.warn(
          `NodeDaemon: queued ssh: session ${sessionId} failed to start after dequeuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    return provisional;
  }

  /**
   * The `ssh:` deploy-and-launch itself (issue #80), split out of
   * {@link scheduleSshSession} so it can run either immediately (the target
   * wasn't at its concurrency cap) or later (dequeued by
   * {@link concurrencyGate} once a running session's slot frees — SPEC
   * §7.16, issue #252). The caller must already hold this session's lease
   * (via `scheduleSshSession`'s own reservation) and concurrency slot
   * before calling this. Deploys-and-launches the provider's agent detached
   * on the remote host via the pooled `RemoteProcessRunner` for this target
   * — with a tmux/screen fallback when the native mechanism isn't available
   * (#81) — bridges it into an `AcpChildProcess` (`RemoteAgentChildProcess`),
   * and hands that to `AgentSupervisor.startWithChild()`. From here on this
   * session is driven through `AgentSession`/`AgentSupervisor` exactly like
   * a `local` one: {@link finishSessionCreation} is the same shared tail
   * both paths use to wire transcript forwarding and announce to the relay.
   *
   * Sends `'starting'` right after entering the `try` (issue #730 parity
   * with {@link launchLocalSession} — this path used to report neither
   * `'starting'` nor a spawn failure at all, so an `ssh:` session that
   * never came up looked exactly as "Awaiting you" as a `local` one did).
   *
   * On failure, reports `'error'` with the underlying message as `reason`
   * (issue #730 — best effort; a failure to even send that is logged and
   * swallowed, same as {@link launchLocalSession}'s own catch, since the
   * unwind below must still run either way) and releases this session's
   * concurrency slot (handing it to the next queued session on this
   * target, if any), its lease heartbeat, and its same-folder reservation
   * — matching what the pre-#252 single-phase version of this method used
   * to unwind in its own `catch` — before rethrowing (for an immediate
   * launch) or logging (for a dequeued one, via {@link scheduleSshSession}'s
   * own `.catch`). Its actual cross-node lease is deliberately left alone
   * on failure, unchanged from before this split: it simply expires on its
   * own TTL, exactly as it always has.
   *
   * Never sandboxed (SPEC §7.17; issue #257), unlike {@link
   * launchLocalSession}: the agent process this spawns runs on the remote
   * `ssh:` target machine, whose mount namespace this node has no way to
   * touch from here — `./session-sandbox.ts`'s `resolveSessionSandbox()`
   * confines a LOCAL child process via `bwrap`, which only ever makes
   * sense for a process this node itself spawns. Confining a remote
   * agent the same way would need the sandbox primitive to run over the
   * SSH transport instead, which is a real, separate follow-up, not
   * built here — this path keeps launching exactly as it did before this
   * issue, unsandboxed.
   */
  private async launchReservedSshSession(
    opts: {
      sessionId: string;
      projectPath: string;
      provider: string;
      targetId: string;
      title: string;
      worktree?: boolean;
      customAgent?: CustomAgentRecordV1;
    },
    mcpServers: AcpMcpServerConfig[],
  ): Promise<Session> {
    const { sessionId, targetId } = opts;
    const inPlace = !opts.worktree;
    const sameFolderKey = `${targetId}:${opts.projectPath}`;

    await this.sendSessionStatus(sessionId, 'starting');

    try {
      // D1-3 (issue #748): a custom agent is registered on this node's
      // supervisor (under a session-scoped id) only after this node's own
      // allowlist accepts its `command` — an ordinary catalogue provider
      // keeps the pre-#748 lookup unchanged. Same gate `resolveLaunchProviderId`
      // enforces for a `local` session; duplicated here (not shared) because
      // this path needs the `AcpProvider` object itself, not just its id, to
      // build the remote shell command below.
      let providerId: string;
      let provider: AcpProvider | undefined;
      if (opts.customAgent) {
        assertCustomAgentAllowed(opts.customAgent.command, this.customAgentAllowlist);
        providerId = `custom:${sessionId}`;
        provider = createCustomAgentProvider(providerId, opts.customAgent);
        this.supervisor.registerProvider(provider);
      } else {
        providerId = opts.provider;
        provider = this.supervisor.getProvider(providerId);
      }
      if (!provider) {
        throw new Error(`NodeDaemon: no provider registered for id "${providerId}"`);
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

      // Each MCP fallback retry (issue #750, D2-2) redeploys the agent
      // from scratch — `launchWithFallback` through `startWithChild` —
      // since a remote process whose own ACP handshake already failed on
      // a bad MCP server can't simply be re-handed a smaller list; there
      // is no cheaper "just retry session/new" seam once the underlying
      // process is in that state. Costs a real ssh round-trip per
      // excluded server, unlike the local path's free in-process retry —
      // an accepted, honest trade for a target this node redeploys to in
      // the first place.
      const { result, failedServers: failedMcpServers } = await this.startAgentWithMcpFallback(
        opts.projectPath,
        mcpServers,
        async (servers) => {
          const { mode, usedFallback, handle } = await runner.launchWithFallback(
            sessionId,
            command,
          );
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
            providerId,
            child: asAcpChildProcess(remoteChild),
            mcpServers: servers,
            evaluateToolProfile: (toolCall) => this.evaluateProfileForSession(sessionId, toolCall),
          });
          return { agentSession, remoteChild };
        },
      );
      const { agentSession, remoteChild } = result;

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
        spendCapUsd: undefined,
      };

      await this.sendMcpServerStatus(sessionId, failedMcpServers);
      return await this.finishSessionCreation(
        session,
        agentSession,
        { targetId, title: opts.title, customAgent: opts.customAgent },
        mcpServers,
        remoteChild,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendSessionStatus(sessionId, 'error', message).catch((sendError: unknown) => {
        console.warn(
          `NodeDaemon: failed to report ssh: session ${sessionId}'s start failure to the relay: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      });
      this.concurrencyGate.release(targetId);
      this.stopLeaseHeartbeat(sessionId);
      if (inPlace) {
        this.sshSameFolderGuard.release(sameFolderKey, sessionId);
      }
      // D1-3 (issue #748): mirrors `launchLocalSession`'s own reason
      // forwarding — a custom-agent allowlist refusal is the one failure on
      // this path the client must see verbatim rather than a bare "error".
      const reason = error instanceof CustomAgentNotAllowedError ? error.message : undefined;
      await this.sendSessionStatus(sessionId, 'error', reason).catch((sendError: unknown) => {
        console.warn(
          `NodeDaemon: failed to report ssh session ${sessionId}'s start failure to the relay: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      });
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
   *
   * `projectPath` (SPEC §7.17; issue #256), when given, wraps the
   * returned target in a fresh `PolicyEnforcedExecutionTarget` bound to
   * that project's saved permission policy — cheap (reads the already-
   * cached underlying local/`ssh:` target, never opens a second
   * connection or re-instantiates it) and never itself cached, since the
   * same underlying target is shared across every project that happens to
   * use it. Omit it for a target-level, not-tied-to-any-one-project call
   * (this method's own three current callers all do — see
   * `policy-enforced-execution-target.ts`'s doc comment for exactly why
   * none of them are project-scoped today).
   */
  async getExecutionTarget(targetId: string, projectPath?: string): Promise<ExecutionTarget> {
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${targetId}"`);
    }

    const inner = await this.getRawExecutionTarget(targetId, target.kind);
    if (!projectPath) return inner;
    return new PolicyEnforcedExecutionTarget({
      inner,
      projectPath,
      policy: this.permissionPolicyStore.get(projectPath),
    });
  }

  private async getRawExecutionTarget(
    targetId: string,
    targetKind: 'local' | 'ssh',
  ): Promise<ExecutionTarget> {
    if (targetKind === 'local') {
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
    opts: { targetId: string; title: string; customAgent?: CustomAgentRecordV1 },
    mcpServers: AcpMcpServerConfig[],
    remoteChild?: RemoteAgentChildProcess,
    seedTranscriptUpdates?: readonly AcpTranscriptUpdate[],
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
    await this.announce(bridge.session, bridge.targetId, bridge.title);
    this.forwardInitialSessionState(bridge);
    // Zed-parity D5-2 (issue #754): remembered for a later `mcp_prompt_get_
    // request` (see {@link mcpServersBySession}'s own doc comment), then
    // discovery fires fire-and-forget — never blocks session creation on
    // an `npx`/`uvx`-fetched server's own cold start (see
    // `discoverAndSendMcpPrompts`'s doc comment for why this is safe to
    // run after `announce`/`forwardInitialSessionState` rather than
    // awaited before them).
    this.mcpServersBySession.set(session.id, mcpServers);
    this.discoverAndSendMcpPrompts(session.id, mcpServers).catch((error: unknown) => {
      console.warn(
        `NodeDaemon: failed to discover MCP prompts for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    // A fork's copied history (design spec
    // `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746): recorded
    // onto the fresh agent's own transcript exactly like a live arrival
    // would be, then replayed to the relay in the same order — after
    // `forwardInitialSessionState` above, so a subscribing client sees
    // status/config first, history second, live turns third, the same
    // order any other session's own history would arrive in.
    if (seedTranscriptUpdates?.length) {
      agentSession.seedTranscriptUpdates(seedTranscriptUpdates);
      for (const update of seedTranscriptUpdates) {
        this.forwardSessionEvent(session.id, update);
      }
    }

    // D1-3 (issue #748): a custom agent's optional `defaultMode`/
    // `defaultConfigOptions` are applied best-effort, fire-and-forget —
    // never blocking session creation on an agent that rejects one of them
    // (see `applyCustomAgentDefaults`'s own doc comment).
    if (opts.customAgent) {
      this.applyCustomAgentDefaults(bridge, opts.customAgent).catch((error: unknown) => {
        console.warn(
          `NodeDaemon: failed to apply custom agent defaults for session ${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    return session;
  }

  /**
   * Applies a custom agent's optional `defaultMode`/`defaultConfigOptions`
   * (issue #748) via the same live `session/set_config_option` mechanism a
   * user-driven config change already uses (`AgentSession.setConfigOption`,
   * issue #718) — one call per entry, sequentially (never raced against
   * each other on the same ACP connection). Best-effort only: an agent
   * that rejects an unknown mode/option id throws from `setConfigOption`,
   * which is caught by this method's own caller and logged — it never
   * fails the session itself, since a stale/typo'd default shouldn't take
   * down an otherwise-working agent. The resulting change (or lack of one)
   * reaches every client the ordinary way, through `wireAgentSession`'s
   * `configOptions.on('changed', ...)` listener — nothing here forwards
   * anything to the relay directly.
   */
  private async applyCustomAgentDefaults(
    bridge: SessionBridge,
    customAgent: CustomAgentRecordV1,
  ): Promise<void> {
    if (customAgent.defaultMode) {
      await bridge.agentSession.setConfigOption('mode', customAgent.defaultMode);
    }
    if (customAgent.defaultConfigOptions) {
      for (const [category, optionId] of Object.entries(customAgent.defaultConfigOptions)) {
        await bridge.agentSession.setConfigOption(category, optionId);
      }
    }
  }

  /**
   * The one place a `usage_update.costUsd` (already known non-`undefined`
   * by the caller) becomes real state, for BOTH SPEC §7.16's spend-cap
   * enforcement and SPEC §7.9's spend-over-time view (issue #249) — never
   * two divergent computations of "how much did this session actually
   * cost." `cost.amount` is documented as the session's own cumulative
   * total to date, not a per-update delta (see `wireAgentSession`'s
   * former inline comment, moved here), so:
   *
   * 1. `bridge.spendCumulativeCostUsd` becomes the running max of itself
   *    and `reportedCostUsd` — unchanged from before this method existed,
   *    still what `maybeApplySpendCap`/the live usage meter read.
   * 2. The INCREASE over the previous running max (if any — a duplicate
   *    or out-of-order report with no real increase writes nothing) is
   *    persisted into `spendLedgerStore`, attributed to today's UTC
   *    calendar date: ACP's `usage_update` carries no timestamp of its
   *    own, so "today, wall-clock, on this node" is the one honest
   *    attribution available — never a fabricated or backdated one.
   */
  private recordUsageCost(bridge: SessionBridge, reportedCostUsd: number): void {
    const previousCostUsd = bridge.spendCumulativeCostUsd ?? 0;
    bridge.spendCumulativeCostUsd = Math.max(previousCostUsd, reportedCostUsd);
    const deltaUsd = reportedCostUsd - previousCostUsd;
    if (deltaUsd > 0) {
      this.spendLedgerStore.recordDelta(
        new Date().toISOString().slice(0, 10),
        bridge.session.projectPath,
        bridge.session.provider,
        deltaUsd,
      );
    }
  }

  private wireAgentSession(bridge: SessionBridge): void {
    bridge.agentSession.on('transcript_update', (update: AcpTranscriptUpdate) => {
      if (update.kind === 'usage_update' && update.costUsd !== undefined) {
        this.recordUsageCost(bridge, update.costUsd);
        this.maybeApplySpendCap(bridge);
      }
      this.forwardSessionEvent(bridge.session.id, update);
    });

    // D3-4's profile-refusal attribution (issue #752): fed by
    // `AgentSession`'s own `evaluateToolProfile` gate, fired instead of
    // (never alongside) `'attention'`'s `permission_required` — see
    // `AgentSessionSpawnOptions.evaluateToolProfile`'s doc comment.
    bridge.agentSession.on(
      'tool_profile_refusal',
      (payload: { toolCall: AcpToolCallUpdate; denial: ToolProfileDenial }) => {
        this.sendToolProfileRefusal(bridge.session.id, payload).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: failed to send tool_profile_refusal for ${bridge.session.id}: ${message}`,
          );
        });
      },
    );

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
      // SPEC §7.16; issue #251: re-checks a cap that was crossed while
      // this turn was still `'working'`/`'permission_required'` (deferred
      // by `maybeApplySpendCap`'s own doc comment) the instant the turn
      // actually settles — a no-op every other time (session not over
      // cap, or already paused).
      this.maybeApplySpendCap(bridge);
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

    bridge.agentSession.availableCommands.on('changed', (event: AvailableCommandsChangeEvent) => {
      // Same ACP-level-vs-loombox-level session id distinction as the
      // configOptions 'changed' listener just above (issue #741).
      if (event.sessionId !== bridge.agentSession.id) return;
      this.forwardSessionEvent(bridge.session.id, {
        kind: 'available_commands_update',
        commands: event.commands,
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
      // SPEC §7.16, issue #252: this is the ONE place a session's
      // concurrency slot is released after a successful launch — a crash,
      // a kill, `stopBridgeIfActive`'s `supervisor.stop()`, and `close()`'s
      // own teardown all end up here, since every one of them ultimately
      // terminates the underlying child process, which is what fires this
      // event. Hands the freed slot straight to the next queued session on
      // this target, if any (FIFO) — see `SessionConcurrencyGate.release`.
      this.concurrencyGate.release(bridge.targetId);
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
      // Forgotten only now, after every listener above (including the
      // 'attention' one registered earlier in this method, which forwards
      // this same terminal transition's 'exited' `session_status` to the
      // relay) has already run against it — `stopBridgeIfActive` used to
      // delete this synchronously and unconditionally, which silenced that
      // forward for an explicitly-stopped (as opposed to crashed) session:
      // `forwardSessionEvent` no-ops the moment `this.bridges.get()` comes
      // back empty. This is the one place a bridge ever leaves the map.
      this.bridges.delete(bridge.session.id);
      // Zed-parity D5-2 (issue #754): this session's resolved MCP server
      // set has no reason to outlive the bridge that launched it — see
      // {@link mcpServersBySession}'s own doc comment.
      this.mcpServersBySession.delete(bridge.session.id);
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
    // No equivalent initial `available_commands_update` snapshot here
    // (issue #741): unlike config options, ACP has no `session/new`-seeded
    // command catalog to read at creation time — `AvailableCommandsStore`
    // is genuinely empty until the agent's own first
    // `available_commands_update` notification arrives (verified directly
    // against a real `omp acp` binary: it arrives with the first
    // `session/prompt` reply, not before), so there is nothing yet for this
    // method to forward; the `'changed'` listener `wireAgentSession` just
    // registered is what delivers it once the agent actually declares one.
  }

  /**
   * The winning spend cap for `session` (SPEC §7.16; issue #251): its own
   * `spendCapUsd` when set, else its project's `spendCapStore` value,
   * else `undefined` (nothing to enforce) — the more-specific-wins
   * resolution issue #251 asks for, mirroring issue #753's identical
   * "project override beats the remembered value" shape for config
   * options. Deliberately returns only the raw number, never a
   * `{value, source}` pair — a caller that needs to know WHICH scope won
   * (a UI showing "why is this session capped at $10") re-derives that
   * itself from the same two raw values `spend_cap_result` already
   * carries, exactly like `spend-cap.ts`'s own doc comment explains for
   * why the wire payload carries no derived field either.
   */
  private effectiveSpendCapUsd(session: Session): number | undefined {
    return session.spendCapUsd ?? this.spendCapStore.get(session.projectPath);
  }

  /**
   * Auto-pauses `bridge`'s session the moment its cumulative cost crosses
   * its effective spend cap (SPEC §7.16; issue #251) — called on every
   * `usage_update` (after {@link SessionBridge.spendCumulativeCostUsd} is
   * updated, see `wireAgentSession`'s `'transcript_update'` listener) and
   * on every `'attention'` transition (so a cap crossed mid-turn is
   * re-checked the instant the turn actually settles, see below).
   *
   * Five guards, in order, each a real reason this does nothing:
   * 1. Already not `'running'` (paused, ended, or disconnected) — nothing
   *    to (re-)apply; a paused session doesn't get paused again, an ended
   *    one is moot.
   * 2. No effective cap at all — nothing to enforce.
   * 3. `spendCumulativeCostUsd` is `undefined` — THIS agent has never
   *    reported a single `usage_update` with a real `cost.amount` for
   *    this session (SPEC §7.9's rollup has nothing to roll up yet).
   *    Treating that silence as $0 real spend would let a provider that
   *    simply never reports cost trip a cap it never actually reached —
   *    the exact fabrication issue #251's acceptance line rules out. No
   *    usage reported, full stop, regardless of how low the cap is.
   * 4. Not yet over the cap.
   * 5. Already resumed through this exact spend level (`spendCapAcknowledgedThroughUsd`)
   *    — see {@link handleSessionSpendCapResume}/{@link
   *    maybeAutoResumeAfterCapChange}'s own doc comments for why a
   *    resume doesn't itself lower the spend, only raises the watermark
   *    past which the SAME cap is allowed to fire again.
   *
   * The interesting decision is the one AFTER every guard above passes:
   * whether a cap crossed mid-turn interrupts that turn or lets it
   * finish. This lets it finish — "mid-turn" meaning
   * `bridge.agentSession.getAttentionState().status` still reads
   * `'working'` OR `'permission_required'`, not just `'working'`: a
   * pending tool-call approval is still part of the SAME open turn (the
   * agent is blocked on the user, not idle), and pausing out from under
   * it would leave a genuinely confusing state — a `'paused'` session
   * with a still-live, still-answerable permission card, whose approval
   * would let the agent keep running while the UI insists it's paused.
   * Two concrete reasons for "let it finish" at all, not just caution:
   * - There is no ACP-level turn-interrupt wire message today —
   *   `apps/web`'s `RelayClient.interruptTurn` (the real Stop button)
   *   documents this directly: "There is no v1 wire message for the
   *   ACP-level turn interrupt itself yet." Building one specifically
   *   for this cap, before the Stop button that actually needs it has
   *   one, would be new protocol surface out of proportion to this issue
   *   and would risk disagreeing with however #147/#129's real interrupt
   *   eventually lands.
   * - Issue #251's own acceptance line requires "agent process
   *   paused/suspended, not silently killed" — yanking control away from
   *   a tool call already in flight (a diff mid-write, a command
   *   mid-execution) is closer to that ruled-out "kill" than to a clean
   *   pause, and ACP gives no way to resume a half-interrupted turn
   *   cleanly even if the process itself survives.
   *
   * So a cap crossed mid-turn does NOT set some "pausing soon" status and
   * wait: this guard simply returns, and the SAME check runs again —
   * still over the cap, since cost only grows — the instant `'attention'`
   * next settles to `'awaiting_input'`/`'error'`/`'exited'`, which is what
   * actually pauses it. The UI stays honest the whole time: the session's
   * live status keeps reading `'working'`/`'permission_required'` (it
   * genuinely still is) right up until it pauses — never `'paused'` a
   * turn early, and never silently stuck `'working'` forever with no
   * visible consequence of having crossed the cap.
   */
  private maybeApplySpendCap(bridge: SessionBridge): void {
    if (bridge.session.state !== 'running') return;
    const capUsd = this.effectiveSpendCapUsd(bridge.session);
    if (capUsd === undefined) return;
    if (bridge.spendCumulativeCostUsd === undefined) return;
    if (bridge.spendCumulativeCostUsd <= capUsd) return;
    if ((bridge.spendCapAcknowledgedThroughUsd ?? 0) >= bridge.spendCumulativeCostUsd) return;
    const liveStatus = bridge.agentSession.getAttentionState().status;
    if (liveStatus === 'working' || liveStatus === 'permission_required') return;
    this.pauseForSpendCap(bridge, capUsd, bridge.spendCumulativeCostUsd);
  }

  /** Applies the auto-pause itself once every guard in {@link maybeApplySpendCap} has passed: transitions the session to `'paused'` (the agent process is untouched — see `session-manager.ts`'s own `SessionLifecycleState` doc comment for why that's "independent of the supervisor's own process-level concerns" by design) and pushes the `'paused'` status with a `reason` a user can read, in the same field #730 added for a spawn failure. Uses {@link forwardSessionEvent}, not the bridge-less `sendSessionStatus` helper (SPEC §7.24's ordering rule) — this session has a live bridge, and its own `sendQueue` is what guarantees this push lands strictly after the `'attention'`-driven status change that triggered it, never racing an independent unqueued encrypt-and-send. */
  private pauseForSpendCap(bridge: SessionBridge, capUsd: number, spentUsd: number): void {
    this.sessionManager.pauseSession(bridge.session.id);
    const reason = `Spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} — raise the cap or resume to continue.`;
    this.forwardSessionEvent(bridge.session.id, {
      kind: 'session_status',
      // `AcpSessionWireEvent`'s `session_status` variant types `status` as
      // the narrow, ACP-native `AttentionStatus` (5 values) — 'paused' is
      // a `SessionStatusV1` (protocol-side) widening with no
      // `AttentionStatus` counterpart, same category as 'queued'/
      // 'starting'/'disconnected' (`session-events.ts`'s own doc comment:
      // "deliberately NOT added to AcpSessionStatus... protocol-side, not
      // there"). This is the one case among those four that DOES have a
      // live bridge to push through, so it rides `forwardSessionEvent`
      // rather than the bridge-less `sendSessionStatus` — the explicit
      // widening cast here is the node-side mirror of `apps/web`'s
      // `parseSessionWireEvent`, which documents the identical tolerance
      // client-side.
      status: 'paused' as unknown as AttentionStatus,
      updatedAt: new Date().toISOString(),
      reason,
    });
  }

  /**
   * Issue #251's "raising the cap is one of the ways to resume": called
   * right after a `spend_cap_set` write lands (either scope), while the
   * session is still `'paused'`. Auto-resumes ONLY when the newly-
   * effective cap now actually covers the session's current spend —
   * raising a project cap to a number still below what this session has
   * already spent changes the limit without making the old pause any
   * less correct, so it stays paused. Advances {@link
   * SessionBridge.spendCapAcknowledgedThroughUsd} to the current spend on
   * resume, exactly like {@link handleSessionSpendCapResume}'s explicit
   * path does, so the cap doesn't immediately re-fire on the very next
   * `usage_update` for a spend that never actually changed.
   */
  private maybeAutoResumeAfterCapChange(bridge: SessionBridge): void {
    if (bridge.session.state !== 'paused') return;
    const capUsd = this.effectiveSpendCapUsd(bridge.session);
    const spentUsd = bridge.spendCumulativeCostUsd;
    if (capUsd === undefined || spentUsd === undefined || spentUsd > capUsd) return;
    this.sessionManager.resumeSession(bridge.session.id);
    bridge.spendCapAcknowledgedThroughUsd = spentUsd;
    this.pushResumedStatus(bridge);
  }

  /** Pushes the session's real, current attention status right after a spend-cap resume (either path) — never a hardcoded `'working'`/`'awaiting_input'` guess, since a resumed session's agent was idle the whole time it was paused and may have settled anywhere in `AttentionStatus` while it waited. */
  private pushResumedStatus(bridge: SessionBridge): void {
    const attention = bridge.agentSession.getAttentionState();
    this.forwardSessionEvent(bridge.session.id, {
      kind: 'session_status',
      status: attention.status,
      updatedAt: attention.updatedAt,
    });
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

  /**
   * Sends `session_announce` (SPEC §5.6/§8's clear routing metadata plus
   * the encrypted `{title, projectPath}` envelope). Takes the session's
   * identifying fields directly, not a `SessionBridge`, so it can be called
   * before a bridge exists — {@link createSessionInternal} announces a
   * `local` session's `'starting'` status the moment its worktree lands,
   * well before `AgentSupervisor.start()` (and therefore any `AgentSession`
   * to put in a bridge) has even been called (issue #516).
   *
   * Also resolves and includes `branch` (issue #738's B3-3: "the node
   * pushes it with the session's own state" — this method, the one place
   * a session's own state already goes out, rather than a separate
   * client-initiated request). `resolveSessionBranch` itself never throws,
   * but the `getExecutionTarget` call feeding it can (an `ssh:` target
   * decommissioned out from under a still-open session, in particular) —
   * caught right here so a branch this node genuinely cannot resolve right
   * now degrades to "omitted" rather than ever blocking the title/
   * projectPath announce every session's own visibility depends on. Called
   * again on every reconnect (`reannounceAll`), which is this field's own
   * refresh point for an in-place session whose branch changed on disk
   * while nothing else about the session did — see `resolveSessionBranch`'s
   * own doc comment for why that, not a live filesystem watch, is the
   * deliberate answer here.
   */
  private async announce(session: Session, targetId: string, title: string): Promise<void> {
    const key = await this.getSessionKey(session.id);
    let branch: string | undefined;
    try {
      branch = await resolveSessionBranch(await this.getExecutionTarget(targetId), session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`NodeDaemon: failed to resolve branch for session ${session.id}: ${message}`);
    }
    const privateMeta: SessionPrivateMetaV1 = {
      title,
      projectPath: session.projectPath,
      ...(branch === undefined ? {} : { branch }),
    };
    const privateEnvelope = await sealJson(session.id, privateMeta, key);
    const meta: SessionMetaPublic = {
      id: session.id,
      nodeId: this.nodeId,
      targetId,
      accountId: this.accountId,
      provider: session.provider,
      createdAt: session.createdAt,
    };
    this.relay.send({
      type: 'session_announce',
      protocolVersion: PROTOCOL_V1,
      session: meta,
      privateEnvelope,
    });
  }

  /**
   * Pushes one `session_status` lifecycle event (SPEC §7.13/§7.24;
   * `@loombox/protocol`'s `session-events.ts`) straight to the relay,
   * sealed under this session's derived key — the same envelope shape
   * `encryptAndSendUpdate` sends for a bridge that already exists, but
   * usable before one does. Needed for the three transitions that fall
   * outside a bridge's lifetime: `'starting'`, sent right after
   * {@link announce} while the agent is still spawning; an `'error'`
   * reported when that spawn fails or times out (issue #516) or is
   * refused by the custom-agent allowlist (issue #748), with `reason` set
   * to something a user can read (issue #730 — previously only ever
   * reached `console.warn`, never the client); and `'disconnected'`
   * (issue #702), re-sent on every reconnect (see {@link reannounceAll})
   * for every session `SessionManager` reports in that state — a
   * disconnected session never gets a bridge again on its own, so nothing
   * else would ever push this one. Every other status transition rides
   * `wireAgentSession`'s `'attention'` listener once a bridge exists. The
   * relay reassigns the authoritative `seq` on receipt (see
   * `SessionBridge.seq`'s doc comment), so the placeholder `0` here never
   * needs to agree with a bridge's own counter.
   */
  private async sendSessionStatus(
    sessionId: string,
    status: SessionStatusV1,
    reason?: string,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(
      sessionId,
      {
        kind: 'session_status',
        status,
        updatedAt: new Date().toISOString(),
        ...(reason === undefined ? {} : { reason }),
      },
      key,
    );
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      seq: 0,
      envelope,
    });
  }

  /**
   * Pushes one `mcp_server_status` lifecycle event (SPEC §7.7/§7.17;
   * issue #750, D2-2) straight to the relay, sealed under this session's
   * derived key — the same "usable before a bridge exists" shape
   * {@link sendSessionStatus} already has, needed for the same reason:
   * {@link reportMcpPreflightFailure} calls this before any `Session` or
   * bridge exists at all, and {@link launchLocalSession}/
   * {@link launchReservedSshSession} call it right after a successful
   * (possibly degraded) start, also before `finishSessionCreation` builds
   * a bridge. A no-op for an empty list — a session with nothing to
   * report stays exactly as silent as it was before this event existed,
   * matching {@link resolveMcpServers}'s own empty-list short circuit.
   */
  private async sendMcpServerStatus(
    sessionId: string,
    servers: McpServerStatusEntryV1[],
  ): Promise<void> {
    if (servers.length === 0) return;
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(
      sessionId,
      { kind: 'mcp_server_status', servers, updatedAt: new Date().toISOString() },
      key,
    );
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      seq: 0,
      envelope,
    });
  }

  /**
   * Reads every launched server's own `prompts/list` (Zed-parity D5-2;
   * issue #754) via `@loombox/providers-core`'s independent MCP client
   * (`fetchMcpServerPrompts` — a second connection per server, separate
   * from whatever the ACP agent itself did with `mcpServers` at
   * `session/new`; see that module's own doc comment for why there is no
   * cheaper seam), then pushes the result. Called fire-and-forget from
   * {@link finishSessionCreation} — never on the critical path a user is
   * waiting on to see their new session open, since an `npx`/`uvx`-fetched
   * server's first cold start can take real seconds and this issue's own
   * acceptance only promises the `/` list fills in, not that it blocks
   * anything. `servers` already excludes anything `mcp_server_status`
   * named as failed (only the survivors of `startAgentWithMcpFallback`
   * ever reach {@link finishSessionCreation} at all) — a server this
   * discovery pass itself can't reach, or that declares no prompts, is
   * silently absent from the result (`fetchMcpServerPrompts`'s own
   * contract), which is exactly this issue's "an unreachable server does
   * not break the list for the others" acceptance line, satisfied at the
   * source rather than by a try/catch here.
   */
  private async discoverAndSendMcpPrompts(
    sessionId: string,
    servers: AcpMcpServerConfig[],
  ): Promise<void> {
    if (servers.length === 0) return;
    const prompts = await fetchMcpServerPrompts(servers);
    await this.sendMcpServerPrompts(sessionId, prompts);
  }

  /**
   * Pushes one `mcp_server_prompts` lifecycle event (Zed-parity D5-2;
   * issue #754) straight to the relay, sealed under this session's
   * derived key — same "ride the `session_update` envelope, no-op on an
   * empty list" shape {@link sendMcpServerStatus} already established
   * (`@loombox/protocol`'s `mcpServerPromptsEventV1` doc comment spells
   * out why this mirrors it deliberately rather than inventing a second
   * transport shape).
   */
  private async sendMcpServerPrompts(
    sessionId: string,
    servers: McpServerPromptsResult[],
  ): Promise<void> {
    if (servers.length === 0) return;
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(
      sessionId,
      { kind: 'mcp_server_prompts', servers, updatedAt: new Date().toISOString() },
      key,
    );
    this.relay.send({
      type: 'session_update',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      seq: 0,
      envelope,
    });
  }

  /**
   * Makes a `McpServerSecretMissingError` pre-flight failure visible
   * (issue #750, D2-2's "a revoked secret grant... produce a distinct,
   * visible reason") without paying for a worktree, lease, or `Session`
   * record this request was always going to fail before reaching —
   * exactly the cost `createSessionInternal`'s own doc comment describes
   * avoiding. The relay drops any `session_update` for a `sessionId` it
   * has never seen a `session_announce` for (`relay.ts`'s "unknown
   * session" guard), so this sends a minimal `session_announce` itself —
   * built from `opts`' own fields, no `Session`/worktree required — then
   * the same `session_status: 'error'` a real spawn failure already gets
   * (issue #730), plus an `mcp_server_status` naming the exact server and
   * secret for a client that wants the structured form too. Both sends
   * are best-effort past the announce: a failure to report is logged, not
   * thrown, so the original `McpServerSecretMissingError` is always what
   * the caller (and `handleSessionCreate`'s own `.catch`) sees.
   */
  private async reportMcpPreflightFailure(
    sessionId: string,
    opts: { targetId: string; provider: string; title: string; projectPath: string },
    error: McpServerSecretMissingError,
  ): Promise<void> {
    try {
      const key = await this.getSessionKey(sessionId);
      const privateEnvelope = await sealJson(
        sessionId,
        { title: opts.title, projectPath: opts.projectPath },
        key,
      );
      const meta: SessionMetaPublic = {
        id: sessionId,
        nodeId: this.nodeId,
        targetId: opts.targetId,
        accountId: this.accountId,
        provider: opts.provider,
        createdAt: Date.now(),
      };
      this.relay.send({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope,
      });
      await this.sendSessionStatus(sessionId, 'error', error.message);
      await this.sendMcpServerStatus(sessionId, [
        {
          name: error.serverName,
          ok: false,
          category: 'secret_missing',
          reason: error.message,
        },
      ]);
    } catch (reportError: unknown) {
      console.warn(
        `NodeDaemon: failed to report session ${sessionId}'s MCP secret-grant failure to the relay: ${
          reportError instanceof Error ? reportError.message : String(reportError)
        }`,
      );
    }
  }

  /**
   * The `ProjectEnvVarMissingError` counterpart to
   * {@link reportMcpPreflightFailure} (issue #258): makes a missing or
   * ungranted project env-var secret's pre-flight failure visible the
   * same way — a minimal `session_announce` (this session never gets a
   * worktree/lease/agent) followed by `session_status: 'error'` naming
   * the env var and the secret it needs (`error.message`, set by
   * `ProjectEnvVarMissingError`'s own constructor). No `mcp_server_status`
   * companion event here: unlike MCP's per-server list, a project's env
   * vars have exactly one consumer (the agent process itself), so the
   * plain session-status reason is the whole story — there is no "which
   * of several servers" to also name. Both sends are best-effort: a
   * failure to report is logged, not thrown, so the original
   * `ProjectEnvVarMissingError` is always what the caller (and
   * `handleSessionCreate`'s own `.catch`) sees.
   */
  private async reportProjectEnvPreflightFailure(
    sessionId: string,
    opts: { targetId: string; provider: string; title: string; projectPath: string },
    error: ProjectEnvVarMissingError,
  ): Promise<void> {
    try {
      const key = await this.getSessionKey(sessionId);
      const privateEnvelope = await sealJson(
        sessionId,
        { title: opts.title, projectPath: opts.projectPath },
        key,
      );
      const meta: SessionMetaPublic = {
        id: sessionId,
        nodeId: this.nodeId,
        targetId: opts.targetId,
        accountId: this.accountId,
        provider: opts.provider,
        createdAt: Date.now(),
      };
      this.relay.send({
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope,
      });
      await this.sendSessionStatus(sessionId, 'error', error.message);
    } catch (reportError: unknown) {
      console.warn(
        `NodeDaemon: failed to report session ${sessionId}'s project env-var failure to the relay: ${
          reportError instanceof Error ? reportError.message : String(reportError)
        }`,
      );
    }
  }

  /**
   * Records one MCP server's start-attempt outcome for `projectPath`
   * (issue #750, D2-2's "lifecycle... disable, decided explicitly"): a
   * success resets its streak to zero (an intermittent failure that then
   * recovers must never accumulate toward a disable it never earns); a
   * failure increments it, and three in a row auto-disables the server
   * via {@link autoDisableMcpServer} — bounded, in-memory, and reset on
   * every node restart (a fresh streak, not a persisted one; only the
   * disable itself, once it happens, survives a restart, in
   * `McpConfigStore`'s own file). "Restart" (this decision's other
   * lifecycle action, alongside "report" and "disable") needs no code of
   * its own: an excluded server was never removed from its config record,
   * only from *this* attempt's list, so the very next session creation
   * retries it fresh — self-healing without this node ever deciding "now
   * is the moment to retry."
   *
   * Returns whether THIS call is the one that just auto-disabled the
   * server (issue #794's `mcp_server_status.disabled` field) — `true`
   * only when the streak just crossed the threshold AND
   * {@link autoDisableMcpServer} actually flipped a node-owned record;
   * `false` for a success, an ordinary (not-yet-third) failure, or a
   * third failure against a client-declared server the node has no
   * record for (see that method's own doc comment).
   */
  private recordMcpServerOutcome(projectPath: string, serverName: string, ok: boolean): boolean {
    const key = `${projectPath}\u0000${serverName}`;
    if (ok) {
      this.mcpFailureStreaks.delete(key);
      return false;
    }
    const streak = (this.mcpFailureStreaks.get(key) ?? 0) + 1;
    if (streak < NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD) {
      this.mcpFailureStreaks.set(key, streak);
      return false;
    }
    this.mcpFailureStreaks.delete(key);
    return this.autoDisableMcpServer(projectPath, serverName);
  }

  /**
   * Disables `serverName` in `projectPath`'s own `McpConfigStore` record —
   * project-scoped first, falling back to a global record of the same
   * name (mirrors {@link resolveMcpServers}'s own project-overrides-global
   * precedence). A client-declared server (no node-store record at all,
   * `mcp-server-store.ts`'s `localStorage` list) has nothing here to
   * disable — this node doesn't own that storage — so it keeps being
   * reported as failed on every attempt until the client itself disables
   * or removes it; logged, not thrown, since a failed auto-disable must
   * never mask the real failure this was reacting to. Returns `true` only
   * when a node-owned record (project or global) was actually flipped —
   * `recordMcpServerOutcome` reports that boolean straight through as
   * `mcp_server_status.disabled` (issue #794), so a client never sees a
   * disable claim the node didn't actually act on.
   */
  private autoDisableMcpServer(projectPath: string, serverName: string): boolean {
    try {
      this.mcpConfigStore.setProjectEnabled(projectPath, serverName, false);
      console.warn(
        `NodeDaemon: auto-disabled project "${projectPath}"'s MCP server "${serverName}" after ${NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD} consecutive failures to start (issue #750).`,
      );
      return true;
    } catch {
      // No project-scoped record by that name — try a global one below.
    }
    try {
      this.mcpConfigStore.setGlobalEnabled(serverName, false);
      console.warn(
        `NodeDaemon: auto-disabled global MCP server "${serverName}" after ${NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD} consecutive failures to start (issue #750).`,
      );
      return true;
    } catch {
      // A client-declared server with no node-store record at all —
      // nothing to disable node-side; see this method's own doc comment.
      return false;
    }
  }

  private sendTargetAnnounce(): void {
    this.relay.send({
      type: 'target_announce',
      protocolVersion: PROTOCOL_V1,
      nodeId: this.nodeId,
      targets: this.targets.map((target) => ({
        ...target,
        providers: this.providerAvailability.get(target.id) ?? [],
      })),
    });
  }

  /**
   * Refreshes {@link providerAvailability} for every currently-held target
   * (SPEC §5.5) — probed once when this node first builds/announces its
   * target set and again on every reconnect (both routed through
   * `reannounceAll`, which awaits this before it builds the outgoing
   * `target_announce`, so the very announce that follows already carries
   * fresh data rather than a stale placeholder). Deliberately not driven
   * by `targetHealthSampler`'s interval: installing a CLI is rare, so a
   * reconnect's cadence is plenty granular, and the sampler is a hot path
   * this must stay off of. A no-op when `providerCandidates` is empty — no
   * `ExecutionTarget` is even requested, so this never opens an `ssh:`
   * connection a caller hasn't opted into probing.
   *
   * Never throws: a target this node can't even get an `ExecutionTarget`
   * for (an `ssh:` target with no matching `sshTargets` entry, or one
   * whose pooled transport fails to connect) degrades to `providers: []`
   * for that target alone, exactly like `probeProviderAvailability`'s own
   * internal probe failures — one unreachable target never blocks or
   * blanks out any other target's result.
   */
  private async refreshProviderAvailability(): Promise<void> {
    if (this.providerCandidates.length === 0) return;
    await Promise.all(
      this.targets.map(async (target) => {
        try {
          const executionTarget = await this.getExecutionTarget(target.id);
          const providers = await probeProviderAvailability(
            executionTarget,
            this.providerCandidates,
            target.id,
          );
          this.providerAvailability.set(target.id, providers);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: provider availability probe failed for target "${target.id}": ${message}`,
          );
          this.providerAvailability.set(target.id, []);
        }
      }),
    );
  }

  private async reannounceAll(): Promise<void> {
    await this.refreshProviderAvailability();
    this.sendTargetAnnounce();
    // A fresh connection means the relay has no `target_status` for this
    // node either (it drops everything on socket close, same as
    // `target_announce`'s own doc comment above) — push whatever this
    // sampler already knows right away rather than leaving a client's
    // `target_list` looking healthless until the next interval tick.
    this.sendTargetStatus();
    for (const bridge of this.bridges.values()) {
      this.announce(bridge.session, bridge.targetId, bridge.title).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`NodeDaemon: failed to re-announce session ${bridge.session.id}: ${message}`);
      });
    }
    // Issue #702: a session with no live bridge got no re-announce above
    // — the relay's own record of it (from before this connection,
    // possibly from before this node's last restart) is still accurate,
    // only its status is stale. Re-push the one honest thing this node
    // knows about it (`SessionManager`'s own `'disconnected'` reload
    // logic — `session-manager.ts`'s `SessionLifecycleState` doc comment)
    // so a client that wasn't watching live still learns the truth the
    // moment it, or this node, reconnects — never for `'running'`/
    // `'paused'` (a live bridge's own attention listener already covers
    // those) or `'ended'` (already reported through the archive flow).
    for (const session of this.sessionManager.listSessions()) {
      if (session.state !== 'disconnected') continue;
      this.sendSessionStatus(session.id, 'disconnected').catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to push disconnected status for session ${session.id}: ${message}`,
        );
      });
    }
  }

  /** Registers this target's {@link TargetHealthSampler} probe (issues #253/#269) — a no-op when resource sampling is disabled (`resourceSampling.enabled`, off by default), since the sampler simply never starts in that case, but harmless to always register so a later opt-in (were one ever added) would need no other change here. */
  private registerHealthProbe(target: TargetDescriptor): void {
    if (target.kind === 'local') {
      this.targetHealthSampler.setProbe(target.id, () => sampleLocalResources());
      return;
    }
    // Mirrors `getExecutionTarget`'s own "no ssh target config" case: an
    // `ssh:` target announced without a matching `sshTargets` connection
    // recipe can't be sampled at all, so it's simply left unprobed rather
    // than registered with a probe that would always fail.
    if (!this.sshTargetConfigs.has(target.id)) return;
    this.targetHealthSampler.setProbe(target.id, async () =>
      sampleRemoteResources(await this.getSshTransport(target.id)),
    );
  }

  /** Pushes this sampler's full latest-per-target snapshot to the relay as `target_status` (issues #253/#269) — a no-op while disconnected (`RelayConnection.send` would otherwise throw/queue oddly) or before any sample has completed yet. */
  private sendTargetStatus(): void {
    if (!this._connected) return;
    const samples: TargetResourceSample[] = [];
    // Issue #476: a decommissioned target's last reading lingers in the
    // sampler's own `latest` map (`removeProbe`'s doc comment: it only stops
    // future sampling, on purpose) — filtered out here so a removed target
    // never resurfaces in `target_status` after `forgetSshTarget` has
    // already dropped it from `this.targets`.
    const stillOwned = new Set(this.targets.map((target) => target.id));
    for (const [targetId, sample] of this.targetHealthSampler.snapshot()) {
      if (!stillOwned.has(targetId)) continue;
      samples.push({ targetId, ...sample });
    }
    if (samples.length === 0) return;
    this.relay.send({
      type: 'target_status',
      protocolVersion: PROTOCOL_V1,
      nodeId: this.nodeId,
      samples,
    });
  }

  /** SPEC §8 / issue #116: on every fresh connection, ask whether a rewrapped-AMK-epoch envelope is waiting for this device. */
  private sendAmkEpochFetchRequest(): void {
    this.relay.send({
      type: 'amk_epoch_fetch_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: this.deviceId,
    });
  }

  /** SPEC §7.26, issue #631: on every fresh connection (mirrors {@link sendAmkEpochFetchRequest}'s identical "ask on every 'open', including a reconnect" shape), asks the relay for this account's connected-account registry — the same request a client sends on its own `attemptOpen()` (`apps/web/src/lib/relay-client.ts`'s own `connected_account_list_request` doc comment). {@link handleConnectedAccountList} replaces {@link connectedAccounts} wholesale with the reply. */
  private sendConnectedAccountListRequest(): void {
    this.relay.send({
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
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

  /** SPEC §7.26, issue #631: `connected_account_list` carries the full account-scoped snapshot (never a delta, and never correlated to a specific request — see `@loombox/protocol`'s `connectedAccountList` doc comment), so this replaces {@link connectedAccounts} wholesale — same "always the full list" contract `apps/web`'s `RelayClient.handleConnectedAccountList` follows client-side. */
  private handleConnectedAccountList(message: ConnectedAccountList): void {
    this.connectedAccounts = [...message.accounts];
  }

  /**
   * A caller (holding this device's private key) has unwrapped a pending
   * envelope and hands back the recovered AMK for this node to actually
   * adopt. No-op (returns `false`) if `epoch` isn't strictly ahead of what
   * this node already has — the same "only if ahead" guard
   * `handleAmkEpochFetchResponse` applies before ever emitting, re-checked
   * here since adoption is the security-relevant step and callers should
   * never be trusted to skip a stale epoch on their own. Clears every
   * cached session key (and {@link targetKeys}/{@link projectKeys}, issue
   * #474's directory picker and issue #697's project-addressed tracker
   * records respectively) so any *new* session/target-browse/tracker
   * request after this call derives from the new epoch; already-cached
   * keys from before rotation are left alone for this process's
   * remaining lifetime (see `session-keys.ts`'s doc comment for why the
   * AMK is the sole root of derivation — there is no separate per-epoch
   * history kept across a restart in this wave).
   */
  adoptAmkEpoch(newAmk: Uint8Array, epoch: number): boolean {
    if (epoch <= this.amkEpoch) return false;
    this.amk = newAmk;
    this.amkEpoch = epoch;
    this.sessionKeys.clear();
    this.targetKeys.clear();
    this.projectKeys.clear();
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
      case 'session_archive_request':
        this.handleSessionArchiveRequest(message);
        return;
      case 'session_fork_request':
        this.handleSessionForkRequest(message);
        return;
      case 'prompt_inject':
        this.handlePromptInject(message);
        return;
      case 'fs_list_request':
        this.handleFsListRequest(message);
        return;
      case 'mcp_prompt_get_request':
        this.handleMcpPromptGetRequest(message);
        return;
      case 'fs_read_request':
        this.handleFsReadRequest(message);
        return;
      case 'git_diff_request':
        this.handleGitDiffRequest(message);
        return;
      case 'git_graph_request':
        this.handleGitGraphRequest(message);
        return;
      case 'git_hunk_diff_request':
        this.handleGitHunkDiffRequest(message);
        return;
      case 'git_hunk_action_request':
        this.handleGitHunkActionRequest(message);
        return;
      case 'git_branch_list_request':
        this.handleGitBranchListRequest(message);
        return;
      case 'git_branch_create_request':
        this.handleGitBranchCreateRequest(message);
        return;
      case 'git_branch_switch_request':
        this.handleGitBranchSwitchRequest(message);
        return;
      case 'git_branch_merge_request':
        this.handleGitBranchMergeRequest(message);
        return;
      case 'git_branch_merge_abort_request':
        this.handleGitBranchMergeAbortRequest(message);
        return;
      case 'git_stash_list_request':
        this.handleGitStashListRequest(message);
        return;
      case 'git_stash_save_request':
        this.handleGitStashSaveRequest(message);
        return;
      case 'git_stash_pop_request':
        this.handleGitStashPopRequest(message);
        return;
      case 'git_stash_drop_request':
        this.handleGitStashDropRequest(message);
        return;
      case 'agent_instructions_get_request':
        this.handleAgentInstructionsGetRequest(message);
        return;
      case 'agent_instructions_set_request':
        this.handleAgentInstructionsSetRequest(message);
        return;
      case 'git_commit_draft_request':
        this.handleGitCommitDraftRequest(message);
        return;
      case 'git_commit_request':
        this.handleGitCommitRequest(message);
        return;
      case 'tracker_snapshot_request':
        this.handleTrackerSnapshotRequest(message);
        return;
      case 'tracker_write_request':
        this.handleTrackerWriteRequest(message);
        return;
      case 'tracker_mode_get_request':
        this.handleTrackerModeGetRequest(message);
        return;
      case 'tracker_mode_set_request':
        this.handleTrackerModeSetRequest(message);
        return;
      case 'target_fs_list_request':
        this.handleTargetFsListRequest(message);
        return;
      case 'custom_agent_probe_request':
        this.handleCustomAgentProbeRequest(message);
        return;
      case 'ssh_discovery_request':
        this.handleSshDiscoveryRequest(message);
        return;
      case 'decommission_target_request':
        this.handleDecommissionTargetRequest(message);
        return;
      case 'target_update_request':
        this.handleTargetUpdateRequest(message);
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
      case 'permission_policy_get':
        this.handlePermissionPolicyGet(message);
        return;
      case 'permission_policy_set':
        this.handlePermissionPolicySet(message);
        return;
      case 'spend_cap_get':
        this.handleSpendCapGet(message);
        return;
      case 'spend_cap_set':
        this.handleSpendCapSet(message);
        return;
      case 'session_spend_cap_resume':
        this.handleSessionSpendCapResume(message);
        return;
      case 'spend_report_request':
        this.handleSpendReportRequest(message);
        return;
      case 'checkpoint_create':
        this.handleCheckpointCreate(message);
        return;
      case 'checkpoint_list':
        this.handleCheckpointList(message);
        return;
      case 'checkpoint_restore_preview':
        this.handleCheckpointRestorePreview(message);
        return;
      case 'checkpoint_restore':
        this.handleCheckpointRestore(message);
        return;
      case 'session_rewind_preview':
        this.handleSessionRewindPreview(message);
        return;
      case 'session_rewind':
        this.handleSessionRewind(message);
        return;
      case 'agent_profile_list_get':
        this.handleAgentProfileListGet(message);
        return;
      case 'agent_profile_list_set':
        this.handleAgentProfileListSet(message);
        return;
      case 'agent_profile_session_get':
        this.handleAgentProfileSessionGet(message);
        return;
      case 'agent_profile_session_set':
        this.handleAgentProfileSessionSet(message);
        return;
      case 'test_runner_config_get':
        this.handleTestRunnerConfigGet(message);
        return;
      case 'test_runner_config_set':
        this.handleTestRunnerConfigSet(message);
        return;
      case 'test_runner_config_detect':
        this.handleTestRunnerConfigDetect(message);
        return;
      case 'pr_open_preview_request':
        this.handlePrOpenPreviewRequest(message);
        return;
      case 'pr_open_request':
        this.handlePrOpenRequest(message);
        return;
      case 'run_start':
        this.handleRunStart(message);
        return;
      case 'run_cancel':
        this.handleRunCancel(message);
        return;
      case 'ci_auto_iterate_stop':
        this.handleCiAutoIterateStop(message);
        return;
      case 'amk_epoch_fetch_response':
        this.handleAmkEpochFetchResponse(message.pending);
        return;
      case 'connected_account_list':
        this.handleConnectedAccountList(message);
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
      case 'github_connect_start_request':
        this.handleGithubConnectStartRequest(message);
        return;
      case 'github_connect_cancel_request':
        this.handleGithubConnectCancelRequest(message);
        return;
      case 'jira_connect_request':
        this.handleJiraConnectRequest(message);
        return;
      case 'connected_account_disconnect_request':
        this.handleConnectedAccountDisconnectRequest(message);
        return;
      case 'account_pin_get_request':
        this.handleAccountPinGetRequest(message);
        return;
      case 'account_pin_set_request':
        this.handleAccountPinSetRequest(message);
        return;
      case 'account_pin_unset_request':
        this.handleAccountPinUnsetRequest(message);
        return;
      case 'account_pin_resolve_request':
        this.handleAccountPinResolveRequest(message);
        return;
      case 'config_option':
        this.handleConfigOption(message);
        return;
      default:
        // Every other v1 message type (permission_response, presence,
        // blob_ref, ...) is out of this wave's scope; ignore rather than
        // crash on a message this node doesn't yet act on.
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
          // SPEC §7.1's per-session choice, now reachable over the relay
          // (issue #507) — see `CreateNodeSessionOptions.worktree`'s doc
          // comment for the full default-mapping story.
          worktree: privateMeta.worktree,
          profileId: privateMeta.profileId,
          // D1-3 (issue #748): the same encrypted envelope carries this
          // session's custom agent, when the client picked one — a
          // `message.provider` of anything else (an ordinary catalogue id)
          // simply carries no `customAgent`, and this field is `undefined`
          // exactly as it was before this issue.
          customAgent: privateMeta.customAgent,
          // issue #750, D2-2: the client's own per-project `localStorage`
          // MCP server declarations, merged by `resolveMcpServers` into
          // this node's own `McpConfigStore` — see
          // `parseClientDeclaredMcpServers`'s own doc comment for why a
          // single malformed entry degrades rather than failing the
          // whole session.
          mcpServerConfigs: parseClientDeclaredMcpServers(privateMeta.mcpServerConfigs),
          // issue #258: the client's own per-project declared env-var
          // injection — `sessionPrivateMetaV1.projectEnvDecls`'s own doc
          // comment. `ProjectEnvVarDeclV1` and `ProjectEnvVarDecl` are the
          // identical `{name,value}|{name,secret}` union (see
          // `@loombox/protocol`'s `project-env.ts` doc comment for why
          // that's deliberate), so the already-zod-validated wire list
          // needs no further re-parse here, unlike `mcpServerConfigs`'s
          // richer domain-level shape.
          projectEnvDecls: privateMeta.projectEnvDecls,
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to create session ${message.sessionId} from session_create: ${detail}`,
        );
      });
  }

  private async decryptSessionCreate(message: SessionCreate): Promise<SessionPrivateMetaV1> {
    const key = await this.getSessionKey(message.sessionId);
    // Validated, not just cast (issue #507): a malformed payload from a
    // peer becomes a clear zod failure here, caught by `handleSessionCreate`'s
    // own `.catch` exactly like a decrypt failure already was, rather than
    // an unchecked `as SessionPrivateMetaV1` silently waving through
    // `undefined`/wrong-shaped or missing fields.
    const decrypted = await openJson<unknown>(message.sessionId, message.privateEnvelope, key);
    return parseSessionPrivateMetaV1(decrypted);
  }

  /**
   * A client asked (via the relay) to fork one of this node's sessions
   * from a turn into a brand-new one (design spec
   * `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746). Always
   * replies — `outcome: 'error'` with a human-readable reason for every
   * refusal case, `outcome: 'ok'` only once the fork's worktree is copied,
   * its transcript seeded, and its own agent spawn kicked off (whose
   * success/failure rides the new session's ordinary `session_status`
   * events from here, exactly like any other creation) — never a
   * half-created fork left for the client to discover on its own.
   */
  private handleSessionForkRequest(message: SessionForkRequest): void {
    if (!this.targets.some((target) => target.id === message.targetId)) {
      this.sendSessionForkResponse(message, {
        outcome: 'error',
        message: `unknown target "${message.targetId}"`,
      });
      return;
    }

    this.decryptSessionFork(message)
      .then(async (privateMeta) => {
        const forkFromTurnId = privateMeta.forkFromTurnId;
        if (!forkFromTurnId) {
          this.sendSessionForkResponse(message, {
            outcome: 'error',
            message: 'malformed fork request: missing forkFromTurnId',
          });
          return;
        }
        try {
          await this.forkSessionInternal({
            sessionId: message.sessionId,
            sourceSessionId: message.sourceSessionId,
            forkFromTurnId,
            projectPath: privateMeta.projectPath,
            provider: message.provider,
            targetId: message.targetId,
            title: privateMeta.title,
          });
          this.sendSessionForkResponse(message, { outcome: 'ok' });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: failed to fork session ${message.sourceSessionId} into ${message.sessionId}: ${detail}`,
          );
          this.sendSessionForkResponse(message, { outcome: 'error', message: detail });
        }
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendSessionForkResponse(message, {
          outcome: 'error',
          message: `could not read the fork request: ${detail}`,
        });
      });
  }

  private async decryptSessionFork(message: SessionForkRequest): Promise<SessionPrivateMetaV1> {
    const key = await this.getSessionKey(message.sessionId);
    const decrypted = await openJson<unknown>(message.sessionId, message.privateEnvelope, key);
    return parseSessionPrivateMetaV1(decrypted);
  }

  /**
   * Does the actual work behind a `session_fork_request`, once its
   * envelope is decrypted: validates the source is forkable right now
   * (issue #746's "never a half-created fork" bar), cuts its transcript at
   * `forkFromTurnId`, copies its worktree via `SessionManager.forkSession`,
   * and launches the new session exactly like `createSessionInternal`
   * does for an ordinary creation — same concurrency-gate queueing, same
   * `launchLocalSession` — with `seedTranscriptUpdates` threaded through
   * so `finishSessionCreation` replays the copied history onto it. Throws
   * (never half-creates) for: an unrecognized target, a non-`local`
   * target (this wave's scope — an `ssh:` fork would need a remote
   * worktree copy this doesn't build), a source with no active bridge (no
   * live agent, or disconnected — there is nothing to read its transcript
   * from), or a `forkFromTurnId` this source's transcript never produced.
   */
  private async forkSessionInternal(opts: {
    sessionId: string;
    sourceSessionId: string;
    forkFromTurnId: string;
    projectPath: string;
    provider: string;
    targetId: string;
    title: string;
  }): Promise<Session> {
    const target = this.targets.find((candidate) => candidate.id === opts.targetId);
    if (!target) {
      throw new Error(`no target with id "${opts.targetId}"`);
    }
    if (target.kind !== 'local') {
      throw new Error(`forking is only supported on a 'local' target, not '${target.kind}'`);
    }

    const sourceBridge = this.bridges.get(opts.sourceSessionId);
    if (!sourceBridge) {
      throw new Error(
        `session ${opts.sourceSessionId} has no active agent to fork from (no live agent, or disconnected)`,
      );
    }
    if (sourceBridge.session.target !== 'local') {
      throw new Error(`cannot fork a '${sourceBridge.session.target}' session`);
    }

    const seedTranscriptUpdates = cutTranscriptAtTurn(
      sourceBridge.agentSession.getTranscriptUpdates(),
      opts.forkFromTurnId,
    );
    if (!seedTranscriptUpdates) {
      throw new Error(
        `turn "${opts.forkFromTurnId}" was not found in session ${opts.sourceSessionId}'s transcript`,
      );
    }

    // A fork request carries no `mcpServerConfigs`/`projectEnvDecls` of its
    // own (issue #750 predates #746's fork wire shape; issue #258 postdates
    // it) — only this node's own McpConfigStore/NodeProjectEnvManager
    // records apply; a future fork-time client declaration would thread
    // through here identically to `createSessionInternal`'s own
    // `opts.mcpServerConfigs`/`opts.projectEnvDecls`.
    const mcpServers = await this.resolveMcpServers(opts.projectPath, []);
    const projectEnv = await this.projectEnvManager.resolveForSession(opts.projectPath, []);

    let session: Session;
    try {
      session = await this.sessionManager.forkSession(opts.sourceSessionId, {
        id: opts.sessionId,
        provider: opts.provider,
        nodeId: this.nodeId,
        targetId: opts.targetId,
      });
    } catch (error) {
      // Re-thrown as a plain Error: `handleSessionForkRequest`'s caller
      // only cares about `.message` (the wire's `outcome: 'error'`
      // string), not the class identity `CannotForkSessionError`
      // otherwise carries.
      throw error instanceof CannotForkSessionError ? new Error(error.message) : error;
    }
    await this.announce(session, opts.targetId, opts.title);

    const launchOpts = { provider: opts.provider, targetId: opts.targetId, title: opts.title };
    if (this.concurrencyGate.tryAcquire(target.id)) {
      return this.launchLocalSession(
        session,
        launchOpts,
        mcpServers,
        projectEnv,
        seedTranscriptUpdates,
      );
    }

    // Over the cap (SPEC §7.16, issue #252): queue rather than launch,
    // exactly like `createSessionInternal`'s own overflow path.
    await this.sendSessionStatus(session.id, 'queued');
    this.concurrencyGate.enqueue(target.id, session.id, () => {
      this.launchLocalSession(
        session,
        launchOpts,
        mcpServers,
        projectEnv,
        seedTranscriptUpdates,
      ).catch((error: unknown) => {
        console.warn(
          `NodeDaemon: forked session ${session.id} failed to start after dequeuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    return session;
  }

  private sendSessionForkResponse(message: SessionForkRequest, result: SessionForkResult): void {
    this.relay.send({
      type: 'session_fork_response',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      result,
    });
  }

  /**
   * A client asked (via the relay) to archive one of this node's sessions
   * — SPEC §7.2's board archive affordance, issue #512 (the counterpart
   * to #507's worktree wiring that had no way to ever clean up after
   * itself). Withdraws it from the concurrency queue if it was still
   * waiting there, and stops its live agent process if it was still
   * running (SPEC §7.16, issue #252 — releasing its concurrency slot is
   * exactly why archiving can no longer skip that step; see
   * {@link stopBridgeIfActive}), then ends the session, tolerating one
   * that already ended (archiving a finished session is the common case),
   * then always forgets the record and, when asked, tears down its
   * isolated worktree and branch too — see
   * {@link SessionManager.removeSession}'s own doc comment for exactly
   * what `removeWorktree` does and doesn't touch. Always replies, exactly
   * like `handleTargetFsListRequest`'s "never a silent hang" contract —
   * including for a sessionId this node does not hold, which answers `ok`.
   *
   * That case is not hypothetical and not a race: `SessionManager` keeps its
   * records in memory only, so every node restart forgets every session
   * while the relay (backed by Postgres) still lists them. Copying
   * `handlePromptInject`'s silent-ignore here made every such row
   * permanently unarchivable — the client waits out its timeout and the row
   * comes back on the next load, forever. Found by archiving a real session
   * across a real node restart, which no test covered.
   *
   * `ok` is the honest answer rather than a convenient one: archiving asks
   * for this session to stop existing, and for everything this node governs
   * that already holds. What it cannot do is clean the forgotten session's
   * worktree, since the path lives under its `projectPath` and that only
   * ever travels inside the session's encrypted envelope (SPEC §8) — a
   * session this node forgot is one whose folder it can no longer name.
   * That leak belongs to the node's session state being memory-only, filed
   * separately; refusing here would only add an unremovable row on top of it.
   */
  private handleSessionArchiveRequest(message: SessionArchiveRequest): void {
    // SPEC §7.16, issue #252: a no-op unless this session is still waiting
    // in the overflow queue — cancel it unconditionally, before checking
    // anything else below, so it can never dequeue and launch after being
    // "archived".
    this.concurrencyGate.cancel(message.sessionId);
    // Also a no-op unless this session is still actually running (`local`
    // or `ssh:` alike) — stops its agent process and, via the `'exit'`
    // event this triggers, releases its concurrency slot (see
    // `wireAgentSession`) before this node forgets about it below.
    this.stopBridgeIfActive(message.sessionId);

    if (!this.sessionManager.getSession(message.sessionId)) {
      console.warn(
        `NodeDaemon: session_archive_request for a session this node no longer tracks ("${message.sessionId}"); reporting it archived so the row can be cleared`,
      );
      this.sendSessionArchiveResponse(message, { outcome: 'ok' });
      return;
    }
    this.archiveSession(message.sessionId, message.removeWorktree)
      .then(() => this.sendSessionArchiveResponse(message, { outcome: 'ok' }))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendSessionArchiveResponse(message, { outcome: 'error', message: detail });
      });
  }

  private async archiveSession(sessionId: string, removeWorktree: boolean): Promise<void> {
    try {
      this.sessionManager.endSession(sessionId);
    } catch (error) {
      // Archiving an already-ended session is the common case (see this
      // method's caller's doc comment) — anything else (e.g. the id
      // vanishing between the existence check and here) is a real failure
      // and must still surface as outcome: 'error'.
      if (!(error instanceof InvalidSessionTransitionError)) throw error;
    }
    // SPEC §7.14, issue #239: a session's CI watch is scoped to that
    // session's own life — an archived session's open PR (if any) is no
    // longer this node's concern to keep polling, and `unwatch` also
    // clears its dedup state so a same-id session (never happens today,
    // but nothing here relies on session ids never being reused) starts
    // clean.
    this.ciCheckWatcher.unwatch(sessionId);
    this.ciCheckWatchStore.remove(sessionId);
    this.ciAutoIterateController.forget(sessionId);
    // Clean up this session's hidden checkpoint refs (issue #603) before
    // the record disappears below — `GitCheckpointStore.deleteAllCheckpoints()`
    // needs `worktreePath`, still readable from `sessionManager` right up
    // until `removeSession` forgets it. Best-effort: a session this node no
    // longer tracks, an `ssh:` session (`getCheckpointStore` refuses it),
    // or a real git failure here must never block archiving itself — see
    // this method's caller's own "always replies ... never a silent hang"
    // doc comment.
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      await this.getCheckpointStore(session)
        ?.deleteAllCheckpoints()
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: failed to delete checkpoints for session ${sessionId} during archive: ${detail}`,
          );
        });
    }
    await this.sessionManager.removeSession(sessionId, { removeWorktree });
  }

  /**
   * Stops `sessionId`'s live agent process, if it has one — a no-op for a
   * session that never started (still queued, SPEC §7.16/issue #252),
   * already stopped, or genuinely unknown. Mirrors `close()`'s own
   * per-bridge teardown exactly (an `ssh:` session's remote agent process
   * is deliberately left running — only this node's local bridge detaches,
   * per issue #80) — the one shared helper both use, so a session's
   * termination path is identical whether it's triggered by a full node
   * shutdown or a single archive request. Does not itself remove the
   * bridge from {@link bridges} or touch {@link concurrencyGate} — both
   * happen downstream, in {@link wireAgentSession}'s `'exit'` listener,
   * once `supervisor.stop()`'s resulting child-process exit actually fires
   * (asynchronously): forgetting the bridge here, synchronously, used to
   * make `forwardSessionEvent` silently drop that same exit's `'exited'`
   * `session_status` (it no-ops the moment `this.bridges.get()` comes back
   * empty), so this method leaves the bridge in place for `wireAgentSession`
   * to actually process the transition before forgetting it.
   */
  private stopBridgeIfActive(sessionId: string): void {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return;
    bridge.remoteChild?.detachLocal();
    // `AgentSupervisor.stop()` is keyed by `AgentSession.id` — the ACP-level
    // session id the agent's own `session/new` response assigned, NOT this
    // bridge's loombox-level `sessionId` (a separate, node-generated id;
    // same distinction `wireAgentSession`'s config-option listener already
    // draws). Passing `sessionId` here found nothing in the supervisor's own
    // map, so `.close()` was never called and the child process never
    // actually died until this node's whole process exited.
    this.supervisor.stop(bridge.agentSession.id);
    this.stopLeaseHeartbeat(sessionId);
  }

  /**
   * Resolves the `session` record + `targetId` a handler needs to act on
   * `sessionId`, independent of whether a live {@link SessionBridge}
   * exists for it (issue #702). `fs_list_request`/`terminal_open`/
   * `terminal_input`/`terminal_resize`/`terminal_close`/
   * `test_runner_config_get`/`test_runner_config_set`/
   * `test_runner_config_detect`/`run_start`/`run_cancel` never actually
   * read `SessionBridge.agentSession` — only `bridge.session` and
   * `bridge.targetId`, both plain fields of the `Session` record
   * `SessionManager` keeps for every session this node owns, live agent or
   * not. Falling back to that record when no bridge is live is exactly
   * what makes those ten handlers keep working for a session reloaded
   * `'disconnected'` after a restart (`session-manager.ts`'s
   * `SessionLifecycleState` doc comment: the session is still real, only
   * the agent process behind it is gone) — a contained re-attach for
   * Files/Terminal/test-runner/run, since none of them ever touched the
   * agent to begin with. `targetId` defaults to `'local'` there, mirroring
   * `SessionManager.createSession`'s own default. Only `handlePromptInject`
   * genuinely needs the live bridge (`bridge.agentSession.prompt()`) and
   * does not go through this helper — reviving an agent conversation on
   * demand is a real feature, not a contained fix; see that handler's own
   * doc comment.
   *
   * Returns `undefined` only when `sessionId` isn't one of this node's
   * sessions at all (never created here, or already archived/removed) —
   * the one case actually worth ignoring per SPEC.md §12. The relay only
   * ever routes a session-addressed message to that session's owning node,
   * so this is a defensive check, not the common path.
   */
  private resolveSessionRouting(sessionId: string): SessionRouting | undefined {
    const bridge = this.bridges.get(sessionId);
    if (bridge) return { session: bridge.session, targetId: bridge.targetId };
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return undefined;
    return { session, targetId: session.targetId ?? 'local' };
  }

  /**
   * Builds this session's `GitCheckpointStore` (issue #603) — stateless
   * (the engine's own class doc comment), so constructed fresh per call
   * rather than cached on the bridge, exactly like this daemon already
   * treats `permissionPolicyStore`/`testRunnerConfigStore` reads ("fresh,
   * never cached", `handlePermissionPolicyGet`'s own doc comment).
   * Returns `undefined` for anything but a `local` session — see
   * `CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE`'s own doc comment for why an
   * `ssh:` session can't be supported here at all; every checkpoint
   * handler below checks for `undefined` first and answers
   * `errorType: 'unsupported_target'` rather than letting
   * `execFile('git', ...)` fail confusingly against an unrelated (or
   * absent) local directory.
   */
  private getCheckpointStore(session: Session): GitCheckpointStore | undefined {
    if (session.target !== 'local') return undefined;
    return new GitCheckpointStore({ worktreePath: session.worktreePath, sessionId: session.id });
  }

  /**
   * Takes an automatic "before this turn" checkpoint (issue #603, SPEC
   * §7.20's "at minimum: before a turn's first write") — `await`ed
   * synchronously BEFORE anything else this turn does: `promptSession`
   * calls it right after `beginTurn`, and `deliverPrompt` calls it before
   * even resolving attachments (see that method's own doc comment). Also
   * chains onto `bridge.checkpointQueue` (mirrors `sendQueue` above) so
   * two turns fired close together never run
   * `GitCheckpointStore.checkpoint()` concurrently against the same
   * worktree.
   *
   * This went through two revisions worth recording. The first pass
   * `await`ed this before `prompt()`, which is what shipped here —
   * `GitCheckpointStore.checkpoint()` measured at 45-90ms (median ~72ms)
   * even against a tiny local repo with no contention (a dozen-plus
   * sequential `git` subprocess spawns: `assertUsable()`'s three reads,
   * `write-tree`, a temp-index `add -u` + `write-tree`, `ls-files`, up to
   * two `commit-tree`s, `update-ref`), a real tax on "time from Enter to
   * anything happening" under load, and the direct cause of a sibling
   * test (`attachments-e2e.test.ts`'s queue-saturation test) timing out
   * in CI. The second pass ran this concurrently with `prompt()` via
   * `Promise.all` instead, on the reasoning that dispatching the prompt's
   * own I/O doesn't need to wait on checkpointing at all. That traded a
   * latency problem for a worse correctness one: with nothing forcing
   * this to finish before the turn's own wire signals do, a caller (a
   * test's `afterEach`, in practice) could tear down the session's
   * worktree directory while `checkpoint()`'s `git` calls were still
   * writing into `.git/objects` inside it — observed on a real, isolated
   * CI runner as `ENOTEMPTY: directory not empty, rmdir '.../.git/objects'`
   * on multiple, otherwise-unrelated tests, not a flake. Back to a serial
   * `await`, but ahead of everything else in the turn rather than in the
   * middle of it (this method's own callers), so a caller waiting on any
   * turn-scoped signal can never observe the turn as "underway" while
   * this is still writing. The actual latency mitigations that remain:
   * `checkpoint()` itself now issues its independent `git` reads via
   * `Promise.all` and one fewer call (see that method's own doc comment),
   * and a transient subprocess-spawn failure gets one retry — real
   * reductions, just not zero, and correctness came first.
   *
   * "Before the turn" (not "before the turn's first WRITE" specifically)
   * is still the honest bound this can promise, unchanged from the
   * reasoning that has held throughout every revision above: ACP's
   * `session/update` stream is fire-and-forget, so there is no
   * request/response boundary this node could synchronously interpose on
   * between "the agent decided to write" and "the write already
   * happened" — before the turn strictly subsumes before its first write,
   * since nothing in the turn has run yet either way. One checkpoint per
   * turn regardless of whether that turn ends up writing anything (cheap:
   * git content-addresses, so an unchanged tree costs only a small commit
   * object) — this is also issue #603's own "leave the seams #747 needs
   * obvious": a future rewind-to-turn has one checkpoint per turn
   * boundary to land on, no separate turn→checkpoint index to build.
   * Best-effort: a failure (no git repo, detached HEAD, a dirty
   * submodule, or `undefined` for an `ssh:` session) is logged and never
   * blocks the turn — rollback being unavailable for one turn must never
   * mean the agent itself stops working.
   */
  private autoCheckpointBeforeTurn(bridge: SessionBridge): Promise<void> {
    const store = this.getCheckpointStore(bridge.session);
    if (!store) return Promise.resolve(); // ssh: target — see getCheckpointStore's own doc comment
    bridge.turnCount = (bridge.turnCount ?? 0) + 1;
    const turnNumber = bridge.turnCount;
    const message = `${AUTO_CHECKPOINT_MESSAGE_PREFIX}${turnNumber}`;
    const next = (bridge.checkpointQueue ?? Promise.resolve()).then(async () => {
      try {
        await store.checkpoint({ message });
      } catch {
        // One retry after a short backoff for a transient subprocess-spawn
        // failure (`spawn git ENOENT` and similar, observed repeatedly
        // under heavy concurrent load in CI — issue #603 PR review) —
        // always safe to retry: `checkpoint()` only ever ADDS new objects
        // and a new ref, never mutates or removes anything, so a retry
        // after a failed attempt can at worst leave one extra unreachable
        // git object behind, never corrupt or duplicate a checkpoint.
        try {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await store.checkpoint({ message });
        } catch (secondError) {
          const detail = secondError instanceof Error ? secondError.message : String(secondError);
          console.warn(
            `NodeDaemon: auto-checkpoint before turn ${turnNumber} failed for session ${bridge.session.id} (after one retry): ${detail}`,
          );
        }
      }
    });
    bridge.checkpointQueue = next;
    return next;
  }

  private sendSessionArchiveResponse(
    message: SessionArchiveRequest,
    result: SessionArchiveResult,
  ): void {
    this.relay.send({
      type: 'session_archive_response',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      result,
    });
  }

  /**
   * A client injected a follow-up prompt (via the relay) into one of this
   * node's sessions. Unlike every other handler in this file (issue #702),
   * this one does NOT fall back to {@link resolveSessionRouting}: prompting
   * needs a live `bridge.agentSession`, which by definition does not exist
   * for a session with no live bridge, and reviving one on demand is a
   * real feature (spawning the provider process, resuming the ACP
   * session), not a contained data-plumbing fix — filed as issue #706.
   * `prompt_inject` also carries no reply channel at all on the wire (no
   * `outcome` field, unlike `terminal_opened`/`fs_list_response`), so
   * there is nowhere to put a real answer even for the case that IS this
   * node's business:
   *
   * - `sessionId` isn't one of this node's sessions at all: ignored per
   *   SPEC.md §12, same as every other handler here.
   * - `sessionId` IS one of this node's sessions but has no live bridge
   *   (reloaded `'disconnected'` after a restart): logged so it is at
   *   least visible in this node's own output, then dropped — inventing a
   *   wire message here would be a protocol change of its own. Once part 2
   *   of #702 reaches the client, the composer for a `disconnected`
   *   session is disabled and this branch stops firing in practice.
   * - `sessionId` IS one of this node's sessions with a live bridge, but
   *   the session is `'paused'` (SPEC §7.16; issue #251 — a spend cap):
   *   the agent process is alive (pausing never touches it — see
   *   `SessionLifecycleState`'s own doc comment), but this node refuses to
   *   hand it another prompt until an explicit resume, same "no reply
   *   channel" logged-and-dropped treatment as the disconnected case
   *   above, since giving `prompt_inject` one is #706's job, not this
   *   issue's.
   */
  private handlePromptInject(message: PromptInjectV1): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) {
      if (this.sessionManager.getSession(message.sessionId)) {
        console.warn(
          `NodeDaemon: dropped prompt_inject for session ${message.sessionId}: it has no live agent (disconnected since the last restart), and prompt_inject has no reply channel to report that on — see issue #706`,
        );
      }
      // else: not one of this node's sessions at all; ignore per SPEC.md §12
      return;
    }
    if (bridge.session.state === 'paused') {
      console.warn(
        `NodeDaemon: dropped prompt_inject for session ${message.sessionId}: it is paused on a spend cap, and prompt_inject has no reply channel to report that on — see issue #706`,
      );
      return;
    }

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

  /**
   * A client picked a config option (model/mode/thinking effort) for one of
   * this node's sessions (SPEC §7.24; issue #718) — the last of three gaps
   * in the same chain (#705 seeded the catalogue, #707 fixed the wire shape
   * `AcpClient.setConfigOption` sends/reads); this is the part that
   * actually calls it. Mirrors `handlePromptInject` exactly in shape: does
   * NOT go through {@link resolveSessionRouting}, because setting a config
   * option is a real `session/set_config_option` round trip against the
   * live agent (`bridge.agentSession.setConfigOption`), which by
   * definition cannot happen without one — and, like a prompt, is gated on
   * {@link assertStillLeaseholder} for an `ssh:` session (issue #82).
   *
   * Unlike `prompt_inject` though, `config_option` DOES have a reply
   * channel ({@link sendConfigOptionResult}'s `config_option_result`,
   * added by this same issue): a rejected/impossible set is answered
   * honestly instead of silently dropped, closing the exact #702 failure
   * mode (an action that looks like it worked but never reached the agent)
   * this whole issue chain has been about.
   *
   * - `sessionId` isn't one of this node's sessions at all: ignored per
   *   SPEC.md §12, same as every other handler here.
   * - `sessionId` IS one of this node's sessions but has no live bridge
   *   (reloaded `'disconnected'` after a restart, issue #702's now-real
   *   state): answered with `outcome: 'error'` rather than dropped — there
   *   is no agent to set anything on, and a client waiting on this pick
   *   deserves to hear that rather than assume it silently worked.
   * - Any other failure (lease lost, no catalogue entry for the category,
   *   the agent rejecting the value) is caught uniformly and reported the
   *   same way, carrying `error.message` — which, for a real agent
   *   rejection, `AcpClient.setConfigOption` (issue #707) already folds the
   *   agent's own `error.data.details` reason into.
   *
   * No optimistic local echo happens anywhere in this call: this node's
   * own `config_options` push ({@link wireAgentSession}'s
   * `configOptions.on('changed', ...)` listener, unchanged by this issue)
   * is what actually updates a client's catalog once the agent acks, and
   * only then — the client-side half of this fix (`RelayClient.
   * setConfigOption`) deliberately does not guess the new value ahead of
   * that, so there is no wrong value for a rejection to ever have to
   * revert.
   */
  private handleConfigOption(message: ConfigOption): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) {
      if (this.sessionManager.getSession(message.sessionId)) {
        this.sendConfigOptionResult(message.sessionId, message.category, {
          outcome: 'error',
          message:
            'This session has no live agent (disconnected since the last restart) — start a new session to change its model, mode, or thinking effort.',
        });
      }
      // else: not one of this node's sessions at all; ignore per SPEC.md §12
      return;
    }

    this.assertStillLeaseholder(bridge)
      .then(() => bridge.agentSession.setConfigOption(message.category, message.optionId))
      .then(() => {
        this.sendConfigOptionResult(message.sessionId, message.category, { outcome: 'ok' });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendConfigOptionResult(message.sessionId, message.category, {
          outcome: 'error',
          message: detail,
        });
      });
  }

  /** Sends this session's `config_option_result` for one `category` (SPEC §7.24; issue #718) — clear, not an encrypted envelope, mirroring `configOption`'s own request (see that schema's doc comment for why). */
  private sendConfigOptionResult(
    sessionId: string,
    category: string,
    result: ConfigOptionSetResult,
  ): void {
    this.relay.send({
      type: 'config_option_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      category,
      result,
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
   *
   * "Hand off to the agent" (SPEC §7.25; issue #158): each resolved
   * attachment is also run through `buildInlineImageContentBlock`
   * (`@loombox/providers-core`), gated on this session's own negotiated
   * `image` prompt capability (`agentSession.getFeatureFlags()
   * .supportsImages` — the same capability-gated flag every other v1
   * feature branches on, SPEC.md §5.5, never a provider-id check: Claude's
   * and Codex's real ACP bridges build the identical inline base64 block,
   * so there is nothing to special-case here). A successful build appends
   * an ACP `ContentBlock::Image` to this turn's prompt, verbatim, after the
   * text block; a declined one (no negotiated capability, an oversize
   * payload, or bytes that don't re-sniff as a supported format) emits
   * `'attachment_handoff_declined'` for observability and otherwise leaves
   * this turn exactly as before this issue — the attachment's `blob_ref`
   * metadata still went out above regardless, so every other subscribed
   * client still sees it attached; only the live agent doesn't receive the
   * bytes inline for this turn. Never throws: a declined hand-off degrades
   * the turn, it does not fail it.
   *
   * `payload.mentions` (issue #742's `@`-mention pills) needs no resolution
   * step of its own — each entry already IS the resolved reference (an ACP
   * `resource_link`'s `uri`/`name`, folded onto the wire's plaintext by the
   * client, never re-derived here) — `renderPromptTextWithMentions` just
   * folds it into the text `agentSession.prompt()` takes.
   */
  private async deliverPrompt(bridge: SessionBridge, payload: PromptPayload): Promise<void> {
    // Checkpoint first, before anything else this turn does (including
    // resolving attachments) — see `autoCheckpointBeforeTurn`'s own doc
    // comment for why this must fully settle before any turn-scoped wire
    // signal (`blob_ref` below, `turn_started`) fires: a caller/test that
    // only waits for one of those signals must never be able to observe
    // this turn as "underway" while a checkpoint attempt (writing into
    // this same worktree's `.git`) is still in flight — awaiting it here,
    // synchronously ahead of everything else, is what makes that true.
    await this.autoCheckpointBeforeTurn(bridge);
    const attachments = payload.attachments ?? [];
    // Read once, lazily: only an attachment-bearing prompt needs this
    // session's negotiated capabilities, so a plain-text prompt on a
    // replay-only bridge (were one ever routed here) never trips
    // `getFeatureFlags()`'s live-session guard for no reason.
    const imageCapabilityNegotiated =
      attachments.length > 0 && bridge.agentSession.getFeatureFlags().supportsImages;
    const contentBlocks: AcpPromptContentBlock[] = [];
    for (const attachment of attachments) {
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

      const handoff = buildInlineImageContentBlock(bytes, { imageCapabilityNegotiated });
      if (handoff.ok) {
        contentBlocks.push(handoff.block);
      } else {
        const declined: AttachmentHandoffDeclined = {
          sessionId: bridge.session.id,
          ref: attachment.ref,
          reason: handoff.reason,
        };
        this.emit('attachment_handoff_declined', declined);
      }
    }
    this.beginTurn(bridge);
    await bridge.agentSession.prompt(
      renderPromptTextWithMentions(payload.text, payload.mentions),
      contentBlocks,
    );
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
   * of its sessions' projects (SPEC §7.4; issue #171). Ignored if
   * `sessionId` isn't one of this node's sessions at all
   * ({@link resolveSessionRouting}'s guard). Listing a directory needs
   * nothing but the session's `worktreePath` + `targetId` (issue #702) —
   * never the live agent — so this keeps working for a session reloaded
   * `'disconnected'` after a restart exactly as well as a live one. A
   * decrypt failure is logged and dropped (there is no path to reply
   * about); everything past that point — path-traversal refusal, a
   * missing/permission-denied directory, an `ssh:` transport failure — is
   * turned into an `outcome: 'error'` response instead of silently dropping,
   * per `@loombox/protocol`'s `fsListResponsePayloadV1` doc comment.
   */
  private handleFsListRequest(message: FsListRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptFsListRequest(message)
      .then((payload) => this.listDirectoryForBridge(routing, payload.path))
      .then((responsePayload) =>
        this.sendFsListResponse(routing.session.id, message.requestId, responsePayload),
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
   * Resolves `requestedPath` against `routing`'s session root and lists it
   * via that session's `ExecutionTarget` (local or `ssh:`, issue #69's
   * shared seam — identical code path for both target kinds, per SPEC
   * §7.4's "works over the same transport the session already uses").
   * Takes a {@link SessionRouting}, not a `SessionBridge` (issue #702):
   * only `session.worktreePath` and `targetId` are ever read, both of
   * which {@link NodeDaemon.resolveSessionRouting} can supply for a
   * session with no live bridge. Never throws: a path-traversal attempt or
   * a filesystem failure both become an `outcome: 'error'` payload rather
   * than an unhandled rejection, so {@link handleFsListRequest} always has
   * a response to seal and send back.
   */
  private async listDirectoryForBridge(
    routing: SessionRouting,
    requestedPath: string,
  ): Promise<FsListResponsePayloadV1> {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSessionRelativePath(routing.session.worktreePath, requestedPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }

    try {
      const target = await this.getExecutionTarget(routing.targetId);
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
   * A client asked (via the relay) this node to render one MCP server's
   * declared prompt (Zed-parity D5-2; issue #754). Ignored if `sessionId`
   * isn't one of this node's sessions at all ({@link resolveSessionRouting}'s
   * guard, same as {@link handleFsListRequest}). A decrypt failure is
   * logged and dropped (there is no path to reply about); everything past
   * that point — an unknown server name, an unreachable server, a
   * rejected `prompts/get` call — is turned into an `outcome: 'error'`
   * response instead of silently dropping, per `@loombox/protocol`'s
   * `mcpPromptGetResponsePayloadV1` doc comment.
   */
  private handleMcpPromptGetRequest(message: McpPromptGetRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptMcpPromptGetRequest(message)
      .then((payload) => this.renderMcpPromptForSession(message.sessionId, payload))
      .then((responsePayload) =>
        this.sendMcpPromptGetResponse(message.sessionId, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle mcp_prompt_get_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptMcpPromptGetRequest(
    message: McpPromptGetRequest,
  ): Promise<McpPromptGetRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<McpPromptGetRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Renders one MCP prompt for `sessionId` (Zed-parity D5-2; issue #754) —
   * looks up that session's actually-launched server config from
   * {@link mcpServersBySession} (a session with no live bridge, e.g.
   * reloaded after a node restart, has no entry here and gets a clear
   * `outcome: 'error'` rather than a stale/guessed config), then opens a
   * fresh MCP connection to render it (`@loombox/providers-core`'s
   * `fetchMcpPromptText`, a second connection independent of whatever the
   * ACP agent itself did — see that module's own doc comment). Never
   * throws: any failure — unknown server name, a timed-out/unreachable
   * server, the server's own rejection (e.g. a missing required argument)
   * — becomes an `outcome: 'error'` payload naming the reason, so
   * {@link handleMcpPromptGetRequest} always has a response to seal and
   * send back rather than leaving the requesting client's
   * `RelayClient.getMcpPromptText` promise hanging.
   */
  private async renderMcpPromptForSession(
    sessionId: string,
    payload: McpPromptGetRequestPayloadV1,
  ): Promise<McpPromptGetResponsePayloadV1> {
    const servers = this.mcpServersBySession.get(sessionId);
    const server = servers?.find((candidate) => candidate.name === payload.serverName);
    if (!server) {
      return {
        outcome: 'error',
        message: `MCP server "${payload.serverName}" is not part of session ${sessionId}'s resolved server set`,
      };
    }
    try {
      const text = await fetchMcpPromptText(server, payload.promptName, payload.arguments ?? {});
      return { outcome: 'ok', text };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendMcpPromptGetResponse(
    sessionId: string,
    requestId: string,
    payload: McpPromptGetResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'mcp_prompt_get_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * The read-only file viewer's own byte cap (issue #737) — a real repo
   * can hold a multi-megabyte generated file; this bounds a single
   * `fs_read_request`'s response so an accidental "open" of one never ties
   * up the encrypted channel with megabytes of text nobody scrolls
   * through. `ExecutionTarget.readFile` has no size-limited variant, so
   * this reads the whole file then truncates — fine at this cap (1MB is
   * small for Node to hold twice), revisit only if a real workload needs
   * streaming.
   */
  private static readonly MAX_FS_READ_BYTES = 1_000_000;

  /**
   * A client asked (via the relay) this node to read one file inside one
   * of its sessions' projects (issue #737's read-only file viewer) —
   * `handleFsListRequest`'s sibling, same "no live bridge needed, always a
   * reply, never a silent drop" contract (issue #702).
   */
  private handleFsReadRequest(message: FsReadRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptFsReadRequest(message)
      .then((payload) => this.readFileForBridge(routing, payload.path))
      .then((responsePayload) =>
        this.sendFsReadResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle fs_read_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptFsReadRequest(message: FsReadRequest): Promise<FsReadRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<FsReadRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Resolves `requestedPath` against `routing`'s session root (the exact
   * same guard `listDirectoryForBridge` uses) and reads it via that
   * session's `ExecutionTarget`. A `\u0000` byte anywhere in the decoded
   * text is this function's binary detector — the traditional "this isn't
   * text" signal, since every `ExecutionTarget.readFile` implementation
   * decodes as UTF-8 regardless of the file's real encoding: a binary file
   * has no useful syntax-highlighted rendering, and forcing one through
   * would paint mojibake rather than something worth viewing. Never
   * throws itself: a path-traversal attempt, a directory, a missing file,
   * or an `ssh:` transport failure all become an `outcome: 'error'`
   * payload instead, so `handleFsReadRequest` always has a response to
   * seal and send back.
   */
  private async readFileForBridge(
    routing: SessionRouting,
    requestedPath: string,
  ): Promise<FsReadResponsePayloadV1> {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSessionRelativePath(routing.session.worktreePath, requestedPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }

    try {
      const target = await this.getExecutionTarget(routing.targetId);
      const content = await target.readFile(resolvedPath);
      if (content.includes('\u0000')) {
        return {
          outcome: 'error',
          path: requestedPath,
          message: 'Binary file — cannot preview as text.',
        };
      }
      const truncated = content.length > NodeDaemon.MAX_FS_READ_BYTES;
      return {
        outcome: 'ok',
        path: requestedPath,
        content: truncated ? content.slice(0, NodeDaemon.MAX_FS_READ_BYTES) : content,
        truncated,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }
  }

  private async sendFsReadResponse(
    sessionId: string,
    requestId: string,
    payload: FsReadResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'fs_read_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node for one session's current
   * working-tree diff (SPEC §7.4; issue #206's diff viewer) — `handleFsReadRequest`'s
   * sibling, same "no live bridge needed, always a reply, never a silent
   * drop" contract. No envelope on `git_diff_request` itself (see
   * `@loombox/protocol`'s `git-diff.ts` doc comment), so there is nothing
   * to decrypt before computing the diff, unlike `handleFsReadRequest`.
   */
  private handleGitDiffRequest(message: GitDiffRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.computeGitDiffForBridge(routing)
      .then((responsePayload) =>
        this.sendGitDiffResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_diff_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * Runs `computeWorktreeDiff` (`./git-diff.ts`) against `routing`'s own
   * `ExecutionTarget`, project-policy-scoped exactly like `pr-open.ts`'s
   * `previewPrOpen`/`openPr` callers below (both drive real `git`
   * subcommands the same way this does) — never `handleFsReadRequest`'s
   * unscoped `getExecutionTarget(routing.targetId)`, since that call
   * spawns no commands of its own. Never throws: a target that can't be
   * resolved, or a `GitDiffError` from a genuinely uncomputable diff (no
   * `git` on the target, not a git worktree at all), both become an
   * `outcome: 'error'` payload instead, so `handleGitDiffRequest` always
   * has a response to seal and send back.
   */
  private async computeGitDiffForBridge(
    routing: SessionRouting,
  ): Promise<GitDiffResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const files = await computeWorktreeDiff(target, routing.session.worktreePath);
      return { outcome: 'ok', files };
    } catch (error) {
      if (error instanceof GitDiffError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitDiffResponse(
    sessionId: string,
    requestId: string,
    payload: GitDiffResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_diff_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node for one session's current
   * staged/unstaged hunk breakdown (SPEC §7.6; issue #232) —
   * `handleGitDiffRequest`'s sibling, same "no live bridge needed, always
   * a reply, never a silent drop" contract. No envelope on
   * `git_hunk_diff_request` itself (see `@loombox/protocol`'s
   * `git-hunks.ts` doc comment), so there is nothing to decrypt before
   * computing the diff.
   */
  private handleGitHunkDiffRequest(message: GitHunkDiffRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.computeGitHunkDiffForBridge(routing)
      .then((responsePayload) =>
        this.sendGitHunkDiffResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_hunk_diff_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * Runs `computeHunkDiff` (`./git-diff.ts`) against `routing`'s own
   * `ExecutionTarget`, project-policy-scoped exactly like
   * `computeGitDiffForBridge` above (both drive real `git` subcommands the
   * same way). Never throws: a target that can't be resolved, or a
   * `GitDiffError` from a genuinely uncomputable diff, both become an
   * `outcome: 'error'` payload instead, so `handleGitHunkDiffRequest`
   * always has a response to seal and send back.
   */
  private async computeGitHunkDiffForBridge(
    routing: SessionRouting,
  ): Promise<GitHunkDiffResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const files = await computeHunkDiff(target, routing.session.worktreePath);
      return { outcome: 'ok', files };
    } catch (error) {
      if (error instanceof GitDiffError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitHunkDiffResponse(
    sessionId: string,
    requestId: string,
    payload: GitHunkDiffResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_hunk_diff_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to stage/unstage/discard one
   * hunk (SPEC §7.6; issue #232) — `handleFsReadRequest`'s sibling in
   * shape (an enveloped request, since `path` is real session content),
   * but mutating: `applyGitHunkAction` really does write to the index
   * and/or worktree rather than merely reading. The caller re-issues
   * `git_hunk_diff_request` afterward to see the result — this reply
   * itself carries no diff.
   */
  private handleGitHunkActionRequest(message: GitHunkActionRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitHunkActionRequest(message)
      .then((payload) => this.applyGitHunkActionForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitHunkActionResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_hunk_action_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptGitHunkActionRequest(
    message: GitHunkActionRequest,
  ): Promise<GitHunkActionRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitHunkActionRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Runs `applyGitHunkAction` (`./git-diff.ts`) against `routing`'s own
   * `ExecutionTarget`, project-policy-scoped exactly like
   * `computeGitHunkDiffForBridge` above. Never throws: a target that
   * can't be resolved, a `GitHunkActionError` (a stale `hunkIndex`, an
   * `unstage` with nothing staged, or the underlying git command
   * failing), or any other error all become an `outcome: 'error'`
   * payload instead, so `handleGitHunkActionRequest` always has a
   * response to seal and send back.
   */
  private async applyGitHunkActionForBridge(
    routing: SessionRouting,
    payload: GitHunkActionRequestPayloadV1,
  ): Promise<GitHunkActionResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await applyGitHunkAction(target, routing.session.worktreePath, payload);
      return { outcome: 'ok' };
    } catch (error) {
      if (error instanceof GitHunkActionError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitHunkActionResponse(
    sessionId: string,
    requestId: string,
    payload: GitHunkActionResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_hunk_action_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to draft a commit message
   * for one session's currently staged changes (SPEC §7.6; issue #233)
   * — generated by prompting the SESSION'S OWN live agent (never a
   * separate hardcoded provider call: the issue's own "message
   * generation must go through the session's existing agent rather than
   * a new provider path"), the exact same `bridge.agentSession.prompt()`
   * this daemon already drives for `promptSession`/`handleCiCheckFailure`
   * above. Unlike `handleGitDiffRequest`'s "no live bridge needed"
   * contract, drafting genuinely needs one — a session with no live
   * agent (archived, or `'disconnected'` since a restart) can't draft
   * anything and reports that plainly rather than silently falling back
   * to some other text source. Never itself commits anything: the draft
   * is purely advisory until the operator explicitly confirms via
   * `git_commit_request` (see that handler's own doc comment below).
   */
  private handleGitCommitDraftRequest(message: GitCommitDraftRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.draftGitCommitMessageForBridge(routing)
      .then((responsePayload) =>
        this.sendGitCommitDraftResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_commit_draft_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * Computes the current staged diff (`./git-commit.ts`'s
   * `computeStagedDiffText`, project-policy-scoped exactly like
   * `computeGitHunkDiffForBridge` above), refuses an empty index up
   * front with a clear reason (drafting a message for nothing staged is
   * meaningless, and would otherwise burn a real agent turn on an empty
   * prompt), then hands it to {@link draftCommitMessageViaAgent}. Never
   * throws: a target that can't be resolved, a `GitCommitError`, or any
   * other error (including "this session has no live agent") all become
   * an `outcome: 'error'` payload instead, so `handleGitCommitDraftRequest`
   * always has a response to seal and send back.
   */
  private async draftGitCommitMessageForBridge(
    routing: SessionRouting,
  ): Promise<GitCommitDraftResponsePayloadV1> {
    const bridge = this.bridges.get(routing.session.id);
    if (!bridge) {
      return {
        outcome: 'error',
        message: 'This session has no live agent to draft a commit message with.',
      };
    }
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const diffText = await computeStagedDiffText(target, routing.session.worktreePath);
      if (diffText.trim().length === 0) {
        return { outcome: 'error', message: 'Nothing staged to draft a commit message for.' };
      }
      const draft = await this.draftCommitMessageViaAgent(bridge, buildCommitDraftPrompt(diffText));
      if (!draft) {
        return { outcome: 'error', message: "The agent's draft came back empty." };
      }
      return { outcome: 'ok', message: draft };
    } catch (error) {
      if (error instanceof GitCommitError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * Prompts `bridge`'s own live agent and captures its whole reply as one
   * string — a real turn (`agentSession.prompt()`), not a hidden side
   * channel: this session's subscribed clients see the usual
   * `turn_started`/`agent_message_chunk`/`turn_ended` sequence exactly
   * like any other prompt, matching `handleCiCheckFailure`'s own
   * precedent for feeding the agent a synthesized instruction rather than
   * one the operator typed. `AcpTranscriptUpdate.text` for an
   * `agent_message_chunk` is that CHUNK's own delta, not the accumulated
   * message (`@loombox/providers-core`'s `AcpMessageChunkUpdate` doc
   * comment — the reducer, not the update itself, appends deltas into a
   * running item), so deltas are concatenated per `messageId` here; the
   * draft is whichever message the LAST chunk before `prompt()` resolves
   * belonged to. `agent_thought_chunk` updates are ignored: only a real
   * message counts as the draft.
   */
  private async draftCommitMessageViaAgent(
    bridge: SessionBridge,
    promptText: string,
  ): Promise<string> {
    const messageTextById = new Map<string, string>();
    let lastMessageId: string | undefined;
    const onTranscriptUpdate = (update: AcpTranscriptUpdate): void => {
      if (update.kind !== 'agent_message_chunk') return;
      messageTextById.set(
        update.messageId,
        (messageTextById.get(update.messageId) ?? '') + update.text,
      );
      lastMessageId = update.messageId;
    };
    bridge.agentSession.on('transcript_update', onTranscriptUpdate);
    try {
      await bridge.agentSession.prompt(promptText);
    } finally {
      bridge.agentSession.off('transcript_update', onTranscriptUpdate);
    }
    return (lastMessageId ? messageTextById.get(lastMessageId) : undefined)?.trim() ?? '';
  }

  private async sendGitCommitDraftResponse(
    sessionId: string,
    requestId: string,
    payload: GitCommitDraftResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_commit_draft_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to commit whatever is
   * currently staged, with `message` (SPEC §7.6; issue #233) — the
   * operator's own explicit confirm, accepting a
   * `git_commit_draft_response` verbatim or edited first (never sent
   * automatically; see `@loombox/protocol`'s `git-commit.ts` doc
   * comment). No live bridge needed (unlike drafting): committing is a
   * plain `git` mutation exactly like `applyGitHunkAction`, so it works
   * even for a session this node only knows from disk.
   */
  private handleGitCommitRequest(message: GitCommitRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitCommitRequest(message)
      .then((payload) => this.commitStagedForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitCommitResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_commit_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptGitCommitRequest(
    message: GitCommitRequest,
  ): Promise<GitCommitRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitCommitRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Runs `commitStaged` (`./git-commit.ts`) against `routing`'s own
   * `ExecutionTarget`, project-policy-scoped exactly like
   * `applyGitHunkActionForBridge` above. Never throws: a target that
   * can't be resolved, a `GitCommitError` (empty message, empty index,
   * or the underlying `git commit` command failing), or any other error
   * all become an `outcome: 'error'` payload instead, so
   * `handleGitCommitRequest` always has a response to seal and send
   * back.
   */
  private async commitStagedForBridge(
    routing: SessionRouting,
    payload: GitCommitRequestPayloadV1,
  ): Promise<GitCommitResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const { sha } = await commitStaged(target, routing.session.worktreePath, payload.message);
      return { outcome: 'ok', sha };
    } catch (error) {
      if (error instanceof GitCommitError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitCommitResponse(
    sessionId: string,
    requestId: string,
    payload: GitCommitResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_commit_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node for a project's tracker
   * snapshot (SPEC §7.10; issue #212) — the kanban/list UI's initial load
   * and its Retry action both funnel through this same handler.
   * Node-addressed by `nodeId` + `projectPath` (issue #697): no session or
   * `SessionBridge` is required, or even consulted, to read a project's
   * tracker — exactly the same addressing `handleTrackerModeGetRequest`
   * already uses. A project's records must be reachable from the Tracker
   * page with no agent session running for it at all, which the old
   * `this.bridges.get(message.sessionId)` guard structurally could never
   * allow (that guard, and this handler's own former `if (!bridge) return`,
   * are gone). Every request now gets an answer: an envelope that fails to
   * decrypt/parse (a stale AMK epoch, a corrupt or foreign envelope, ...)
   * becomes an `outcome: 'error'` response exactly like an unreadable
   * native store or an unresolvable `TrackerMode` dispatch already did —
   * never a silently dropped request, which could only ever surface to the
   * client as #691's class of bug one layer down: a timeout with no real
   * cause attached (this issue's own motivating bug report).
   */
  private handleTrackerSnapshotRequest(message: TrackerSnapshotRequest): void {
    this.decryptTrackerSnapshotRequest(message)
      .then((payload) => this.readTrackerSnapshot(message.projectPath, payload))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: could not read tracker_snapshot_request envelope for project ${message.projectPath}: ${detail}`,
        );
        return { outcome: 'error' as const, message: `This request could not be read: ${detail}` };
      })
      .then((responsePayload) =>
        this.sendTrackerSnapshotResponse(
          message.nodeId,
          message.projectPath,
          message.requestId,
          responsePayload,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send tracker_snapshot_response for project ${message.projectPath}: ${detail}`,
        );
      });
  }

  private async decryptTrackerSnapshotRequest(
    message: TrackerSnapshotRequest,
  ): Promise<TrackerSnapshotRequestPayloadV1> {
    const key = await this.getProjectKey(message.projectPath);
    return openJson<TrackerSnapshotRequestPayloadV1>(message.projectPath, message.envelope, key);
  }

  /**
   * The one seam `readTrackerSnapshot` and `applyTrackerWrite` both
   * dispatch through (SPEC §7.10; issue #631) — `projectPath`'s
   * `TrackerMode` is read here exactly once per call
   * (`this.trackerModeStore.get`, "never chosen" defaulting to
   * `{kind:'native'}`, same as `handleTrackerModeGetRequest`'s own
   * contract), and a `live` mode is resolved through
   * `resolveTrackerBackend` here exactly once per call, against this
   * daemon's own `connectedAccounts`/`accountPinStore`/
   * `githubConnectService`/`jiraConnectService`. There is structurally
   * nowhere for the two dispatch paths to see a different mode, a
   * different account list, or a different pin than each other — the
   * only place they're allowed to differ is `intent`, which changes
   * which #227 resolver `resolveTrackerBackend` applies
   * (`resolveAccountForRead` may default to an unambiguous candidate;
   * `resolveAccountForWrite` never does — SPEC §7.26's "falling back to
   * a different account for a write action is a correctness/security
   * bug"), never which mode/account/pin state it applies it to.
   */
  private async resolveTrackerDispatch(
    projectPath: string,
    intent: TrackerBackendIntent,
  ): Promise<TrackerBridgeDispatch> {
    const mode = this.trackerModeStore.get(projectPath) ?? { kind: 'native' as const };
    if (mode.kind !== 'live') return { kind: 'native' };

    const resolution = await resolveTrackerBackend({
      mode,
      projectPath,
      intent,
      accounts: this.connectedAccounts,
      pins: this.accountPinStore.get(projectPath),
      githubConnectService: this.githubConnectService,
      jiraConnectService: this.jiraConnectService,
      fetchImpl: this.trackerBackendFetchImpl,
    });
    if (!resolution.ok) return { kind: 'error', error: resolution.error };

    return {
      kind: 'live',
      backend: resolution.backend,
      binding: { connectionId: mode.connectionId, target: mode.target },
      provider: mode.provider,
      connectionId: mode.connectionId,
    };
  }

  /**
   * Reads `projectPath`'s tracker (SPEC §7.10; issue #631; project-
   * addressed directly rather than through a `SessionBridge` since issue
   * #697): dispatches on the project's `TrackerMode` through
   * {@link resolveTrackerDispatch}, shared with {@link applyTrackerWrite}
   * so the two can't diverge. `'native'` ({@link readNativeTrackerSnapshot})
   * behaves exactly as before this issue. `'live'`
   * ({@link readLiveTrackerSnapshot}) calls the resolved `TrackerBackend.list`
   * and maps its `TrackerItemLive[]` through `tracker-live-bridge.ts` into
   * the same `TrackerRecordV1[]`/`TrackerTypeDefinitionV1[]` shape, so the
   * Tracker page's kanban/list views need no live-specific rendering path.
   * `'error'` (an unresolvable mode) never falls back to the native store
   * — SPEC §7.10's explicit connectivity-error state — and carries both a
   * human `message` and the structured `reason` `TrackerPage.svelte`
   * switches on. {@link handleTrackerSnapshotRequest} always has a
   * response to seal and send back either way.
   */
  private async readTrackerSnapshot(
    projectPath: string,
    payload: TrackerSnapshotRequestPayloadV1,
  ): Promise<TrackerSnapshotResponsePayloadV1> {
    const dispatch = await this.resolveTrackerDispatch(projectPath, 'read');
    if (dispatch.kind === 'error') return trackerResolutionErrorPayload(dispatch.error);
    if (dispatch.kind === 'native') return this.readNativeTrackerSnapshot(projectPath, payload);
    return this.readLiveTrackerSnapshot(dispatch);
  }

  /** Never throws: a corrupt on-disk store becomes an `outcome: 'error'` payload rather than an unhandled rejection. */
  private readNativeTrackerSnapshot(
    projectPath: string,
    payload: TrackerSnapshotRequestPayloadV1,
  ): TrackerSnapshotResponsePayloadV1 {
    try {
      const records = this.nativeTrackerStore.list(projectPath, {
        includeArchived: payload.includeArchived,
      });
      const types = this.nativeTrackerStore.listTypes(projectPath);
      return { outcome: 'ok', records, types };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * The live half of {@link readTrackerSnapshot}. Only the first page of
   * `dispatch.backend.list` is fetched — `tracker_snapshot_request`
   * carries no cursor field for a caller to page through, a real,
   * documented limitation of this bridge rather than dropped pagination.
   * Never throws: a backend/network failure (as opposed to a resolution
   * failure, already handled by `resolveTrackerDispatch`'s own `'error'`
   * dispatch) becomes an `outcome: 'error'` payload the same way a
   * corrupt native store does.
   */
  private async readLiveTrackerSnapshot(
    dispatch: Extract<TrackerBridgeDispatch, { kind: 'live' }>,
  ): Promise<TrackerSnapshotResponsePayloadV1> {
    try {
      const page = await dispatch.backend.list(dispatch.binding, {});
      const records = page.items.map((item) =>
        liveItemToTrackerRecord(item, dispatch.provider, dispatch.connectionId),
      );
      return { outcome: 'ok', records, types: [liveTrackerTypeDefinition(dispatch.provider)] };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendTrackerSnapshotResponse(
    nodeId: string,
    projectPath: string,
    requestId: string,
    payload: TrackerSnapshotResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getProjectKey(projectPath);
    const envelope = await sealJson(projectPath, payload, key);
    this.relay.send({
      type: 'tracker_snapshot_response',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      projectPath,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to create/update a native
   * tracker record, or define a custom type, against a project (SPEC
   * §7.10; issue #212) — the kanban board's drag-to-move, the create/edit
   * dialogs, and the custom-type dialog all funnel through this one
   * handler. Mirrors `handleTrackerSnapshotRequest`'s node-addressed
   * decrypt/reply shape exactly, including its "every request gets an
   * answer" contract (issue #697).
   */
  private handleTrackerWriteRequest(message: TrackerWriteRequest): void {
    this.decryptTrackerWriteRequest(message)
      .then((payload) => this.applyTrackerWrite(message.projectPath, payload))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: could not read tracker_write_request envelope for project ${message.projectPath}: ${detail}`,
        );
        return { outcome: 'error' as const, message: `This request could not be read: ${detail}` };
      })
      .then((responsePayload) =>
        this.sendTrackerWriteResponse(
          message.nodeId,
          message.projectPath,
          message.requestId,
          responsePayload,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send tracker_write_response for project ${message.projectPath}: ${detail}`,
        );
      });
  }

  private async decryptTrackerWriteRequest(
    message: TrackerWriteRequest,
  ): Promise<TrackerWriteRequestPayloadV1> {
    const key = await this.getProjectKey(message.projectPath);
    return openJson<TrackerWriteRequestPayloadV1>(message.projectPath, message.envelope, key);
  }

  /**
   * Applies one create/update/defineType op against `projectPath` (SPEC
   * §7.10; issue #631; project-addressed directly rather than through a
   * `SessionBridge` since issue #697) — dispatches on `TrackerMode`
   * through {@link resolveTrackerDispatch}, called with `intent:'write'`
   * (never `'read'`) so an unpinned live account never defaults
   * silently — see that method's own doc comment. `'error'` never falls
   * back to the native store, same as {@link readTrackerSnapshot}.
   */
  private async applyTrackerWrite(
    projectPath: string,
    payload: TrackerWriteRequestPayloadV1,
  ): Promise<TrackerWriteResponsePayloadV1> {
    const dispatch = await this.resolveTrackerDispatch(projectPath, 'write');
    if (dispatch.kind === 'error') return trackerResolutionErrorPayload(dispatch.error);
    if (dispatch.kind === 'native') return this.applyNativeTrackerWrite(projectPath, payload);
    return this.applyLiveTrackerWrite(dispatch, payload);
  }

  /**
   * `authorId` on a `create` is always this node's own bound `accountId`
   * — never taken from the client payload (there is no such field on
   * the wire schema), the human-UI counterpart of `tracker_create`'s
   * MCP-tool "stamped from context, never from tool input" contract.
   * Never throws: an unknown type or a missing record id
   * (`NativeTrackerStoreError`) becomes an `outcome: 'error'` payload
   * rather than an unhandled rejection.
   */
  private applyNativeTrackerWrite(
    projectPath: string,
    payload: TrackerWriteRequestPayloadV1,
  ): TrackerWriteResponsePayloadV1 {
    try {
      switch (payload.op) {
        case 'create': {
          const record = this.nativeTrackerStore.create(projectPath, {
            primaryType: payload.primaryType,
            typeTags: payload.typeTags,
            fields: payload.fields,
            authorId: this.accountId,
          });
          return { outcome: 'ok', record };
        }
        case 'update': {
          const record = this.nativeTrackerStore.update(projectPath, payload.id, {
            primaryType: payload.primaryType,
            typeTags: payload.typeTags,
            fields: payload.fields,
            archived: payload.archived,
          });
          return { outcome: 'ok', record };
        }
        case 'defineType': {
          const typeDefinition = this.nativeTrackerStore.defineType(projectPath, {
            id: payload.id,
            label: payload.label,
            builtin: false,
            roles: payload.roles,
          });
          return { outcome: 'ok', typeDefinition };
        }
      }
    } catch (error) {
      const detail =
        error instanceof NativeTrackerStoreError || error instanceof Error
          ? error.message
          : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * The live half of {@link applyTrackerWrite}. `create`/`update`
   * forward `fields` straight to the resolved `TrackerBackend` — a live
   * record has no native `primaryType`/`typeTags`/`archived` concept to
   * apply, see `tracker-live-bridge.ts`'s own doc comment for what a
   * live-mode record actually carries. `defineType` has no live-mode
   * analog (a live project's types come from the provider, never a user
   * definition) and fails immediately, without attempting a backend
   * call. Never throws: a backend/network failure becomes an
   * `outcome: 'error'` payload, same as {@link readLiveTrackerSnapshot}.
   */
  private async applyLiveTrackerWrite(
    dispatch: Extract<TrackerBridgeDispatch, { kind: 'live' }>,
    payload: TrackerWriteRequestPayloadV1,
  ): Promise<TrackerWriteResponsePayloadV1> {
    try {
      switch (payload.op) {
        case 'create': {
          const item = await dispatch.backend.create(dispatch.binding, payload.fields);
          return {
            outcome: 'ok',
            record: liveItemToTrackerRecord(item, dispatch.provider, dispatch.connectionId),
          };
        }
        case 'update': {
          const item = await dispatch.backend.update(
            dispatch.binding,
            payload.id,
            payload.fields ?? {},
          );
          return {
            outcome: 'ok',
            record: liveItemToTrackerRecord(item, dispatch.provider, dispatch.connectionId),
          };
        }
        case 'defineType':
          return {
            outcome: 'error',
            message: 'Custom tracker types are only supported for native-mode projects.',
          };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendTrackerWriteResponse(
    nodeId: string,
    projectPath: string,
    requestId: string,
    payload: TrackerWriteResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getProjectKey(projectPath);
    const envelope = await sealJson(projectPath, payload, key);
    this.relay.send({
      type: 'tracker_write_response',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      projectPath,
      requestId,
      envelope,
    });
  }

  /**
   * `nodeId`'s answer to whether/how `projectPath` tracks work (SPEC
   * §7.10; issue #631) — `TrackerModeStore.get`'s wire counterpart.
   * `mode` in the reply is `undefined` for a project that has never had
   * one chosen, distinct from an explicit `{kind:'native'}` (see
   * `tracker.ts`'s `trackerModeResponse` doc comment — collapsing that
   * distinction here would silently reintroduce the guess issue #209
   * exists to prevent).
   */
  private handleTrackerModeGetRequest(message: TrackerModeGetRequest): void {
    const mode = this.trackerModeStore.get(message.projectPath);
    this.sendTrackerModeResponse(message.requestId, message.projectPath, mode);
  }

  /** `TrackerModeStore.set` (SPEC §7.10; issue #631) — saves `message.mode` for `message.projectPath`. There is deliberately no unset handler (mirrors `trackerModeSetRequest`'s own doc comment). Replies with the resulting mode re-read through the store, mirroring `handleAccountPinSetRequest`'s same re-read-after-write convention, so the client never needs a second round trip. */
  private handleTrackerModeSetRequest(message: TrackerModeSetRequest): void {
    this.trackerModeStore.set(message.projectPath, message.mode);
    this.sendTrackerModeResponse(
      message.requestId,
      message.projectPath,
      this.trackerModeStore.get(message.projectPath),
    );
  }

  private sendTrackerModeResponse(
    requestId: string,
    projectPath: string,
    mode: TrackerMode | undefined,
  ): void {
    this.relay.send({
      type: 'tracker_mode_response',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      projectPath,
      mode,
    });
  }

  /**
   * A client asked (via the relay) this node to list a directory on one of
   * its OWN targets' filesystems, before any session exists there (SPEC
   * §7.25's directory picker; issue #474) — `handleFsListRequest`'s
   * target-scoped sibling, keyed by `targetId` directly rather than an
   * existing session's `sessionId`. Ignored if `targetId` isn't one of this
   * node's own targets (mirrors `handleSessionCreate`'s same guard). A
   * decrypt failure is logged and dropped (there is no path to reply
   * about); everything past that — an unreadable/missing directory, an
   * `ssh:` transport failure — becomes an `outcome: 'error'` response
   * instead of a silent drop, exactly like `handleFsListRequest`'s own
   * contract.
   */
  private handleTargetFsListRequest(message: TargetFsListRequest): void {
    if (!this.targets.some((target) => target.id === message.targetId)) {
      console.warn(`NodeDaemon: target_fs_list_request for unknown target "${message.targetId}"`);
      return;
    }

    this.decryptTargetFsListRequest(message)
      .then((payload) => this.listDirectoryForTarget(message.targetId, payload.path))
      .then((responsePayload) =>
        this.sendTargetFsListResponse(message.targetId, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle target_fs_list_request for target ${message.targetId}: ${detail}`,
        );
      });
  }

  private async decryptTargetFsListRequest(
    message: TargetFsListRequest,
  ): Promise<TargetFsListRequestPayloadV1> {
    const key = await this.getTargetKey(message.targetId);
    return openJson<TargetFsListRequestPayloadV1>(message.targetId, message.envelope, key);
  }

  /**
   * Lists `requestedPath` directly on `targetId`'s filesystem — unlike
   * {@link listDirectoryForBridge}, there is no session worktree root to
   * bound traversal against (SPEC §7.25: the whole point is browsing to
   * PICK a project directory, anywhere the target can reach), so an empty/
   * `.` path resolves to the target's own home directory instead of a
   * session root (see {@link resolveTargetFsPath}). Entries come back
   * directories-first, then alphabetically, since this is meant to drive a
   * picker (SPEC §7.25's acceptance) rather than merely mirror the
   * filesystem's own return order. Also reports whether `resolvedPath`
   * itself is a git work tree (`gitRepo`; issue #507), so the picker can
   * offer or hide SPEC §7.1's worktree choice before any session exists —
   * probed alongside the listing, never a reason for the listing itself to
   * fail: a folder that isn't a repo is still a perfectly good SPEC §6
   * project. Never throws: a failure becomes an `outcome: 'error'` payload,
   * exactly like `listDirectoryForBridge`.
   */
  private async listDirectoryForTarget(
    targetId: string,
    requestedPath: string,
  ): Promise<TargetFsListResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(targetId);
      const resolvedPath = await this.resolveTargetFsPath(target, requestedPath);
      const entries = await target.readdirDetailed(resolvedPath);
      const mapped = entries.map((entry) => ({
        name: entry.name,
        // `readdirDetailed`'s `'other'` (socket/device/fifo) collapses to
        // `'file'` on the wire, same as `listDirectoryForBridge`'s own map.
        kind: entry.type === 'other' ? ('file' as const) : entry.type,
        size: entry.size,
      }));
      mapped.sort((a, b) => {
        if (a.kind === 'dir' && b.kind !== 'dir') return -1;
        if (b.kind === 'dir' && a.kind !== 'dir') return 1;
        return a.name.localeCompare(b.name);
      });

      // The same `git -C <path> rev-parse --is-inside-work-tree` probe
      // `assertIsGitRepo` (`./session-manager.ts`) runs for `local` sessions,
      // repeated here over `ExecutionTarget.exec` so the identical check
      // also works for `ssh:` targets. Its own try/catch, nested inside the
      // one around this whole method: a host with no `git` on PATH, or a
      // path that plain isn't a repo, both just mean `gitRepo: false` —
      // never a reason for the listing itself to fail (see this method's
      // doc comment above).
      let gitRepo = false;
      try {
        const probe = await target.exec('git', [
          '-C',
          resolvedPath,
          'rev-parse',
          '--is-inside-work-tree',
        ]);
        gitRepo = probe.exitCode === 0 && probe.stdout.trim() === 'true';
      } catch {
        // git missing, or some other exec failure — still not a repo.
      }

      return { outcome: 'ok', path: resolvedPath, entries: mapped, gitRepo };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', path: requestedPath, message: detail };
    }
  }

  /**
   * Resolves an empty/`.` `requestedPath` to `target`'s own home directory;
   * any other value is used as-is (SPEC §7.25: browsing here is not bounded
   * to a project root). `local` reaches for `os.homedir()` directly
   * (mirrors `resource-sampler.ts`'s own `diskPath` default); `ssh:` has no
   * such direct handle, so this runs `pwd` with no `cwd` override —
   * `ExecutionTarget.exec`'s own "omit for the target's own default", which
   * for a real login shell is ordinarily `$HOME`.
   */
  private async resolveTargetFsPath(
    target: ExecutionTarget,
    requestedPath: string,
  ): Promise<string> {
    const trimmed = requestedPath.trim();
    if (trimmed !== '' && trimmed !== '.') return trimmed;
    if (target.kind === 'local') return homedir();
    const result = await target.exec('pwd', []);
    if (result.exitCode !== 0) {
      throw new Error(`could not resolve the target's default directory: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  private async sendTargetFsListResponse(
    targetId: string,
    requestId: string,
    payload: TargetFsListResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getTargetKey(targetId);
    const envelope = await sealJson(targetId, payload, key);
    this.relay.send({
      type: 'target_fs_list_response',
      protocolVersion: PROTOCOL_V1,
      targetId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) this node to check whether a custom
   * agent's `command` could actually run on one of its targets (issue
   * #748's provider-availability-probing bullet) — `handleTargetFsListRequest`'s
   * sibling, same "no session yet" routing (`nodeId`+`targetId` directly).
   * Reports TWO independent facts rather than one boolean: `available`
   * (this node's own PATH probe on that target, `probeProviderAvailability`
   * — the exact mechanism a registered provider's `requiredCommand` is
   * checked with today) and `allowed` (this node's own allowlist verdict,
   * `isCustomAgentCommandAllowed`) — a command can be installed but not
   * allowlisted, or the reverse, and the client should be able to tell
   * those apart rather than see one undifferentiated "no". Never a silent
   * drop: an unknown target or a decrypt/exec failure still replies, with
   * `outcome: 'error'`, exactly like `handleTargetFsListRequest`'s own
   * contract.
   */
  private handleCustomAgentProbeRequest(message: CustomAgentProbeRequest): void {
    if (!this.targets.some((target) => target.id === message.targetId)) {
      console.warn(
        `NodeDaemon: custom_agent_probe_request for unknown target "${message.targetId}"`,
      );
      return;
    }

    this.decryptCustomAgentProbeRequest(message)
      .then(async (payload): Promise<CustomAgentProbeResultV1> => {
        const executionTarget = await this.getExecutionTarget(message.targetId);
        const found = await probeProviderAvailability(
          executionTarget,
          [{ id: payload.command, requiredCommand: payload.command }],
          message.targetId,
        );
        return {
          outcome: 'ok',
          available: found.includes(payload.command),
          allowed: isCustomAgentCommandAllowed(payload.command, this.customAgentAllowlist),
        };
      })
      .catch((error: unknown): CustomAgentProbeResultV1 => ({
        outcome: 'error',
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((result) =>
        this.sendCustomAgentProbeResponse(message.targetId, message.requestId, result),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle custom_agent_probe_request for target ${message.targetId}: ${detail}`,
        );
      });
  }

  private async decryptCustomAgentProbeRequest(
    message: CustomAgentProbeRequest,
  ): Promise<CustomAgentProbeRequestPayloadV1> {
    const key = await this.getTargetKey(message.targetId);
    const raw = await openJson<unknown>(message.targetId, message.envelope, key);
    return parseCustomAgentProbeRequestPayloadV1(raw);
  }

  private async sendCustomAgentProbeResponse(
    targetId: string,
    requestId: string,
    result: CustomAgentProbeResultV1,
  ): Promise<void> {
    const key = await this.getTargetKey(targetId);
    const envelope = await sealJson(targetId, { result }, key);
    this.relay.send({
      type: 'custom_agent_probe_response',
      protocolVersion: PROTOCOL_V1,
      targetId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked (via the relay) THIS node to run `discoverSshTargets()`
   * on its own machine (redesign v2 §3.2; issue #475) — the add-target
   * wizard's candidate-card picker, for a client (the PWA) with no local
   * filesystem/IPC access of its own to autodetect `~/.ssh/config` +
   * ssh-agent the way the desktop app's IPC bridge does directly. Plain
   * fields, no envelope (see `@loombox/protocol`'s `ssh-discovery.ts` doc
   * comment for why), so unlike `handleTargetFsListRequest` there is no
   * decrypt step and no per-target key to resolve. `discoverSshTargets`
   * itself never throws (see its own doc comment), but this still always
   * replies — an `outcome: 'error'` for an unexpected failure rather than a
   * hang with no answer, exactly like `listDirectoryForTarget`'s own
   * contract.
   */
  private handleSshDiscoveryRequest(message: SshDiscoveryRequest): void {
    this.discoverSshTargetsImpl(this.sshDiscoveryOptions)
      .then((discovery) =>
        this.sendSshDiscoveryResponse(message.requestId, {
          outcome: 'ok',
          candidates: discovery.candidates,
          agent: discovery.agent,
          requiresManualEntry: discovery.requiresManualEntry,
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendSshDiscoveryResponse(message.requestId, { outcome: 'error', message: detail });
      });
  }

  private sendSshDiscoveryResponse(requestId: string, result: SshDiscoveryResultV1): void {
    this.relay.send({
      type: 'ssh_discovery_response',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      result,
    });
  }

  /**
   * A client asked (via the relay) this node to start SPEC §7.26's GitHub
   * device-flow connect (issue #222's flow, reachable here for #230).
   * Fails immediately with a named `'error'` outcome if this node has no
   * GitHub OAuth App client id configured (`githubConnectClientId`) —
   * never attempts a call GitHub would just reject. Otherwise runs
   * `GithubConnectService.connect`, streaming the device/user code back
   * the moment GitHub issues it (`github_connect_device_code`) and
   * announcing the resulting account (`connected_account_announce`, issue
   * #221) before the terminal `github_connect_result` — a client that
   * only listens for the terminal message still sees a fully synced
   * account either way. `handleGithubConnectCancelRequest` aborts through
   * the same `AbortController` this registers in `githubConnectFlows`.
   */
  private handleGithubConnectStartRequest(message: GithubConnectStartRequest): void {
    if (!this.githubConnectClientId) {
      this.sendGithubConnectResult(message.requestId, {
        outcome: 'failure',
        reason: 'error',
        message:
          'this node has no GitHub OAuth App client id configured (LOOMBOX_GITHUB_CONNECT_CLIENT_ID)',
      });
      return;
    }
    const controller = new AbortController();
    this.githubConnectFlows.set(message.requestId, controller);
    this.githubConnectService
      .connect({
        clientId: this.githubConnectClientId,
        signal: controller.signal,
        onUserCode: (info) => {
          this.relay.send({
            type: 'github_connect_device_code',
            protocolVersion: PROTOCOL_V1,
            requestId: message.requestId,
            nodeId: this.nodeId,
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            ...(info.verificationUriComplete
              ? { verificationUriComplete: info.verificationUriComplete }
              : {}),
            expiresInSeconds: info.expiresInSeconds,
            intervalSeconds: info.intervalSeconds,
          });
        },
      })
      .then((account) => {
        this.relay.send({
          type: 'connected_account_announce',
          protocolVersion: PROTOCOL_V1,
          account,
        });
        this.sendGithubConnectResult(message.requestId, { outcome: 'success', account });
      })
      .catch((error: unknown) => {
        this.sendGithubConnectResult(message.requestId, githubConnectFailureFromError(error));
      })
      .finally(() => {
        this.githubConnectFlows.delete(message.requestId);
      });
  }

  /** Cancels an in-flight `github_connect_start_request` — a no-op if `requestId` names no flow this node currently holds (already settled, or never started here). Fire-and-forget: `handleGithubConnectStartRequest`'s own `.catch` is what sends the resulting `github_connect_result` (reason `'cancelled'`), via `runGithubDeviceFlow`'s `AbortSignal` contract. */
  private handleGithubConnectCancelRequest(message: GithubConnectCancelRequest): void {
    this.githubConnectFlows.get(message.requestId)?.abort();
  }

  private sendGithubConnectResult(requestId: string, result: GithubConnectOutcome): void {
    this.relay.send({
      type: 'github_connect_result',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      result,
    });
  }

  /**
   * A client asked (via the relay) this node to run SPEC §7.26's Jira
   * API-token connect path (issue #225's flow, reachable here for #230)
   * against `{siteUrl, email, apiToken}` the operator just typed. One
   * round trip — success announces the account (`connected_account_announce`,
   * issue #221) before replying, exactly like the GitHub flow above.
   */
  private handleJiraConnectRequest(message: JiraConnectRequest): void {
    this.jiraConnectService
      .connect({ siteUrl: message.siteUrl, email: message.email, apiToken: message.apiToken })
      .then((account) => {
        this.relay.send({
          type: 'connected_account_announce',
          protocolVersion: PROTOCOL_V1,
          account,
        });
        this.sendJiraConnectResponse(message.requestId, { outcome: 'success', account });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendJiraConnectResponse(message.requestId, { outcome: 'failure', message: detail });
      });
  }

  private sendJiraConnectResponse(requestId: string, result: JiraConnectOutcome): void {
    this.relay.send({
      type: 'jira_connect_response',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      result,
    });
  }

  /**
   * A client asked (via the relay) this node to disconnect `accountId` —
   * deletes the local keyring entry for whichever provider's connect
   * service owns it (`GithubConnectService.deleteAccessToken` /
   * `JiraConnectService.deleteCredential`, both keyed identically by
   * `secretRef`), then replies `outcome: 'ok'`; the relay itself forgets
   * the synced metadata row on that reply (`relay.ts`'s
   * `connected_account_disconnect_response` handler), not this node. Does
   * not scan for or unpin project pins referencing this account (issue
   * #229's full scan-and-warn) — the client already confirmed with the
   * operator before ever sending this (SPEC §7.26).
   */
  private handleConnectedAccountDisconnectRequest(
    message: ConnectedAccountDisconnectRequest,
  ): void {
    const parsed = parseConnectedAccountId(message.accountId);
    const secretRef = connectedAccountSecretRef(message.accountId);
    const deletion =
      parsed?.provider === 'github'
        ? this.githubConnectService.deleteAccessToken({ secretRef })
        : parsed?.provider === 'jira'
          ? this.jiraConnectService.deleteCredential({ secretRef })
          : Promise.reject(
              new Error(
                `connected_account_disconnect_request: unknown provider for account id "${message.accountId}"`,
              ),
            );
    deletion
      .then(() => {
        this.relay.send({
          type: 'connected_account_disconnect_response',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          nodeId: this.nodeId,
          accountId: message.accountId,
          outcome: 'ok',
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.relay.send({
          type: 'connected_account_disconnect_response',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          nodeId: this.nodeId,
          accountId: message.accountId,
          outcome: 'error',
          message: detail,
        });
      });
  }

  /** SPEC §7.26/#227's `AccountPinStore.get` — `projectPath`'s full pin map, unchanged. */
  private handleAccountPinGetRequest(message: AccountPinGetRequest): void {
    const pins = this.accountPinStore.get(message.projectPath);
    this.sendAccountPinResponse(message.requestId, message.projectPath, pins);
  }

  /** `AccountPinStore.setPin` — pins `message.capability` to `message.accountId`, or records an explicit opt-out when it's `null`. Replies with the resulting full map so the client never needs a second round trip. */
  private handleAccountPinSetRequest(message: AccountPinSetRequest): void {
    this.accountPinStore.setPin(message.projectPath, message.capability, message.accountId);
    this.sendAccountPinResponse(
      message.requestId,
      message.projectPath,
      this.accountPinStore.get(message.projectPath),
    );
  }

  /** `AccountPinStore.unsetPin` — reverts `message.capability` to unconfigured (deletes the key entirely, distinct from `handleAccountPinSetRequest`'s explicit-`null` opt-out). */
  private handleAccountPinUnsetRequest(message: AccountPinUnsetRequest): void {
    this.accountPinStore.unsetPin(message.projectPath, message.capability);
    this.sendAccountPinResponse(
      message.requestId,
      message.projectPath,
      this.accountPinStore.get(message.projectPath),
    );
  }

  private sendAccountPinResponse(
    requestId: string,
    projectPath: string,
    pins: AccountPinMap,
  ): void {
    this.relay.send({
      type: 'account_pin_response',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      projectPath,
      pins: toWireAccountPinMap(pins),
    });
  }

  /**
   * A client asked (via the relay) this node to preview what
   * `message.capability` currently resolves to for `message.projectPath`,
   * without performing a write-back action (SPEC §7.26/#227's
   * `resolveAccountForRead`/`resolveAccountForWrite`, reachable here for
   * #230's pin picker). `message.accounts` — the client's own already-
   * synced list — and this node's own locally-stored pin map are the only
   * two inputs either resolver needs.
   */
  private handleAccountPinResolveRequest(message: AccountPinResolveRequest): void {
    const pins = this.accountPinStore.get(message.projectPath);
    const params = {
      pins,
      capability: message.capability,
      accounts: message.accounts,
      target: message.target,
    };
    try {
      const account =
        message.mode === 'read' ? resolveAccountForRead(params) : resolveAccountForWrite(params);
      this.sendAccountPinResolveResponse(
        message.requestId,
        account ? { outcome: 'resolved', account } : { outcome: 'none' },
      );
    } catch (error) {
      const outcome = accountPinResolveErrorFromException(error);
      if (!outcome) {
        // Defensive: account-pin.ts's own contract is that its resolvers
        // only ever throw one of the five AccountResolutionError
        // subclasses `accountPinResolveErrorFromException` checks —
        // anything else is a bug in that contract, not a state this
        // response type can label. Logged rather than silently dropped or
        // left to crash this node's relay message handler.
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: unexpected error resolving account pin for "${message.capability}": ${detail}`,
        );
        return;
      }
      this.sendAccountPinResolveResponse(message.requestId, outcome);
    }
  }

  private sendAccountPinResolveResponse(requestId: string, result: AccountPinResolveOutcome): void {
    this.relay.send({
      type: 'account_pin_resolve_response',
      protocolVersion: PROTOCOL_V1,
      requestId,
      nodeId: this.nodeId,
      result,
    });
  }

  /**
   * A client asked (via the relay) this node to decommission one of its own
   * `ssh:` targets — Remove, or the teardown half of Edit (redesign v2
   * §3.3; issue #476): `./ssh/decommission.ts`'s already-tested
   * `decommissionSshTarget`, over this target's pooled transport. Always
   * replies — `ok: true` with the step summary, or `ok: false` with an
   * explanatory message for an unknown target, the `local` target (nothing
   * to decommission), or a genuine failure (an unreachable transport, a
   * failed remote command) — exactly like `handleSshDiscoveryRequest`'s own
   * "never a silent hang" contract. On success this node also forgets the
   * target itself (see {@link forgetSshTarget}).
   */
  private handleDecommissionTargetRequest(message: DecommissionTargetRequest): void {
    const target = this.targets.find((candidate) => candidate.id === message.targetId);
    if (!target) {
      this.sendDecommissionTargetResponse(message, {
        ok: false,
        message: `unknown target "${message.targetId}"`,
      });
      return;
    }
    if (target.kind === 'local') {
      this.sendDecommissionTargetResponse(message, {
        ok: false,
        message: 'the local target cannot be decommissioned',
      });
      return;
    }

    this.getSshTransport(message.targetId)
      .then((transport) =>
        decommissionSshTarget(transport, this.sshTargetStore, {
          targetId: message.targetId,
          removeFiles: message.removeFiles,
        }),
      )
      .then((result) => {
        this.forgetSshTarget(message.targetId);
        this.sendDecommissionTargetResponse(message, {
          ok: true,
          result: {
            unitWasInstalled: result.unitWasInstalled,
            unitStopped: result.unitStopped,
            unitDisabled: result.unitDisabled,
            deviceKeyRevoked: result.deviceKeyRevoked,
            filesRemoved: result.filesRemoved,
          },
          message: `decommissioned "${message.targetId}"`,
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendDecommissionTargetResponse(message, { ok: false, message: detail });
      });
  }

  private sendDecommissionTargetResponse(
    message: DecommissionTargetRequest,
    outcome:
      { ok: true; result: DecommissionResultV1; message: string } | { ok: false; message: string },
  ): void {
    this.relay.send({
      type: 'decommission_target_response',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      nodeId: this.nodeId,
      targetId: message.targetId,
      ...outcome,
    });
  }

  /**
   * Fully forgets `targetId` right after a successful decommission (issue
   * #476): drops it from every in-memory index this node keeps
   * (`sshTargetConfigs`, `sshExecutionTargets`, `remoteRunners`, the health
   * sampler's probe), closes its pooled transport, removes it from
   * `this.targets`, and re-announces the now-smaller target list — the
   * wire-level counterpart to `decommission.ts`'s own doc comment: "the
   * target genuinely no longer appears as usable the instant this returns."
   */
  private forgetSshTarget(targetId: string): void {
    const index = this.targets.findIndex((candidate) => candidate.id === targetId);
    if (index !== -1) this.targets.splice(index, 1);
    this.sshTargetConfigs.delete(targetId);
    this.sshExecutionTargets.delete(targetId);
    this.remoteRunners.delete(targetId);
    this.providerAvailability.delete(targetId);
    this.targetHealthSampler.removeProbe(targetId);
    this.sshTransportPool.close(targetId).catch(() => {});
    this.sendTargetAnnounce();
  }

  /**
   * A client asked (via the relay) this node to run the "Update" one-tap
   * action against one of its own `ssh:` targets (redesign v2 §3.3; issue
   * #476) — `TargetUpdateMonitor.updateTarget`'s wire-level counterpart,
   * over this target's pooled transport. Always replies, exactly like
   * {@link handleDecommissionTargetRequest}. Requires
   * `NodeDaemonOptions.targetUpdate` to be configured (see that option's own
   * doc comment for why none is wired in by default yet); without it,
   * replies `ok: false` rather than pretending to update anything real.
   */
  private handleTargetUpdateRequest(message: TargetUpdateRequest): void {
    const target = this.targets.find((candidate) => candidate.id === message.targetId);
    if (!target) {
      this.sendTargetUpdateResponse(message, {
        ok: false,
        message: `unknown target "${message.targetId}"`,
      });
      return;
    }
    if (target.kind === 'local') {
      this.sendTargetUpdateResponse(message, {
        ok: false,
        message: 'the local target has no supervisor version to update',
      });
      return;
    }
    const updateOptions = this.targetUpdateOptions;
    const monitor = this.targetUpdateMonitor;
    if (!updateOptions || !monitor) {
      this.sendTargetUpdateResponse(message, {
        ok: false,
        message: 'target updates are not configured on this node',
      });
      return;
    }

    this.getSshTransport(message.targetId)
      .then((transport) =>
        monitor.updateTarget(message.targetId, transport, {
          artifactSource: updateOptions.artifactSource,
          publicKey: updateOptions.publicKey,
          baseDir: updateOptions.baseDir,
        }),
      )
      .then((result) => {
        const handshake = monitor.statusFor(message.targetId);
        this.sendTargetUpdateResponse(message, {
          ok: result.ok,
          status: handshake?.status,
          remoteVersion: handshake?.remoteVersion,
          installedVersion: result.installedVersion,
          message:
            result.error ??
            (result.installedVersion
              ? `"${message.targetId}" is now at ${result.installedVersion}`
              : `"${message.targetId}": ${result.action}`),
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.sendTargetUpdateResponse(message, { ok: false, message: detail });
      });
  }

  private sendTargetUpdateResponse(
    message: TargetUpdateRequest,
    outcome: {
      ok: boolean;
      status?: TargetVersionStatusV1;
      remoteVersion?: string;
      installedVersion?: string;
      message: string;
    },
  ): void {
    this.relay.send({
      type: 'target_update_response',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      nodeId: this.nodeId,
      targetId: message.targetId,
      ...outcome,
    });
  }

  /**
   * A client asked (via the relay) this node to open a new interactive PTY
   * terminal on one of its sessions' targets (SPEC §7.5; issues #172/#173).
   * Ignored if `sessionId` isn't one of this node's sessions at all
   * ({@link resolveSessionRouting}'s guard, mirroring
   * `handleFsListRequest`'s same one). Opening a terminal needs nothing but
   * the session's `worktreePath` + `targetId` (issue #702) — never the live
   * agent — so this keeps working for a session reloaded `'disconnected'`
   * after a restart exactly as well as a live one. Always replies with
   * `terminal_opened` — `outcome: 'ok'` once the PTY is spawned and
   * streaming, or `outcome: 'error'` for a decrypt failure, an unknown
   * target, or a spawn failure — so the client never hangs waiting for a
   * reply that never comes, per `@loombox/protocol`'s
   * `terminalOpenResultPayloadV1` doc comment.
   */
  private handleTerminalOpen(message: TerminalOpen): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptTerminalOpenPayload(message)
      .then((payload) => this.openTerminalForBridge(routing, message.terminalId, payload))
      .then(({ cwd, shell }) =>
        this.sendTerminalOpened(routing.session.id, message.terminalId, message.requestId, {
          outcome: 'ok',
          cwd,
          shell,
        }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle terminal_open for session ${message.sessionId} terminal ${message.terminalId}: ${detail}`,
        );
        this.sendTerminalOpened(routing.session.id, message.terminalId, message.requestId, {
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
   * Spawns `terminalId`'s PTY on `routing`'s target and wires its
   * output/exit back to the relay (issue #172's "the same terminal works
   * identically whether the target is `local` or `ssh:`"): a `local`
   * target gets a real `node-pty` process (`TerminalSupervisor.open`)
   * running this node's own shell; an `ssh:` target gets a `Client.shell()`
   * channel on that target's already-pooled transport
   * (`./ssh/ssh2-transport.ts`), adapted into the same `PtyLike` contract
   * (`./ssh/ssh-pty-adapter.ts`) and adopted via
   * `TerminalSupervisor.openWithPty` — from here on both look identical to
   * every caller. Both start in `routing.session.worktreePath` — the
   * session's project root/worktree — so a second terminal opened for the
   * same session shares that same directory automatically (issue #173).
   *
   * Both are also wrapped in a `PolicyEnforcedPty` (SPEC §7.17; issue
   * #256) bound to `routing.session.projectPath`'s saved permission policy
   * before being adopted — every terminal this node opens, local or
   * `ssh:`, is gated identically. See `policy-enforced-pty.ts`'s own doc
   * comment for exactly how a denied line is stopped and what is (and is
   * not) covered.
   *
   * Takes a {@link SessionRouting}, not a `SessionBridge` (issue #702):
   * only `session.worktreePath`/`session.projectPath`/`session.id` and
   * `targetId` are ever read, all of which
   * {@link NodeDaemon.resolveSessionRouting} can supply for a session with
   * no live bridge — spawning a terminal never touches the agent.
   *
   * Returns the real `cwd`/`shell` this PTY actually started with
   * (issue #669: `terminalOpenOkV1`'s own fields) — `cwd` is always
   * `routing.session.worktreePath` itself (known regardless of target
   * kind); `shell` only for `local`, where the spawned binary is known
   * ahead of time — an `ssh:` login shell is never named until it starts
   * (see the `cd`-first-line comment below), so it stays `undefined`
   * rather than a guess.
   */
  private async openTerminalForBridge(
    routing: SessionRouting,
    terminalId: string,
    payload: TerminalOpenPayloadV1,
  ): Promise<{ cwd: string; shell?: string }> {
    const target = this.targets.find((candidate) => candidate.id === routing.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${routing.targetId}"`);
    }

    const gate = (pty: PtyLike): PtyLike =>
      new PolicyEnforcedPty({
        inner: pty,
        projectPath: routing.session.projectPath,
        policy: () => this.permissionPolicyStore.get(routing.session.projectPath),
        onViolation: (violation) => {
          this.sendPermissionPolicyViolation(routing.session.id, violation).catch(
            (error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              console.warn(
                `NodeDaemon: failed to send permission_policy_violation for session ${routing.session.id}: ${detail}`,
              );
            },
          );
        },
      });

    let session: TerminalSession;
    let shell: string | undefined;
    if (target.kind === 'local') {
      shell = process.env.SHELL ?? '/bin/bash';
      const pty = defaultPtySpawn({
        terminalId,
        file: shell,
        cwd: routing.session.worktreePath,
        cols: payload.cols,
        rows: payload.rows,
      });
      session = this.terminalSupervisor.openWithPty(terminalId, gate(pty));
    } else {
      const transport = await this.getSshTransport(routing.targetId);
      if (!supportsShellChannel(transport)) {
        throw new Error(
          `NodeDaemon: ssh target "${routing.targetId}" transport does not support shell channels`,
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
      // this same limitation). No `shell` value returned below either, for
      // the same reason: the remote login shell's binary is never named on
      // this path.
      channel.write(`cd ${shQuote(routing.session.worktreePath)} && clear\n`);
      session = this.terminalSupervisor.openWithPty(terminalId, gate(shellChannelToPty(channel)));
    }

    this.wireTerminalSession(routing.session.id, session);
    return { cwd: routing.session.worktreePath, shell };
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

  /**
   * A client streamed one chunk of typed input to an open terminal's
   * stdin (SPEC §7.5). Ignored if `sessionId` isn't one of this node's
   * sessions at all ({@link resolveSessionRouting}'s guard). No live
   * bridge is otherwise required — `terminalSupervisor.write` addresses
   * the PTY directly by `terminalId`, unrelated to the agent — but a
   * session reloaded `'disconnected'` after a restart can never actually
   * have an open terminal to write to either (this node's own restart
   * killed every PTY it held), so `write` here is a safe no-op for that
   * case, same as an already-unknown `terminalId`
   * (`TerminalSupervisor.write`'s own no-op contract).
   */
  private handleTerminalInput(message: TerminalInput): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

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

  /** A client asked to renegotiate an open terminal's PTY window size (SPEC §7.5). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — see `handleTerminalInput`'s doc comment for why no live bridge is otherwise needed here either. */
  private handleTerminalResize(message: TerminalResize): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

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
   * `sessionId` isn't one of this node's sessions at all
   * ({@link resolveSessionRouting}'s guard); a silent no-op if `terminalId`
   * is already closed or unknown (`TerminalSupervisor.close`'s own no-op
   * contract) — which is exactly what this always is for a session with no
   * live bridge, per `handleTerminalInput`'s doc comment.
   */
  private handleTerminalClose(message: TerminalClose): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.clientInitiatedTerminalCloses.add(message.terminalId);
    this.terminalSupervisor.close(message.terminalId);
  }

  /** A client asked for a session's project's saved permission policy (SPEC §7.17; issue #751). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — needs only `projectPath`, never the live agent, mirrors `handleTestRunnerConfigGet`. */
  private handlePermissionPolicyGet(message: PermissionPolicyGet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    const policy = this.permissionPolicyStore.get(routing.session.projectPath);
    this.sendPermissionPolicyResult(message.sessionId, message.requestId, {
      policy: toPermissionPolicyV1(policy),
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send permission_policy_result for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * A client asked to save (fully replace) a session's project's
   * permission policy (SPEC §7.17; issue #751) — a whole-policy replace,
   * never a partial patch, mirroring `PermissionPolicyStore.save()`'s own
   * contract (unlike `handleTestRunnerConfigSet`'s per-key merge). Takes
   * effect on the very next command/terminal-line check with no restart
   * (issue #751's own acceptance line): `getExecutionTarget` and
   * `openTerminalForBridge` both call `this.permissionPolicyStore.get()`
   * fresh, never caching a policy across calls. Ignored if `sessionId`
   * isn't one of this node's sessions at all. Replies with the same
   * `permission_policy_result` `handlePermissionPolicyGet` does, carrying
   * the saved result, so "save" and "read the current value" are one
   * client-side code path.
   */
  private handlePermissionPolicySet(message: PermissionPolicySet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptPermissionPolicySet(message)
      .then((payload) => {
        this.permissionPolicyStore.save(routing.session.projectPath, payload.policy);
        const policy = this.permissionPolicyStore.get(routing.session.projectPath);
        return this.sendPermissionPolicyResult(message.sessionId, message.requestId, {
          policy: toPermissionPolicyV1(policy),
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle permission_policy_set for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptPermissionPolicySet(
    message: PermissionPolicySet,
  ): Promise<PermissionPolicySetPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<PermissionPolicySetPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendPermissionPolicyResult(
    sessionId: string,
    requestId: string,
    payload: PermissionPolicyResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'permission_policy_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** A client asked for a session's current project and session spend caps (SPEC §7.16; issue #251). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — needs only the session record and `projectPath`, never the live agent, mirrors `handlePermissionPolicyGet`. */
  private handleSpendCapGet(message: SpendCapGet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.sendSpendCapResult(message.sessionId, message.requestId, {
      projectCapUsd: this.spendCapStore.get(routing.session.projectPath) ?? null,
      sessionCapUsd: routing.session.spendCapUsd ?? null,
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send spend_cap_result for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * A client asked to save (or, with `capUsd: null`, clear) one scope's
   * spend cap (SPEC §7.16; issue #251) — `scope: 'project'` writes
   * `spendCapStore`, keyed by `routing.session.projectPath` exactly like
   * `handlePermissionPolicySet`; `scope: 'session'` writes this session's
   * own `SessionManager.setSpendCapUsd`. Takes effect on this session's
   * very next `usage_update`/attention transition, same "no restart"
   * contract `handlePermissionPolicySet` already documents. Ignored if
   * `sessionId` isn't one of this node's sessions at all. Replies with the
   * same `spend_cap_result` `handleSpendCapGet` does, so "save" and "read
   * the current value" are one client-side code path — and, per issue
   * #251's "raising the cap is one of the ways to resume" design decision,
   * a live bridge whose new effective cap now covers its current spend is
   * auto-resumed as a side effect ({@link maybeAutoResumeAfterCapChange}).
   */
  private handleSpendCapSet(message: SpendCapSet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptSpendCapSet(message)
      .then((payload) => {
        if (payload.scope === 'project') {
          this.spendCapStore.save(routing.session.projectPath, payload.capUsd ?? undefined);
        } else {
          this.sessionManager.setSpendCapUsd(routing.session.id, payload.capUsd ?? undefined);
        }
        const bridge = this.bridges.get(routing.session.id);
        if (bridge) this.maybeAutoResumeAfterCapChange(bridge);
        return this.sendSpendCapResult(message.sessionId, message.requestId, {
          projectCapUsd: this.spendCapStore.get(routing.session.projectPath) ?? null,
          sessionCapUsd: routing.session.spendCapUsd ?? null,
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle spend_cap_set for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked to take a checkpoint of a session's worktree right now
   * (issue #268's "named or auto-labeled checkpoint on demand", issue
   * #603's own wiring). Ignored if `sessionId` isn't one of this node's
   * sessions at all ({@link resolveSessionRouting}'s guard). A decrypt
   * failure is logged only (mirrors `handlePermissionPolicySet`'s own
   * "nothing to reply to a garbled request with"); once decrypted,
   * {@link performCheckpointCreate} always replies, `outcome: 'error'`
   * included.
   */
  private handleCheckpointCreate(message: CheckpointCreate): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptCheckpointCreate(message)
      .then((payload) => this.performCheckpointCreate(routing.session, message.requestId, payload))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle checkpoint_create for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptSpendCapSet(message: SpendCapSet): Promise<SpendCapSetPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<SpendCapSetPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendSpendCapResult(
    sessionId: string,
    requestId: string,
    payload: SpendCapResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'spend_cap_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked for a project's spend-over-time history (SPEC §7.9;
   * issue #249). Node-addressed by `nodeId` + `projectPath`, needing
   * neither a live `SessionBridge` nor even a session that ever ran for
   * this exact `sessionId` — mirrors `handleTrackerSnapshotRequest`'s own
   * "reachable with no session running at all" reasoning (issue #697),
   * for the identical reason: a project's spend history outlives every
   * session that ever added to it. Always answered, `rows: []` included
   * — a project with nothing recorded in the requested range is a real,
   * representable answer, never a dropped request (issue #691's class of
   * bug).
   */
  private handleSpendReportRequest(message: SpendReportRequest): void {
    const rows = filterSpendLedgerRows(this.spendLedgerStore.all(), {
      projectPath: message.projectPath,
      sinceDate: message.sinceDate,
      untilDate: message.untilDate,
    });
    this.sendSpendReportResponse(message.nodeId, message.projectPath, message.requestId, {
      rows: rows.map(({ date, provider, costUsd }) => ({ date, provider, costUsd })),
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send spend_report_response for project ${message.projectPath}: ${detail}`,
      );
    });
  }

  private async sendSpendReportResponse(
    nodeId: string,
    projectPath: string,
    requestId: string,
    payload: SpendReportResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getProjectKey(projectPath);
    const envelope = await sealJson(projectPath, payload, key);
    this.relay.send({
      type: 'spend_report_response',
      protocolVersion: PROTOCOL_V1,
      nodeId,
      projectPath,
      requestId,
      envelope,
    });
  }

  private async decryptCheckpointCreate(
    message: CheckpointCreate,
  ): Promise<CheckpointCreatePayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<CheckpointCreatePayloadV1>(message.sessionId, message.envelope, key);
  }

  private async performCheckpointCreate(
    session: Session,
    requestId: string,
    payload: CheckpointCreatePayloadV1,
  ): Promise<void> {
    const store = this.getCheckpointStore(session);
    if (!store) {
      await this.sendCheckpointResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'unsupported_target',
        message: CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      });
      return;
    }
    try {
      const checkpoint = await store.checkpoint({ message: payload.message });
      await this.sendCheckpointResult(session.id, requestId, {
        outcome: 'ok',
        checkpoint: toGitCheckpointV1(checkpoint, session),
      });
    } catch (error) {
      await this.sendCheckpointResult(session.id, requestId, checkpointErrorOutcome(error));
    }
  }

  private async sendCheckpointResult(
    sessionId: string,
    requestId: string,
    payload: CheckpointResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'checkpoint_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** A client asked for every checkpoint taken so far for a session (issue #603). Ignored if `sessionId` isn't one of this node's sessions at all — needs only `worktreePath`, never the live agent, mirrors `handleTestRunnerConfigGet`. No envelope on the request, so no decrypt step. */
  private handleCheckpointList(message: CheckpointList): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.performCheckpointList(routing.session, message.requestId).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to handle checkpoint_list for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  private async performCheckpointList(session: Session, requestId: string): Promise<void> {
    const store = this.getCheckpointStore(session);
    if (!store) {
      await this.sendCheckpointListResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'unsupported_target',
        message: CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      });
      return;
    }
    try {
      const checkpoints = await store.listCheckpoints();
      await this.sendCheckpointListResult(session.id, requestId, {
        outcome: 'ok',
        checkpoints: checkpoints.map((checkpoint) => toGitCheckpointV1(checkpoint, session)),
      });
    } catch (error) {
      await this.sendCheckpointListResult(session.id, requestId, checkpointErrorOutcome(error));
    }
  }

  private async sendCheckpointListResult(
    sessionId: string,
    requestId: string,
    payload: CheckpointListResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'checkpoint_list_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** A client asked what restoring to `checkpointId` would do, with no side effects (issue #603's "surface `RestorePreview` to the client before a rollback executes"). Ignored if `sessionId` isn't one of this node's sessions at all. `checkpointId` travels as a plain field (no envelope), mirroring `handleTerminalClose`. */
  private handleCheckpointRestorePreview(message: CheckpointRestorePreview): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.performCheckpointRestorePreview(
      routing.session,
      message.requestId,
      message.checkpointId,
    ).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to handle checkpoint_restore_preview for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  private async performCheckpointRestorePreview(
    session: Session,
    requestId: string,
    checkpointId: string,
  ): Promise<void> {
    const store = this.getCheckpointStore(session);
    if (!store) {
      await this.sendCheckpointRestorePreviewResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'unsupported_target',
        message: CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      });
      return;
    }
    try {
      const preview = await store.previewRestore(checkpointId);
      await this.sendCheckpointRestorePreviewResult(session.id, requestId, {
        outcome: 'ok',
        preview: toRestorePreviewV1(preview, session),
      });
    } catch (error) {
      await this.sendCheckpointRestorePreviewResult(
        session.id,
        requestId,
        checkpointErrorOutcome(error),
      );
    }
  }

  private async sendCheckpointRestorePreviewResult(
    sessionId: string,
    requestId: string,
    payload: CheckpointRestorePreviewResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'checkpoint_restore_preview_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client explicitly confirms continuing a session that auto-paused on
   * a spend cap, without changing the cap itself (SPEC §7.16; issue #251's
   * OTHER deliberate way to resume, alongside a `spend_cap_set` that
   * raises the cap back above current spend — see {@link
   * maybeAutoResumeAfterCapChange}). A silent no-op, mirroring `run_cancel`'s
   * own "already exited or unknown" contract, when there is no live bridge
   * to resume (session unknown to this node, or reloaded `'disconnected'`
   * after a restart) or the session isn't actually `'paused'`
   * (`InvalidSessionTransitionError`, e.g. a double-click, or the cap was
   * already raised out from under it by a concurrent `spend_cap_set`).
   */
  private handleSessionSpendCapResume(message: SessionSpendCapResume): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) return;
    try {
      this.sessionManager.resumeSession(bridge.session.id);
    } catch (error) {
      if (error instanceof InvalidSessionTransitionError) return;
      throw error;
    }
    // The cap re-arms only once spend grows past what the user just
    // explicitly resumed through (issue #251's "resuming ... must be a
    // deliberate act") — never immediately, on the very next `usage_update`
    // for a session whose cumulative cost never actually dropped.
    bridge.spendCapAcknowledgedThroughUsd = bridge.spendCumulativeCostUsd;
    this.pushResumedStatus(bridge);
  }

  /**
   * A client asked to actually roll back to `checkpointId` (issue #603) —
   * destructive. Ignored if `sessionId` isn't one of this node's sessions
   * at all. `checkpointId`/`confirm` travel as plain fields (no envelope),
   * mirroring `checkpoint_restore_preview`. See
   * {@link performCheckpointRestore} for the confirmation gate and the
   * turn-in-progress refusal.
   */
  private handleCheckpointRestore(message: CheckpointRestore): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.performCheckpointRestore(
      routing.session,
      message.requestId,
      message.checkpointId,
      message.confirm,
    ).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to handle checkpoint_restore for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * Refuses outright for an `ssh:` session or while this session's agent
   * is actively mid-turn (`bridge.agentSession.getAttentionState().status
   * === 'working'` — a restore racing a live write, issue #603's "the
   * destructive path needs to be honest"). Otherwise previews first: if
   * there is anything uncommitted to discard and the caller didn't
   * already set `confirm: true`, replies `outcome: 'confirmation_required'`
   * with that same preview and stops — the actual `restore()` never runs
   * without an explicit, informed `confirm` (this is the structural half
   * of "a rollback that would discard uncommitted human edits must say so
   * before it runs"; `preview.isWorkInPlace` is the client's own signal
   * for whether those uncommitted changes might be the human's, not just
   * the agent's — see `@loombox/protocol`'s `checkpoint.ts` doc comment).
   */
  private async performCheckpointRestore(
    session: Session,
    requestId: string,
    checkpointId: string,
    confirm: boolean,
  ): Promise<void> {
    const store = this.getCheckpointStore(session);
    if (!store) {
      await this.sendCheckpointRestoreResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'unsupported_target',
        message: CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      });
      return;
    }

    const bridge = this.bridges.get(session.id);
    if (bridge && bridge.agentSession.getAttentionState().status === 'working') {
      await this.sendCheckpointRestoreResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'turn_in_progress',
        message: CHECKPOINT_TURN_IN_PROGRESS_MESSAGE,
      });
      return;
    }

    try {
      const preview = await store.previewRestore(checkpointId);
      if (preview.hasUncommittedChangesToDiscard && !confirm) {
        await this.sendCheckpointRestoreResult(session.id, requestId, {
          outcome: 'confirmation_required',
          preview: toRestorePreviewV1(preview, session),
        });
        return;
      }
      const result = await store.restore(checkpointId);
      await this.sendCheckpointRestoreResult(session.id, requestId, { outcome: 'ok', result });
    } catch (error) {
      await this.sendCheckpointRestoreResult(session.id, requestId, checkpointErrorOutcome(error));
    }
  }

  private async sendCheckpointRestoreResult(
    sessionId: string,
    requestId: string,
    payload: CheckpointRestoreResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'checkpoint_restore_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** `session_rewind`'s own refusal while `resolveSessionRewind` (below) needs a live `AgentSession` to read the transcript from, but this session was reloaded `'disconnected'` after a node restart (issue #702's real state) — see `@loombox/protocol`'s `rewind.ts` module doc comment for why this is a real, contained refusal rather than issue #706's "revive a disconnected session" scope. */
  private static readonly SESSION_REWIND_NO_LIVE_AGENT_MESSAGE =
    "This session has no live agent (disconnected since the last restart) — its transcript can't be read to rewind. Reconnect or start a new session.";

  /**
   * Resolves what rewinding `session` to `turn` would do, with no side
   * effects — the shared computation behind `session_rewind_preview` and
   * `session_rewind`'s own confirmation gate, exactly mirroring how
   * `performCheckpointRestore` reuses `previewRestore` rather than a
   * second confirmation mechanism (issue #747's own instruction). Checked
   * in order: `unsupported_target` (an `ssh:` session — no worktree store
   * at all, {@link getCheckpointStore}'s own doc comment), then
   * `no_live_agent` (no bridge to read the transcript from), then
   * `turn_not_found` (`turn` doesn't map to a checkpoint this session
   * ever took, via {@link resolveRewindCheckpoint}, OR the transcript
   * itself never produced that many distinct turns — a defensive check:
   * the two should always agree, since `autoCheckpointBeforeTurn` and
   * the ACP-level turn id both advance once per real prompt, but this
   * refuses honestly instead of truncating to a turn count that doesn't
   * actually exist in the transcript). `targetTurnId` is `undefined` only
   * for `turn: 0` (rewind to before any turn ran — nothing to cut TO,
   * the whole transcript is discarded).
   */
  private async resolveSessionRewind(
    session: Session,
    turn: number,
  ): Promise<
    | { outcome: 'ok'; preview: RewindPreviewV1; targetTurnId: string | undefined }
    | { outcome: 'error'; errorType: RewindErrorTypeV1; message: string }
  > {
    const store = this.getCheckpointStore(session);
    if (!store) {
      return {
        outcome: 'error',
        errorType: 'unsupported_target',
        message: CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      };
    }
    const bridge = this.bridges.get(session.id);
    if (!bridge) {
      return {
        outcome: 'error',
        errorType: 'no_live_agent',
        message: NodeDaemon.SESSION_REWIND_NO_LIVE_AGENT_MESSAGE,
      };
    }

    try {
      const checkpoints = await store.listCheckpoints();
      const targetCheckpoint = resolveRewindCheckpoint(checkpoints, turn);
      const updates = bridge.agentSession.getTranscriptUpdates();
      const targetTurnId = turn > 0 ? turnIdForTurnNumber(updates, turn) : undefined;
      const turnsAtRisk = orderedTurnIds(updates).length - turn;

      if (!targetCheckpoint || (turn > 0 && !targetTurnId) || turnsAtRisk <= 0) {
        return {
          outcome: 'error',
          errorType: 'turn_not_found',
          message: `session ${session.id} has no turn ${turn} to rewind to — it hasn't happened yet, or it's already the session's current turn with nothing recorded after it`,
        };
      }

      const [restorePreview, filesAtRisk] = await Promise.all([
        store.previewRestore(targetCheckpoint.id),
        store.filesAffectedByRestore(targetCheckpoint.id),
      ]);

      return {
        outcome: 'ok',
        preview: {
          turn,
          checkpointId: targetCheckpoint.id,
          isWorkInPlace: session.branch === '',
          turnsAtRisk,
          filesAtRisk,
          commitsSinceCheckpoint: restorePreview.commitsSinceCheckpoint,
        },
        targetTurnId,
      };
    } catch (error) {
      return checkpointErrorOutcome(error);
    }
  }

  /** A client asked what rewinding this session to `turn` would do, with no side effects (issue #747). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard). No envelope on the request (a plain integer, not content), mirroring `checkpoint_restore_preview`. */
  private handleSessionRewindPreview(message: SessionRewindPreview): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.resolveSessionRewind(routing.session, message.turn)
      .then((resolved) =>
        this.sendSessionRewindPreviewResult(
          message.sessionId,
          message.requestId,
          resolved.outcome === 'ok' ? { outcome: 'ok', preview: resolved.preview } : resolved,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle session_rewind_preview for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async sendSessionRewindPreviewResult(
    sessionId: string,
    requestId: string,
    payload: SessionRewindPreviewResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'session_rewind_preview_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked to actually rewind this session to `turn` (issue #747)
   * — destructive. Ignored if `sessionId` isn't one of this node's
   * sessions at all. `turn`/`confirm` travel as plain fields (no
   * envelope), mirroring `checkpoint_restore`. See
   * {@link performSessionRewind} for the confirmation gate, the
   * turn-in-progress refusal, and the worktree-restore-plus-transcript-
   * truncation that runs as one operation once confirmed.
   */
  private handleSessionRewind(message: SessionRewind): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.performSessionRewind(
      routing.session,
      message.requestId,
      message.turn,
      message.confirm,
    ).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to handle session_rewind for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * Refuses outright for an `ssh:` session, a session with no live agent,
   * or an unresolvable `turn` (all three via {@link resolveSessionRewind}),
   * or while this session's agent is actively mid-turn
   * (`bridge.agentSession.getAttentionState().status === 'working'` —
   * mirrors `performCheckpointRestore`'s own race guard, checked first,
   * before the possibly-slow preview computation). Otherwise previews via
   * {@link resolveSessionRewind}: every valid rewind target discards at
   * least one turn (`turnsAtRisk >= 1`), so unlike
   * `performCheckpointRestore`'s conditional gate, an unconfirmed
   * `session_rewind` ALWAYS replies `outcome: 'confirmation_required'`
   * with that same preview — this issue's own "Destructive, and confirmed
   * before it runs" as an unconditional rule. Once confirmed, restores the
   * worktree AND truncates the transcript to the target turn in the same
   * call — this issue's own "so the thread and the worktree cannot
   * disagree" — reusing the preview's own `filesAtRisk` as the result's
   * `filesChanged` rather than recomputing it (the worktree now matches
   * the checkpoint, so a fresh diff would show nothing).
   */
  private async performSessionRewind(
    session: Session,
    requestId: string,
    turn: number,
    confirm: boolean,
  ): Promise<void> {
    const bridge = this.bridges.get(session.id);
    if (bridge && bridge.agentSession.getAttentionState().status === 'working') {
      await this.sendSessionRewindResult(session.id, requestId, {
        outcome: 'error',
        errorType: 'turn_in_progress',
        message: CHECKPOINT_TURN_IN_PROGRESS_MESSAGE,
      });
      return;
    }

    const resolved = await this.resolveSessionRewind(session, turn);
    if (resolved.outcome === 'error') {
      await this.sendSessionRewindResult(session.id, requestId, resolved);
      return;
    }
    if (!confirm) {
      await this.sendSessionRewindResult(session.id, requestId, {
        outcome: 'confirmation_required',
        preview: resolved.preview,
      });
      return;
    }

    // Re-checked rather than trusted from the top of this method: the
    // async preview computation above (real `git` subprocess calls) is
    // exactly the same window `performCheckpointRestore` already accepts
    // this same race for — the store/bridge existing a moment ago is
    // best-effort, not a lock.
    const store = this.getCheckpointStore(session);
    const liveBridge = this.bridges.get(session.id);
    if (!store || !liveBridge) {
      await this.sendSessionRewindResult(session.id, requestId, {
        outcome: 'error',
        errorType: store ? 'no_live_agent' : 'unsupported_target',
        message: store
          ? NodeDaemon.SESSION_REWIND_NO_LIVE_AGENT_MESSAGE
          : CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE,
      });
      return;
    }

    try {
      const restoreResult = await store.restore(resolved.preview.checkpointId);
      const keepCount = resolved.targetTurnId
        ? (cutTranscriptAtTurn(
            liveBridge.agentSession.getTranscriptUpdates(),
            resolved.targetTurnId,
          ) ?? [])!.length
        : 0;
      liveBridge.agentSession.truncateTranscriptUpdates(keepCount);

      await this.sendSessionRewindResult(session.id, requestId, {
        outcome: 'ok',
        result: {
          turn,
          checkpointId: resolved.preview.checkpointId,
          turnsDiscarded: resolved.preview.turnsAtRisk,
          filesChanged: resolved.preview.filesAtRisk,
          discardedUncommittedChanges: restoreResult.discardedUncommittedChanges,
          commitsPreserved: restoreResult.commitsPreserved,
        },
      });
    } catch (error) {
      await this.sendSessionRewindResult(session.id, requestId, checkpointErrorOutcome(error));
    }
  }

  private async sendSessionRewindResult(
    sessionId: string,
    requestId: string,
    payload: SessionRewindResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'session_rewind_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** A client asked for its account's saved agent-profile catalog (design spec `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — needs no live agent, mirrors `handlePermissionPolicyGet`. */
  private handleAgentProfileListGet(message: AgentProfileListGet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.sendAgentProfileListResult(message.sessionId, message.requestId, {
      profiles: this.agentProfileStore.list().map(toAgentProfileV1),
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send agent_profile_list_result for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /** A client asked to save (fully replace) its account's agent-profile catalog (issue #752) — mirrors `handlePermissionPolicySet`'s "whole value, never a partial patch" contract. Replies with the same `agent_profile_list_result` `handleAgentProfileListGet` does. */
  private handleAgentProfileListSet(message: AgentProfileListSet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptAgentProfileListSet(message)
      .then((payload) => {
        this.agentProfileStore.saveAll(payload.profiles.map(fromAgentProfileV1));
        return this.sendAgentProfileListResult(message.sessionId, message.requestId, {
          profiles: this.agentProfileStore.list().map(toAgentProfileV1),
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle agent_profile_list_set for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptAgentProfileListSet(
    message: AgentProfileListSet,
  ): Promise<AgentProfileListSetPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<AgentProfileListSetPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendAgentProfileListResult(
    sessionId: string,
    requestId: string,
    payload: AgentProfileListResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'agent_profile_list_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** A client asked which profile is currently active for a session (issue #752). Ignored if `sessionId` isn't one of this node's sessions. Reads {@link sessionProfiles} — in-memory only, so a session reloaded `'disconnected'` after a restart reports unrestricted until it's live again and re-selected. */
  private handleAgentProfileSessionGet(message: AgentProfileSessionGet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.sendAgentProfileSessionResult(message.sessionId, message.requestId, {
      profileId: this.sessionProfiles.get(message.sessionId) ?? null,
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send agent_profile_session_result for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * A client asked to switch a session's active profile (issue #752).
   * Mirrors `handleConfigOption`'s shape: requires a LIVE bridge (not
   * just `resolveSessionRouting`), since this mutates
   * {@link sessionProfiles}, the very map {@link evaluateProfileForSession}
   * reads fresh on every `session/request_permission` — a session with no
   * live agent has no future tool call to apply this to yet. Answered
   * with `outcome: 'error'` in that case rather than silently accepted
   * (mirrors `handleConfigOption`'s "disconnected since the last restart"
   * case). Takes effect starting with the very next tool call, never
   * retroactively — see `evaluateProfileForSession`'s own doc comment.
   */
  private handleAgentProfileSessionSet(message: AgentProfileSessionSet): void {
    const bridge = this.bridges.get(message.sessionId);
    if (!bridge) {
      if (this.sessionManager.getSession(message.sessionId)) {
        this.sendAgentProfileSessionError(
          message.sessionId,
          message.requestId,
          'This session has no live agent (disconnected since the last restart) — start a new session to change its profile.',
        );
      }
      // else: not one of this node's sessions at all; ignore per SPEC.md §12
      return;
    }

    this.decryptAgentProfileSessionPayload(message)
      .then((payload) => {
        this.sessionProfiles.set(message.sessionId, payload.profileId ?? undefined);
        return this.sendAgentProfileSessionResult(message.sessionId, message.requestId, {
          profileId: payload.profileId,
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle agent_profile_session_set for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptAgentProfileSessionPayload(
    message: AgentProfileSessionSet,
  ): Promise<AgentProfileSessionPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<AgentProfileSessionPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendAgentProfileSessionResult(
    sessionId: string,
    requestId: string,
    payload: AgentProfileSessionPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'agent_profile_session_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private sendAgentProfileSessionError(
    sessionId: string,
    requestId: string,
    message: string,
  ): void {
    const payload: AgentProfileSessionErrorPayloadV1 = { outcome: 'error', message };
    this.getSessionKey(sessionId)
      .then((key) => sealJson(sessionId, payload, key))
      .then((envelope) => {
        this.relay.send({
          type: 'agent_profile_session_result',
          protocolVersion: PROTOCOL_V1,
          sessionId,
          requestId,
          envelope,
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send agent_profile_session_result error for session ${sessionId}: ${detail}`,
        );
      });
  }

  /**
   * Reports one live policy denial to every client subscribed to
   * `sessionId` (SPEC §7.17; issue #751, D3-4's own "the UI must say
   * which of the three layers refused it") — the `onViolation` hook
   * `openTerminalForBridge`/`executeRun` already pass to
   * `PolicyEnforcedPty`/build from `evaluateCommandLine` funnels through
   * here, in addition to (never instead of) the existing
   * `logPolicyViolation` console line and, for the terminal surface, the
   * ANSI banner written straight into `terminal_output`. Best-effort: a
   * failure to seal/send is logged, never thrown back into the caller
   * that already denied the command — the command staying blocked is the
   * part that must never fail silently, not this notification.
   */
  private async sendPermissionPolicyViolation(
    sessionId: string,
    violation: PolicyViolation,
  ): Promise<void> {
    const payload: PermissionPolicyViolationPayloadV1 = {
      reason: {
        kind: 'permission_policy',
        dimension: violation.dimension,
        rule: violation.rule,
        matched: violation.matched,
      },
      surface: violation.surface,
      command: violation.command,
      timestamp: violation.timestamp,
    };
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'permission_policy_violation',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      envelope,
    });
  }

  /**
   * Reports one live profile refusal to every client subscribed to
   * `sessionId` (design spec `2026-08-05-zed-parity-decisions.md`'s D3-4;
   * issue #752) — the profile-gate sibling of
   * {@link sendPermissionPolicyViolation} just above, reusing the exact
   * same `permission_policy_violation` wire message and
   * `ToolRefusalReasonV1` union rather than a second notification
   * mechanism (`@loombox/protocol`'s `permission-policy.ts` doc comment).
   * `command` carries the refused tool call's own `title`, or its `id`
   * when the agent gave no title. Called from {@link wireAgentSession}'s
   * `'tool_profile_refusal'` listener, itself fed by
   * `AgentSession`'s own `evaluateToolProfile` gate
   * ({@link evaluateProfileForSession}) — best-effort, same as
   * `sendPermissionPolicyViolation`: a failure to seal/send is logged,
   * never thrown back (the tool call staying refused already happened,
   * synchronously, before this notification is even attempted).
   */
  private async sendToolProfileRefusal(
    sessionId: string,
    payload: { toolCall: AcpToolCallUpdate; denial: ToolProfileDenial },
  ): Promise<void> {
    const violationPayload: PermissionPolicyViolationPayloadV1 = {
      reason: {
        kind: 'profile',
        profileId: payload.denial.profileId,
        profileName: payload.denial.profileName,
        matchedBy: payload.denial.matchedBy,
        rule: payload.denial.rule,
      },
      surface: 'tool_call',
      command: payload.toolCall.title ?? payload.toolCall.id,
      timestamp: new Date().toISOString(),
    };
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, violationPayload, key);
    this.relay.send({
      type: 'permission_policy_violation',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      envelope,
    });
  }

  /** A client asked for a session's project's saved test/lint/build commands (SPEC §7.15; issue #245). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — needs only `projectPath` (issue #702), never the live agent, so this keeps working for a `'disconnected'` session exactly like a live one. */
  private handleTestRunnerConfigGet(message: TestRunnerConfigGet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    const commands = this.testRunnerConfigStore.get(routing.session.projectPath);
    this.sendTestRunnerConfigResult(message.sessionId, message.requestId, { commands }).catch(
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send test_runner_config_result for session ${message.sessionId}: ${detail}`,
        );
      },
    );
  }

  /** A client asked to save (merge over) a session's project's test/lint/build commands (SPEC §7.15; issue #245). Ignored if `sessionId` isn't one of this node's sessions at all ({@link resolveSessionRouting}'s guard) — see `handleTestRunnerConfigGet`'s doc comment for why no live bridge is otherwise needed here either. Replies with the same `test_runner_config_result` `handleTestRunnerConfigGet` does, carrying the merged result, so "save" and "read the current value" are one client-side code path. */
  private handleTestRunnerConfigSet(message: TestRunnerConfigSet): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptTestRunnerConfigSet(message)
      .then((payload) => {
        const commands = this.testRunnerConfigStore.save(
          routing.session.projectPath,
          payload.commands,
        );
        return this.sendTestRunnerConfigResult(message.sessionId, message.requestId, { commands });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle test_runner_config_set for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptTestRunnerConfigSet(
    message: TestRunnerConfigSet,
  ): Promise<TestRunnerConfigSetPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<TestRunnerConfigSetPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendTestRunnerConfigResult(
    sessionId: string,
    requestId: string,
    payload: TestRunnerConfigResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'test_runner_config_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client asked this node to inspect a session's project (on whichever
   * target — `local` or `ssh:` — that session runs on) and propose
   * test/lint/build commands (SPEC §7.15; issue #245). Never persists
   * anything itself — `detectTestRunnerCommands` only reads
   * `package.json`/lockfiles via the resolved `ExecutionTarget`, and the
   * reply is a suggestion the client must submit back via
   * `test_runner_config_set` to actually save (issue #245's "shown for
   * confirmation before being saved, not silently applied"). Ignored if
   * `sessionId` isn't one of this node's sessions at all
   * ({@link resolveSessionRouting}'s guard) — needs only `projectPath` +
   * `targetId` (issue #702), never the live agent, so this keeps working
   * for a `'disconnected'` session exactly like a live one.
   */
  private handleTestRunnerConfigDetect(message: TestRunnerConfigDetect): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.getExecutionTarget(routing.targetId, routing.session.projectPath)
      .then((target) => detectTestRunnerCommands(target, routing.session.projectPath))
      .then((suggestions) =>
        this.sendTestRunnerConfigDetected(message.sessionId, message.requestId, { suggestions }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle test_runner_config_detect for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async sendTestRunnerConfigDetected(
    sessionId: string,
    requestId: string,
    payload: TestRunnerConfigDetectedPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'test_runner_config_detected',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /** Maps a `pr-open.ts` rejection to `{ category, reason }` for `pr_open_preview_result`/`pr_open_result`'s own `outcome: 'failure'` shape — `PrOpenError`'s own named `category` passes straight through; anything else (an unexpected throw this module didn't anticipate) becomes `'create_failed'` with the raw message, so a caller here never has to handle a third, uncategorized shape. */
  private prOpenFailureFrom(error: unknown): { category: PrOpenFailureCategory; reason: string } {
    if (error instanceof PrOpenError) return { category: error.category, reason: error.message };
    return {
      category: 'create_failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * A client asked this node what opening a pull request from a session's
   * own branch would do (SPEC §7.14; issue #238) — never pushes, never
   * calls `gh pr create`, only checks `gh` availability/auth on the
   * session's own target, resolves its branch (`resolveSessionBranch`,
   * issue #738) and the repo's default base branch, and counts commits
   * ahead, via `pr-open.ts`'s `previewPrOpen`. No envelope on the
   * request, same reasoning as `test_runner_config_detect`. Ignored if
   * `sessionId` isn't one of this node's sessions at all
   * ({@link resolveSessionRouting}'s guard).
   */
  private handlePrOpenPreviewRequest(message: PrOpenPreviewRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.getExecutionTarget(routing.targetId, routing.session.projectPath)
      .then((target) => previewPrOpen(target, routing.session))
      .then(
        (preview) => ({
          outcome: 'ok' as const,
          branch: preview.branch,
          base: preview.base,
          commitCount: preview.commitCount,
        }),
        (error: unknown) => ({ outcome: 'failure' as const, ...this.prOpenFailureFrom(error) }),
      )
      .then((result) =>
        this.sendPrOpenPreviewResult(message.sessionId, message.requestId, { result }),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send pr_open_preview_result for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async sendPrOpenPreviewResult(
    sessionId: string,
    requestId: string,
    payload: PrOpenPreviewResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'pr_open_preview_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * A client confirmed opening a pull request from a session's own branch
   * (SPEC §7.14; issue #238) — sent only after the client already showed
   * the operator a `pr_open_preview_result` and the operator typed a
   * title/body and explicitly confirmed; this is the one message in the
   * whole feature with a real side effect on the operator's actual
   * repository (`pr-open.ts`'s `openPr`: pushes the branch, then `gh pr
   * create`). `openPr` re-verifies the same preview fresh right before
   * acting rather than trusting this client's now-possibly-stale one.
   * Title/body travel encrypted (user-composed text, never agent-drafted
   * here — that's #233). Ignored if `sessionId` isn't one of this node's
   * sessions at all ({@link resolveSessionRouting}'s guard).
   */
  private handlePrOpenRequest(message: PrOpenRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptPrOpenRequest(message)
      .then((payload) =>
        this.getExecutionTarget(routing.targetId, routing.session.projectPath).then((target) =>
          openPr(target, routing.session, payload).then((opened) =>
            // SPEC §7.14, issue #239: once a PR is genuinely open, start
            // watching its CI checks — best-effort, never lets a watch-
            // registration failure (e.g. an unparseable PR URL) turn an
            // otherwise-successful pr_open_request into a reported
            // failure.
            this.registerCiCheckWatch(routing.session, target, opened)
              .catch((error: unknown) => {
                console.warn(
                  `NodeDaemon: failed to register CI check watch for session ${message.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
                );
              })
              .then(() => opened),
          ),
        ),
      )
      .then(
        (opened) => ({ outcome: 'ok' as const, url: opened.url, number: opened.number }),
        (error: unknown) => ({ outcome: 'failure' as const, ...this.prOpenFailureFrom(error) }),
      )
      .then((result) => this.sendPrOpenResult(message.sessionId, message.requestId, { result }))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle pr_open_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptPrOpenRequest(message: PrOpenRequest): Promise<PrOpenRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<PrOpenRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendPrOpenResult(
    sessionId: string,
    requestId: string,
    payload: PrOpenResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'pr_open_result',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * SPEC §7.14, issue #239: once a session's PR is genuinely open, this
   * starts (or replaces) that session's watched entry — `CiCheckWatcher`
   * polls it from the very next pass, and `CiWatchStore` persists it so a
   * later node restart re-registers it too (see this daemon's own
   * constructor). Best-effort: `parseGithubPullRequestUrl` returning
   * `undefined` (a non-`github.com` PR — out of this watcher's scope, see
   * that function's own doc comment) or `resolveSessionBranch` resolving
   * nothing usable both fall through as a silent no-op rather than an
   * error, matching `handlePrOpenRequest`'s own "never lets a watch-
   * registration failure turn an otherwise-successful pr_open_request
   * into a reported failure" contract.
   */
  private async registerCiCheckWatch(
    session: Session,
    target: ExecutionTarget,
    opened: OpenPrResult,
  ): Promise<void> {
    const parsed = parseGithubPullRequestUrl(opened.url);
    if (!parsed) return;
    const ref = await resolveSessionBranch(target, session);
    if (!ref) return;
    const entry: CiWatchEntry = {
      owner: parsed.owner,
      repo: parsed.repo,
      ref,
      prNumber: opened.number,
      prUrl: opened.url,
      projectPath: session.projectPath,
    };
    this.ciCheckWatchStore.set(session.id, entry);
    this.ciCheckWatcher.watch(session.id, entry);
    this.ciAutoIterateController.reset(session.id);
  }

  /**
   * `CiCheckWatcher`'s only source of a GitHub bearer token (SPEC §7.14,
   * issue #239) — reuses SPEC §7.26's connected-account pin resolution
   * (`./account-pin.ts`'s `resolveAccountForRead`) rather than a new
   * token path, the same composition `resolveTrackerBackend`'s own GitHub
   * branch applies. `github.com` only (this watcher's own scope — see
   * `parseGithubPullRequestUrl`'s doc comment): a GHES account pinned for
   * a project's `github` capability is simply never a candidate here.
   * Never throws: an ambiguous pin ({@link AmbiguousAccountError}) or any
   * other resolution error is caught and treated exactly like "nothing
   * configured" — `undefined` — so a project a person hasn't yet resolved
   * their GitHub ambiguity for degrades this one watched session's state
   * to `'unknown'` rather than crashing a poll pass.
   */
  private async resolveCiCheckGithubToken(projectPath: string): Promise<string | undefined> {
    let account: ConnectedAccount | undefined;
    try {
      account = resolveAccountForRead({
        pins: this.accountPinStore.get(projectPath),
        capability: 'github',
        accounts: this.connectedAccounts,
        target: { provider: 'github', host: 'github.com' },
      });
    } catch {
      return undefined;
    }
    if (!account) return undefined;
    return this.githubConnectService.getAccessToken(account);
  }

  /**
   * Pushes a session's latest `CiCheckWatcher` reading to its subscribed
   * clients (SPEC §7.14, issue #239) — `CiCheckWatcher`'s own `onUpdate`,
   * fired after every completed poll pass, whatever the resulting state.
   * Session-scoped and envelope-sealed exactly like `sendFileEvent`/
   * `sendPrOpenResult`: the relay only ever sees `sessionId` and
   * ciphertext.
   */
  private async sendCiCheckStatus(sessionId: string, state: CiCheckStateV1): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const payload: CiCheckStatusPayloadV1 = { status: state };
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'ci_check_status',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      envelope,
    });
  }

  /**
   * Pushes `sessionId`'s current auto-iterate loop state to its
   * subscribed clients (SPEC §7.14/§7.15; issue #246) — every time
   * `CiAutoIterateController` reports one, whether that's a fresh
   * attempt, a green stop, a max-attempts stop, or a user stop. Session-
   * scoped and envelope-sealed exactly like `sendCiCheckStatus` above.
   */
  private async sendCiAutoIterateStatus(
    sessionId: string,
    state: CiAutoIterateStatusPayloadV1['state'],
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const payload: CiAutoIterateStatusPayloadV1 = { state };
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'ci_auto_iterate_status',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      envelope,
    });
  }

  /**
   * Whether `sessionId` may currently be driven by the auto-iterate loop
   * (SPEC §7.16; issue #251's "a paused session must not be resumed by
   * the loop", and the same for a session over its effective spend cap)
   * — read fresh on every new CI failure, never cached, since either
   * condition can change moment to moment. `true` when this daemon has
   * no record of the session at all (never created here, or already
   * archived): {@link promptSession}'s own "no session with id" guard is
   * the real, authoritative gate for that case, and this best-effort
   * check has nothing more specific to say. Two real reasons this
   * returns `false`:
   * 1. The session's own lifecycle state isn't `'running'` — covers a
   *    session paused for any reason, including `pauseForSpendCap`'s own
   *    auto-pause (SPEC §7.16), since that always lands here first.
   * 2. Defense in depth for the gap between a spend cap being crossed and
   *    `maybeApplySpendCap` actually landing the pause above (e.g. mid-
   *    turn, `maybeApplySpendCap`'s own "let it finish" guard): a live
   *    bridge whose `spendCumulativeCostUsd` already exceeds its
   *    `effectiveSpendCapUsd` is treated as ineligible even while
   *    `session.state` still reads `'running'`.
   */
  private isAutoIterateEligible(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return true;
    if (session.state !== 'running') return false;
    const bridge = this.bridges.get(sessionId);
    const capUsd = this.effectiveSpendCapUsd(session);
    if (
      bridge &&
      capUsd !== undefined &&
      bridge.spendCumulativeCostUsd !== undefined &&
      bridge.spendCumulativeCostUsd > capUsd
    ) {
      return false;
    }
    return true;
  }

  /**
   * `CiCheckWatcher`'s `onFailure` hook (SPEC §7.14, issue #239) — fired
   * exactly once per NEW failing commit (see `ci-check-watcher.ts`'s own
   * "exactly-once-per-failure dedup" doc comment; this method itself does
   * no deduping of its own). This IS issue #246's loop: `isAutoIterateEligible`
   * reads whether this session may currently iterate at all (not paused,
   * not over its spend cap), `CiAutoIterateController.onFailure` weighs
   * that alongside a prior user stop and the attempt cap, and only a real
   * `proceed: true` decision feeds the failure back to the session's own
   * agent via `promptSession` — the "surfaced ... which can auto-iterate
   * a fix" half of SPEC §7.14's PR & CI lifecycle bullet. Every decision,
   * proceeding or not, pushes the resulting `ci_auto_iterate_status` so a
   * client always sees why. A session with no live agent
   * (`promptSession`'s own "no session with id" — archived, or
   * `'disconnected'` since a restart) rejects here and is caught by this
   * method's own caller (the `onFailure` wiring in this daemon's
   * constructor), exactly like every other best-effort hook in this file.
   */
  private async handleCiCheckFailure(sessionId: string, state: CiCheckStateV1): Promise<void> {
    const eligible = this.isAutoIterateEligible(sessionId);
    const decision = this.ciAutoIterateController.onFailure(
      sessionId,
      state.headSha ?? 'unknown',
      eligible,
    );
    await this.sendCiAutoIterateStatus(sessionId, decision.state);
    if (!decision.proceed) return;

    const failing = state.checkRuns.filter((run) => isFailingConclusion(run.conclusion));
    const lines = failing.map((run) => {
      const detail = run.summary ? `: ${run.summary}` : '';
      return `- ${run.name} (${run.conclusion ?? 'unknown'})${detail}`;
    });
    const text = [
      `CI just went red on this session's open pull request (${state.prUrl}):`,
      '',
      ...(lines.length > 0 ? lines : ['- (no failing check run details available)']),
      '',
      'Please look into the failure above and push a fix.',
    ].join('\n');
    await this.promptSession(sessionId, text);
  }

  /**
   * A client asked this node to run a session's project's configured
   * `kind` command and stream its output live (SPEC §7.15; issue #244).
   * Always replies with `run_started` — `outcome: 'ok'` once this project
   * has a saved command for `kind` (tracking begins under the `runId` the
   * request itself named), or `outcome: 'error'` when nothing is
   * configured for it — so the client never hangs waiting for a reply
   * that never comes, per `@loombox/protocol`'s `runStartedResultPayloadV1`
   * doc comment. A permission-policy denial or a real "command not found"
   * both happen only *after* `outcome: 'ok'`, reported later via
   * `run_exit` — see `executeRun`. Ignored if `sessionId` isn't one of
   * this node's sessions at all ({@link resolveSessionRouting}'s guard) —
   * running a saved command needs only `projectPath` + `targetId` (issue
   * #702), never the live agent, so this keeps working for a
   * `'disconnected'` session exactly like a live one.
   */
  private handleRunStart(message: RunStart): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptRunStartPayload(message)
      .then(async (payload) => {
        const commands = this.testRunnerConfigStore.get(routing.session.projectPath);
        const command = commands[payload.kind];
        if (!command) {
          throw new Error(`no ${payload.kind} command configured for this project`);
        }
        await this.sendRunStarted(routing.session.id, message.runId, message.requestId, {
          outcome: 'ok',
        });
        // Fire-and-forget: the run's own lifecycle (streamed output, then
        // exactly one pass/fail/could-not-start) is reported entirely
        // through run_output/run_exit inside executeRun, never through
        // this promise chain — which only ever answers "is there
        // something to run at all".
        this.executeRun(routing, message.runId, command).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(
            `NodeDaemon: run ${message.runId} for session ${message.sessionId} failed unexpectedly: ${detail}`,
          );
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle run_start for session ${message.sessionId} run ${message.runId}: ${detail}`,
        );
        this.sendRunStarted(routing.session.id, message.runId, message.requestId, {
          outcome: 'error',
          message: detail,
        }).catch(() => {
          /* best-effort error reply; nothing further to do if even this fails */
        });
      });
  }

  private async decryptRunStartPayload(message: RunStart): Promise<RunStartPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<RunStartPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Actually runs `command` for `runId` on `routing`'s target and streams
   * the result (SPEC §7.15; issue #244) — called only once `handleRunStart`
   * already knows a command exists; this is where the permission-policy
   * check (`evaluateCommandLine`, the same entry point
   * `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) and the actual
   * spawn (`./test-runner-process.ts`'s `startLocalRun`/`startSshRun`)
   * happen. Registers the run in {@link activeRuns} so
   * `handleRunCancel`/`close()` can reach it, and always removes it again
   * the instant `run_exit` is sent, whatever the outcome. Takes a
   * {@link SessionRouting}, not a `SessionBridge` (issue #702): only
   * `session.id`/`session.projectPath` and `targetId` are ever read, all
   * of which {@link NodeDaemon.resolveSessionRouting} can supply for a
   * session with no live bridge — running a saved command never touches
   * the agent.
   */
  private async executeRun(routing: SessionRouting, runId: string, command: string): Promise<void> {
    if (!isSafeRunId(runId)) {
      await this.sendRunExit(routing.session.id, runId, {
        outcome: 'could_not_start',
        exitCode: null,
        reason: 'invalid run id',
      });
      return;
    }

    const target = this.targets.find((candidate) => candidate.id === routing.targetId);
    if (!target) {
      await this.sendRunExit(routing.session.id, runId, {
        outcome: 'could_not_start',
        exitCode: null,
        reason: `no target with id "${routing.targetId}"`,
      });
      return;
    }

    const policy = this.permissionPolicyStore.get(routing.session.projectPath);
    const decision = evaluateCommandLine(policy, command, {
      resolveRealBasename: target.kind === 'local' ? resolveRealBasename : undefined,
    });
    if (!decision.allowed) {
      const violation: PolicyViolation = {
        projectPath: routing.session.projectPath,
        surface: 'exec',
        dimension: decision.dimension,
        rule: decision.rule,
        matched: decision.matched,
        command,
        timestamp: new Date().toISOString(),
      };
      logPolicyViolation(violation);
      this.sendPermissionPolicyViolation(routing.session.id, violation).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send permission_policy_violation for session ${routing.session.id}: ${detail}`,
        );
      });
      await this.sendRunExit(routing.session.id, runId, {
        outcome: 'could_not_start',
        exitCode: null,
        reason: `policy denied: ${violation.dimension} deny rule "${violation.rule}" matched "${violation.matched}"`,
      });
      return;
    }

    const onOutput = (chunk: Uint8Array): void => {
      this.queueRunOutput(routing.session.id, runId, chunk);
    };
    const onExit = (result: RunExitResult): void => {
      this.activeRuns.delete(runId);
      this.sendRunExit(routing.session.id, runId, result).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to send run_exit for session ${routing.session.id} run ${runId}: ${detail}`,
        );
      });
    };

    if (target.kind === 'local') {
      const handle = startLocalRun({ command, onOutput, onExit });
      this.activeRuns.set(runId, { sessionId: routing.session.id, cancel: handle.cancel });
    } else {
      const transport = await this.getSshTransport(routing.targetId);
      const runner = await this.getRemoteRunner(routing.targetId);
      const handle = await startSshRun({ runner, transport, runId, command, onOutput, onExit });
      this.activeRuns.set(runId, { sessionId: routing.session.id, cancel: handle.cancel });
    }
  }

  private async sendRunStarted(
    sessionId: string,
    runId: string,
    requestId: string,
    payload: RunStartedResultPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'run_started',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      runId,
      requestId,
      envelope,
    });
  }

  /** Chains this run's `run_output` sends (mirrors `queueTerminalOutput`) so concurrent encrypts can never resolve, and so get sent to the relay, out of the order their chunks arrived in. */
  private queueRunOutput(sessionId: string, runId: string, chunk: Uint8Array): void {
    const queueKey = `${sessionId}:${runId}`;
    const previous = this.runSendQueues.get(queueKey) ?? Promise.resolve();
    const next = previous
      .then(() => this.sendRunOutput(sessionId, runId, chunk))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to encrypt/send run_output for session ${sessionId} run ${runId}: ${detail}`,
        );
      });
    this.runSendQueues.set(queueKey, next);
  }

  private async sendRunOutput(sessionId: string, runId: string, chunk: Uint8Array): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const payload: RunOutputPayloadV1 = { data: Buffer.from(chunk).toString('base64') };
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'run_output',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      runId,
      envelope,
    });
  }

  private async sendRunExit(
    sessionId: string,
    runId: string,
    payload: RunExitPayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({ type: 'run_exit', protocolVersion: PROTOCOL_V1, sessionId, runId, envelope });
  }

  /**
   * A client asked to cancel an in-flight run (SPEC §7.15; issue #244) — a
   * silent no-op if `runId` is already exited or unknown, mirroring
   * `handleTerminalClose`'s identical guard. Ignored if `sessionId` isn't
   * one of this node's sessions at all ({@link resolveSessionRouting}'s
   * guard); a session with no live bridge can never have an active run to
   * begin with (`executeRun` requires one, per `handleRunStart`), so this
   * is always the "already unknown" no-op for that case too. The run's own
   * `run_exit` (with `cancelled: true`) is sent from inside `executeRun`'s
   * `onExit`, once the underlying process is confirmed gone — never from
   * here directly.
   */
  private handleRunCancel(message: RunCancel): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    const active = this.activeRuns.get(message.runId);
    if (!active) return;
    active.cancel().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to cancel run ${message.runId} for session ${message.sessionId}: ${detail}`,
      );
    });
  }

  /**
   * A client asked to stop `sessionId`'s auto-iterate loop right now
   * (SPEC §7.14/§7.15; issue #246's own "user-initiated" stop) — a
   * silent no-op when `sessionId` isn't one of this node's sessions at
   * all, mirroring `handleRunCancel`'s identical guard just above.
   * Unlike `handleRunCancel`, there is nothing further to actually
   * cancel here (there is no in-flight process this stop needs to kill —
   * any turn `handleCiCheckFailure` already started keeps running to
   * completion exactly like any other prompt would); this only tells
   * `CiAutoIterateController` to refuse every FUTURE new failure until
   * the next green check or a fresh PR watch.
   */
  private handleCiAutoIterateStop(message: CiAutoIterateStop): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    const state = this.ciAutoIterateController.stopByUser(message.sessionId);
    this.sendCiAutoIterateStatus(message.sessionId, state).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `NodeDaemon: failed to send ci_auto_iterate_status for session ${message.sessionId}: ${detail}`,
      );
    });
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

  /** Same caching shape as {@link getSessionKey}, for {@link targetKeys} (issue #474's directory picker). */
  private getTargetKey(targetId: string): Promise<CryptoKey> {
    let key = this.targetKeys.get(targetId);
    if (!key) {
      key = deriveTargetKey(this.amk, this.accountId, targetId);
      this.targetKeys.set(targetId, key);
    }
    return key;
  }

  /** Same caching shape as {@link getSessionKey}/{@link getTargetKey}, for {@link projectKeys} (issue #697's project-addressed tracker records — `@loombox/crypto`'s `deriveProjectKey`, the account-scoped sibling of `deriveSessionKey`, keyed by `projectPath` rather than `sessionId` so a client can reach a project's tracker with no session running for it at all). */
  private getProjectKey(projectPath: string): Promise<CryptoKey> {
    let key = this.projectKeys.get(projectPath);
    if (!key) {
      key = deriveProjectKey(this.amk, this.accountId, projectPath);
      this.projectKeys.set(projectPath, key);
    }
    return key;
  }

  private async abortMergeForBridge(
    routing: SessionRouting,
  ): Promise<GitBranchMergeAbortResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await abortMerge(target, routing.session.worktreePath);
      return { outcome: 'ok' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * Creates `payload.name` (`./git-diff.ts`'s `createBranch`), then —
   * only when `payload.checkout` — switches onto it exactly like
   * `switchBranchForBridge` below, guarded by the identical
   * worktree-isolated-session check FIRST: a session whose branch is
   * fixed for its whole life (`session-manager.ts`'s own doc comment)
   * never has this create-and-switch path move it either — see
   * `@loombox/protocol`'s `git-branch.ts` file doc comment. Never throws:
   * every expected failure becomes its own outcome instead.
   */
  private async createBranchForBridge(
    routing: SessionRouting,
    payload: GitBranchCreateRequestPayloadV1,
  ): Promise<GitBranchCreateResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await createBranch(target, routing.session.worktreePath, {
        name: payload.name,
        startPoint: payload.startPoint,
      });
      if (!payload.checkout) {
        return { outcome: 'ok', branch: payload.name, checkedOut: false };
      }
      if (routing.session.branch) {
        return {
          outcome: 'session_branch_fixed',
          message: `this session's worktree is fixed to "${routing.session.branch}" for its whole life — start a new session on "${payload.name}" instead of switching this one`,
        };
      }
      await switchBranch(target, routing.session.worktreePath, { name: payload.name });
      return { outcome: 'ok', branch: payload.name, checkedOut: true };
    } catch (error) {
      if (error instanceof GitBranchAlreadyExistsError) {
        return { outcome: 'already_exists', message: error.message };
      }
      if (error instanceof GitDirtyWorktreeError) {
        return { outcome: 'dirty_worktree', message: error.message, paths: error.paths };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async decryptGitBranchCreateRequest(
    message: GitBranchCreateRequest,
  ): Promise<GitBranchCreateRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitBranchCreateRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async decryptGitBranchMergeRequest(
    message: GitBranchMergeRequest,
  ): Promise<GitBranchMergeRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitBranchMergeRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async decryptGitBranchSwitchRequest(
    message: GitBranchSwitchRequest,
  ): Promise<GitBranchSwitchRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitBranchSwitchRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async decryptGitStashDropRequest(
    message: GitStashDropRequest,
  ): Promise<GitStashDropRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitStashDropRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async decryptGitStashPopRequest(
    message: GitStashPopRequest,
  ): Promise<GitStashPopRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitStashPopRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async decryptGitStashSaveRequest(
    message: GitStashSaveRequest,
  ): Promise<GitStashSaveRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitStashSaveRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * A client asked (via the relay) this node to create a branch, and
   * optionally switch onto it (SPEC §7.6; issue #234) — `handleGitHunkActionRequest`'s
   * sibling in shape (an enveloped request; `name` is real session
   * content).
   */
  private handleGitBranchCreateRequest(message: GitBranchCreateRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitBranchCreateRequest(message)
      .then((payload) => this.createBranchForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitBranchCreateResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_branch_create_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node for one session's current
   * local branches (SPEC §7.6; issue #234) — `handleGitDiffRequest`'s
   * sibling, same "no live bridge needed, always a reply, never a silent
   * drop" contract. No envelope on `git_branch_list_request` itself (see
   * `@loombox/protocol`'s `git-branch.ts` doc comment).
   */
  private handleGitBranchListRequest(message: GitBranchListRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.listBranchesForBridge(routing)
      .then((responsePayload) =>
        this.sendGitBranchListResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_branch_list_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to abort a merge stopped on
   * conflicts (SPEC §7.6; issue #234) — the other half of
   * `git_branch_merge_response`'s `'conflict'` outcome's "resolve or
   * abort" (this issue's own acceptance bar). No envelope on
   * `git_branch_merge_abort_request` itself (nothing to carry beyond
   * session/request id).
   */
  private handleGitBranchMergeAbortRequest(message: GitBranchMergeAbortRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.abortMergeForBridge(routing)
      .then((responsePayload) =>
        this.sendGitBranchMergeAbortResponse(
          routing.session.id,
          message.requestId,
          responsePayload,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_branch_merge_abort_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to merge a branch into this
   * session's current branch (SPEC §7.6; issue #234) —
   * `handleGitBranchSwitchRequest`'s sibling in shape. Never moves which
   * branch is checked out, so — unlike switch/create-with-checkout —
   * this carries no worktree-isolated-session guard: merging upstream
   * INTO an isolated session's own branch is the intended use.
   */
  private handleGitBranchMergeRequest(message: GitBranchMergeRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitBranchMergeRequest(message)
      .then((payload) => this.mergeBranchForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitBranchMergeResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_branch_merge_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to switch this session's
   * worktree onto another branch (SPEC §7.6; issue #234) —
   * `handleGitBranchCreateRequest`'s sibling in shape.
   */
  private handleGitBranchSwitchRequest(message: GitBranchSwitchRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitBranchSwitchRequest(message)
      .then((payload) => this.switchBranchForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitBranchSwitchResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_branch_switch_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to drop a stash entry for
   * good (SPEC §7.6; issue #234) — the way out of a resolved (or
   * abandoned) `git_stash_pop_response`'s `'conflict'` outcome, or of an
   * entry no longer wanted. `handleGitStashPopRequest`'s sibling in
   * shape.
   */
  private handleGitStashDropRequest(message: GitStashDropRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitStashDropRequest(message)
      .then((payload) => this.stashDropForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitStashDropResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_stash_drop_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node for one session's current
   * stash stack (SPEC §7.6; issue #234) — `handleGitBranchListRequest`'s
   * sibling in shape (no envelope on the request either).
   */
  private handleGitStashListRequest(message: GitStashListRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.listStashesForBridge(routing)
      .then((responsePayload) =>
        this.sendGitStashListResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_stash_list_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to pop a stash entry (SPEC
   * §7.6; issue #234) — `handleGitStashSaveRequest`'s sibling in shape.
   */
  private handleGitStashPopRequest(message: GitStashPopRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitStashPopRequest(message)
      .then((payload) => this.stashPopForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitStashPopResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_stash_pop_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to save the current
   * worktree onto the stash stack (SPEC §7.6; issue #234) —
   * `handleGitBranchCreateRequest`'s sibling in shape.
   */
  private handleGitStashSaveRequest(message: GitStashSaveRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitStashSaveRequest(message)
      .then((payload) => this.stashSaveForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitStashSaveResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_stash_save_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async listBranchesForBridge(
    routing: SessionRouting,
  ): Promise<GitBranchListResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const branches = await listBranches(target, routing.session.worktreePath);
      return { outcome: 'ok', branches };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async listStashesForBridge(
    routing: SessionRouting,
  ): Promise<GitStashListResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const stashes = await listStashes(target, routing.session.worktreePath);
      return { outcome: 'ok', stashes };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async mergeBranchForBridge(
    routing: SessionRouting,
    payload: GitBranchMergeRequestPayloadV1,
  ): Promise<GitBranchMergeResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const result = await mergeBranch(target, routing.session.worktreePath, {
        name: payload.name,
      });
      return { outcome: 'ok', branch: payload.name, fastForward: result.fastForward };
    } catch (error) {
      if (error instanceof GitMergeConflictError) {
        return {
          outcome: 'conflict',
          message: error.message,
          conflictedPaths: error.conflictedPaths,
        };
      }
      if (error instanceof GitBranchNotFoundError) {
        return { outcome: 'not_found', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitBranchCreateResponse(
    sessionId: string,
    requestId: string,
    payload: GitBranchCreateResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_branch_create_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitBranchListResponse(
    sessionId: string,
    requestId: string,
    payload: GitBranchListResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_branch_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitBranchMergeAbortResponse(
    sessionId: string,
    requestId: string,
    payload: GitBranchMergeAbortResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_branch_merge_abort_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitBranchMergeResponse(
    sessionId: string,
    requestId: string,
    payload: GitBranchMergeResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_branch_merge_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitBranchSwitchResponse(
    sessionId: string,
    requestId: string,
    payload: GitBranchSwitchResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_branch_switch_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitStashDropResponse(
    sessionId: string,
    requestId: string,
    payload: GitStashDropResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_stash_drop_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitStashListResponse(
    sessionId: string,
    requestId: string,
    payload: GitStashListResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_stash_list_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitStashPopResponse(
    sessionId: string,
    requestId: string,
    payload: GitStashPopResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_stash_pop_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendGitStashSaveResponse(
    sessionId: string,
    requestId: string,
    payload: GitStashSaveResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_stash_save_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async stashDropForBridge(
    routing: SessionRouting,
    payload: GitStashDropRequestPayloadV1,
  ): Promise<GitStashDropResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await stashDrop(target, routing.session.worktreePath, { index: payload.index });
      return { outcome: 'ok' };
    } catch (error) {
      if (error instanceof GitStashNotFoundError) {
        return { outcome: 'not_found', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * Runs `stashPop` (`./git-diff.ts`) — issue #234's own named failure
   * mode, "a stash that cannot pop", surfaces here as `'conflict'` with
   * `stashKept: true`: real git conflict-markers the worktree and keeps
   * the stash entry rather than dropping it, so nothing is lost either
   * way (a caller resolves the conflicts and calls `git_stash_drop_request`,
   * or discards the conflict-marked changes and tries again).
   */
  private async stashPopForBridge(
    routing: SessionRouting,
    payload: GitStashPopRequestPayloadV1,
  ): Promise<GitStashPopResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await stashPop(target, routing.session.worktreePath, { index: payload.index });
      return { outcome: 'ok' };
    } catch (error) {
      if (error instanceof GitStashPopConflictError) {
        return {
          outcome: 'conflict',
          message: error.message,
          conflictedPaths: error.conflictedPaths,
          stashKept: true,
        };
      }
      if (error instanceof GitStashNotFoundError) {
        return { outcome: 'not_found', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async stashSaveForBridge(
    routing: SessionRouting,
    payload: GitStashSaveRequestPayloadV1,
  ): Promise<GitStashSaveResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const result = await stashSave(target, routing.session.worktreePath, {
        message: payload.message,
      });
      return { outcome: 'ok', created: result.created };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * Refuses before touching git at all for a worktree-isolated session
   * (`routing.session.branch !== ''`) — that worktree's branch never
   * moves for the session's whole life (`session-manager.ts`'s own doc
   * comment: it's created on `loombox/session-<id>` and stays there).
   * Switching it out from under the session would silently break
   * `resolveSessionBranch`'s cached report (it trusts `session.branch`
   * directly for an isolated session, never re-probing) and
   * `SessionManager.removeSession`'s own `git worktree remove` + `git
   * branch -D session.branch` teardown — exactly the "session's own
   * worktree left in a state the user can't get out of from the UI"
   * failure mode issue #234 calls out by name. A work-in-place or `ssh:`
   * session (`branch === ''`) has no such invariant and switches freely.
   */
  private async switchBranchForBridge(
    routing: SessionRouting,
    payload: GitBranchSwitchRequestPayloadV1,
  ): Promise<GitBranchSwitchResponsePayloadV1> {
    if (routing.session.branch) {
      return {
        outcome: 'session_branch_fixed',
        message: `this session's worktree is fixed to "${routing.session.branch}" for its whole life — start a new session on "${payload.name}" instead of switching this one`,
      };
    }
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      await switchBranch(target, routing.session.worktreePath, { name: payload.name });
      return { outcome: 'ok', branch: payload.name };
    } catch (error) {
      if (error instanceof GitDirtyWorktreeError) {
        return { outcome: 'dirty_worktree', message: error.message, paths: error.paths };
      }
      if (error instanceof GitBranchNotFoundError) {
        return { outcome: 'not_found', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * A client asked (via the relay) this node for one session's project's
   * current `AGENTS.md`/`CLAUDE.md` state (SPEC §7.18; issue #260) —
   * `handleGitDiffRequest`'s sibling, same "no live bridge needed,
   * always a reply, never a silent drop" contract. No envelope on
   * `agent_instructions_get_request` itself (see `@loombox/protocol`'s
   * `agent-instructions.ts` doc comment), so there is nothing to decrypt
   * before reading the files.
   */
  private handleAgentInstructionsGetRequest(message: AgentInstructionsGetRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.readAgentInstructionsForBridge(routing)
      .then((responsePayload) =>
        this.sendAgentInstructionsGetResponse(
          routing.session.id,
          message.requestId,
          responsePayload,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle agent_instructions_get_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * A client asked (via the relay) this node to save one `AGENTS.md`/
   * `CLAUDE.md` file inside one of its sessions' projects (SPEC §7.18;
   * issue #260) — `handleGitHunkActionRequest`'s sibling, same "decrypt,
   * apply, always reply" contract.
   */
  private handleAgentInstructionsSetRequest(message: AgentInstructionsSetRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptAgentInstructionsSetRequest(message)
      .then((payload) => this.writeAgentInstructionsForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendAgentInstructionsSetResponse(
          routing.session.id,
          message.requestId,
          responsePayload,
        ),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle agent_instructions_set_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  /**
   * Runs `readAgentInstructionsFiles` (`./agent-instructions.ts`) against
   * `routing`'s own `ExecutionTarget` — unscoped, exactly like
   * `handleFsReadRequest`'s own `getExecutionTarget(routing.targetId)`,
   * since this is a plain filesystem read/write, never a spawned
   * command. Never throws: an unreachable worktree
   * (`AgentInstructionsError`) or any other error becomes an
   * `outcome: 'error'` payload instead, so `handleAgentInstructionsGetRequest`
   * always has a response to seal and send back.
   */
  private async readAgentInstructionsForBridge(
    routing: SessionRouting,
  ): Promise<AgentInstructionsGetResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId);
      const files = await readAgentInstructionsFiles(target, routing.session.worktreePath);
      return { outcome: 'ok', files };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  /**
   * Runs `writeAgentInstructionsFile` (`./agent-instructions.ts`)
   * against `routing`'s own `ExecutionTarget`, unscoped exactly like
   * {@link readAgentInstructionsForBridge} above. Never throws: an
   * `AgentInstructionsError` (an unreachable worktree, or a genuine
   * write failure) or any other error becomes an `outcome: 'error'`
   * payload instead — a legitimate `'conflict'` outcome (the file
   * changed underneath the edit) comes straight back from
   * `writeAgentInstructionsFile` itself, never thrown.
   */
  private async writeAgentInstructionsForBridge(
    routing: SessionRouting,
    payload: AgentInstructionsSetRequestPayloadV1,
  ): Promise<AgentInstructionsSetResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId);
      return await writeAgentInstructionsFile(target, routing.session.worktreePath, payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', fileName: payload.fileName, message: detail };
    }
  }

  private async decryptAgentInstructionsSetRequest(
    message: AgentInstructionsSetRequest,
  ): Promise<AgentInstructionsSetRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<AgentInstructionsSetRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  private async sendAgentInstructionsGetResponse(
    sessionId: string,
    requestId: string,
    payload: AgentInstructionsGetResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'agent_instructions_get_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  private async sendAgentInstructionsSetResponse(
    sessionId: string,
    requestId: string,
    payload: AgentInstructionsSetResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'agent_instructions_set_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }

  /**
   * Commit graph / branch tree (SPEC §7.6; issue #231) — kept as one
   * contiguous block appended here, deliberately never interleaved
   * among the sibling `git_*` handlers above (tonight's own lesson:
   * near-identical `handleX`/sibling method families interleaved
   * through this class make a three-way merge produce a broken
   * hybrid).
   *
   * A client asked (via the relay) this node for one page of one
   * session's commit graph — enveloped like `handleGitBranchCreateRequest`
   * (this request carries a real caller-chosen filter: `ref`/`limit`/
   * `offset`, unlike `git_diff_request`'s own no-envelope "asking
   * carries no content" shape), same "no live bridge needed, always a
   * reply, never a silent drop" contract as `handleGitDiffRequest`.
   */
  private handleGitGraphRequest(message: GitGraphRequest): void {
    const routing = this.resolveSessionRouting(message.sessionId);
    if (!routing) return; // not one of this node's sessions; ignore per SPEC.md §12

    this.decryptGitGraphRequest(message)
      .then((payload) => this.computeCommitGraphForBridge(routing, payload))
      .then((responsePayload) =>
        this.sendGitGraphResponse(routing.session.id, message.requestId, responsePayload),
      )
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `NodeDaemon: failed to handle git_graph_request for session ${message.sessionId}: ${detail}`,
        );
      });
  }

  private async decryptGitGraphRequest(
    message: GitGraphRequest,
  ): Promise<GitGraphRequestPayloadV1> {
    const key = await this.getSessionKey(message.sessionId);
    return openJson<GitGraphRequestPayloadV1>(message.sessionId, message.envelope, key);
  }

  /**
   * Runs `computeCommitGraph` (`./git-diff.ts`) against `routing`'s own
   * `ExecutionTarget`, project-policy-scoped exactly like {@link
   * computeGitDiffForBridge} above (both drive real `git` subcommands
   * the same way). Never throws: a target that can't be resolved, or a
   * `GitGraphError` from a genuinely uncomputable page, both become an
   * `outcome: 'error'` payload instead, so {@link handleGitGraphRequest}
   * always has a response to seal and send back.
   */
  private async computeCommitGraphForBridge(
    routing: SessionRouting,
    payload: GitGraphRequestPayloadV1,
  ): Promise<GitGraphResponsePayloadV1> {
    try {
      const target = await this.getExecutionTarget(routing.targetId, routing.session.projectPath);
      const page = await computeCommitGraph(target, routing.session.worktreePath, {
        ref: payload.ref,
        limit: payload.limit,
        offset: payload.offset,
      });
      return { outcome: 'ok', commits: page.commits, nextOffset: page.nextOffset };
    } catch (error) {
      if (error instanceof GitGraphError) {
        return { outcome: 'error', message: error.message };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: detail };
    }
  }

  private async sendGitGraphResponse(
    sessionId: string,
    requestId: string,
    payload: GitGraphResponsePayloadV1,
  ): Promise<void> {
    const key = await this.getSessionKey(sessionId);
    const envelope = await sealJson(sessionId, payload, key);
    this.relay.send({
      type: 'git_graph_response',
      protocolVersion: PROTOCOL_V1,
      sessionId,
      requestId,
      envelope,
    });
  }
}

/** Convenience composition: builds a `NodeDaemon` and immediately connects it to the relay. */
export function createNode(options: NodeDaemonOptions): NodeDaemon {
  const node = new NodeDaemon(options);
  node.connect();
  return node;
}
