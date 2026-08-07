export const PACKAGE_NAME = '@loombox/node';

export type { CreateSessionOptions, Session, SessionLifecycleState } from './session-manager';
export { InvalidSessionTransitionError, SessionManager } from './session-manager';

export type {
  RelayConnectionOptions,
  WebSocketConstructor,
  WebSocketLike,
} from './relay-connection';
export { RelayConnection } from './relay-connection';

export type {
  CreateNodeSessionOptions,
  NodeDaemonOptions,
  PromptAttachmentRef,
  ResolvedAttachment,
} from './node-daemon';
export { createNode, NodeDaemon } from './node-daemon';

// v1: attachment fetch-and-decrypt on the executing host over the existing
// node<->supervisor control channel (SPEC §7.25; issue #156).
export type { BlobSource, RelayBlobSourceOptions, RelayLike } from './attachments';
export { AttachmentResolver, RelayBlobSource, attachmentResourceId } from './attachments';

// v1: node identity keypair generation + persistence (SPEC §5.1, §8, §16; issues #64, #118).
export type { NodeIdentity, NodeIdentityStoreOptions } from './identity';
export { NodeIdentityStore } from './identity';

// v1: node-side secrets-at-rest via an OS-native keyring, with a documented
// and tested 0600-file fallback (SPEC §8, §16; issue #118).
export type { FileKeyringBackendOptions, KeyringBackend, NodeKeyringOptions } from './keyring';
export { createOsKeyringBackend, FileKeyringBackend, NodeKeyring } from './keyring';

// v1: node-side MCP server configuration persistence (SPEC §7.7; issue #187).
export type { McpConfigStoreOptions } from './mcp-config-store';
export { McpConfigError, McpConfigStore } from './mcp-config-store';

// v1: node-side per-server MCP secret grants + secret-value storage +
// session-start resolution (SPEC §7.7, §7.17; issue #189).
export type { NodeMcpSecretManagerOptions } from './mcp-secrets';
export { NodeMcpSecretManager } from './mcp-secrets';

// v1: node-side per-project direct-agent-env-injection grants + session-
// start resolution, reusing NodeMcpSecretManager's own secret-value
// storage (SPEC §7.17, §8; issue #258).
export type { NodeProjectEnvManagerOptions, ProjectSecretValueSource } from './project-env-secrets';
export { NodeProjectEnvManager } from './project-env-secrets';

// v2: node-side persistence for loombox's native tracker data model
// (`@loombox/shared`'s `TrackerRecord`/`TrackerTypeDefinition`; SPEC
// §7.10 "Native mode"; issue #210).
export type {
  CreateTrackerRecordInput,
  ListTrackerRecordsFilter,
  NativeTrackerStoreOptions,
  UpdateTrackerRecordInput,
} from './native-tracker-store';
export { NativeTrackerStore, NativeTrackerStoreError } from './native-tracker-store';

// v2: MCP tool contract for the native tracker (SPEC §7.10, §7.7; issue
// #211) — tracker_list/tracker_get/tracker_create/tracker_update/
// tracker_link_session, built from a NativeTrackerStore plus a session's
// already-resolved (projectPath, authorId, sessionId). No node-side MCP
// host consumes this yet — see tracker-mcp-tools.ts's doc comment.
export type {
  TrackerCreateToolInput,
  TrackerGetToolInput,
  TrackerGetToolOutput,
  TrackerListToolInput,
  TrackerListToolOutput,
  TrackerLinkSessionToolInput,
  TrackerMcpTool,
  TrackerMcpToolContext,
  TrackerMcpToolName,
  TrackerRecordToolOutput,
  TrackerUpdateToolInput,
} from './tracker-mcp-tools';
export {
  createTrackerMcpTools,
  trackerCreateInputSchema,
  trackerGetInputSchema,
  trackerLinkSessionInputSchema,
  trackerListInputSchema,
  trackerUpdateInputSchema,
  TRACKER_MCP_TOOL_NAMES,
  TrackerMcpToolError,
} from './tracker-mcp-tools';

