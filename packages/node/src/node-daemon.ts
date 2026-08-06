import { randomUUID, type webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, posix } from 'node:path';

import {
  McpServerSecretMissingError,
  mergeMcpServerConfigLists,
  parseMcpServerConfig,
  type AcpMcpServerConfig,
  type AcpPermissionOption,
  type AcpProvider,
  type AcpSessionWireEvent,
  type AcpToolCallUpdate,
  type AcpTranscriptUpdate,
  type AcpTurnEnd,
  type AvailableCommandsChangeEvent,
  type ConfigOptionChangeEvent,
  type McpServerConfig,
} from '@loombox/providers-core';
import {
  AgentSupervisor,
  defaultPtySpawn,
  TerminalSupervisor,
  type AgentSession,
  type AgentSupervisorStartOptions,
  type AttentionState,
  type AttentionStatus,
  type PtyLike,
  type TerminalSession,
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
  PROTOCOL_V1,
  connectedAccountSecretRef,
  parseConnectedAccountId,
  parseSessionPrivateMetaV1,
  parseCustomAgentProbeRequestPayloadV1,
  type AccountPinGetRequest,
  type AccountPinMapV1,
  type AccountPinResolveOutcome,
  type AccountPinResolveRequest,
  type AccountPinSetRequest,
  type AccountPinUnsetRequest,
  type AmkEpochPendingEnvelope,
  type AttentionHintClass,
  type BuildIdentityV1,
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
  type GithubConnectCancelRequest,
  type GithubConnectOutcome,
  type GithubConnectStartRequest,
  type JiraConnectOutcome,
  type JiraConnectRequest,
  type PromptInjectV1,
  type ProvisionProgress,
  type ProvisionTargetResult,
  type SessionArchiveRequest,
  type SessionArchiveResult,
  type SessionCreate,
  type SessionForkRequest,
  type SessionForkResult,
  type SessionMetaPublic,
  type SessionPrivateMetaV1,
  type SessionStatusV1,
  type SshDiscoveryRequest,
  type SshDiscoveryResultV1,
  type TargetDescriptor,
  type TargetFsListRequest,
  type TargetFsListRequestPayloadV1,
  type TargetFsListResponsePayloadV1,
  type TargetResourceSample,
  type TargetUpdateRequest,
  type TargetVersionStatusV1,
  type RunCancel,
  type RunExitPayloadV1,
  type RunOutputPayloadV1,
  type RunStart,
  type RunStartedResultPayloadV1,
  type RunStartPayloadV1,
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
  type PermissionPolicyGet,
  type PermissionPolicyResultPayloadV1,
  type PermissionPolicySet,
  type PermissionPolicySetPayloadV1,
  type PermissionPolicyV1,
  type PermissionPolicyViolationPayloadV1,
  type TestRunnerConfigDetect,
  type McpServerConfigV1,
  type McpServerFailureCategoryV1,
  type McpServerStatusEntryV1,
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
import { AccountPinStore } from './account-pin-store';
import { AttachmentResolver, RelayBlobSource, type BlobSource } from './attachments';
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
import {
  evaluateCommandLine,
  logPolicyViolation,
  type PermissionPolicy,
  type PolicyViolation,
} from './permission-policy';
import { PermissionPolicyStore } from './permission-policy-store';
import {
  PolicyEnforcedExecutionTarget,
  resolveRealBasename,
} from './policy-enforced-execution-target';
import { PolicyEnforcedPty } from './policy-enforced-pty';
import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import { sampleLocalResources, sampleRemoteResources } from './resource-sampler';
import { SameFolderGuard } from './same-folder-guard';
import { SessionConcurrencyGate } from './session-concurrency-gate';
import {
  CannotForkSessionError,
  InvalidSessionTransitionError,
  SessionManager,
  sessionWorktreeBranch,
  type Session,
} from './session-manager';
import { cutTranscriptAtTurn } from './session-fork';
import { resolveSessionBranch } from './session-branch';
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
  /** Per-process (never persisted) consecutive-failure streak for an MCP server that failed to start, keyed by `${projectPath}\u0000${serverName}` — see {@link recordMcpServerOutcome}'s own doc comment (issue #750, D2-2's "disable" lifecycle action). */
  private readonly mcpFailureStreaks = new Map<string, number>();
  /** Consecutive start failures before {@link recordMcpServerOutcome} auto-disables an MCP server (issue #750, D2-2). */
  private static readonly MCP_AUTO_DISABLE_THRESHOLD = 3;
  /** SPEC §7.17; issue #256 — see `NodeDaemonOptions.permissionPolicyStore`'s doc comment. */
  private readonly permissionPolicyStore: PermissionPolicyStore;
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
    this.permissionPolicyStore =
      options.permissionPolicyStore ?? new PermissionPolicyStore({ stateDir: options.stateDir });
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
      customAgent: options.customAgent,
      mcpServerConfigs: options.mcpServerConfigs,
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
    customAgent?: CustomAgentRecordV1;
    /** The client's own per-project `localStorage` MCP server declarations (issue #750, D2-2), merged into resolution alongside this node's own `McpConfigStore` — see {@link resolveMcpServers}'s doc comment. Omitted/`[]` behaves exactly like before this option existed. */
    mcpServerConfigs?: readonly McpServerConfig[];
  }): Promise<Session> {
    const target = this.targets.find((candidate) => candidate.id === opts.targetId);
    if (!target) {
      throw new Error(`NodeDaemon: no target with id "${opts.targetId}"`);
    }

    const sessionId = opts.sessionId ?? randomUUID();

    // Resolved before any worktree/lease/child is touched, and before this
    // session can even be queued (issues #187/#189's "fails clearly on an
    // ungranted/missing secret... before any session opens"): a session
    // that would fail on a missing MCP secret grant fails right here, not
    // after this node created a worktree, acquired an ssh: lease, or made
    // some other queued session wait behind a request that was always
    // going to fail. A resulting `McpServerSecretMissingError` never gets
    // a bridge, or even a `Session`, to hang a normal `sendSessionStatus`
    // off of — `reportMcpPreflightFailure` announces a minimal phantom
    // session record itself, purely so this failure is visible at all
    // (issue #750, D2-2's "a revoked secret grant... produce a distinct,
    // visible reason"); the worktree/lease cost this comment describes
    // avoiding is still avoided — only a `session_announce` plus a
    // `session_status: 'error'`/`mcp_server_status` pair go out.
    let mcpServers: AcpMcpServerConfig[];
    try {
      mcpServers = await this.resolveMcpServers(opts.projectPath, opts.mcpServerConfigs ?? []);
    } catch (error) {
      if (error instanceof McpServerSecretMissingError) {
        await this.reportMcpPreflightFailure(sessionId, opts, error);
      }
      throw error;
    }

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
      return this.launchLocalSession(session, opts, mcpServers);
    }

    // Over the cap (SPEC §7.16, issue #252): queue rather than launch.
    // `launchLocalSession` runs later, fire-and-forget, once a slot frees —
    // its errors are logged rather than thrown, since by then nothing is
    // left awaiting this call (mirrors `handleSessionCreate`'s own
    // fire-and-forget `.catch`).
    await this.sendSessionStatus(session.id, 'queued');
    this.concurrencyGate.enqueue(target.id, session.id, () => {
      this.launchLocalSession(session, opts, mcpServers).catch((error: unknown) => {
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
    seedTranscriptUpdates?: readonly AcpTranscriptUpdate[],
  ): Promise<Session> {
    await this.sendSessionStatus(session.id, 'starting');

    let agentSession: AgentSession;
    let failedMcpServers: McpServerStatusEntryV1[];
    try {
      const providerId = this.resolveLaunchProviderId(session.id, opts.provider, opts.customAgent);
      const outcome = await this.startAgentWithMcpFallback(
        session.projectPath,
        mcpServers,
        (servers) =>
          this.startAgentWithTimeout({
            workspacePath: session.worktreePath,
            providerId,
            mcpServers: servers,
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
        failedServers.push({
          name: attribution.name,
          ok: false,
          category: attribution.category,
          reason: attribution.reason,
        });
        this.recordMcpServerOutcome(projectPath, attribution.name, false);
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
      };

      await this.sendMcpServerStatus(sessionId, failedMcpServers);
      return await this.finishSessionCreation(
        session,
        agentSession,
        { targetId, title: opts.title, customAgent: opts.customAgent },
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
   */
  private recordMcpServerOutcome(projectPath: string, serverName: string, ok: boolean): void {
    const key = `${projectPath}\u0000${serverName}`;
    if (ok) {
      this.mcpFailureStreaks.delete(key);
      return;
    }
    const streak = (this.mcpFailureStreaks.get(key) ?? 0) + 1;
    if (streak < NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD) {
      this.mcpFailureStreaks.set(key, streak);
      return;
    }
    this.mcpFailureStreaks.delete(key);
    this.autoDisableMcpServer(projectPath, serverName);
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
   * never mask the real failure this was reacting to.
   */
  private autoDisableMcpServer(projectPath: string, serverName: string): void {
    try {
      this.mcpConfigStore.setProjectEnabled(projectPath, serverName, false);
      console.warn(
        `NodeDaemon: auto-disabled project "${projectPath}"'s MCP server "${serverName}" after ${NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD} consecutive failures to start (issue #750).`,
      );
      return;
    } catch {
      // No project-scoped record by that name — try a global one below.
    }
    try {
      this.mcpConfigStore.setGlobalEnabled(serverName, false);
      console.warn(
        `NodeDaemon: auto-disabled global MCP server "${serverName}" after ${NodeDaemon.MCP_AUTO_DISABLE_THRESHOLD} consecutive failures to start (issue #750).`,
      );
    } catch {
      // A client-declared server with no node-store record at all —
      // nothing to disable node-side; see this method's own doc comment.
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
      case 'test_runner_config_get':
        this.handleTestRunnerConfigGet(message);
        return;
      case 'test_runner_config_set':
        this.handleTestRunnerConfigSet(message);
        return;
      case 'test_runner_config_detect':
        this.handleTestRunnerConfigDetect(message);
        return;
      case 'run_start':
        this.handleRunStart(message);
        return;
      case 'run_cancel':
        this.handleRunCancel(message);
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

    // A fork request carries no `mcpServerConfigs` of its own (issue #750
    // predates #746's fork wire shape) — only this node's own McpConfigStore
    // applies; a future fork-time client declaration would thread through
    // here identically to `createSessionInternal`'s own `opts.mcpServerConfigs`.
    const mcpServers = await this.resolveMcpServers(opts.projectPath, []);

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
      return this.launchLocalSession(session, launchOpts, mcpServers, seedTranscriptUpdates);
    }

    // Over the cap (SPEC §7.16, issue #252): queue rather than launch,
    // exactly like `createSessionInternal`'s own overflow path.
    await this.sendSessionStatus(session.id, 'queued');
    this.concurrencyGate.enqueue(target.id, session.id, () => {
      this.launchLocalSession(session, launchOpts, mcpServers, seedTranscriptUpdates).catch(
        (error: unknown) => {
          console.warn(
            `NodeDaemon: forked session ${session.id} failed to start after dequeuing: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
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
   * `payload.mentions` (issue #742's `@`-mention pills) needs no resolution
   * step of its own — each entry already IS the resolved reference (an ACP
   * `resource_link`'s `uri`/`name`, folded onto the wire's plaintext by the
   * client, never re-derived here) — `renderPromptTextWithMentions` just
   * folds it into the text `agentSession.prompt()` takes, see that
   * function's own doc comment for why text is still the only channel.
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
    await bridge.agentSession.prompt(renderPromptTextWithMentions(payload.text, payload.mentions));
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
}

/** Convenience composition: builds a `NodeDaemon` and immediately connects it to the relay. */
export function createNode(options: NodeDaemonOptions): NodeDaemon {
  const node = new NodeDaemon(options);
  node.connect();
  return node;
}
