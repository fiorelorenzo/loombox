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

// v1: config loading (env + optional file) (SPEC §5.1, §10; issue #63). The
// runnable CLI entrypoint itself (`main.ts`'s `start`/`run`) is not part of
// this package's library surface, same as `@loombox/relay`'s own `main.ts` —
// it's reached via this package's `start`/`dev` scripts (`tsx src/main.ts`),
// not imported.
export type { LoadNodeConfigOptions, NodeCliConfig } from './config';
export { ConfigError, loadNodeConfig } from './config';

// v1: recovery-code AMK bootstrap (SPEC §8 path 2; issue #386) — the
// intended way a resident node obtains its account AMK, mirroring
// `apps/web`'s `bootstrapAmkFromRecoveryCode` crypto path against the relay.
export type { AmkBootstrapper, BootstrapAmkFromRecoveryCodeOptions } from './amk-bootstrap';
export { bootstrapAmkFromRecoveryCode } from './amk-bootstrap';

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
