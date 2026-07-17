export const PACKAGE_NAME = '@loombox/node';

export type { CreateSessionOptions, Session } from './session-manager';
export { SessionManager } from './session-manager';

export type {
  RelayConnectionOptions,
  WebSocketConstructor,
  WebSocketLike,
} from './relay-connection';
export { RelayConnection } from './relay-connection';

export type { CreateNodeSessionOptions, NodeDaemonOptions } from './node-daemon';
export { createNode, NodeDaemon } from './node-daemon';

export type { SshTargetConfig } from './target';
export { DEFAULT_LOCAL_TARGET } from './target';

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
