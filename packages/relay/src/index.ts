export {
  createRelay,
  startRelay,
  RELAY_WS_PATH,
  type AccountResolver,
  type CreateRelayOptions,
  type StartRelayOptions,
  type StartedRelay,
} from './relay';

export {
  createInMemoryRelayStore,
  createTargetStore,
  type Awaitable,
  type BlobStore,
  type DeviceRecord,
  type DeviceStore,
  type RelayStore,
  type RelayStoreOptions,
  type ResyncResult,
  type RingEntry,
  type SessionRecord,
  type SessionStore,
  type SyncRelayStore,
  type TargetStore,
} from './store';

export { createPostgresRelayStore } from './store-postgres';
export type { PgLike, PgQueryResult } from './pg-client';
export { runMigrations } from './migrate';
export { migrations, type Migration } from './migrations';

export {
  createRelayAuth,
  deriveAccountIdStub,
  mountBetterAuth,
  resolveAccountIdViaBetterAuth,
  BETTER_AUTH_ROUTE_PREFIX,
  type BetterAuthDatabase,
  type RelayAuth,
  type RelayAuthConfig,
} from './auth';
