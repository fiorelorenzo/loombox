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