// v1: config loading (env + optional file) (SPEC §5.1, §10; issue #63).
export type { LoadNodeConfigOptions, NodeCliConfig } from './config';
export { ConfigError, loadNodeConfig } from './config';

// v2: the local-node runtime entry point (issue #406) — previously reached
// only via this package's `start`/`dev` scripts (`tsx src/main.ts`) run as a
// separate process, same as `@loombox/relay`'s own `main.ts`. Exported here
// too so a co-located caller (the desktop app's Electron main process) can
// drive a local node in-process — `start()` resolves config/identity/
// accountId/AMK and connects, `installGracefulShutdown` wires SIGTERM/SIGINT
// to its `stop()`, and `run()` is the two combined (what `main.ts`'s own
// `isMainModule` guard calls when this module runs as the CLI entry — that
// guard only fires for the literal entry-point invocation, never on import,
// so re-exporting these here doesn't also start a second node as a
// side effect of importing this package).
export type {
  DeviceLoginRunner,
  GracefulShutdownOptions,
  StartedNode,
  StartOptions,
  WrappedAmkFileAdopter,
} from './main';
export { installGracefulShutdown, run, start } from './main';

// v2: resolves this node's `accountId` from its bearer token (issue #380) —
// exported so a caller driving `start()`/`runLocalGuidedSetup()`
// programmatically can inject a non-default resolver the same way tests do.
export type { AccountIdResolver } from './resolve-account-id';
export { relayHttpBaseUrl, resolveAccountIdViaRelay } from './resolve-account-id';

// v1: recovery-code AMK bootstrap (SPEC §8 path 2; issue #386) — the
// intended way a resident node obtains its account AMK, mirroring
// `apps/web`'s `bootstrapAmkFromRecoveryCode` crypto path against the relay.
export type { AmkBootstrapper, BootstrapAmkFromRecoveryCodeOptions } from './amk-bootstrap';
export { bootstrapAmkFromRecoveryCode } from './amk-bootstrap';

// v2: the node RECEIVER side of the non-interactive AMK handoff over SSH
// (SPEC §8, §16; issue #399) — reads, unwraps, adopts, and deletes the
// one-shot wrapped-AMK file a provisioner wrote, the third AMK source
// alongside the raw override and the recovery-code bootstrap above.
export type { AdoptWrappedAmkFileOptions, WrappedAmkFileIdentity } from './amk-handoff-file';
export { adoptWrappedAmkFromFile } from './amk-handoff-file';

export type { ExecOptions, ExecResult, ExecutionTarget, SshTargetConfig } from './target';
export { DEFAULT_LOCAL_TARGET } from './target';

// v1: the shared exec/filesystem seam local and ssh: targets both implement
// (SPEC §5.2, §6; issue #69).
export { LocalExecutionTarget } from './local-execution-target';
export { SshExecutionTarget } from './ssh-execution-target';

// ssh: target execution (issues #80/#81/#82/#84): deploy-and-launch over a
// pooled SSH transport with a tmux/screen fallback, cross-node session
// leasing, and the guided setup flow's "verify & persist" step.
export type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './ssh/remote-transport';
export { shQuote } from './ssh/remote-transport';

// v2: SSH host autodetection for the add-target wizard's candidate-card
// picker (SPEC §7.23 step 1; redesign v2 §3.2; issue #475) — was
// package-internal only, so `apps/desktop/src/main/ssh-candidates.ts`'s
// bridge method had to fall back to a hardcoded empty stub. Exported here so
// that bridge (the desktop-machine case) and this package's own
// `node-daemon.ts` (the `ssh_discovery_request` handler, for an
// already-paired node running discovery on ITS OWN machine and reporting
// back over the relay — the path a PWA client with no local filesystem/IPC
// access needs) can both call the real implementation.
export type {
  DiscoverSshTargetsOptions,
  SshHostCandidate,
  SshTargetDiscovery,
} from './ssh/host-candidates';
export { discoverSshTargets } from './ssh/host-candidates';

