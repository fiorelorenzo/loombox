import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket, { type WebSocket as WsWebSocket } from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  HEARTBEAT_CAPABILITY,
  PROTOCOL_V1,
  initialize,
  negotiateVersion,
  safeParseWireMessageV1,
  type AmkEpochFetchResponse,
  type BlobDownloadResponse,
  type BuildIdentityV1,
  type NodeSelfUpdateSummaryV1,
  type ConnectedAccountList,
  type KeymapResult,
  type InitializeResult,
  type Pong,
  type LeaseReleaseResult,
  type LeaseResult,
  type NewDeviceBootstrapResponse,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionArchiveResponse,
  type SessionForkResponse,
  type SessionListV1,
  type SessionViewStateResult,
  type SessionUpdateEnvelopeV1,
  type TargetList,
  type TargetListEntry,
  type WireMessageV1,
} from '@loombox/protocol';

import {
  deriveAccountIdStub,
  mountBetterAuth,
  resolveAccountIdViaBetterAuth,
  type RelayAuth,
} from './auth';
import { hashDeviceSecret } from './device-auth';
import { registerDeviceAuthRoutes } from './device-auth-routes';
import { createInProcessFanOutBackend, type FanOutBackend } from './fanout';
import { registerNodeTokenRoutes } from './node-token-routes';
import { BoundedClientOutbox, type OutboxItem } from './outbox';
import { BoundedTerminalOutbox, type TerminalOutboxItem } from './terminal-outbox';
import type { PgLike } from './pg-client';
import { createWebPushSender, type PushPayload, type PushSender } from './push';
import {
  createInMemoryRelayStore,
  envelopeByteSize,
  type RelayStore,
  type VapidKeyPair,
} from './store';

/**
 * Resolves the WS handshake's `authToken` to an `accountId`, or `undefined`
 * to reject the connection (#121). May return synchronously or via a
 * Promise — see `store.ts`'s `Awaitable` doc comment for why. Defaults to
 * {@link deriveAccountIdStub} (dev/hermetic mode); `main.ts` supplies
 * `resolveAccountIdViaBetterAuth` bound to a real Better Auth instance once
 * `DATABASE_URL` is configured.
 */
export type AccountResolver = (
  authToken: string,
) => string | undefined | Promise<string | undefined>;

/** Path the WS route is mounted on; both nodes and clients connect here. */
export const RELAY_WS_PATH = '/ws';

/**
 * Protocol versions this relay build understands. v1 only for now — the v0
 * relay this supersedes is superseded, not bridged; a v0-only peer fails
 * negotiation and is closed with an "update required" notice (#108).
 */
const RELAY_SUPPORTED_VERSIONS = [PROTOCOL_V1] as const;

/**
 * What this relay build can do, echoed back in `initializeResult` (#108).
 *
 * Mostly informational, with one exception that is load-bearing:
 * {@link HEARTBEAT_CAPABILITY} is how a peer learns it may arm a pong
 * deadline against this relay (issue #511). A relay that predates the
 * heartbeat drops a `ping` silently instead of answering it, so a peer that
 * assumed a reply would kill its own healthy connection every interval.
 */
const RELAY_CAPABILITIES = [
  'devices',
  'targets',
  'sessions',
  'blobs',
  'resync',
  'presence',
  HEARTBEAT_CAPABILITY,
] as const;

interface BaseConnection {
  socket: WsWebSocket;
  deviceId: string;
  accountId: string;
}

interface NodeConnection extends BaseConnection {
  kind: 'node';
  /** nodeId(s) this connection has announced as, via `target_announce`/`session_announce`. */
  nodeIds: Set<string>;
  /** This node's own build identity, from its `initialize.buildIdentity` (issue #655) — `undefined` for a node that predates the field. Connection-scoped, exactly like `reachable` (`registry.nodeConnectionsByNodeId`): never persisted in `TargetStore`, since it isn't a per-target property and a disconnected node has nothing live to report. */
  buildIdentity?: BuildIdentityV1;
  /** This node's latest self-update check (issue #656), from its `node_self_update_status` push — `undefined` until the first one arrives on this connection, or for a node that predates the field. Connection-scoped, exactly like `buildIdentity` above: never persisted, since a disconnected node has nothing live to report. */
  selfUpdate?: NodeSelfUpdateSummaryV1;
}

interface ClientConnection extends BaseConnection {
  kind: 'client';
  subscriptions: Set<string>;
  outbox: BoundedClientOutbox;
  /** One `BoundedTerminalOutbox` per open terminal this connection is subscribed to (SPEC §7.16; issue #207), keyed by `sessionId:terminalId` — see {@link terminalOutboxFor}'s doc comment for why one PER TERMINAL rather than one shared instance like `outbox` above. Created lazily on first `terminal_output`; entries are removed on `terminal_closed`. */
  terminalOutboxes: Map<string, BoundedTerminalOutbox>;
  /** One entry per subscribed sessionId — the {@link FanOutBackend}'s own unsubscribe function for this specific connection, released on disconnect (#97). */
  fanOutUnsubscribes: Map<string, () => void>;
}

type Connection = NodeConnection | ClientConnection;

interface Registry {
  nodes: Set<NodeConnection>;
  clients: Set<ClientConnection>;
  /** Live routing target for a nodeId — only ever the most recently connected owner. */
  nodeConnectionsByNodeId: Map<string, NodeConnection>;
}

function createRegistry(): Registry {
  return { nodes: new Set(), clients: new Set(), nodeConnectionsByNodeId: new Map() };
}

