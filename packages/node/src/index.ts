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