export { LocalProcessTransport } from './ssh/local-process-transport';
export { FakeTransport } from './ssh/fake-transport';
export type { FakeExecHandler, FakeTransportOptions } from './ssh/fake-transport';
export { Ssh2Transport } from './ssh/ssh2-transport';
export type { Ssh2TransportConfig } from './ssh/ssh2-transport';

export type {
  ChooseDetachModeOptions,
  DetachMode,
  RemoteCapabilities,
  RemoteProcessRunnerOptions,
  RemoteRunHandle,
} from './ssh/remote-process-runner';
export { chooseDetachMode, RemoteProcessRunner } from './ssh/remote-process-runner';

export { asAcpChildProcess, RemoteAgentChildProcess } from './ssh/remote-agent-child';

export type {
  Lease,
  LeaseAcquireResult,
  LeaseStore,
  SessionLeaseManagerOptions,
} from './ssh/session-lease';
export { InMemoryLeaseStore, SessionLeaseManager } from './ssh/session-lease';

// v1: the cross-process half of session-ownership leasing (SPEC §9; issues
// #82/#104) — talks to the relay's own lease arbiter over this node's
// existing relay connection, layered additively alongside
// `SessionLeaseManager` above (see `RelayLeaseClient`'s own doc comment).
export type {
  RelayLeaseClientOptions,
  RelayLeaseOutcome,
  RelayLike as RelayLeaseRelayLike,
} from './ssh/relay-lease-client';
export { RelayLeaseClient } from './ssh/relay-lease-client';

export type { SshVerifyFailureReason, SshVerifyResult } from './ssh/verify-and-persist';
export {
  classifyConnectError,
  defaultNodeStateDir,
  SshTargetStore,
  verifyAndPersistSshTarget,
  verifySshTarget,
} from './ssh/verify-and-persist';

// Issue #817 (decision A1-2): a real, filesystem-backed `SupervisorArtifactSource`
// (network-fetch-from-GitHub-Releases is a follow-up — see this module's own
// doc comment for why) plus the resolve/stage/activate/rollback primitives
// for the `~/.loombox/versions/<version>/` + `current` install layout.
export type { LocalFsSupervisorArtifactSourceOptions } from './ssh/local-fs-artifact-source';
export { createLocalFsSupervisorArtifactSource } from './ssh/local-fs-artifact-source';
export type { SupervisorArtifact, SupervisorArtifactSource } from './ssh/supervisor-artifact';
export { verifySupervisorArtifact } from './ssh/supervisor-artifact';
export type { InstallLayoutDriver } from './install-layout';
export {
  createLocalInstallLayoutDriver,
  createRemoteInstallLayoutDriver,
  createTarGzArchive,
  rollbackVersion,
} from './install-layout';

// v2: composes every SPEC §7.23 ssh: provisioning primitive above into the
// one "add this target and it provisions" flow, and its decommission
// counterpart (issue #400) — the callable library operations a future
// add-target wizard/RPC and the desktop app drive.
export type {
  DecommissionOptionsInput,
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep,
  ProvisionStepId,
  ResidentNodeConfig,
  ResidentNodeInstallStep,
  RuntimeBootstrapStep,
  SupervisorInstallStep,
  VerifyAndPersistStep,
} from './ssh/provision-target';
export { buildResidentNodeEnvironment, decommission, provision } from './ssh/provision-target';

// v2: the PROVISIONER side of the non-interactive AMK handoff over SSH
// (SPEC §8, §16; issue #399) — wraps the unlocked AMK for a freshly-
// provisioned target's device pubkey and writes it to a one-shot file on the
// remote, the counterpart to `amk-handoff-file.ts`'s receiver above.
// Callable by `provision-target.ts`'s orchestrator or a future app bridge
// that already holds the unlocked AMK.
export type {
  AmkHandoffActingIdentity,
  WriteWrappedAmkHandoffOptions,
  WriteWrappedAmkHandoffResult,
} from './ssh/amk-handoff-provision';
export {
  DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME,
  resolveWrappedAmkHandoffPath,
  writeWrappedAmkHandoff,
} from './ssh/amk-handoff-provision';