function sendJson(socket: WsWebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export interface CreateRelayOptions {
  logger?: boolean;
  /** Injectable for tests/Postgres swap; defaults to a fresh in-memory store per relay instance. */
  store?: RelayStore;
  /** Bounded per-client output-queue depth for `session_update` fan-out (SPEC §7.16, #98/#254). */
  maxClientQueueDepth?: number;
  /** Bounded per-client output-queue depth for `terminal_output` fan-out (SPEC §7.16; issue #207) — the terminal-stream sibling of {@link maxClientQueueDepth}. */
  maxTerminalQueueDepth?: number;
  /**
   * How the WS handshake's `authToken` resolves to an `accountId` (#121).
   * Defaults to {@link deriveAccountIdStub} — every existing hermetic test in
   * this package, and `scripts/v1-e2e-harness.mjs`, rely on that default
   * (any non-empty token accepted as its own account) and construct
   * `startRelay()`/`createRelay()` without this option.
   */
  resolveAccountId?: AccountResolver;
  /**
   * A Better Auth instance to mount at `/api/auth/*` on this Fastify
   * instance (#119). When supplied and `resolveAccountId` is not
   * explicitly given, the resolver defaults to validating bearer tokens
   * against this instance instead of the dev stub — see `main.ts` for the
   * production wiring.
   */
  auth?: RelayAuth;
  /**
   * Origins allowed to make credentialed cross-origin HTTP requests to this
   * relay (the web app + desktop app are served from a different origin than
   * the relay, e.g. app.loombox.dev vs relay.loombox.dev). Better Auth's
   * `trustedOrigins` only covers its CSRF/Origin check; the browser also
   * needs `Access-Control-Allow-Origin` on the response, which these drive.
   * Usually the same list as `LOOMBOX_TRUSTED_ORIGINS`.
   */
  corsOrigins?: string[];
  /**
   * Per-IP abuse protection for the public relay endpoint (#101, SPEC §8's
   * "public-relay abuse limits"): caps requests per IP per window across
   * every HTTP/upgrade route this Fastify instance serves — the WS upgrade
   * (`/ws`), and Better Auth's own routes when mounted — except `/health`,
   * which stays exempt (see that route's own comment). Defaults to
   * {@link DEFAULT_RATE_LIMIT_MAX}/{@link DEFAULT_RATE_LIMIT_WINDOW_MS}.
   */
  rateLimit?: {
    /** Max requests per IP per window. */
    max?: number;
    /** Window length — a number of milliseconds, or `@fastify/rate-limit`'s own duration-string format (e.g. `'1 minute'`). */
    timeWindow?: number | string;
  };
  /**
   * Per-account total ciphertext-storage budget in bytes — blobs plus
   * buffered resync-ring entries, the same two write paths #102's retention
   * CLI reclaims from (#101, SPEC §8's "storage-exhaustion cap"). A write
   * that would push the account over this is rejected (see
   * `envelopeByteSize`/the `blob_upload`/`session_update` handlers below);
   * it is never enforced retroactively here — see `prune.ts` for the
   * reclaim-what's-already-over-budget path. Defaults to
   * {@link DEFAULT_MAX_ACCOUNT_STORAGE_BYTES}.
   */
  maxAccountStorageBytes?: number;
  /**
   * How `session_update`/session-scoped control messages reach subscribed
   * clients (#97). Defaults to {@link createInProcessFanOutBackend} — a
   * same-process, synchronous stand-in that reproduces this relay's
   * pre-#97 direct-iteration fan-out exactly, for the single deployed
   * instance case. `main.ts` supplies a Redis-backed backend instead when
   * `REDIS_URL` is set, so multiple relay processes share one fan-out plane.
   */
  fanOutBackend?: FanOutBackend;
  /**
   * Dependency handles `/health`'s readiness probe (#270, SPEC §7.21)
   * round-trips against before answering — deliberately separate from
   * `store`/`fanOutBackend` above (both already abstracted behind
   * hermetic-testable interfaces with no "am I actually reachable"
   * primitive of their own) rather than widening either just for this.
   * `main.ts` passes the same `pg.Pool` it hands `createPostgresRelayStore`
   * (structurally a {@link PgLike}, no extra connection opened). Omitted
   * `db` (dev/hermetic in-memory store, no `DATABASE_URL`) is reported
   * healthy trivially — there is nothing configured to be down. Redis has
   * no separate entry here: it's optional (#97) and already reachable
   * through `fanOutBackend.ping` when Redis-backed, absent on the
   * in-process default.
   */
  healthCheck?: {
    db?: PgLike;
    /** Per-probe timeout (Postgres and Redis each get their own race against this). Defaults to {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}; tests lower it to keep hung-dependency assertions fast. */
    timeoutMs?: number;
  };
  /**
   * Self-owned Web Push (SPEC §7.11/§16, RFC 8291/8292; issues #161/#163).
   * Undefined disables the feature entirely (`/push/*` routes 404, and a
   * `permission_request` never triggers a push) — the shape every existing
   * hermetic test in this package and `scripts/v1-e2e-harness.mjs` already
   * rely on by constructing `startRelay()`/`createRelay()` without this
   * option. `main.ts` resolves `vapidKeys` once at boot (`push.ts`'s
   * `resolveVapidKeys`, generating + persisting on first setup) and passes
   * the result here — key resolution needs the store's own `Awaitable`
   * (genuinely async against Postgres), which `createRelay` itself, unlike
   * `startRelay`, deliberately stays synchronous to construct.
   */
  push?: {
    vapidKeys: VapidKeyPair;
    /** The VAPID JWT's `sub` claim (RFC 8292) — a `mailto:` address or `https:` URL identifying the relay operator. */
    subject: string;
    /** Defaults to {@link createWebPushSender} — injectable so #163's presence-aware delivery is testable without a real Web Push network call. */
    sender?: PushSender;
  };
  /**
   * Session-ownership lease TTL bounds (SPEC §9; issues #82/#104). A
   * `lease_request`'s own `ttlMs` (if any) is clamped into `[1, max]`, then
   * defaults to `default` when omitted entirely — the relay is always the
   * final authority on how long a grant actually lasts, never a bare
   * pass-through of whatever a node asks for. Defaults to
   * {@link DEFAULT_LEASE_TTL_MS}/{@link DEFAULT_MAX_LEASE_TTL_MS}; tests lower
   * both to keep expiry-then-grant assertions fast.
   */
  leaseTtlMs?: {
    default?: number;
    max?: number;
  };
  /**
   * Device-authorization-grant config (issue #387, RFC 8628-shaped). Only
   * `appUrl` today: the app's own origin `/device/authorize`'s
   * `verification_uri` is built from (`main.ts`'s `LOOMBOX_APP_URL`),
   * defaulting to `device-auth.ts`'s `DEFAULT_APP_URL`. Unlike `/push/*`
   * (gated on operator-supplied VAPID keys), the `/device/*` routes are
   * always registered — minting a device token needs no operator secret,
   * so there's nothing to meaningfully disable the feature on.
   */
  deviceAuth?: {
    appUrl?: string;
  };
  /**
   * How long a `provision_target_request`'s per-requestId routing entry
   * (#410 — see the `pendingProvisionRequests` doc comment below) survives
   * without a final `provision_target_result`, before the relay drops it on
   * its own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_PROVISION_REQUEST_TTL_MS}; tests lower it to keep
   * expiry-then-reuse assertions fast, exactly like `leaseTtlMs` above.
   */
  provisionRequestTtlMs?: number;
  /**
   * How long a `target_fs_list_request`'s per-requestId routing entry (#474
   * — see the `pendingTargetFsListRequests` doc comment below) survives
   * without a `target_fs_list_response`, before the relay drops it on its
   * own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_TARGET_FS_LIST_REQUEST_TTL_MS}; tests lower it to keep
   * expiry-then-reuse assertions fast, exactly like `provisionRequestTtlMs`.
   */
  targetFsListRequestTtlMs?: number;
  /**
   * How long a `custom_agent_probe_request`'s per-requestId routing entry
   * (issue #748 — see the `pendingCustomAgentProbeRequests` doc comment
   * below) survives without a `custom_agent_probe_response`, before the
   * relay drops it on its own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_CUSTOM_AGENT_PROBE_REQUEST_TTL_MS}; tests lower it to
   * keep expiry-then-reuse assertions fast, exactly like
   * `targetFsListRequestTtlMs`.
   */
  customAgentProbeRequestTtlMs?: number;
  /**
   * How long a `session_template_list_get`/`_set`'s per-requestId routing
   * entry (issue #259 — see the `pendingSessionTemplateListRequests` doc
   * comment below) survives without a `session_template_list_result`,
   * before the relay drops it on its own to avoid leaking it forever.
   * Defaults to {@link DEFAULT_SESSION_TEMPLATE_LIST_REQUEST_TTL_MS}; tests
   * lower it to keep expiry-then-reuse assertions fast, exactly like
   * `customAgentProbeRequestTtlMs`.
   */
  sessionTemplateListRequestTtlMs?: number;
  /**
   * How long an `ssh_discovery_request`'s per-requestId routing entry (#475
   * — see the `pendingSshDiscoveryRequests` doc comment below) survives
   * without an `ssh_discovery_response`, before the relay drops it on its
   * own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_SSH_DISCOVERY_REQUEST_TTL_MS}; tests lower it to keep
   * expiry-then-reuse assertions fast, exactly like `targetFsListRequestTtlMs`.
   */
  sshDiscoveryRequestTtlMs?: number;
  /**
   * How long a `decommission_target_request`'s per-requestId routing entry
   * (#476 — see the `pendingDecommissionTargetRequests` doc comment below)
   * survives without a `decommission_target_response`, before the relay
   * drops it on its own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_DECOMMISSION_TARGET_REQUEST_TTL_MS}; tests lower it to
   * keep expiry-then-reuse assertions fast, exactly like
   * `sshDiscoveryRequestTtlMs`.
   */
  decommissionTargetRequestTtlMs?: number;
  /**
   * How long a `target_update_request`'s per-requestId routing entry (#476
   * — see the `pendingTargetUpdateRequests` doc comment below) survives
   * without a `target_update_response`, before the relay drops it on its
   * own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_TARGET_UPDATE_REQUEST_TTL_MS}; tests lower it to keep
   * expiry-then-reuse assertions fast, exactly like
   * `decommissionTargetRequestTtlMs`.
   */
  targetUpdateRequestTtlMs?: number;
  /**
   * How long a `node_self_update_apply_request`'s per-requestId routing
   * entry (issue #656 — see the `pendingNodeSelfUpdateApplyRequests` doc
   * comment below) survives without a `node_self_update_apply_response`,
   * before the relay drops it on its own to avoid leaking it forever.
   * Defaults to {@link DEFAULT_NODE_SELF_UPDATE_APPLY_REQUEST_TTL_MS};
   * tests lower it to keep expiry-then-reuse assertions fast, exactly
   * like `targetUpdateRequestTtlMs`.
   */
  nodeSelfUpdateApplyRequestTtlMs?: number;
  /**
   * How long any SPEC §7.26 connected-account request's (github/jira
   * connect, disconnect, pin get/set/unset/resolve — issue #230; see the
   * `pendingAccountRequests` doc comment below) per-requestId routing entry
   * survives without its terminal reply, before the relay drops it on its
   * own to avoid leaking it forever. Defaults to
   * {@link DEFAULT_ACCOUNT_REQUEST_TTL_MS}; tests lower it to keep
   * expiry-then-reuse assertions fast, exactly like
   * `targetUpdateRequestTtlMs`. The GitHub device flow is this pair's
   * slowest member (an operator has up to `expires_in` — GitHub's own
   * default is 15 minutes — to approve in a browser), so the default is
   * generous enough to cover it rather than tuned to the sub-second pin/
   * disconnect calls that share this same table.
   */
  accountRequestTtlMs?: number;
  /**
   * This relay's own build identity (issue #655): "what is actually being
   * served", echoed back in every `initialize_result` a connecting peer
   * receives (`buildIdentityV1`'s own doc comment on why nothing here is
   * ever parsed for ordering — only equality, via `buildIdentityMismatch`).
   * `createRelay` stays synchronous exactly like `push.vapidKeys` above —
   * resolving a real one needs `build-identity.ts`'s async `git rev-parse`/
   * env-var lookup, so `main.ts` resolves it once at boot and passes the
   * plain value here. Omitted (every existing test, and any relay build
   * that predates #655) simply never sends the field — `initializeResult`
   * schema already tolerates that (additive, optional).
   */
  buildIdentity?: BuildIdentityV1;
}

const DEFAULT_MAX_CLIENT_QUEUE_DEPTH = 64;
/** Sane default for {@link CreateRelayOptions.maxTerminalQueueDepth} — same depth as {@link DEFAULT_MAX_CLIENT_QUEUE_DEPTH} (issue #207): generous enough that an ordinary high-volume burst (a build log, `find /`) drains under real backpressure pacing with zero loss, tight enough that a genuinely stalled client's queue never grows past a small, fixed bound. */
const DEFAULT_MAX_TERMINAL_QUEUE_DEPTH = 500;

/** Sane default for {@link CreateRelayOptions.rateLimit}'s `max` — generous enough for a single self-hoster's own devices reconnecting in a burst, tight enough to blunt a public-endpoint scan/enrollment flood (#101). */
export const DEFAULT_RATE_LIMIT_MAX = 120;
/** Sane default for {@link CreateRelayOptions.rateLimit}'s `timeWindow` (#101). */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
/** Sane default for {@link CreateRelayOptions.maxAccountStorageBytes} — 50 MiB (#101). */
export const DEFAULT_MAX_ACCOUNT_STORAGE_BYTES = 50 * 1024 * 1024;
/** Sane default for {@link CreateRelayOptions.leaseTtlMs}'s `default` — 30s, matching `packages/node/src/ssh/session-lease.ts`'s own historical local default (issues #82/#104). */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** Sane default for {@link CreateRelayOptions.leaseTtlMs}'s `max` — 5 minutes, long enough for a slow renew cycle to catch up, short enough that a crashed/misbehaving node's session becomes reclaimable in a bounded time even if it requested an enormous TTL. */
export const DEFAULT_MAX_LEASE_TTL_MS = 5 * 60_000;
/** Sane default for {@link CreateRelayOptions.provisionRequestTtlMs} — 10 minutes, generous because the underlying provision-and-pair sequence (runtime bootstrap + package installs over SSH, #400) can genuinely take a while; this only guards against a genuinely abandoned/crashed run leaking its routing entry forever (#410). */
export const DEFAULT_PROVISION_REQUEST_TTL_MS = 10 * 60_000;
/** Sane default for {@link CreateRelayOptions.targetFsListRequestTtlMs} — 30s, generous for a slow `ssh:` directory listing; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (#474), not normal picker latency. */
export const DEFAULT_TARGET_FS_LIST_REQUEST_TTL_MS = 30_000;
/** Sane default for {@link CreateRelayOptions.customAgentProbeRequestTtlMs} — 15s, generous for a `command -v` probe over `ssh:`; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (issue #748), not normal probe latency. */
export const DEFAULT_CUSTOM_AGENT_PROBE_REQUEST_TTL_MS = 15_000;
/** Sane default for {@link CreateRelayOptions.sessionTemplateListRequestTtlMs} — 15s, generous for a small local JSON file read/write on the node; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (issue #259), not normal catalog latency. */
export const DEFAULT_SESSION_TEMPLATE_LIST_REQUEST_TTL_MS = 15_000;
/** Sane default for {@link CreateRelayOptions.sshDiscoveryRequestTtlMs} — 15s, generous for `~/.ssh/config` parsing + an ssh-agent probe on the acting node; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (#475), not normal discovery latency. */
export const DEFAULT_SSH_DISCOVERY_REQUEST_TTL_MS = 15_000;
/** Sane default for {@link CreateRelayOptions.decommissionTargetRequestTtlMs} — 60s, generous for the systemd stop/disable + optional file cleanup `decommissionSshTarget` runs over `ssh:`; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (#476), not normal decommission latency. */
export const DEFAULT_DECOMMISSION_TARGET_REQUEST_TTL_MS = 60_000;
/** Sane default for {@link CreateRelayOptions.targetUpdateRequestTtlMs} — 5 minutes, generous because the underlying update re-runs supervisor provisioning (fetch + verify + stage an artifact over `ssh:`, #87); this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (#476), not normal update latency. */
export const DEFAULT_TARGET_UPDATE_REQUEST_TTL_MS = 5 * 60_000;
/** Sane default for {@link CreateRelayOptions.nodeSelfUpdateApplyRequestTtlMs} — 5 minutes, the same generous window as `DEFAULT_TARGET_UPDATE_REQUEST_TTL_MS` and for the same reason: a real node self-update stages+verifies+activates a real bundle before it ever replies; this only guards against a genuinely abandoned/crashed request leaking its routing entry forever (issue #656), not normal update latency. */
export const DEFAULT_NODE_SELF_UPDATE_APPLY_REQUEST_TTL_MS = 5 * 60_000;
/** Sane default for {@link CreateRelayOptions.accountRequestTtlMs} — 16 minutes, one past GitHub's own device-flow `expires_in` default (15 minutes, `github-device-flow.ts`), so a slow-but-real approval is never cut off by the relay's own routing-entry TTL; this only guards against a genuinely abandoned/crashed request leaking its entry forever (#230), not normal connect/pin/disconnect latency. */
export const DEFAULT_ACCOUNT_REQUEST_TTL_MS = 16 * 60_000;
/** Sane default for {@link CreateRelayOptions.healthCheck}'s `timeoutMs` (#270) — generous relative to a healthy `SELECT 1`/`PING` (single-digit milliseconds on the same host/LAN as prodbox's Postgres/Redis), short enough that a hung dependency still answers well within any external uptime checker's own timeout (these commonly run 5-30s). */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Races `probe` against `timeoutMs` so a hung Postgres/Redis connection
 * can't hang `/health` itself (#270) — the timeout side always wins a
 * probe that never settles. Any rejection (the probe's own error, or the
 * timeout) collapses to `false`: `/health` reports failure by dependency
 * *name* only (see the route below), never the underlying error's
 * message/stack, so an unauthenticated caller can't learn a connection
 * string, credential, or version from a failing probe.
 */
async function probeWithTimeout(
  probe: () => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('health probe timed out')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the Fastify instance for the v1 relay: an in-memory, blind-router
 * WS fan-out between agent nodes and PWA clients (SPEC §5.3, §8, §16;
 * issue #315's locked v1 architecture). The relay never decrypts — every
 * session/resource payload it stores or forwards is an opaque
 * `EncryptedEnvelope`; it only ever indexes clear routing metadata
 * (`SessionMetaPublic`: id, nodeId, targetId, accountId, provider, seq).
 * Does not call `listen`; see {@link startRelay} for that.
 */
export function createRelay(opts: CreateRelayOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // CORS for the app origins (SPEC §10: app served from a different origin
  // than the relay). Better Auth's trustedOrigins handles CSRF but not the
  // Access-Control-* response headers the browser needs for credentialed
  // cross-origin fetches (sign-in, get-session). Runs before routing so a
  // preflight OPTIONS is answered even where no route matches the verb.
  const corsOrigins = opts.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && corsOrigins.includes(origin)) {
        reply
          .header('Access-Control-Allow-Origin', origin)
          .header('Access-Control-Allow-Credentials', 'true')
          // Better Auth's Bearer plugin returns the session token in a custom
          // `set-auth-token` response header; the browser only lets the app
          // read it cross-origin when it's explicitly exposed. Without this
          // the client can't capture/persist the token after sign-in, so it
          // loops back to the login screen despite a valid session.
          .header('Access-Control-Expose-Headers', 'set-auth-token')
          .header('Vary', 'Origin');
        if (request.method === 'OPTIONS') {
          await reply
            .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            .header('Access-Control-Allow-Headers', 'content-type, authorization')
            .header('Access-Control-Max-Age', '600')
            .code(204)
            .send();
        }
      }
    });
  }
  const registry = createRegistry();
  const store = opts.store ?? createInMemoryRelayStore();
  const maxClientQueueDepth = opts.maxClientQueueDepth ?? DEFAULT_MAX_CLIENT_QUEUE_DEPTH;
  const maxTerminalQueueDepth = opts.maxTerminalQueueDepth ?? DEFAULT_MAX_TERMINAL_QUEUE_DEPTH;
  const maxAccountStorageBytes = opts.maxAccountStorageBytes ?? DEFAULT_MAX_ACCOUNT_STORAGE_BYTES;
  const defaultLeaseTtlMs = opts.leaseTtlMs?.default ?? DEFAULT_LEASE_TTL_MS;
  const maxLeaseTtlMs = opts.leaseTtlMs?.max ?? DEFAULT_MAX_LEASE_TTL_MS;
  const fanOutBackend = opts.fanOutBackend ?? createInProcessFanOutBackend();
  const healthCheckDb = opts.healthCheck?.db;
  const healthProbeTimeoutMs = opts.healthCheck?.timeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const pushSender = opts.push ? (opts.push.sender ?? createWebPushSender()) : undefined;
  const provisionRequestTtlMs = opts.provisionRequestTtlMs ?? DEFAULT_PROVISION_REQUEST_TTL_MS;
  const targetFsListRequestTtlMs =
    opts.targetFsListRequestTtlMs ?? DEFAULT_TARGET_FS_LIST_REQUEST_TTL_MS;
  const customAgentProbeRequestTtlMs =
    opts.customAgentProbeRequestTtlMs ?? DEFAULT_CUSTOM_AGENT_PROBE_REQUEST_TTL_MS;
  const sessionTemplateListRequestTtlMs =
    opts.sessionTemplateListRequestTtlMs ?? DEFAULT_SESSION_TEMPLATE_LIST_REQUEST_TTL_MS;
  const sshDiscoveryRequestTtlMs =
    opts.sshDiscoveryRequestTtlMs ?? DEFAULT_SSH_DISCOVERY_REQUEST_TTL_MS;
  const decommissionTargetRequestTtlMs =
    opts.decommissionTargetRequestTtlMs ?? DEFAULT_DECOMMISSION_TARGET_REQUEST_TTL_MS;
  const targetUpdateRequestTtlMs =
    opts.targetUpdateRequestTtlMs ?? DEFAULT_TARGET_UPDATE_REQUEST_TTL_MS;
  const accountRequestTtlMs = opts.accountRequestTtlMs ?? DEFAULT_ACCOUNT_REQUEST_TTL_MS;
  const nodeSelfUpdateApplyRequestTtlMs =
    opts.nodeSelfUpdateApplyRequestTtlMs ?? DEFAULT_NODE_SELF_UPDATE_APPLY_REQUEST_TTL_MS;
  const relayBuildIdentity = opts.buildIdentity;

  /**
   * #410: routes a node's `provision_progress`/`provision_target_result`
   * back to the client whose `provision_target_request` this requestId
   * belongs to. There is no sessionId to fan out through yet — the whole
   * point of provisioning is that the target doesn't exist until it
   * succeeds — so this is its own small in-memory routing table instead of
   * `store.sessions`/the fan-out backend, exactly like
   * `registry.nodeConnectionsByNodeId` is its own table for nodeId
   * routing. Populated in the `provision_target_request` handler below,
   * consumed in the `provision_progress`/`provision_target_result`
   * handlers, and cleaned up in exactly three places so it never leaks: the
   * final `provision_target_result`, the requesting client's own
   * disconnect (`dropConnection`), and the TTL timer set here
   * (`provisionRequestTtlMs`). Never persisted — purely routing metadata
   * for a request that is currently in flight.
   */
  const pendingProvisionRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingProvisionRequest(requestId: string): void {
    const pending = pendingProvisionRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingProvisionRequests.delete(requestId);
  }

  /**
   * #474: routes a node's `target_fs_list_response` back to the client whose
   * `target_fs_list_request` this requestId belongs to — the directory
   * picker's own small in-memory routing table, exactly like
   * `pendingProvisionRequests` above and for the same reason (there is no
   * `sessionId` to fan this out through; a target can be browsed before any
   * session exists on it). Populated in the `target_fs_list_request` handler
   * below, consumed in the `target_fs_list_response` handler, and cleaned up
   * in exactly three places so it never leaks: the response itself, the
   * requesting client's own disconnect (`dropConnection`), and the TTL timer
   * set here (`targetFsListRequestTtlMs`). Never persisted — purely routing
   * metadata for a request currently in flight.
   */
  const pendingTargetFsListRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingTargetFsListRequest(requestId: string): void {
    const pending = pendingTargetFsListRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingTargetFsListRequests.delete(requestId);
  }

  /**
   * Issue #748: routes a node's `custom_agent_probe_response` back to the
   * client whose `custom_agent_probe_request` this requestId belongs to —
   * the same small in-memory routing table `pendingTargetFsListRequests`
   * is, and for the same reason (there is no session, and often no
   * project, to fan this out through — a custom agent can be probed
   * before any session using it ever exists). Populated in the
   * `custom_agent_probe_request` handler below, consumed in the
   * `custom_agent_probe_response` handler, and cleaned up in exactly three
   * places so it never leaks: the response itself, the requesting
   * client's own disconnect (`dropConnection`), and the TTL timer set here
   * (`customAgentProbeRequestTtlMs`). Never persisted — purely routing
   * metadata for a request currently in flight.
   */
  const pendingCustomAgentProbeRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingCustomAgentProbeRequest(requestId: string): void {
    const pending = pendingCustomAgentProbeRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingCustomAgentProbeRequests.delete(requestId);
  }

  /**
   * Issue #259: routes a node's `session_template_list_result` back to the
   * client whose `session_template_list_get`/`_set` this requestId belongs
   * to — the same small in-memory routing table `pendingTargetFsListRequests`
   * is, and for the same reason (there is no session, and often none has
   * ever existed for this project, to fan this out through —
   * `NewSessionDialog` is exactly where a template gets loaded/saved
   * BEFORE any session exists). Shared by both `_get` and `_set`, since
   * both produce the same `session_template_list_result` reply, mirroring
   * `agent_profile_list_get`/`_set`'s own shared-reply convention.
   * Populated in the `session_template_list_get`/`_set` handler below,
   * consumed in the `session_template_list_result` handler, and cleaned up
   * in exactly three places so it never leaks: the response itself, the
   * requesting client's own disconnect (`dropConnection`), and the TTL
   * timer set here (`sessionTemplateListRequestTtlMs`). Never persisted —
   * purely routing metadata for a request currently in flight.
   */
  const pendingSessionTemplateListRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingSessionTemplateListRequest(requestId: string): void {
    const pending = pendingSessionTemplateListRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSessionTemplateListRequests.delete(requestId);
  }

  /**
   * #475: routes a node's `ssh_discovery_response` back to the client whose
   * `ssh_discovery_request` this requestId belongs to — the add-target
   * wizard's own small in-memory routing table, exactly like
   * `pendingTargetFsListRequests` above and for the same reason (there is no
   * target, let alone a session, to fan this out through — discovering
   * hosts is what happens BEFORE either exists). Populated in the
   * `ssh_discovery_request` handler below, consumed in the
   * `ssh_discovery_response` handler, and cleaned up in exactly three
   * places so it never leaks: the response itself, the requesting client's
   * own disconnect (`dropConnection`), and the TTL timer set here
   * (`sshDiscoveryRequestTtlMs`). Never persisted — purely routing metadata
   * for a request currently in flight.
   */
  const pendingSshDiscoveryRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingSshDiscoveryRequest(requestId: string): void {
    const pending = pendingSshDiscoveryRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSshDiscoveryRequests.delete(requestId);
  }

  /**
   * #476: routes a node's `decommission_target_response` back to the client
   * whose `decommission_target_request` this requestId belongs to —
   * `TargetStatusView`'s Remove/Edit actions' own small in-memory routing
   * table, exactly like `pendingSshDiscoveryRequests` above and for the same
   * reason (a single-shot reply with no `sessionId` to fan it out through).
   * Populated in the `decommission_target_request` handler below, consumed
   * in the `decommission_target_response` handler, and cleaned up in exactly
   * three places so it never leaks: the response itself, the requesting
   * client's own disconnect (`dropConnection`), and the TTL timer set here
   * (`decommissionTargetRequestTtlMs`). Never persisted — purely routing
   * metadata for a request currently in flight.
   */
  const pendingDecommissionTargetRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingDecommissionTargetRequest(requestId: string): void {
    const pending = pendingDecommissionTargetRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingDecommissionTargetRequests.delete(requestId);
  }

  /**
   * #476: routes a node's `target_update_response` back to the client whose
   * `target_update_request` this requestId belongs to — `TargetStatusView`'s
   * Update action's own small in-memory routing table, exactly like
   * `pendingDecommissionTargetRequests` above and for the same reason.
   * Populated in the `target_update_request` handler below, consumed in the
   * `target_update_response` handler, and cleaned up in exactly three places
   * so it never leaks: the response itself, the requesting client's own
   * disconnect (`dropConnection`), and the TTL timer set here
   * (`targetUpdateRequestTtlMs`). Never persisted — purely routing metadata
   * for a request currently in flight.
   */
  const pendingTargetUpdateRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingTargetUpdateRequest(requestId: string): void {
    const pending = pendingTargetUpdateRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingTargetUpdateRequests.delete(requestId);
  }

  /**
   * Issue #656: routes a node's `node_self_update_apply_response` back to
   * the client whose `node_self_update_apply_request` this requestId
   * belongs to — same shape as `pendingTargetUpdateRequests` above and for
   * the same reason (a single-shot reply with no `targetId`/session to
   * fan it out through). Populated in the `node_self_update_apply_request`
   * handler below, consumed in the `node_self_update_apply_response`
   * handler, and cleaned up in exactly three places so it never leaks: the
   * response itself, the requesting client's own disconnect
   * (`dropConnection`), and the TTL timer set here
   * (`nodeSelfUpdateApplyRequestTtlMs`). Never persisted — purely routing
   * metadata for a request currently in flight.
   */
  const pendingNodeSelfUpdateApplyRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: ReturnType<typeof setTimeout> }
  >();

  function clearPendingNodeSelfUpdateApplyRequest(requestId: string): void {
    const pending = pendingNodeSelfUpdateApplyRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingNodeSelfUpdateApplyRequests.delete(requestId);
  }

  /**
   * SPEC §7.26's connected-accounts management surface (issue #230): every
   * nodeId-scoped connect/disconnect/pin request shares this one routing
   * table, exactly like `pendingProvisionRequests`/
   * `pendingSshDiscoveryRequests` above and for the same reason — none has
   * an existing session/target to fan a reply through (a pin can be set
   * before any tracker session exists on that project; disconnecting an
   * account has no target of its own; a connect flow's whole point is that
   * the account doesn't exist yet). One shared map, not seven near-
   * identical ones, because every member is "one client-owned requestId in
   * flight, terminal reply delivered to that same client" with no other
   * per-type state to track. `github_connect_start_request` is the one
   * multi-message case (an intermediate `github_connect_device_code`
   * before the terminal `github_connect_result`) — handled by simply not
   * clearing the entry on the intermediate message, exactly like
   * `provision_progress` vs. `provision_target_result` above.
   * `github_connect_cancel_request` deliberately never touches this table:
   * it's forwarded straight to the owning node by `nodeId` (the client
   * already knows it, having started the flow), and the eventual
   * `github_connect_result` (reason `'cancelled'`) is what retires the
   * original request's own entry.
   *
   * Cleaned up in exactly three places so nothing ever leaks: the terminal
   * reply itself, the requesting client's own disconnect
   * (`dropConnection`), and the TTL timer set here (`accountRequestTtlMs`).
   * Never persisted — purely routing metadata for a request currently in
   * flight.
   */
  const pendingAccountRequests = new Map<
    string,
    { clientConnection: ClientConnection; timeout: NodeJS.Timeout }
  >();

  function clearPendingAccountRequest(requestId: string): void {
    const pending = pendingAccountRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingAccountRequests.delete(requestId);
  }

  /** Registers a fresh routing entry for `requestId`, owned by `connection`, retired automatically after `accountRequestTtlMs` if no terminal reply ever arrives — the one piece of setup every account-request handler below shares. */
  function trackAccountRequest(requestId: string, connection: ClientConnection): void {
    clearPendingAccountRequest(requestId);
    const timeout = setTimeout(() => {
      app.log.warn(
        { requestId },
        'relay: connected-account request routing entry expired before a terminal reply arrived',
      );
      pendingAccountRequests.delete(requestId);
    }, accountRequestTtlMs);
    pendingAccountRequests.set(requestId, { clientConnection: connection, timeout });
  }

  app.addHook('onClose', async () => {
    for (const requestId of [...pendingProvisionRequests.keys()]) {
      clearPendingProvisionRequest(requestId);
    }
    for (const requestId of [...pendingTargetFsListRequests.keys()]) {
      clearPendingTargetFsListRequest(requestId);
    }
    for (const requestId of [...pendingCustomAgentProbeRequests.keys()]) {
      clearPendingCustomAgentProbeRequest(requestId);
    }
    for (const requestId of [...pendingSessionTemplateListRequests.keys()]) {
      clearPendingSessionTemplateListRequest(requestId);
    }
    for (const requestId of [...pendingSshDiscoveryRequests.keys()]) {
      clearPendingSshDiscoveryRequest(requestId);
    }
    for (const requestId of [...pendingDecommissionTargetRequests.keys()]) {
      clearPendingDecommissionTargetRequest(requestId);
    }
    for (const requestId of [...pendingTargetUpdateRequests.keys()]) {
      clearPendingTargetUpdateRequest(requestId);
    }
    for (const requestId of [...pendingAccountRequests.keys()]) {
      clearPendingAccountRequest(requestId);
    }
    await fanOutBackend.close();
  });
  const baseResolveAccountId: AccountResolver =
    opts.resolveAccountId ??
    (opts.auth
      ? (authToken) => resolveAccountIdViaBetterAuth(opts.auth as RelayAuth, authToken)
      : deriveAccountIdStub);
  // #387: a relay-native device token (minted by `/device/approve`, see
  // `device-auth-routes.ts`) is checked ahead of the base resolver on EVERY
  // bearer this relay sees — the WS handshake's `authToken` and every HTTP
  // route's `Authorization: Bearer` alike, since both ultimately call this
  // same `resolveAccountId`. A device token that doesn't match anything
  // falls through to `baseResolveAccountId` unchanged, so this is purely
  // additive: it never changes how a real Better Auth bearer (or, in
  // hermetic/dev mode, the stub) resolves.
  const resolveAccountId: AccountResolver = async (authToken) => {
    const deviceAccountId = await store.deviceTokens.resolveByHash(hashDeviceSecret(authToken));
    if (deviceAccountId) return deviceAccountId;
    return baseResolveAccountId(authToken);
  };

  // #101: registered before any route, so its `onRequest` hook covers every
  // HTTP/upgrade request this instance serves (all Fastify hooks run ahead
  // of the WS upgrade — the `/ws` route below is no exception). `/health`
  // opts back out individually (see that route), since it's meant for an
  // external uptime prober hitting it far more often than any real device
  // would ever legitimately reconnect.
  app.register(fastifyRateLimit, {
    max: opts.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX,
    timeWindow: opts.rateLimit?.timeWindow ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  });

  if (opts.auth) mountBetterAuth(app, opts.auth);

  /** Current usage + incoming write, checked against `maxAccountStorageBytes` before any blob/ring-entry write (#101). */
  async function hasQuotaFor(accountId: string, incomingBytes: number): Promise<boolean> {
    const used = await store.quota.getUsageBytes(accountId);
    return used + incomingBytes <= maxAccountStorageBytes;
  }

  /** Direct, unbounded send — used for control/reply traffic that must never be dropped. */
  function sendDirect(connection: Connection, message: WireMessageV1): void {
    sendJson(connection.socket, message);
  }

  /** SPEC §7.26, issue #221/#631: `connected_account_list_request`'s reply, shared by both `handleClientMessage` and `handleNodeMessage` — a node needs its own account's registry exactly like a client does (`@loombox/node`'s `resolveTrackerBackend`, issue #631, is the first node-side consumer), scoped identically to `connection.accountId` either way. One implementation rather than two near-identical case bodies is what keeps a future change here (an added field, a different scoping rule) from landing in only one of the two call sites. */
  async function sendConnectedAccountList(connection: Connection): Promise<void> {
    const accounts = await store.connectedAccounts.listForAccount(connection.accountId);
    const response: ConnectedAccountList = {
      type: 'connected_account_list',
      protocolVersion: PROTOCOL_V1,
      accounts: [...accounts],
    };
    sendDirect(connection, response);
  }

  // #97: publishing goes through the fan-out backend rather than iterating
  // `registry.clients` directly — with the default in-process backend this
  // is exactly the old direct-iteration fan-out (see
  // `subscribeClientToSession` below for the other half: registering each
  // subscribed client's own delivery). With a Redis-backed backend, this is
  // what lets a client connected to a different relay process receive an
  // update whose owning node is connected here.
  /**
   * The `terminal_output`/`terminal_resync_marker` sibling of
   * {@link fanOutSessionUpdate} above (SPEC §7.16; issue #207). Unlike
   * `outbox` (one shared bounded queue for every session a connection is
   * subscribed to), each open terminal gets its OWN
   * {@link BoundedTerminalOutbox}, keyed by `sessionId:terminalId` in
   * {@link ClientConnection.terminalOutboxes} — a single connection can
   * have several terminals open (SPEC §7.5, issue #173) sharing one
   * session's working directory, and a single shared queue would let one
   * terminal's firehose (a build log) evict — and so starve — a second,
   * otherwise idle terminal's own reply, since drop-oldest has no way to
   * tell "this queued item belongs to a different terminal" from "this
   * queued item is just old" (found and fixed while proving issue #207's
   * acceptance: a real two-terminal round trip against a shared queue
   * lost the second terminal's own output entirely for as long as the
   * first kept overflowing). One small bounded queue per terminal keeps
   * the fix simple and the total bound still small: N open terminals
   * means at most `N * maxTerminalQueueDepth` items in flight, and N is a
   * user-controlled, inherently small number, never adversarial.
   */
  function terminalOutboxFor(
    client: ClientConnection,
    sessionId: string,
    terminalId: string,
  ): BoundedTerminalOutbox {
    const key = `${sessionId}:${terminalId}`;
    let outbox = client.terminalOutboxes.get(key);
    if (!outbox) {
      outbox = new BoundedTerminalOutbox((item, done) => {
        sendJson(client.socket, item);
        done();
      }, maxTerminalQueueDepth);
      client.terminalOutboxes.set(key, outbox);
    }
    return outbox;
  }

  function fanOutSessionUpdate(sessionId: string, item: OutboxItem): void {
    fanOutBackend.publish(sessionId, { kind: 'update', item });
  }

  /** The `terminal_output`/`terminal_resync_marker` fan-out publish half — see {@link terminalOutboxFor}'s doc comment for the per-terminal queue this feeds on the receiving end. */
  function fanOutTerminalOutput(sessionId: string, item: TerminalOutboxItem): void {
    fanOutBackend.publish(sessionId, { kind: 'terminal', item });
  }

  /** Direct fan-out (no bounded queue) for lower-volume session-scoped control traffic (permission requests, blob refs, ...). */
  function fanOutDirect(sessionId: string, message: WireMessageV1): void {
    fanOutBackend.publish(sessionId, { kind: 'direct', message });
  }

  /**
   * Registers this client connection's own delivery for `sessionId` with
   * the fan-out backend (#97) — the other half of `fanOutSessionUpdate`/
   * `fanOutDirect` above. Idempotent: a client resuming the same session
   * twice does not double-subscribe. The registration is undone in
   * `dropConnection` on disconnect, which is also what releases the
   * backend's own channel subscription once the last local client for a
   * session goes away (see `FanOutBackend.subscribe`'s doc comment).
   */
  function subscribeClientToSession(client: ClientConnection, sessionId: string): void {
    if (client.subscriptions.has(sessionId)) return;
    client.subscriptions.add(sessionId);
    const unsubscribe = fanOutBackend.subscribe(sessionId, (payload) => {
      if (payload.kind === 'update') client.outbox.enqueue(payload.item);
      else if (payload.kind === 'terminal') {
        terminalOutboxFor(client, payload.item.sessionId, payload.item.terminalId).enqueue(
          payload.item,
        );
      } else {
        sendDirect(client, payload.message);
        // A closed terminal's queue is never coming back — drop it from
        // this connection's map so a session that opens and closes many
        // terminals over its lifetime doesn't accumulate one empty,
        // never-reclaimed `BoundedTerminalOutbox` per terminal ever opened.
        if (payload.message.type === 'terminal_closed') {
          client.terminalOutboxes.delete(
            `${payload.message.sessionId}:${payload.message.terminalId}`,
          );
        }
      }
    });
    client.fanOutUnsubscribes.set(sessionId, unsubscribe);
  }

  async function routeToOwningNode(sessionId: string, message: WireMessageV1): Promise<void> {
    const record = await store.sessions.get(sessionId);
    if (!record) {
      app.log.warn({ sessionId }, 'relay: message for unknown session');
      return;
    }
    const nodeConnection = registry.nodeConnectionsByNodeId.get(record.meta.nodeId);
    if (!nodeConnection) {
      app.log.warn({ sessionId, nodeId: record.meta.nodeId }, 'relay: owning node not connected');
      return;
    }
    sendDirect(nodeConnection, message);
  }

  /** True when `deviceId` (under `accountId`) currently has a live *client* connection — a node connection (the daemon side) never counts, only a PWA client "seeing it live" is what #163's presence check suppresses push for. */
  function hasLiveClientConnection(accountId: string, deviceId: string): boolean {
    for (const client of registry.clients) {
      if (client.accountId === accountId && client.deviceId === deviceId) return true;
    }
    return false;
  }

  /**
   * Presence-aware Web Push delivery (SPEC §7.11 "events go to the device
   * you are actively using, fall back to push on the others"; issues
   * #163/#170). Fires for every `PushPayload` kind visible to this blind
   * relay in cleartext-routable form: `'permission_required'` (from a real
   * `permission_request`) and, as of #170, `'awaiting_input'`/
   * `'session_outcome'` (from an `attention_hint`, mirroring that same
   * mechanism — see `push.ts`'s `PushPayload` doc comment for why CI/review
   * aren't reachable here yet). Never blocks/affects the live WS fan-out
   * this runs alongside; a delivery failure to one device's subscription is
   * logged and does not stop delivery to the account's other devices.
   */
  async function maybeSendAttentionPush(accountId: string, payload: PushPayload): Promise<void> {
    if (!pushSender || !opts.push) return;
    const subscriptions = await store.pushSubscriptions.listForAccount(accountId);
    for (const subscription of subscriptions) {
      // The device that's currently open/connected already sees this live
      // over the WS fan-out above — pushing to it too would just be a
      // redundant OS notification for something already on screen.
      if (hasLiveClientConnection(accountId, subscription.deviceId)) continue;
      try {
        const result = await pushSender.send(
          subscription,
          opts.push.vapidKeys,
          opts.push.subject,
          payload,
        );
        if (result.expired) {
          // The browser itself dropped this subscription (410/404) — self-clean
          // rather than keep trying it on every future attention event (#163).
          await store.pushSubscriptions.delete(accountId, subscription.deviceId);
        }
      } catch (error) {
        app.log.warn(
          { error, accountId, deviceId: subscription.deviceId, sessionId: payload.sessionId },
          'relay: push delivery failed',
        );
      }
    }
  }

  /** Closes every live connection registered under `deviceId`/`accountId`, e.g. on revoke (#112). */
  function closeConnectionsForDevice(deviceId: string, accountId: string): void {
    for (const node of registry.nodes) {
      if (node.deviceId === deviceId && node.accountId === accountId) {
        node.socket.close(4403, 'device revoked');
      }
    }
    for (const client of registry.clients) {
      if (client.deviceId === deviceId && client.accountId === accountId) {
        client.socket.close(4403, 'device revoked');
      }
    }
  }

  async function handleInitialize(
    socket: WsWebSocket,
    raw: string,
  ): Promise<Connection | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      app.log.warn('relay: dropped a non-JSON first frame');
      socket.close(4400, 'invalid frame');
      return undefined;
    }

    const candidate =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    if (candidate.type !== 'initialize') {
      app.log.warn({ type: candidate.type }, 'relay: first frame was not initialize');
      socket.close(4401, 'first frame must be initialize');
      return undefined;
    }

    const remoteVersion = candidate.protocolVersion;
    const negotiated = negotiateVersion(
      RELAY_SUPPORTED_VERSIONS,
      typeof remoteVersion === 'number' ? [remoteVersion] : [],
    );
    if (negotiated === null) {
      // #108: never silently drop an incompatible peer — tell it, then close.
      sendJson(socket, {
        type: 'update_required',
        message: `relay supports protocol version(s) ${RELAY_SUPPORTED_VERSIONS.join(', ')}`,
      });
      socket.close(4400, 'update required');
      return undefined;
    }

    const result = initialize.safeParse(parsed);
    if (!result.success) {
      app.log.warn({ issues: result.error.issues }, 'relay: invalid initialize payload');
      socket.close(4400, 'invalid initialize payload');
      return undefined;
    }
    const message = result.data;

    // #121: validate the bearer authToken (Better Auth-backed in production,
    // the dev/hermetic stub otherwise — see `resolveAccountId`'s construction
    // above) and reject/close on an invalid or absent token.
    const accountId = await resolveAccountId(message.authToken);
    if (!accountId) {
      app.log.warn('relay: rejected initialize with an invalid/absent auth token');
      socket.close(4401, 'invalid or missing auth token');
      return undefined;
    }

    const existingDevice = await store.devices.get(message.deviceId);
    if (existingDevice?.status === 'revoked') {
      socket.close(4403, 'device revoked');
      return undefined;
    }
    if (existingDevice && existingDevice.accountId !== accountId) {
      app.log.warn({ deviceId: message.deviceId }, 'relay: deviceId reused under another account');
      socket.close(4403, 'device/account mismatch');
      return undefined;
    }
    await store.devices.upsert({
      deviceId: message.deviceId,
      devicePublicKey: message.devicePublicKey,
      accountId,
    });

    const connection: Connection =
      message.role === 'node'
        ? {
            kind: 'node',
            socket,
            deviceId: message.deviceId,
            accountId,
            nodeIds: new Set(),
            buildIdentity: message.buildIdentity,
          }
        : {
            kind: 'client',
            socket,
            deviceId: message.deviceId,
            accountId,
            subscriptions: new Set(),
            outbox: new BoundedClientOutbox((item, done) => {
              sendJson(socket, item);
              done();
            }, maxClientQueueDepth),
            terminalOutboxes: new Map(),
            fanOutUnsubscribes: new Map(),
          };

    if (connection.kind === 'node') registry.nodes.add(connection);
    else registry.clients.add(connection);

    const initResult: InitializeResult = {
      type: 'initialize_result',
      protocolVersion: PROTOCOL_V1,
      negotiatedVersion: negotiated,
      capabilities: [...RELAY_CAPABILITIES],
      ...(relayBuildIdentity ? { buildIdentity: relayBuildIdentity } : {}),
    };
    sendDirect(connection, initResult);
    return connection;
  }

  async function handleDeviceMessage(
    connection: Connection,
    message: WireMessageV1,
  ): Promise<boolean> {
    switch (message.type) {
      // Issue #511. Answered on the socket it arrived on and never routed:
      // a peer built on the WHATWG `WebSocket` (the node's Node 22 global,
      // the browser's) cannot send a transport-level ping, so this is its
      // only way to tell a live relay from a half-open socket that will
      // never deliver another frame. Same for both roles, hence here rather
      // than in the node/client switches below.
      case 'ping': {
        const reply: Pong = { type: 'pong', protocolVersion: PROTOCOL_V1, nonce: message.nonce };
        sendDirect(connection, reply);
        return true;
      }
      case 'device_register':
        await store.devices.upsert({
          deviceId: message.deviceId,
          devicePublicKey: message.devicePublicKey,
          label: message.label,
          accountId: connection.accountId,
        });
        return true;
      case 'device_revoke': {
        const device = await store.devices.get(message.deviceId);
        if (!device || device.accountId !== connection.accountId) {
          app.log.warn({ deviceId: message.deviceId }, 'relay: revoke for unknown/foreign device');
          return true;
        }
        // #116: the acting device's `newEpoch` must be exactly one past the
        // account's current epoch — the relay's own defense against a
        // stale/duplicate/out-of-order revoke setting a wrong epoch. A
        // mismatch rejects the *whole* revoke (nothing below runs): the
        // device stays registered and no envelope is stored, rather than
        // silently accepting an inconsistent epoch number.
        const advanced = await store.amkRotation.advanceEpoch(
          connection.accountId,
          message.newEpoch,
        );
        if (!advanced) {
          app.log.warn(
            { accountId: connection.accountId, newEpoch: message.newEpoch },
            'relay: device_revoke newEpoch is not exactly one past the account current epoch; rejecting',
          );
          return true;
        }
        await store.devices.revoke(message.deviceId);
        // Wrap-fan-out delivery (SPEC §8): park each surviving device's own
        // rewrapped-AMK-epoch envelope for it to fetch on next connect
        // (`amk_epoch_fetch_request` below). Defensively skips any entry
        // that targets the revoked device itself or a device this account
        // doesn't actually own, rather than trusting the sender's list
        // wholesale.
        for (const entry of message.rewrappedAmk) {
          if (entry.deviceId === message.deviceId) {
            app.log.warn(
              { deviceId: entry.deviceId },
              'relay: device_revoke rewrappedAmk entry targets the revoked device itself; ignoring',
            );
            continue;
          }
          const survivor = await store.devices.get(entry.deviceId);
          if (!survivor || survivor.accountId !== connection.accountId) {
            app.log.warn(
              { deviceId: entry.deviceId },
              'relay: device_revoke rewrappedAmk entry targets an unknown/foreign device; ignoring',
            );
            continue;
          }
          await store.amkRotation.putPending(connection.accountId, entry.deviceId, {
            epoch: message.newEpoch,
            fromDeviceId: connection.deviceId,
            envelope: entry.envelope,
          });
        }
        closeConnectionsForDevice(message.deviceId, connection.accountId);
        return true;
      }
      case 'device_rotate': {
        const device = await store.devices.get(message.deviceId);
        if (!device || device.accountId !== connection.accountId) {
          app.log.warn({ deviceId: message.deviceId }, 'relay: rotate for unknown/foreign device');
          return true;
        }
        await store.devices.rotate(message.deviceId, message.newDevicePublicKey);
        return true;
      }
      case 'amk_escrow':
        // SPEC §8 path 2 "recovery-code escrow": the relay only ever stores
        // this as an opaque base64 blob (`@loombox/crypto`'s
        // `packWrappedAmkForWire` output) — it never parses, decrypts, or
        // otherwise learns anything from it. Scoped to `connection.accountId`
        // (the OAuth-authenticated account from this connection's own
        // `initialize` handshake), never a client-supplied account id.
        await store.escrow.put(connection.accountId, message.wrappedAmk);
        return true;
      case 'new_device_bootstrap_request': {
        // A new device, having proven identity via OAuth alone (this
        // connection's own handshake), asks for its account's escrowed
        // wrapped-AMK blob. Scoped to `connection.accountId` exactly like
        // `amk_escrow` above — a device can only ever fetch its own
        // account's blob, never another account's.
        const wrappedAmk = await store.escrow.get(connection.accountId);
        if (!wrappedAmk) {
          app.log.warn(
            { accountId: connection.accountId },
            'relay: new_device_bootstrap_request but this account has never escrowed an AMK',
          );
          return true;
        }
        const response: NewDeviceBootstrapResponse = {
          type: 'new_device_bootstrap_response',
          protocolVersion: PROTOCOL_V1,
          wrappedAmk,
        };
        sendDirect(connection, response);
        return true;
      }
      case 'amk_epoch_fetch_request': {
        // #116: a surviving device, on reconnect, asks whether the relay is
        // holding a rewrapped-AMK-epoch envelope for it. Always answered for
        // *this connection's own* authenticated deviceId — `message.deviceId`
        // is never trusted for the actual lookup (only logged if it disagrees,
        // e.g. a stale client), so a spoofed `deviceId` in the request body
        // can never fetch another device's envelope. Still always replies
        // (never silently drops), since this is a request/response pair a
        // caller waits on, exactly like `new_device_bootstrap_request` above.
        if (message.deviceId !== connection.deviceId) {
          app.log.warn(
            { deviceId: message.deviceId, connectionDeviceId: connection.deviceId },
            "relay: amk_epoch_fetch_request deviceId does not match the requesting connection; answering for the connection's own device instead",
          );
        }
        const pending = await store.amkRotation.getPending(
          connection.accountId,
          connection.deviceId,
        );
        let responsePending: AmkEpochFetchResponse['pending'];
        if (pending) {
          // `fromDevicePublicKey` is looked up fresh from the device
          // registry here, never trusted from whatever the original
          // `device_revoke` sender claimed — the acting device's current
          // registered public key is the only one `unwrapAmkEpochForDevice`
          // can actually derive the right ECDH shared secret against.
          const fromDevice = await store.devices.get(pending.fromDeviceId);
          if (fromDevice && fromDevice.accountId === connection.accountId) {
            responsePending = {
              epoch: pending.epoch,
              fromDeviceId: pending.fromDeviceId,
              fromDevicePublicKey: fromDevice.devicePublicKey,
              envelope: pending.envelope,
            };
          } else {
            app.log.warn(
              { deviceId: connection.deviceId, fromDeviceId: pending.fromDeviceId },
              'relay: amk_epoch_fetch_request has a pending envelope whose wrapping device is no longer known; withholding',
            );
          }
        }
        const response: AmkEpochFetchResponse = {
          type: 'amk_epoch_fetch_response',
          protocolVersion: PROTOCOL_V1,
          deviceId: connection.deviceId,
          pending: responsePending,
        };
        sendDirect(connection, response);
        return true;
      }
      case 'new_device_bootstrap_response':
      case 'qr_pairing_request':
      case 'qr_pairing_response':
      case 'amk_epoch_fetch_response':
        // `new_device_bootstrap_response`/`amk_epoch_fetch_response` are only
        // ever relay->client (this relay's own replies above); QR pairing
        // (#113) is deliberately device-to-device over an out-of-band
        // channel with "no relay unwrap" (SPEC §8 path 1) and never needs
        // relay-side wiring at all. None of these are messages this relay
        // legitimately receives.
        app.log.warn({ type: message.type }, 'relay: unexpected inbound device-pairing message');
        return true;
      default:
        return false;
    }
  }

  // Serving an opaque blob back to the requester. Used by BOTH a client
  // (fetching an attachment the executing host produced) and a node/executing
  // host (fetching an attachment a client uploaded — #156): the relay stays
  // blind, it only matches the ciphertext blob to the requester's own account.
  async function handleBlobDownload(
    connection: Connection,
    message: Extract<WireMessageV1, { type: 'blob_download' }>,
  ): Promise<void> {
    const record = await store.sessions.get(message.sessionId);
    if (!record || record.meta.accountId !== connection.accountId) {
      app.log.warn(
        { sessionId: message.sessionId },
        'relay: blob_download for unknown/foreign session',
      );
      return;
    }
    const envelope = await store.blobs.download(`${message.sessionId}:${message.ref}`);
    if (!envelope) {
      app.log.warn({ sessionId: message.sessionId, ref: message.ref }, 'relay: blob not found');
      return;
    }
    const response: BlobDownloadResponse = {
      type: 'blob_download_response',
      protocolVersion: PROTOCOL_V1,
      sessionId: message.sessionId,
      ref: message.ref,
      envelope,
    };
    sendDirect(connection, response);
  }

  /** Clamps a `lease_request`'s optional `ttlMs` into `[1, maxLeaseTtlMs]`, defaulting to `defaultLeaseTtlMs` when omitted (issues #82/#104) — the relay is always the final authority on how long a grant actually lasts. */
  function resolveLeaseTtlMs(requested: number | undefined): number {
    const base = requested ?? defaultLeaseTtlMs;
    return Math.min(Math.max(base, 1), maxLeaseTtlMs);
  }

  /**
   * Session-ownership leasing (SPEC §9; issues #82/#104): a node acquires or
   * renews a session's lease, arbitrated by `store.leases` account-scoped to
   * this connection's own `accountId` (never a client-supplied one, exactly
   * like every other store lookup in this file). Always replies — a caller
   * is waiting on `requestId` — whether granted or denied.
   */
  async function handleLeaseRequest(
    connection: NodeConnection,
    message: Extract<WireMessageV1, { type: 'lease_request' }>,
  ): Promise<void> {
    const ttlMs = resolveLeaseTtlMs(message.ttlMs);
    const now = Date.now();
    const outcome =
      message.action === 'acquire'
        ? await store.leases.acquire(
            connection.accountId,
            message.sessionId,
            message.nodeId,
            ttlMs,
            now,
          )
        : await store.leases.renew(
            connection.accountId,
            message.sessionId,
            message.nodeId,
            ttlMs,
            now,
          );
    const response: LeaseResult = {
      type: 'lease_result',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      result: outcome.granted
        ? { outcome: 'granted', expiresAt: outcome.lease.expiresAt }
        : { outcome: 'denied', heldBy: outcome.heldBy, expiresAt: outcome.expiresAt },
    };
    sendDirect(connection, response);
  }

  /** A node deliberately releasing a lease it holds (session stop, node exit — SPEC §9). Account-scoped exactly like `handleLeaseRequest`. */
  async function handleLeaseRelease(
    connection: NodeConnection,
    message: Extract<WireMessageV1, { type: 'lease_release' }>,
  ): Promise<void> {
    const released = await store.leases.release(
      connection.accountId,
      message.sessionId,
      message.nodeId,
    );
    const response: LeaseReleaseResult = {
      type: 'lease_release_result',
      protocolVersion: PROTOCOL_V1,
      requestId: message.requestId,
      sessionId: message.sessionId,
      released,
    };
    sendDirect(connection, response);
  }

  async function handleNodeMessage(
    connection: NodeConnection,
    message: WireMessageV1,
  ): Promise<void> {
    if (await handleDeviceMessage(connection, message)) return;

    switch (message.type) {
      case 'target_announce': {
        store.targets.announce(message.nodeId, connection.accountId, message.targets);
        connection.nodeIds.add(message.nodeId);
        registry.nodeConnectionsByNodeId.set(message.nodeId, connection);
        return;
      }
      case 'target_status': {
        // Issues #253/#269: no account check needed here beyond what
        // `TargetStore.updateHealth` itself enforces (a sample is only ever
        // recorded for a targetId this nodeId has actually announced) —
        // mirrors `target_announce`'s own trust model just above.
        store.targets.updateHealth(message.nodeId, message.samples);
        return;
      }
      case 'session_announce': {
        if (message.session.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.session.id },
            'relay: session_announce account mismatch',
          );
          return;
        }
        await store.sessions.announce({
          meta: message.session,
          privateEnvelope: message.privateEnvelope,
        });
        connection.nodeIds.add(message.session.nodeId);
        registry.nodeConnectionsByNodeId.set(message.session.nodeId, connection);
        return;
      }
      case 'connected_account_announce': {
        // SPEC §7.26, issue #221: node-only, exactly like `target_announce`/
        // `session_announce` above — `store.connectedAccounts.upsert` scopes
        // by this already-authenticated connection's own `accountId`, never
        // a value trusted out of the message (the wire `ConnectedAccount`
        // type has no such field to trust in the first place).
        await store.connectedAccounts.upsert(connection.accountId, message.account);
        return;
      }
      case 'session_update': {
        const record = await store.sessions.get(message.sessionId);
        if (!record) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: session_update for unknown session',
          );
          return;
        }
        const seq = await store.sessions.nextSeq(message.sessionId);
        const finalized: SessionUpdateEnvelopeV1 = { ...message, seq };
        // #101: an over-quota account still gets its update fanned out live
        // (the relay's real-time delivery promise isn't gated on storage
        // headroom) — only the resync-ring *durability* of this update is
        // skipped, and the node is told so, since a client that reconnects
        // and asks to resync past this seq will not get it replayed.
        if (await hasQuotaFor(record.meta.accountId, envelopeByteSize(message.envelope))) {
          await store.sessions.pushRingEntry(
            message.sessionId,
            { seq, envelope: message.envelope },
            record.meta.accountId,
          );
        } else {
          app.log.warn(
            { accountId: record.meta.accountId, sessionId: message.sessionId, seq },
            'relay: ring entry not buffered for resync, account storage quota exceeded',
          );
          sendJson(connection.socket, {
            type: 'quota_exceeded',
            scope: 'session_update',
            sessionId: message.sessionId,
            seq,
          });
        }
        fanOutSessionUpdate(message.sessionId, finalized);
        return;
      }
      case 'session_archive_response': {
        // #512: the owning node's reply to a client's session_archive_request.
        // On success the session is actually gone — delete it from the
        // store BEFORE publishing, so no client can race a fresh
        // session_resume against a row every device is about to be told
        // no longer exists.
        if (message.result.outcome === 'ok') {
          await store.sessions.deleteSession(message.sessionId);
          await store.sessionViewStates.delete(message.sessionId);
        }
        // Published to every client of the account, not only the
        // requester — exactly like presence's own account-wide client
        // loop below (`handleClientMessage`): a second device holding the
        // same board must drop the row too, or it keeps one pointing at a
        // session that's already gone. There is no per-session subscriber
        // list to fan this through (the session may no longer exist by
        // the time this runs), hence the direct account-wide loop rather
        // than `fanOutDirect`.
        for (const client of registry.clients) {
          if (client.accountId === connection.accountId) sendDirect(client, message);
        }
        return;
      }
      case 'session_fork_response': {
        // #746 (design spec `2026-08-05-zed-parity-decisions.md` §3's
        // C6-2): the owning node's reply to a client's
        // session_fork_request, matched back by requestId. Broadcast
        // account-wide exactly like session_archive_response above — the
        // new session itself (on outcome 'ok') already reached every
        // device the ordinary way via session_announce, this only settles
        // whichever device's pending fork promise is waiting on
        // requestId.
        for (const client of registry.clients) {
          if (client.accountId === connection.accountId) sendDirect(client, message);
        }
        return;
      }
      case 'permission_request':
        fanOutDirect(message.sessionId, message);
        // #163: presence-aware push — a tool call awaiting approval is one
        // of SPEC §7.11/§7.13's attention-worthy events, and `connection`
        // (the announcing node) always belongs to the same account the
        // session itself is scoped to.
        await maybeSendAttentionPush(connection.accountId, {
          kind: 'permission_required',
          sessionId: message.sessionId,
        });
        return;
      case 'attention_hint':
        // #170: the metadata-only mirror of the permission_request push
        // trigger above, for the two other attention-inbox classes that
        // have a live source at v1 (SPEC §7.13) — `awaiting_input` and
        // `session_outcome` (finished/errored). This message carries
        // nothing else: no `fanOutDirect` here, unlike `permission_request`,
        // because a client never needs to render this hint itself — it
        // already gets the real `session_status` transition, encrypted,
        // over the ordinary `session_update` fan-out this rides alongside.
        // This message exists solely to give the relay a trigger to push
        // on without ever decrypting that session_update.
        await maybeSendAttentionPush(connection.accountId, {
          kind: message.class,
          sessionId: message.sessionId,
        });
        return;
      case 'blob_ref':
        fanOutDirect(message.sessionId, message);
        return;
      case 'blob_download':
        // The executing host fetching an attachment blob a client uploaded (#156).
        await handleBlobDownload(connection, message);
        return;
      case 'fs_list_response':
        // The owning node's reply to a client's fs_list_request (SPEC §7.4;
        // issue #171/#160) — fanned out to this session's subscribed
        // clients exactly like blob_ref/permission_request above; the
        // relay never opens the envelope, so it never learns the path or
        // directory contents (SPEC §8's metadata boundary). A requesting
        // client matches its own pending request by `requestId`; any other
        // subscribed client simply has no pending request with that id.
        fanOutDirect(message.sessionId, message);
        return;
      case 'mcp_prompt_get_response':
      case 'fs_read_response':
      case 'fs_write_response':
      case 'git_diff_response':
      case 'git_graph_response':
      case 'git_hunk_diff_response':
      case 'git_hunk_action_response':
      case 'agent_instructions_get_response':
      case 'agent_instructions_set_response':
      case 'git_commit_draft_response':
      case 'git_commit_response':
      case 'git_diff_explain_response':
        // The owning node's reply to a client's mcp_prompt_get_request
        // (Zed-parity D5-2; issue #754), fs_read_request (issue #737's
        // read-only file viewer), git_diff_request (issue #206's
        // working-tree diff viewer), git_hunk_diff_request/
        // git_hunk_action_request (issue #232's hunk-level stage/
        // unstage/discard), or agent_instructions_get_request/
        // agent_instructions_set_request (SPEC §7.18's per-project
        // AGENTS.md/CLAUDE.md surface; issue #260) — fanned out to this
        // session's subscribed clients exactly like fs_list_response
        // above; the relay never opens the envelope, so it never learns
        // which server/prompt/rendered text, file content, changed-file
        // diff, hunk breakdown, stage/unstage/discard outcome, or
        // instructions-file content/hash, only that something was read
        // or applied (SPEC §8's metadata boundary). A requesting client
        // matches its own pending request by `requestId`; any other
        // subscribed client simply has no pending request with that id.
        // unstage/discard), or git_commit_draft_request/git_commit_request
        // (issue #233's commit workflow) — fanned out to this session's
        // subscribed clients exactly like fs_list_response above; the
        // relay never opens the envelope, so it never learns which
        // server/prompt/rendered text, file content, changed-file diff,
        // hunk breakdown, drafted commit message, or commit outcome, only
        // that something was read or applied (SPEC §8's metadata
        // boundary). A requesting client matches its own pending request
        // by `requestId`; any other subscribed client simply has no
        // pending request with that id.
        // git_diff_explain_request/git_diff_explain_response (issue #236's
        // "explain a diff or a hunk" AI assist, `git_commit_draft_request`'s
        // own sibling for understanding a diff rather than drafting text
        // from one) fan out exactly the same way: the relay never learns
        // which file/hunk was addressed or what the agent's explanation
        // said.
        fanOutDirect(message.sessionId, message);
        return;
      case 'git_branch_list_response':
      case 'git_branch_create_response':
      case 'git_branch_switch_response':
      case 'git_branch_merge_response':
      case 'git_branch_merge_abort_response':
      case 'git_stash_save_response':
      case 'git_stash_list_response':
      case 'git_stash_pop_response':
      case 'git_stash_drop_response':
      case 'git_push_response':
        // The owning node's reply to a client's git_branch_list_request/
        // git_branch_create_request/git_branch_switch_request/
        // git_branch_merge_request/git_branch_merge_abort_request or
        // git_stash_save_request/git_stash_list_request/
        // git_stash_pop_request/git_stash_drop_request (SPEC §7.6; issue
        // #234's branch create/switch/merge and stash save/pop) — fanned
        // out to this session's subscribed clients exactly like
        // git_hunk_action_response above; the relay never opens the
        // envelope, so it never learns which branch, stash message, or
        // conflicted path was involved, only that something was asked
        // (SPEC §8's metadata boundary). A requesting client matches its
        // own pending request by `requestId`; any other subscribed
        // client simply has no pending request with that id.
        fanOutDirect(message.sessionId, message);
        return;
      case 'config_option_result':
        // The owning node's reply to a client's config_option (SPEC §7.24;
        // issue #718) — fanned out to this session's subscribed clients
        // exactly like fs_list_response above; the relay never opens
        // anything here (this reply travels clear, not an envelope — see
        // that schema's own doc comment) but still never targets the
        // requester alone, matching every other session-scoped node reply.
        // A client matches its own pending request by `category`; any
        // other subscribed client simply has no pending request for it.
        fanOutDirect(message.sessionId, message);
        return;
      case 'prompt_inject_result':
        // The owning node's reply to a client's prompt_inject (issue
        // #706) — fanned out to this session's subscribed clients exactly
        // like config_option_result above; the relay never opens anything
        // here (clear, not an envelope). A client matches its own
        // pending request by `promptId`; any other subscribed client
        // simply has no pending request for it.
        fanOutDirect(message.sessionId, message);
        return;
      case 'terminal_opened':
      case 'terminal_closed':
        // The owning node's terminal open reply/close notification (SPEC
        // §7.5; issues #172/#173/#174) — fanned out exactly like
        // fs_list_response above; the relay never opens either envelope,
        // so it never sees the negotiated cols/rows or the close reason
        // (SPEC §8's metadata boundary). Low-volume (once per open/close),
        // unlike `terminal_output` below, so the direct path is correct
        // here: `fanOutDirect` never drops a control message a client is
        // actively waiting on a reply for.
        fanOutDirect(message.sessionId, message);
        return;
      case 'terminal_output':
        // One chunk of an open terminal's byte stream (SPEC §7.5) — unlike
        // `terminal_opened`/`terminal_closed` above, this can arrive far
        // faster than a slow client drains its own socket (a build log
        // scrolling past, `find /`), so it rides its own bounded,
        // drop-oldest `BoundedTerminalOutbox` (SPEC §7.16; issue #207)
        // rather than the unbounded `fanOutDirect` path every other
        // node-pushed reply uses — see `terminal-outbox.ts`'s doc comment.
        // The relay never opens this envelope either; only `seq` (plain
        // routing metadata, never content) is visible to it.
        fanOutTerminalOutput(message.sessionId, message);
        return;
      case 'test_runner_config_result':
      case 'test_runner_config_detected':
        // The owning node's reply to a client's test_runner_config_get/
        // _set/_detect (SPEC §7.15; issue #245) — fanned out exactly like
        // fs_list_response above; the relay never opens either envelope,
        // so it never sees a configured or suggested command string
        // (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'checkpoint_result':
      case 'checkpoint_list_result':
      case 'checkpoint_restore_preview_result':
      case 'checkpoint_restore_result':
        // The owning node's reply to a client's checkpoint_create/_list/
        // _restore_preview/_restore (SPEC §7.20; issue #603) — fanned out
        // exactly like permission_policy_result above; the relay never
        // opens any of these envelopes, so it never sees a checkpoint's
        // label, which commits sit between it and HEAD, or what a
        // restore actually discarded (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'session_rewind_preview_result':
      case 'session_rewind_result':
        // The owning node's reply to a client's session_rewind_preview/
        // session_rewind (design spec `2026-08-05-zed-parity-decisions.md`
        // §3's C6-3; issue #747) — fanned out exactly like
        // checkpoint_restore_result above; the relay never opens either
        // envelope, so it never sees which files or turns a rewind put at
        // risk, or what it actually discarded (SPEC §8's metadata
        // boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'permission_policy_result':
        // The owning node's reply to a client's permission_policy_get/_set
        // (SPEC §7.17; issue #751) — fanned out exactly like
        // test_runner_config_result above; the relay never opens the
        // envelope, so it never sees a project's actual glob rules
        // (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'spend_cap_result':
        // The owning node's reply to a client's spend_cap_get/_set (SPEC
        // §7.16; issue #251) — fanned out exactly like
        // permission_policy_result above; the relay never opens the
        // envelope, so it never sees a project's or session's actual
        // dollar-figure cap (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'permission_policy_violation':
        // The owning node reporting a live policy denial (SPEC §7.17;
        // issue #751) — fanned out exactly like terminal_output; the
        // relay never opens the envelope, so it never sees which rule or
        // command was involved.
        fanOutDirect(message.sessionId, message);
        return;
      case 'pr_open_preview_result':
      case 'pr_open_result':
      case 'pr_merge_result':
        // The owning node's reply to a client's pr_open_preview_request/
        // pr_open_request (SPEC §7.14; issue #238) — fanned out exactly
        // like permission_policy_result above; the relay never opens
        // either envelope, so it never sees a branch name, commit count,
        // PR title/body, or the created PR's URL (SPEC §8's metadata
        // boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'agent_profile_list_result':
      case 'agent_profile_session_result':
        // The owning node's reply to a client's agent_profile_list_get/
        // _set or agent_profile_session_get/_set (design spec
        // `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752) —
        // fanned out exactly like permission_policy_result above; the
        // relay never opens the envelope, so it never sees a profile's
        // name or rules.
        fanOutDirect(message.sessionId, message);
        return;
      case 'snippet_list_result':
        // The owning node's reply to a client's snippet_list_get/_set
        // (SPEC §7.18; issue #261) — fanned out exactly like
        // agent_profile_list_result above; the relay never opens the
        // envelope, so it never sees a saved prompt's name or text.
        fanOutDirect(message.sessionId, message);
        return;
      case 'run_started':
      case 'run_output':
      case 'run_exit':
        // The owning node's reply to a client's run_start, streamed run
        // output, and a run's terminal state (SPEC §7.15; issue #244) —
        // fanned out exactly like terminal_opened/terminal_output/
        // terminal_closed above; the relay never opens any of these
        // envelopes, so it never sees which of test/lint/build ran, a
        // byte of its output, or its pass/fail/could-not-start outcome
        // (SPEC §8's metadata boundary).
        fanOutDirect(message.sessionId, message);
        return;
      case 'ci_check_status':
        // The owning node's periodic CI check-run reading for a session
        // whose branch has an open PR (SPEC §7.14; issue #239) — fanned
        // out exactly like run_output/pr_open_result above; the relay
        // never opens the envelope, so it never sees a check's name,
        // conclusion, or failure output.
        fanOutDirect(message.sessionId, message);
        return;
      case 'review_comment_status':
        // The owning node's periodic review-thread reading for a
        // session's open pull request (SPEC §7.14; issue #240) — fanned
        // out exactly like ci_check_status above; the relay never opens
        // the envelope, so it never sees a review comment's own body,
        // author, or file/line.
        fanOutDirect(message.sessionId, message);
        return;
      case 'tracker_connectivity_status':
        // The owning node's periodic live-tracker reachability reading for
        // a session's project (SPEC §7.10; issue #219) — fanned out
        // exactly like ci_check_status above; the relay never opens the
        // envelope, so it never sees which provider or why a poll failed.
        fanOutDirect(message.sessionId, message);
        return;
      case 'ci_auto_iterate_status':
        // The owning node's current auto-iterate-until-green loop state
        // for a session (SPEC §7.14/§7.15; issue #246) — fanned out
        // exactly like ci_check_status above; the relay never opens the
        // envelope, so it never sees an attempt's commit sha or why the
        // loop stopped.
        fanOutDirect(message.sessionId, message);
        return;
      case 'run_status':
        // The owning node's latest durable per-kind run status for a
        // session (SPEC §7.14/§7.15; issue #247) — fanned out exactly
        // like ci_check_status/run_exit above; the relay never opens the
        // envelope, so it never sees which kind ran, its outcome, or why.
        fanOutDirect(message.sessionId, message);
        return;
      case 'lease_request':
        // SPEC §9; issues #82/#104: a session is owned by a node, never a
        // client — only a node connection ever sends this.
        await handleLeaseRequest(connection, message);
        return;
      case 'lease_release':
        await handleLeaseRelease(connection, message);
        return;
      case 'provision_progress': {
        // #410: streamed back to the requesting client only, via the
        // per-requestId routing table populated in
        // `provision_target_request` above — never fanned out account-wide.
        // Account-scoped like every lookup in this file: a requestId whose
        // owning client belongs to a different account than this replying
        // node is treated the same as an unknown requestId.
        const pending = pendingProvisionRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: provision_progress for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        return;
      }
      case 'provision_target_result': {
        // The sequence's terminal message (success or the step it failed
        // at) — delivered exactly like provision_progress above, then the
        // routing entry is retired: this requestId is done either way.
        const pending = pendingProvisionRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: provision_target_result for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingProvisionRequest(message.requestId);
        return;
      }
      case 'target_fs_list_response': {
        // #474's directory picker: a single-shot reply, delivered directly
        // to the requesting client and then retired — via the same
        // per-requestId routing table `target_fs_list_request` populates
        // below, exactly like `provision_target_result` above (there is no
        // session to fan this out through, unlike `fs_list_response`).
        // Account-scoped the same way: a requestId whose owning client
        // belongs to a different account than this replying node is treated
        // the same as an unknown requestId.
        const pending = pendingTargetFsListRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: target_fs_list_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingTargetFsListRequest(message.requestId);
        return;
      }
      case 'custom_agent_probe_response': {
        // Issue #748: a single-shot reply, delivered directly to the
        // requesting client and then retired — same shape as
        // `target_fs_list_response` above, via `pendingCustomAgentProbeRequests`.
        const pending = pendingCustomAgentProbeRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: custom_agent_probe_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingCustomAgentProbeRequest(message.requestId);
        return;
      }
      case 'session_template_list_result': {
        // Issue #259: a single-shot reply, delivered directly to the
        // requesting client and then retired — same shape as
        // `custom_agent_probe_response` above, via
        // `pendingSessionTemplateListRequests`.
        const pending = pendingSessionTemplateListRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: session_template_list_result for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingSessionTemplateListRequest(message.requestId);
        return;
      }
      case 'ssh_discovery_response': {
        // #475's add-target wizard: a single-shot reply, delivered directly
        // to the requesting client and then retired — via the same
        // per-requestId routing table `ssh_discovery_request` populates
        // below, exactly like `target_fs_list_response` above. Account-
        // scoped the same way: a requestId whose owning client belongs to a
        // different account than this replying node is treated the same as
        // an unknown requestId.
        const pending = pendingSshDiscoveryRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: ssh_discovery_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingSshDiscoveryRequest(message.requestId);
        return;
      }
      case 'decommission_target_response': {
        // #476's Remove/Edit actions: a single-shot reply, delivered
        // directly to the requesting client and then retired — via the
        // same per-requestId routing table `decommission_target_request`
        // populates below, exactly like `ssh_discovery_response` above.
        // Account-scoped the same way: a requestId whose owning client
        // belongs to a different account than this replying node is
        // treated the same as an unknown requestId.
        const pending = pendingDecommissionTargetRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: decommission_target_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingDecommissionTargetRequest(message.requestId);
        return;
      }
      case 'target_update_response': {
        // #476's Update action: same single-shot reply/routing-table shape
        // as `decommission_target_response` above.
        const pending = pendingTargetUpdateRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: target_update_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingTargetUpdateRequest(message.requestId);
        return;
      }
      case 'node_self_update_status': {
        // Issue #656: an unprompted push, never a reply — stored on the
        // live connection exactly like `buildIdentity` at handshake time
        // (`handleInitialize`), except this one can legitimately arrive
        // again later on the SAME connection (a node's own version is
        // static for its process lifetime, but "is there a newer one"
        // keeps getting re-checked while it stays connected). Read back at
        // `target_list_request` time, mirrored onto every target row this
        // node owns, exactly like `buildIdentity`/`build`.
        connection.selfUpdate = {
          status: message.status,
          currentVersion: message.currentVersion,
          ...(message.latestVersion ? { latestVersion: message.latestVersion } : {}),
          checkedAt: message.checkedAt,
        };
        // ALSO broadcast account-wide, live — exactly like
        // `session_archive_response`/`session_fork_response`'s own
        // account-wide client loop above: "detecting an update costs the
        // user nothing and needs no confirmation" (this module's own doc
        // comment) means a client watching the node row should see it the
        // moment it's known, not wait for its next `target_list_request`
        // poll — the stored `connection.selfUpdate` above is only the
        // fallback for a client that queries later (a fresh page load, a
        // second device that wasn't connected yet).
        for (const client of registry.clients) {
          if (client.accountId === connection.accountId) sendDirect(client, message);
        }
        return;
      }
      case 'node_self_update_apply_response': {
        // Issue #656: same single-shot reply/routing-table shape as
        // `target_update_response` above.
        const pending = pendingNodeSelfUpdateApplyRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: node_self_update_apply_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingNodeSelfUpdateApplyRequest(message.requestId);
        return;
      }
      case 'github_connect_device_code': {
        // #230: streamed once ahead of the terminal `github_connect_result`
        // — delivered to the requesting client, routing entry kept (not
        // retired), exactly like `provision_progress` above.
        const pending = pendingAccountRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: github_connect_device_code for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        return;
      }
      case 'github_connect_result':
      case 'jira_connect_response':
      case 'github_cli_import_response':
      case 'account_pin_response':
      case 'account_pin_resolve_response':
      case 'account_pin_scan_response':
      case 'tracker_mode_response':
      case 'tracker_snapshot_response':
      case 'tracker_write_response':
      case 'spend_report_response': {
        // #230/#631/#697: every other single-shot connect/pin/tracker-mode/
        // tracker-record reply — delivered to the requesting client and the
        // routing entry retired, exactly like `target_update_response` above.
        const pending = pendingAccountRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId, type: message.type },
            'relay: connected-account reply for an unknown/expired/foreign requestId',
          );
          return;
        }
        sendDirect(pending.clientConnection, message);
        clearPendingAccountRequest(message.requestId);
        return;
      }
      case 'connected_account_disconnect_response': {
        // #230: same single-shot routing as above, plus (on success) the
        // relay-side half of disconnecting — forgetting the synced
        // metadata row; the node already deleted its local keyring entry
        // before sending this (`github-connect.ts`/`jira-connect.ts`'s own
        // `deleteAccessToken`/`deleteCredential`).
        const pending = pendingAccountRequests.get(message.requestId);
        if (!pending || pending.clientConnection.accountId !== connection.accountId) {
          app.log.warn(
            { requestId: message.requestId },
            'relay: connected_account_disconnect_response for an unknown/expired/foreign requestId',
          );
          return;
        }
        if (message.outcome === 'ok') {
          await store.connectedAccounts.remove(connection.accountId, message.accountId);
        }
        sendDirect(pending.clientConnection, message);
        clearPendingAccountRequest(message.requestId);
        return;
      }
      case 'connected_account_list_request': {
        // SPEC §7.26, issue #631: the node-side counterpart of the client
        // case below — same account-scoped read (`@loombox/node`'s
        // `resolveTrackerBackend` is the first caller, on handshake), so
        // both dispatch through the identical `sendConnectedAccountList`.
        await sendConnectedAccountList(connection);
        return;
      }
      default:
        // #691: a `WireMessageV1` member this relay is not equipped to handle
        // from a node — either genuinely unrouted (see `message-routing.ts`'s
        // `MESSAGE_ROUTES`, kept exhaustive at the type level) or a peer
        // sending something client-only/relay-outbound-only. Either way this
        // is always a bug, never routine traffic, so it logs at `error` (not
        // `warn`) rather than being easy to miss in production logs.
        app.log.error({ type: message.type }, 'relay: unexpected message from a node connection');
    }
  }

  async function handleClientMessage(
    connection: ClientConnection,
    message: WireMessageV1,
  ): Promise<void> {
    if (await handleDeviceMessage(connection, message)) return;

    switch (message.type) {
      case 'target_list_request': {
        // #383: account-scoped, exactly like session_list_request below —
        // `store.targets.listForAccount` only ever returns nodes whose
        // announcing connection's `accountId` matched this account, so one
        // account can never see another's nodes/targets. `reachable` is
        // true only while that nodeId still has a live relay connection
        // (`registry.nodeConnectionsByNodeId`); a node that announced then
        // disconnected still shows up (so a client can see it existed) but
        // as unreachable. `build` (issue #655) is that same live
        // connection's own `buildIdentity` — absent for exactly the same
        // two reasons `reachable` can be false/health can be missing: no
        // live connection, or a node that predates the field.
        const perNode = store.targets.listForAccount(connection.accountId);
        const targets: TargetListEntry[] = [];
        for (const { nodeId, targets: nodeTargets } of perNode) {
          const nodeConnection = registry.nodeConnectionsByNodeId.get(nodeId);
          const reachable = nodeConnection !== undefined;
          for (const target of nodeTargets) {
            // Issues #253/#269: the latest `target_status` sample for this
            // target, if any has arrived yet — `undefined` for a node that
            // predates resource sampling or hasn't completed its first tick.
            const health = store.targets.healthForTarget(nodeId, target.id);
            targets.push({
              nodeId,
              targetId: target.id,
              label: target.label,
              kind: target.kind,
              reachable,
              providers: target.providers,
              ...(health ? { health } : {}),
              ...(nodeConnection?.buildIdentity ? { build: nodeConnection.buildIdentity } : {}),
              ...(nodeConnection?.selfUpdate ? { selfUpdate: nodeConnection.selfUpdate } : {}),
              // Issue #255: forwarded verbatim from the node's own
              // `target_announce`, exactly like `providers` above — absent
              // for a node that predates it.
              ...(target.maxConcurrentSessions !== undefined
                ? {
                    maxConcurrentSessions: target.maxConcurrentSessions,
                    maxConcurrentSessionsSource: target.maxConcurrentSessionsSource,
                  }
                : {}),
            });
          }
        }
        const response: TargetList = {
          type: 'target_list',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          targets,
        };
        sendDirect(connection, response);
        return;
      }
      case 'session_list_request': {
        const records = await store.sessions.listForAccount(connection.accountId);
        const sessions = records.map((record) => ({
          session: record.meta,
          privateEnvelope: record.privateEnvelope,
        }));
        const response: SessionListV1 = {
          type: 'session_list',
          protocolVersion: PROTOCOL_V1,
          sessions,
        };
        sendDirect(connection, response);
        return;
      }
      case 'connected_account_list_request': {
        // SPEC §7.26, issue #221: account-scoped, exactly like
        // `session_list_request` above — never another account's rows, and
        // never a token (the store only ever holds `ConnectedAccount`s,
        // which have no token field to leak in the first place).
        await sendConnectedAccountList(connection);
        return;
      }
      case 'keymap_get_request': {
        // Zed-parity F3-3, issue #760: account-scoped, no node/session/
        // project involved at all — sent proactively on every fresh
        // connection (`RelayClient`'s handshake handler) so a brand-new
        // device sees the current keymap the instant it signs in.
        // `envelope: null` (never an error) is "this account has never
        // saved one yet"; every action still uses its built-in default.
        const envelope = await store.keymaps.get(connection.accountId);
        const response: KeymapResult = {
          type: 'keymap_result',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          envelope: envelope ?? null,
        };
        sendDirect(connection, response);
        return;
      }
      case 'keymap_set_request': {
        // Fully replaces any previously saved keymap (never a partial
        // patch, same whole-document contract `permission_policy_set`
        // follows) — the relay never inspects `message.envelope`, only
        // `apps/web/src/lib/keymap.ts`'s client-side `validateKeymapCandidate`
        // checked it against the live registry before this was ever sent.
        await store.keymaps.set(connection.accountId, message.envelope);
        const response: KeymapResult = {
          type: 'keymap_result',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          envelope: message.envelope,
        };
        sendDirect(connection, response);
        // Issue #760's "a merge story for the same account editing from
        // two tabs": last full write wins here at the relay, but every
        // OTHER live connection on this same account is pushed the
        // winning state immediately too, so a losing tab's UI corrects
        // itself instead of silently drifting stale — mirrors
        // `hasLiveClientConnection`'s own `registry.clients` scan above.
        for (const client of registry.clients) {
          if (client.accountId === connection.accountId && client !== connection) {
            sendDirect(client, response);
          }
        }
        return;
      }
      case 'session_view_state_get_request': {
        // Same ownership guard `session_resume` below applies — a session
        // view state is never readable by anyone but its own session's
        // account, and there is no view state at all for a session that
        // doesn't exist (or was archived out from under a stale request).
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: view-state request for unknown/foreign session',
          );
          return;
        }
        const saved = await store.sessionViewStates.get(message.sessionId);
        const response: SessionViewStateResult = {
          type: 'session_view_state_result',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          sessionId: message.sessionId,
          envelope: saved?.envelope ?? null,
          revision: saved?.revision ?? 0,
        };
        sendDirect(connection, response);
        return;
      }
      case 'session_view_state_set': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: view-state save for unknown/foreign session',
          );
          return;
        }
        await store.sessionViewStates.set(message.sessionId, {
          envelope: message.envelope,
          revision: message.revision,
        });
        const response: SessionViewStateResult = {
          type: 'session_view_state_result',
          protocolVersion: PROTOCOL_V1,
          requestId: message.requestId,
          sessionId: message.sessionId,
          envelope: message.envelope,
          revision: message.revision,
        };
        sendDirect(connection, response);
        // Mirrors `keymap_set_request`'s own cross-tab/cross-device push
        // (issue #760) — a device live right now on this session sees the
        // new draft/panel/position immediately, not only on its own next
        // reconnect (issue #198's own "resumes at a sensible point" bar
        // applies just as much to a device that never disconnected).
        for (const client of registry.clients) {
          if (client.accountId === connection.accountId && client !== connection) {
            sendDirect(client, response);
          }
        }
        return;
      }
      case 'session_resume': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: resume for unknown/foreign session',
          );
          return;
        }
        subscribeClientToSession(connection, message.sessionId);
        const announce: SessionAnnounceV1 = {
          type: 'session_announce',
          protocolVersion: PROTOCOL_V1,
          session: record.meta,
          privateEnvelope: record.privateEnvelope,
        };
        sendDirect(connection, announce);
        return;
      }
      case 'session_archive_request': {
        // #512's row-menu archive action: same account-ownership check as
        // session_resume above. On a foreign/unknown session, reply
        // directly with outcome: 'error' instead of silently dropping —
        // unlike a routed request, there is no owning node that will ever
        // answer this one, so a silent drop would just make the caller's
        // own pending-request timeout the only way to learn it failed.
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: session_archive_request for unknown/foreign session',
          );
          const errorResponse: SessionArchiveResponse = {
            type: 'session_archive_response',
            protocolVersion: PROTOCOL_V1,
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: { outcome: 'error', message: `unknown session ${message.sessionId}` },
          };
          sendDirect(connection, errorResponse);
          return;
        }
        // Routed directly by the session's own nodeId, verbatim, keeping
        // requestId — an owning node that isn't currently connected is the
        // same "nothing to route to" case session_create/
        // provision_target_request above already treat as a silent drop,
        // relying on the requester's own pending-request timeout.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(record.meta.nodeId);
        if (!nodeConnection) {
          app.log.warn(
            { sessionId: message.sessionId, nodeId: record.meta.nodeId },
            'relay: session_archive_request owning node not connected',
          );
          return;
        }
        sendDirect(nodeConnection, message);
        return;
      }
      case 'session_create': {
        const nodeId = store.targets.findNodeForTarget(message.targetId);
        const nodeConnection = nodeId ? registry.nodeConnectionsByNodeId.get(nodeId) : undefined;
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { targetId: message.targetId },
            'relay: session_create for unknown/foreign target',
          );
          return;
        }
        sendDirect(nodeConnection, message);
        return;
      }
      case 'session_fork_request': {
        // #746: routed by targetId exactly like session_create above — the
        // forked session doesn't exist as a SessionRecord yet, so there is
        // nothing to route by sessionId. Unlike session_create's own
        // silent drop on a bad target, a fork's own request/response
        // contract exists specifically to surface a refusal (SPEC C6-2's
        // "never half-creates"), so an unroutable target replies with an
        // explicit error instead of leaving the requester to learn it only
        // from its own pending-request timeout — the same reasoning
        // session_archive_request's unknown-session branch already applies.
        const nodeId = store.targets.findNodeForTarget(message.targetId);
        const nodeConnection = nodeId ? registry.nodeConnectionsByNodeId.get(nodeId) : undefined;
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { targetId: message.targetId },
            'relay: session_fork_request for unknown/foreign target',
          );
          const errorResponse: SessionForkResponse = {
            type: 'session_fork_response',
            protocolVersion: PROTOCOL_V1,
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: { outcome: 'error', message: `unknown target ${message.targetId}` },
          };
          sendDirect(connection, errorResponse);
          return;
        }
        sendDirect(nodeConnection, message);
        return;
      }
      case 'provision_target_request': {
        // #410: the same account-scoped connection lookup as session_create
        // above, just addressed directly by nodeId — there is no existing
        // target to resolve through yet, since provisioning one is the
        // whole point (SPEC §7.23).
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: provision_target_request for unknown/foreign node',
          );
          return;
        }
        // A resent/reused requestId replaces whatever routing entry it had
        // before, same "last one wins" convention as
        // `registry.nodeConnectionsByNodeId` above.
        clearPendingProvisionRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: provision_target_request routing entry expired before a final result arrived',
          );
          pendingProvisionRequests.delete(message.requestId);
        }, provisionRequestTtlMs);
        pendingProvisionRequests.set(message.requestId, { clientConnection: connection, timeout });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'target_fs_list_request': {
        // #474's directory picker: routed directly by `nodeId`, scoped to
        // the requester's account, exactly like `provision_target_request`
        // above — there is no existing session to resolve the owning node
        // through (`routeToOwningNode`'s `sessionId` lookup), since browsing
        // a target's filesystem to pick a `projectPath` can happen before
        // any session exists on it (`@loombox/protocol`'s `target-fs.ts`
        // doc comment). The reply is a single `target_fs_list_response`
        // (never a stream of progress like provisioning's), so its routing
        // entry is populated here and retired in exactly the same three
        // places `pendingProvisionRequests` is: the response itself, this
        // client's own disconnect (`dropConnection`), and the TTL timer.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: target_fs_list_request for unknown/foreign node',
          );
          return;
        }
        clearPendingTargetFsListRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: target_fs_list_request routing entry expired before a response arrived',
          );
          pendingTargetFsListRequests.delete(message.requestId);
        }, targetFsListRequestTtlMs);
        pendingTargetFsListRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'custom_agent_probe_request': {
        // Issue #748: routed directly by `nodeId`, exactly like
        // `target_fs_list_request` above — there is no session (and often
        // no project) yet to resolve the owning node through.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: custom_agent_probe_request for unknown/foreign node',
          );
          return;
        }
        clearPendingCustomAgentProbeRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: custom_agent_probe_request routing entry expired before a response arrived',
          );
          pendingCustomAgentProbeRequests.delete(message.requestId);
        }, customAgentProbeRequestTtlMs);
        pendingCustomAgentProbeRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'session_template_list_get':
      case 'session_template_list_set': {
        // Issue #259: routed directly by `nodeId`, exactly like
        // `custom_agent_probe_request` above — there is no session (and
        // often none has ever existed for this project) to resolve the
        // owning node through: `NewSessionDialog` loads/saves templates
        // before ever creating one. Both request types share the same
        // `session_template_list_result` reply, mirroring
        // `agent_profile_list_get`/`_set`'s own shared-reply convention.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            `relay: ${message.type} for unknown/foreign node`,
          );
          return;
        }
        clearPendingSessionTemplateListRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            `relay: ${message.type} routing entry expired before a response arrived`,
          );
          pendingSessionTemplateListRequests.delete(message.requestId);
        }, sessionTemplateListRequestTtlMs);
        pendingSessionTemplateListRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'ssh_discovery_request': {
        // #475's add-target wizard candidate picker: routed directly by
        // `nodeId`, scoped to the requester's account, exactly like
        // `provision_target_request`/`target_fs_list_request` above — there
        // is no existing target to resolve through (discovering hosts is
        // what happens before one exists at all). The reply is a single
        // `ssh_discovery_response`, so its routing entry is populated here
        // and retired in exactly the same three places
        // `pendingTargetFsListRequests` is: the response itself, this
        // client's own disconnect (`dropConnection`), and the TTL timer.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: ssh_discovery_request for unknown/foreign node',
          );
          return;
        }
        clearPendingSshDiscoveryRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: ssh_discovery_request routing entry expired before a response arrived',
          );
          pendingSshDiscoveryRequests.delete(message.requestId);
        }, sshDiscoveryRequestTtlMs);
        pendingSshDiscoveryRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'decommission_target_request': {
        // #476's Remove/Edit actions: routed directly by `nodeId`, scoped to
        // the requester's account, exactly like `ssh_discovery_request`
        // above — the target already exists, but there is no session to
        // resolve the owning node through either, so this is addressed
        // directly the same way. The reply is a single
        // `decommission_target_response`, so its routing entry is populated
        // here and retired in exactly the same three places
        // `pendingSshDiscoveryRequests` is: the response itself, this
        // client's own disconnect (`dropConnection`), and the TTL timer.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: decommission_target_request for unknown/foreign node',
          );
          return;
        }
        clearPendingDecommissionTargetRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: decommission_target_request routing entry expired before a response arrived',
          );
          pendingDecommissionTargetRequests.delete(message.requestId);
        }, decommissionTargetRequestTtlMs);
        pendingDecommissionTargetRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'target_update_request': {
        // #476's Update action: same direct-by-`nodeId` routing shape as
        // `decommission_target_request` above.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: target_update_request for unknown/foreign node',
          );
          return;
        }
        clearPendingTargetUpdateRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: target_update_request routing entry expired before a response arrived',
          );
          pendingTargetUpdateRequests.delete(message.requestId);
        }, targetUpdateRequestTtlMs);
        pendingTargetUpdateRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'node_self_update_apply_request': {
        // Issue #656: same direct-by-`nodeId` routing shape as
        // `target_update_request` above — this node updates ITSELF, never
        // one of its targets, so there's no `targetId` to validate.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: node_self_update_apply_request for unknown/foreign node',
          );
          return;
        }
        clearPendingNodeSelfUpdateApplyRequest(message.requestId);
        const timeout = setTimeout(() => {
          app.log.warn(
            { requestId: message.requestId },
            'relay: node_self_update_apply_request routing entry expired before a response arrived',
          );
          pendingNodeSelfUpdateApplyRequests.delete(message.requestId);
        }, nodeSelfUpdateApplyRequestTtlMs);
        pendingNodeSelfUpdateApplyRequests.set(message.requestId, {
          clientConnection: connection,
          timeout,
        });
        sendDirect(nodeConnection, message);
        return;
      }
      case 'github_connect_start_request':
      case 'jira_connect_request':
      case 'github_cli_import_request':
      case 'connected_account_disconnect_request':
      case 'account_pin_get_request':
      case 'account_pin_set_request':
      case 'account_pin_unset_request':
      case 'account_pin_resolve_request':
      case 'account_pin_scan_request':
      case 'tracker_mode_get_request':
      case 'tracker_mode_set_request':
      case 'tracker_snapshot_request':
      case 'tracker_write_request':
      case 'spend_report_request': {
        // #230/#631/#697: every SPEC §7.26 connect/disconnect/pin request,
        // SPEC §7.10's tracker-mode get/set (issue #631), and (as of #697)
        // the tracker-record snapshot/write requests, share one routing
        // shape — direct-by-`nodeId`, scoped to the requester's account,
        // exactly like `target_update_request` above (none of these has an
        // existing target/session to resolve the owning node through — the
        // tracker-record pair used to route by `sessionId`, but #697
        // re-addressed them by `nodeId` + `projectPath` since a project's
        // records must be reachable with no session running at all).
        // `pendingAccountRequests`'s own doc comment covers why one shared
        // table backs every member, including this one's multi-message case
        // (`github_connect_start_request`).
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId, type: message.type },
            'relay: connected-account request for unknown/foreign node',
          );
          return;
        }
        trackAccountRequest(message.requestId, connection);
        sendDirect(nodeConnection, message);
        return;
      }
      case 'github_connect_cancel_request': {
        // #230: fire-and-forget — forwarded straight to the same `nodeId`
        // the original `github_connect_start_request` named (the client
        // already knows it); the eventual `github_connect_result` (reason
        // `'cancelled'`) retires that original request's own routing entry,
        // so this message never touches `pendingAccountRequests` itself.
        const nodeConnection = registry.nodeConnectionsByNodeId.get(message.nodeId);
        if (!nodeConnection || nodeConnection.accountId !== connection.accountId) {
          app.log.warn(
            { nodeId: message.nodeId },
            'relay: github_connect_cancel_request for unknown/foreign node',
          );
          return;
        }
        sendDirect(nodeConnection, message);
        return;
      }
      case 'prompt_inject':
      case 'permission_response':
      case 'config_option':
      case 'fs_list_request':
      case 'mcp_prompt_get_request':
      case 'fs_read_request':
      case 'fs_write_request':
      case 'git_hunk_action_request':
      case 'agent_instructions_set_request':
      case 'git_commit_request':
      case 'git_diff_explain_request':
        // fs_list_request (SPEC §7.4; issue #171/#160), its D5-2 sibling
        // mcp_prompt_get_request (Zed-parity D5-2; issue #754), its
        // #737 sibling fs_read_request (read-only file viewer), its
        // #232 sibling git_hunk_action_request (hunk-level stage/
        // unstage/discard), and its #260 sibling
        // agent_instructions_set_request (SPEC §7.18's per-project
        // AGENTS.md/CLAUDE.md surface): a client asking the owning node
        // to list a directory, render an MCP prompt, read a file, apply
        // one hunk's stage/unstage/discard, or save an instructions file
        // inside one of its sessions' projects — routed exactly like
        // prompt_inject/config_option above. The relay only ever sees
        // `sessionId`/`targetId`/`requestId` and an opaque
        // `EncryptedEnvelope`; the requested path, which server/prompt
        // was asked for, which hunk was touched and how, or which
        // instructions file changed to what, never reaches the relay in
        // the clear (SPEC §8's metadata boundary).
        // unstage/discard), and its #233 sibling git_commit_request (commit
        // what's staged with the operator's own final message): a client
        // asking the owning node to list a directory, render an MCP
        // prompt, read a file, apply one hunk's stage/unstage/discard, or
        // commit the currently staged index inside one of its sessions'
        // projects — routed exactly like prompt_inject/config_option
        // above. The relay only ever sees `sessionId`/`targetId`/
        // `requestId` and an opaque `EncryptedEnvelope`; the requested
        // path, which server/prompt was asked for, which hunk was touched
        // and how, or the commit message itself, never reaches the relay
        // in the clear (SPEC §8's metadata boundary).
        // and its #236 sibling git_diff_explain_request (explain a diff or
        // a hunk): routed the same way. The relay only ever sees
        // `sessionId`/`requestId` and an opaque `EncryptedEnvelope`; which
        // file/hunk was addressed never reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'git_branch_list_request':
      case 'git_branch_create_request':
      case 'git_branch_switch_request':
      case 'git_branch_merge_request':
      case 'git_branch_merge_abort_request':
      case 'git_stash_save_request':
      case 'git_stash_list_request':
      case 'git_stash_pop_request':
      case 'git_stash_drop_request':
      case 'git_push_request':
        // A client listing branches/stashes, creating/switching/merging a
        // branch, aborting a conflicted merge, or saving/popping/dropping
        // a stash (SPEC §7.6; issue #234) — routed to the owning node
        // exactly like git_hunk_action_request above. The relay only ever
        // sees sessionId/requestId plus, for every request that carries a
        // payload (create/switch/merge/stash save/pop/drop), an opaque
        // `EncryptedEnvelope`; git_branch_list_request,
        // git_branch_merge_abort_request, and git_stash_list_request carry
        // no envelope at all (asking/aborting carries no content, mirrors
        // git_diff_request) — no branch name, stash message, or
        // conflicted path ever reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'terminal_open':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_close':
        // A client opening/typing into/resizing/closing an interactive PTY
        // terminal (SPEC §7.5; issues #172/#173) — routed to the owning node
        // exactly like fs_list_request above. The relay only ever sees
        // sessionId/terminalId (and, for terminal_open, targetId/requestId)
        // plus an opaque `EncryptedEnvelope`; not one byte of typed input or
        // the negotiated cols/rows ever reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'test_runner_config_get':
      case 'test_runner_config_set':
      case 'test_runner_config_detect':
        // A client reading/saving/auto-detecting a session's project's
        // test/lint/build commands (SPEC §7.15; issue #245) — routed to
        // the owning node exactly like terminal_open above. The relay only
        // ever sees sessionId/requestId plus (for _set) an opaque
        // `EncryptedEnvelope`; no command string ever reaches the relay in
        // the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'permission_policy_get':
      case 'permission_policy_set':
        // A client reading/saving a session's project's permission policy
        // (SPEC §7.17; issue #751) — routed to the owning node exactly
        // like test_runner_config_get/_set above. The relay only ever
        // sees sessionId/requestId plus (for _set) an opaque
        // `EncryptedEnvelope`; no glob pattern ever reaches the relay in
        // the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'spend_cap_get':
      case 'spend_cap_set':
        // A client reading/saving a session's project or session spend
        // cap (SPEC §7.16; issue #251) — routed to the owning node
        // exactly like permission_policy_get/_set above. The relay only
        // ever sees sessionId/requestId plus (for _set) an opaque
        // `EncryptedEnvelope`; no dollar figure ever reaches the relay in
        // the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'session_spend_cap_resume':
        // A client explicitly resuming a session paused on a spend cap
        // (SPEC §7.16; issue #251) — envelope-less (resuming carries no
        // content, mirrors run_cancel), routed to the owning node the
        // same way.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'checkpoint_create':
      case 'checkpoint_list':
      case 'checkpoint_restore_preview':
      case 'checkpoint_restore':
      case 'git_diff_request':
      case 'git_graph_request':
      case 'git_hunk_diff_request':
      case 'agent_instructions_get_request':
      case 'git_commit_draft_request':
      case 'pr_open_preview_request':
      case 'pr_open_request':
      case 'pr_merge_request':
        // A client taking/listing/previewing/rolling back a session's
        // checkpoints (SPEC §7.20; issue #603), the session's own current
        // working-tree diff (SPEC §7.4; issue #206's diff viewer), the
        // same session's staged/unstaged hunk breakdown (issue #232's
        // hunk-level stage/unstage/discard), its saved AGENTS.md/
        // CLAUDE.md state (SPEC §7.18; issue #260), or previewing/
        // confirming opening a pull request from a session's own branch
        // (SPEC §7.14; issue #238) — routed to the owning node exactly
        // like permission_policy_get/_set above. The relay only ever
        // sees sessionId/requestId plus, for checkpoint_create/
        // pr_open_request, an opaque `EncryptedEnvelope`; checkpoint_
        // restore_preview/_restore carry only an opaque checkpointId and
        // (for _restore) a plain confirm boolean; git_diff_request,
        // git_hunk_diff_request, and agent_instructions_get_request
        // carry no envelope at all (asking carries no content) — no
        // checkpoint label, commit, diff content, hunk breakdown,
        // instructions-file content, PR title, body, branch name, or PR
        // URL ever reaches the relay in the clear.
        // hunk-level stage/unstage/discard), a drafted commit message for
        // the currently staged diff (issue #233's commit workflow), or
        // previewing/confirming opening a pull request from a session's
        // own branch (SPEC §7.14; issue #238) — routed to the owning node
        // exactly like permission_policy_get/_set above. The relay only
        // ever sees sessionId/requestId plus, for checkpoint_create/
        // pr_open_request, an opaque `EncryptedEnvelope`; checkpoint_
        // restore_preview/_restore carry only an opaque checkpointId and
        // (for _restore) a plain confirm boolean; git_diff_request,
        // git_hunk_diff_request, and git_commit_draft_request carry no
        // envelope at all (asking carries no content) — no checkpoint
        // label, commit, diff content, hunk breakdown, drafted commit
        // message, PR title, body, branch name, or PR URL ever reaches
        // the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'session_rewind_preview':
      case 'session_rewind':
        // A client previewing/confirming a rewind of a session to a turn
        // (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-3;
        // issue #747) — routed to the owning node exactly like
        // checkpoint_restore_preview/_restore above. The relay only ever
        // sees sessionId/requestId plus a plain turn number and (for
        // session_rewind) a plain confirm boolean — no file path, turn
        // content, or checkpoint id ever reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'agent_profile_list_get':
      case 'agent_profile_list_set':
      case 'agent_profile_session_get':
      case 'agent_profile_session_set':
        // A client reading/saving its account's agent-profile catalog, or
        // reading/switching a session's active profile (design spec
        // `2026-08-05-zed-parity-decisions.md`'s D3-4; issue #752) —
        // routed to the owning node exactly like permission_policy_get/
        // _set above. The relay only ever sees sessionId/requestId plus
        // an opaque `EncryptedEnvelope`; no profile name or rule ever
        // reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'snippet_list_get':
      case 'snippet_list_set':
        // A client reading/saving its account's saved prompt/snippet
        // catalog (SPEC §7.18; issue #261) — routed to the owning node
        // exactly like agent_profile_list_get/_set above. The relay only
        // ever sees sessionId/requestId plus an opaque `EncryptedEnvelope`;
        // no snippet name or text ever reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'run_start':
      case 'run_cancel':
        // A client starting/cancelling a configured test/lint/build run
        // (SPEC §7.15; issue #244) — routed to the owning node exactly
        // like terminal_open/terminal_close above. The relay only ever
        // sees sessionId/targetId/runId (and, for run_start, requestId)
        // plus an opaque `EncryptedEnvelope`; which command kind ran never
        // reaches the relay in the clear.
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'ci_auto_iterate_stop':
        // A client stopping a session's auto-iterate-until-green loop
        // right now (SPEC §7.14/§7.15; issue #246) — routed to the
        // owning node exactly like run_cancel above. Envelope-less: the
        // relay only ever sees sessionId, never why the loop was
        // stopped (that's the resulting ci_auto_iterate_status push's
        // own sealed envelope).
        await routeToOwningNode(message.sessionId, message);
        return;
      case 'blob_upload': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: blob_upload for unknown/foreign session',
          );
          return;
        }
        // #101: reject rather than partially accept — the upload is simply
        // not stored, and the client is told exactly why (out-of-band,
        // same as `update_required` above — not a `WireMessageV1`, the
        // protocol isn't changed by adding this).
        if (!(await hasQuotaFor(connection.accountId, envelopeByteSize(message.envelope)))) {
          app.log.warn(
            { accountId: connection.accountId, sessionId: message.sessionId, ref: message.ref },
            'relay: blob_upload rejected, account storage quota exceeded',
          );
          sendJson(connection.socket, {
            type: 'quota_exceeded',
            scope: 'blob_upload',
            sessionId: message.sessionId,
            ref: message.ref,
          });
          return;
        }
        await store.blobs.upload(
          `${message.sessionId}:${message.ref}`,
          message.envelope,
          connection.accountId,
        );
        return;
      }
      case 'blob_download':
        await handleBlobDownload(connection, message);
        return;
      case 'resync_request': {
        const record = await store.sessions.get(message.sessionId);
        if (!record || record.meta.accountId !== connection.accountId) {
          app.log.warn(
            { sessionId: message.sessionId },
            'relay: resync for unknown/foreign session',
          );
          return;
        }
        const result = await store.sessions.getEntriesSince(message.sessionId, message.sinceSeq);
        if (result.droppedFromSeq !== undefined && result.droppedToSeq !== undefined) {
          const marker: ResyncMarker = {
            type: 'resync_marker',
            protocolVersion: PROTOCOL_V1,
            sessionId: message.sessionId,
            fromSeq: result.droppedFromSeq,
            toSeq: result.droppedToSeq,
            dropped: true,
          };
          sendDirect(connection, marker);
        }
        for (const entry of result.entries) {
          const replay: SessionUpdateEnvelopeV1 = {
            type: 'session_update',
            protocolVersion: PROTOCOL_V1,
            sessionId: message.sessionId,
            seq: entry.seq,
            envelope: entry.envelope,
          };
          sendDirect(connection, replay);
        }
        return;
      }
      case 'presence': {
        for (const node of registry.nodes) {
          if (node.accountId === connection.accountId) sendDirect(node, message);
        }
        for (const client of registry.clients) {
          if (client !== connection && client.accountId === connection.accountId) {
            sendDirect(client, message);
          }
        }
        return;
      }
      default:
        // #691: same reasoning as handleNodeMessage's default above — an
        // unrouted/misdirected message from a client is always a bug, so it
        // logs at `error` rather than `warn`.
        app.log.error({ type: message.type }, 'relay: unexpected message from a client connection');
    }
  }

  function dropConnection(connection: Connection): void {
    if (connection.kind === 'node') {
      registry.nodes.delete(connection);
      for (const nodeId of connection.nodeIds) {
        if (registry.nodeConnectionsByNodeId.get(nodeId) === connection) {
          registry.nodeConnectionsByNodeId.delete(nodeId);
        }
      }
    } else {
      registry.clients.delete(connection);
      // #97: release this client's fan-out backend subscriptions — for the
      // Redis backend this is what actually issues UNSUBSCRIBE once no
      // local client cares about a given session anymore.
      for (const unsubscribe of connection.fanOutUnsubscribes.values()) unsubscribe();
      connection.fanOutUnsubscribes.clear();
      // #410: a disconnected client is no longer a valid delivery target for
      // any provisioning request it started — drop its routing entry now
      // rather than leave it to the TTL timer.
      for (const [requestId, pending] of pendingProvisionRequests) {
        if (pending.clientConnection === connection) clearPendingProvisionRequest(requestId);
      }
      // #474: same reasoning as the provisioning cleanup above — a
      // disconnected client can never receive a still-pending
      // target_fs_list_response.
      for (const [requestId, pending] of pendingTargetFsListRequests) {
        if (pending.clientConnection === connection) clearPendingTargetFsListRequest(requestId);
      }
      // Issue #748: same reasoning as the cleanup above — a disconnected
      // client can never receive a still-pending custom_agent_probe_response.
      for (const [requestId, pending] of pendingCustomAgentProbeRequests) {
        if (pending.clientConnection === connection) {
          clearPendingCustomAgentProbeRequest(requestId);
        }
      }
      // Issue #259: same reasoning as the cleanup above — a disconnected
      // client can never receive a still-pending session_template_list_result.
      for (const [requestId, pending] of pendingSessionTemplateListRequests) {
        if (pending.clientConnection === connection) {
          clearPendingSessionTemplateListRequest(requestId);
        }
      }
      // #475: same reasoning as the two cleanups above — a disconnected
      // client can never receive a still-pending ssh_discovery_response.
      for (const [requestId, pending] of pendingSshDiscoveryRequests) {
        if (pending.clientConnection === connection) clearPendingSshDiscoveryRequest(requestId);
      }
      // #476: same reasoning as the cleanups above — a disconnected client
      // can never receive a still-pending decommission_target_response.
      for (const [requestId, pending] of pendingDecommissionTargetRequests) {
        if (pending.clientConnection === connection) {
          clearPendingDecommissionTargetRequest(requestId);
        }
      }
      // #476: same reasoning — a disconnected client can never receive a
      // still-pending target_update_response.
      for (const [requestId, pending] of pendingTargetUpdateRequests) {
        if (pending.clientConnection === connection) clearPendingTargetUpdateRequest(requestId);
      }
      // Issue #656: same reasoning — a disconnected client can never
      // receive a still-pending node_self_update_apply_response.
      for (const [requestId, pending] of pendingNodeSelfUpdateApplyRequests) {
        if (pending.clientConnection === connection) {
          clearPendingNodeSelfUpdateApplyRequest(requestId);
        }
      }
      // #230: same reasoning as every cleanup above — a disconnected client
      // can never receive a still-pending github/jira connect, disconnect,
      // or pin get/set/unset/resolve reply.
      for (const [requestId, pending] of pendingAccountRequests) {
        if (pending.clientConnection === connection) clearPendingAccountRequest(requestId);
      }
    }
  }

  // Readiness endpoint for external uptime monitoring (#270, SPEC §7.21):
  // alerting can't depend on the relay itself being up to notice its own
  // outage. This used to be a plain liveness stub (#100) that returned 200
  // unconditionally — it could tell "the HTTP server answers" but not "the
  // relay actually works", so a dead Postgres or Redis behind a healthy
  // process never tripped the uptime checker at all. `SELECT 1`/`PING` are
  // the cheapest real round trip each dependency offers; each gets its own
  // `probeWithTimeout` race so a hung dependency 503s instead of hanging
  // this request. `rateLimit: false` stays deliberate, unchanged from
  // #100: an external uptime checker carries no session/auth and polls far
  // more often than any real device would ever legitimately reconnect, so
  // exempting it (rather than tuning the shared per-IP limit around it) is
  // what keeps it from being rate-limited by its own monitoring traffic.
  // Postgres absent (`opts.healthCheck.db` unset — dev/hermetic in-memory
  // store, no `DATABASE_URL`) or Redis absent (`REDIS_URL` unset,
  // in-process fan-out has no `ping`) is not a failure: neither is part of
  // this deployment, so there is nothing configured to be down (#97's same
  // "optional" contract Redis already has elsewhere).
  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    const [postgresHealthy, redisHealthy] = await Promise.all([
      healthCheckDb
        ? probeWithTimeout(() => healthCheckDb.query('SELECT 1'), healthProbeTimeoutMs)
        : Promise.resolve(true),
      fanOutBackend.ping
        ? probeWithTimeout(() => fanOutBackend.ping!(), healthProbeTimeoutMs)
        : Promise.resolve(true),
    ]);
    if (postgresHealthy && redisHealthy) return { status: 'ok' };

    // Names which dependency failed, nothing more — no error
    // message/stack, connection string, or version, so an unauthenticated
    // caller learns only what an uptime dashboard needs to page on.
    const failed: string[] = [];
    if (!postgresHealthy) failed.push('postgres');
    if (!redisHealthy) failed.push('redis');
    reply.code(503);
    return { status: 'unhealthy', failed };
  });

  /** Resolves the `Authorization: Bearer <token>` header the same way the WS handshake resolves its `authToken` (#121) — `undefined` if absent/invalid. Used by the `/push/*` REST routes below, which have no WS connection of their own to piggyback auth on. */
  async function accountIdFromBearer(
    header: string | string[] | undefined,
  ): Promise<string | undefined> {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) return undefined;
    return resolveAccountId(value.slice('Bearer '.length));
  }

  function isPushSubscribeBody(
    body: unknown,
  ): body is { deviceId: string; endpoint: string; keys: { p256dh: string; auth: string } } {
    if (typeof body !== 'object' || body === null) return false;
    const candidate = body as Record<string, unknown>;
    const keys = candidate.keys as Record<string, unknown> | undefined;
    return (
      typeof candidate.deviceId === 'string' &&
      candidate.deviceId.length > 0 &&
      typeof candidate.endpoint === 'string' &&
      candidate.endpoint.length > 0 &&
      typeof keys === 'object' &&
      keys !== null &&
      typeof keys.p256dh === 'string' &&
      typeof keys.auth === 'string'
    );
  }

  // #161: the documented endpoint a client fetches the relay's self-owned
  // VAPID public key from, to pass into `PushManager.subscribe()`'s
  // `applicationServerKey`. 404 (not disabled-but-empty) when this relay
  // wasn't configured with `push` at all — the same "feature absent, not
  // feature broken" signal `/push/subscribe` below gives.
  app.get('/push/vapid-public-key', async (_request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    return { publicKey: opts.push.vapidKeys.publicKey };
  });

  // #161/#162: registers (or overwrites, on re-subscribe) this account's
  // device's push subscription — see `store.ts`'s `PushSubscriptionStore`
  // doc comment for the overwrite-not-accumulate behavior.
  app.post('/push/subscribe', async (request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    if (!isPushSubscribeBody(request.body)) {
      return reply.code(400).send({ error: 'invalid push subscription body' });
    }
    const body = request.body;
    await store.pushSubscriptions.save({
      accountId,
      deviceId: body.deviceId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
    return reply.code(204).send();
  });

  // A client that turned notifications off, or is signing this device out,
  // removes its own subscription — scoped to the bearer's own account, same
  // as every other account-scoped mutation in this file.
  app.delete('/push/subscribe', async (request, reply) => {
    if (!opts.push) return reply.code(404).send({ error: 'push not configured' });
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    const body = request.body as { deviceId?: unknown } | undefined;
    if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
      return reply.code(400).send({ error: 'deviceId is required' });
    }
    await store.pushSubscriptions.delete(accountId, body.deviceId);
    return reply.code(204).send();
  });

  // Answers "which account does this bearer belong to?" for ANY token this
  // relay accepts, which is the point: `accountIdFromBearer` runs the same
  // `resolveAccountId` the WS handshake does, so a relay-native device token
  // (#387/#398), a Better Auth session, and the dev stub all resolve here
  // exactly as they do everywhere else.
  //
  // It exists because a resident node could not answer that question for
  // itself. `@loombox/node` used to ask Better Auth's `/api/auth/get-session`
  // directly, which only knows about browser sessions, so a node that
  // bootstrapped through the intended device-authorization flow died on
  // startup ("not a valid, active Better Auth session") holding a token this
  // relay would have accepted on the WS a moment later. Measured on a real
  // node against a real relay: same persisted token, connected fine once
  // `LOOMBOX_ACCOUNT_ID` was set by hand, which is exactly the workaround
  // this endpoint removes.
  app.get('/account', async (request, reply) => {
    const accountId = await accountIdFromBearer(request.headers.authorization);
    if (!accountId) return reply.code(401).send({ error: 'invalid or missing auth token' });
    return reply.code(200).send({ accountId });
  });

  // #387: the device-authorization-grant REST endpoints — see
  // `device-auth-routes.ts`'s own doc comment. `accountIdFromBearer` above
  // is what makes `/device/approve`/`/device/deny` (the operator's browser)
  // resolve the SAME way `/push/subscribe` does; `resolveAccountId` itself
  // (not `accountIdFromBearer`) is what makes a minted device token usable
  // for the WS handshake and every other bearer-checked route, wired above.
  registerDeviceAuthRoutes(app, store, accountIdFromBearer, {
    appUrl: opts.deviceAuth?.appUrl,
  });

  // #398: the authenticated, zero-touch node-token mint — an already-signed-
  // in caller mints a token for its OWN account in one call, no `user_code`
  // round trip. Shares `accountIdFromBearer` with every other authenticated
  // REST route above, so a device token minted here (or via `/device/
  // approve`) resolves the same way through `resolveAccountId`.
  registerNodeTokenRoutes(app, store, accountIdFromBearer);

  app.register(fastifyWebsocket);

  app.register(async (instance) => {
    instance.get(RELAY_WS_PATH, { websocket: true }, (socket: WsWebSocket) => {
      let connection: Connection | undefined;
      // Every store call is now awaited (the Postgres swap makes that
      // unavoidable — see `store.ts`'s `Awaitable` doc comment), so a frame
      // handler is no longer guaranteed to run to completion before the next
      // 'message' event fires. Chaining each frame onto this socket's own
      // promise processes them strictly one at a time, in arrival order —
      // preserving the seq/backpressure ordering guarantees the resync and
      // drop-oldest tests (and real clients) depend on — while still letting
      // different sockets' frames interleave freely.
      let processing: Promise<void> = Promise.resolve();

      async function processFrame(text: string): Promise<void> {
        if (!connection) {
          connection = await handleInitialize(socket, text);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          app.log.warn('relay: dropped a non-JSON frame');
          return;
        }
        const result = safeParseWireMessageV1(parsed);
        if (!result.success) {
          app.log.warn({ issues: result.error.issues }, 'relay: dropped an invalid wire frame');
          return;
        }
        const message = result.data;

        if (connection.kind === 'node') await handleNodeMessage(connection, message);
        else await handleClientMessage(connection, message);
      }

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = raw.toString();
        // `processing` is always fully settled (its own `.catch` below
        // absorbs any failure) by the time the next frame chains onto it, so
        // this `.then` always runs — a prior frame's error never blocks or
        // skips a later one.
        processing = processing
          .then(() => processFrame(text))
          .catch((error: unknown) => {
            app.log.error({ error }, 'relay: error processing frame');
          });
      });

      socket.on('close', () => {
        if (connection) dropConnection(connection);
      });
    });
  });

  return app;
}

export interface StartRelayOptions extends CreateRelayOptions {
  /** Defaults to 127.0.0.1 — never bind a public interface without an explicit opt-in. */
  host?: string;
  /** Defaults to an ephemeral port (0) when omitted. */
  port?: number;
}

export interface StartedRelay {
  /** The base ws:// URL clients/nodes connect to (includes {@link RELAY_WS_PATH}). */
  url: string;
  close: () => Promise<void>;
}

/** Starts the relay listening on `host:port` and resolves once it's bound. */
export async function startRelay(opts: StartRelayOptions = {}): Promise<StartedRelay> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const app = createRelay(opts);

  await app.listen({ host, port });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('relay: failed to determine listen address');
  }

  const boundHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `ws://${boundHost}:${address.port}${RELAY_WS_PATH}`,
    close: async () => {
      await app.close();
    },
  };
}