// v2: the common local-only first-run flow (SPEC §7.23, issue #91) — no SSH
// configuration touched at any point. Exported (issue #406) so the Electron
// bridge/app can drive it programmatically instead of only through a test.
export type {
  GuidedSetupStepId,
  GuidedSetupStepResult,
  LocalGuidedSetupOptions,
  LocalGuidedSetupResult,
} from './ssh/local-guided-setup';
export { runLocalGuidedSetup } from './ssh/local-guided-setup';

// v2: opt-in launchd LaunchAgent install for a Mac-resident LOCAL node
// (issue #406) — the launchd counterpart to `./ssh/systemd-provisioning.ts`'s
// resident-node systemd unit, for the co-located (no SSH) case. Pure plist
// generation plus a plan/execute split, with every disk write/`launchctl`
// call behind the injectable `LaunchdIo` seam; `createNodeLaunchdIo` is the
// real implementation a caller wires up on the actual Mac it runs on.
export type {
  LaunchctlResult,
  LaunchdAgentConfig,
  LaunchdIo,
  LaunchdProvisionAction,
  LaunchdProvisionPlan,
  LaunchdProvisionResult,
  PlanLaunchdProvisioningOptions,
} from './launchd/launchd-provisioning';
export {
  buildLocalNodeLaunchdAgent,
  createNodeLaunchdIo,
  DEFAULT_LAUNCHD_LABEL,
  executeLaunchdProvisioning,
  generateLaunchdPlist,
  planLaunchdProvisioning,
} from './launchd/launchd-provisioning';

// Moved into @loombox/crypto so a node and a client/PWA share one seal/open/
// derive implementation (SPEC §8, §16); re-exported here for callers that
// previously imported these from @loombox/node.
export {
  deriveSessionKey,
  envelopeFromWire,
  envelopeToWire,
  openJson,
  sealJson,
} from '@loombox/crypto';

// v2: the live GitHub `TrackerBackend` — issues + comments only, slice 1
// of SPEC §7.10's phased tracker delivery (issue #213). Credentials come
// only from an injected `resolveCredential`, never this package's own
// `./github-connect.ts`/`./keyring.ts` — see the module's own top comment.
export type {
  GithubCredential,
  GithubTrackerBackendOptions,
  ResolveGithubCredential,
} from './github-tracker-backend';
export {
  GithubTrackerAccessError,
  GithubTrackerBackend,
  GithubTrackerRateLimitError,
  GithubTrackerRequestError,
} from './github-tracker-backend';

// v2: the live Jira `TrackerBackend` — issues + comments only, slice 1
// of SPEC §7.10's phased tracker delivery (issue #214). Credentials come
// only from an injected `resolveCredential`, never this package's own
// `./jira-connect.ts`/`./keyring.ts` — see the module's own top comment.
export type {
  JiraCredential,
  JiraTrackerBackendOptions,
  ResolveJiraCredential,
} from './jira-tracker-backend';
export {
  JiraTrackerAccessError,
  JiraTrackerBackend,
  JiraTrackerRequestError,
} from './jira-tracker-backend';

// v1: Linux namespace/bind-mount sandboxing of a `local` session's agent
// process (SPEC §7.17; issue #257) — `linux-sandbox.ts` is the bare
// `bwrap` primitive, `session-sandbox.ts` the integration layer
// `node-daemon.ts`'s `launchLocalSession` actually calls. Exported so a
// caller (a future target-health/status surface, or a test) can query
// `detectSandboxCapability()` without reaching into package-internal
// files.
export type {
  BuildSandboxedCommandOptions,
  DetectSandboxCapabilityOptions,
  SandboxBackend,
  SandboxCapability,
  SandboxedSpawn,
  SandboxMounts,
} from './linux-sandbox';
export {
  buildBubblewrapArgv,
  detectSandboxCapability,
  resetSandboxCapabilityCacheForTests,
  sandboxCommand,
  SandboxUnavailableError,
} from './linux-sandbox';
export type { ResolveSessionSandboxOptions, SessionSandboxResolution } from './session-sandbox';
export { resolveSessionSandbox } from './session-sandbox';

// v2: the supervisor-backend seam (issue #654, epic #653) — one
// install/start/stop/status/uninstall/survivesReboot vocabulary, no
// platform words above it. Two implementations wired: `systemd` for an
// `ssh:` target, `launchd` for a macOS-local node.
export type {
  SupervisorBackend,
  SupervisorBackendAction,
  SupervisorBackendActionResult,
  SupervisorBackendInstallConfig,
  SupervisorBackendInstallResult,
  SupervisorBackendStatus,
  SupervisorBackendUninstallOptions,
  SupervisorRunState,
} from './supervisor-backend';

export type { LocalFsNodeReleaseSourceOptions, NodeReleaseSource } from './node-release';
export { createLocalFsNodeReleaseSource, NODE_BUNDLE_ENTRY_FILE } from './node-release';

export type { SystemdSshSupervisorBackendOptions } from './ssh/systemd-supervisor-backend';
export { createSystemdSshSupervisorBackend } from './ssh/systemd-supervisor-backend';

export type { LaunchdSupervisorBackendOptions } from './launchd/launchd-supervisor-backend';
export { createLaunchdSupervisorBackend } from './launchd/launchd-supervisor-backend';

// v2: the systemd-user backend for a Linux-local node (issue #658) — the
// third `SupervisorBackend` implementation, wrapping `./ssh/systemd-
// provisioning.ts` unchanged (same generator the ssh backend above uses)
// over `./ssh/local-process-transport.ts` instead of a real ssh: host.
export type { SystemdLocalSupervisorBackendOptions } from './local/systemd-local-supervisor-backend';
export { createSystemdLocalSupervisorBackend } from './local/systemd-local-supervisor-backend';

// v2: the local-node provisioning orchestrator (issue #654) — the shared
// half of the seam alongside `SupervisorBackend` itself: composes
// runtime_bootstrap/target_identity/mint_node_token/amk_handoff (reused
// unchanged from the ssh: reference) with a resident_node_install
// dispatched through the caller's own `SupervisorBackend`. #658/#659
// (Linux/Windows local) reuse this function unchanged, only swapping the
// backend they pass in.
export type {
  LocalProvisionOptions,
  LocalProvisionProgress,
  LocalProvisionResult,
  LocalProvisionStepId,
  LocalProvisionStepStatus,
} from './local/provision-local-node';
export { provisionLocalNode } from './local/provision-local-node';

// v2: the environment concept the local supervisor-backend seam and
// `provisionLocalNode` accept (issue #867, epic #863) — one place a
// caller running a second, non-production node on a machine that already
// has one turns "which environment is this for" into collision-free unit
// name / launchd label / install root / node id defaults, rather than
// having to remember to vary each of those by hand.
export type { NodeEnvironment } from './node-environment';
export {
  collisionFreeNodeId,
  defaultBaseDirName,
  defaultLaunchdLabel,
  defaultUnitName,
} from './node-environment';

// v1: uninstall on the supervisor-backend seam (issue #814, decision
// E1-3) — the missing caller-level counterpart to `provisionLocalNode`
// just above: revokes this node's own device on the relay, delegates
// local teardown to the caller's own `SupervisorBackend`, and (unless
// `keepData`) forgets this identity's OS-native keyring entry too.
export type {
  DeviceRevokeOutcome,
  NodeUninstallOptions,
  NodeUninstallRelayOptions,
  NodeUninstallResult,
} from './node-uninstall';
export {
  resolveNodeUninstallRelayOptions,
  revokeNodeDeviceOnRelay,
  uninstallNode,
} from './node-uninstall';
