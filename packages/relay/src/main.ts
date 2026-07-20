import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  createRelayAuth,
  describeActiveProviders,
  migrateBetterAuth,
  type RelayAuth,
} from './auth';
import { createRedisFanOutBackend, type FanOutBackend } from './fanout';
import { runMigrations } from './migrate';
import { resolveVapidKeys } from './push';
import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';
import { createPostgresRelayStore } from './store-postgres';
import type { RelayStore } from './store';

/**
 * Runnable entry point for the v1 relay (SPEC §9's "relay on prodbox").
 * Reads HOST/PORT from the environment; defaults to a loopback bind so the
 * deploy step must opt in explicitly to a public interface.
 *
 * Persistence/auth are selected by config (#96, #112, #99, #119-#122):
 * when `DATABASE_URL` is set, the relay runs the Postgres-backed
 * `RelayStore` and mounts Better Auth (social login from whichever of
 * `GITHUB_CLIENT_ID`/`SECRET` and `GOOGLE_CLIENT_ID`/`SECRET` are present —
 * missing Google credentials, say, just mean Google login isn't offered,
 * never a crash — see the `describeActiveProviders` log line below, #120);
 * otherwise it falls back to the in-memory store and the dev/hermetic auth
 * stub, exactly as before — the shape this package's own hermetic tests and
 * `scripts/v1-e2e-harness.mjs` rely on.
 *
 * Fan-out (#97): `REDIS_URL` unset -> the default in-process, single-instance
 * fan-out (unchanged); set -> Redis-backed, so this process can be one of
 * several relay replicas behind a load balancer sharing one fan-out plane.
 *
 * Abuse limits (#101) are config-only, always on: `RELAY_RATE_LIMIT_MAX` /
 * `RELAY_RATE_LIMIT_WINDOW_MS` (per-IP) and
 * `RELAY_ACCOUNT_STORAGE_QUOTA_BYTES` (per-account) fall back to
 * `relay.ts`'s own sane defaults when unset. `prune-cli.ts` (#102) reads
 * the same `RELAY_ACCOUNT_STORAGE_QUOTA_BYTES` for its size-cap reclaim
 * pass, so setting it once here keeps the write-time reject and the
 * scheduled reclaim in agreement.
 */
export async function start(): Promise<StartedRelayHandle> {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ? Number(process.env.PORT) : 8787;
  const rateLimitMax = process.env.RELAY_RATE_LIMIT_MAX
    ? Number(process.env.RELAY_RATE_LIMIT_MAX)
    : undefined;
  const rateLimitWindowMs = process.env.RELAY_RATE_LIMIT_WINDOW_MS
    ? Number(process.env.RELAY_RATE_LIMIT_WINDOW_MS)
    : undefined;
  const maxAccountStorageBytes = process.env.RELAY_ACCOUNT_STORAGE_QUOTA_BYTES
    ? Number(process.env.RELAY_ACCOUNT_STORAGE_QUOTA_BYTES)
    : undefined;

  const databaseUrl = process.env.DATABASE_URL;
  // #161: always a concrete store (Postgres when configured, otherwise a
  // process-lifetime in-memory one) rather than leaving it `undefined` for
  // `createRelay`'s own internal fallback to construct — VAPID key
  // resolution below needs to read/write the SAME store instance
  // `startRelay` ends up using, so the keypair it generates on first boot
  // is the one `createRelay` actually serves from `/push/vapid-public-key`.
  let store: RelayStore = createInMemoryRelayStore();
  let auth: RelayAuth | undefined;
  let pool: Pool | undefined;

  if (databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool, 'up');
    store = createPostgresRelayStore(pool);

    const baseURL = process.env.RELAY_PUBLIC_URL ?? `http://${host}:${port}`;
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      throw new Error('loombox relay: BETTER_AUTH_SECRET is required when DATABASE_URL is set');
    }
    const github =
      process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
        : undefined;
    const google =
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
        : undefined;
    auth = createRelayAuth({ database: pool, baseURL, secret, github, google });
    // Better Auth's tables are separate from the relay's own and are not
    // created lazily on Postgres, so apply its schema on boot too (otherwise
    // the first login 500s on a missing `verification` relation).
    await migrateBetterAuth(auth);
    // #120: a self-hoster who forgot/mistyped a client id/secret finds out
    // from this log line at boot, not from a user reporting a dead button.
    console.log(`loombox relay: ${describeActiveProviders({ github, google })}`);
  }

  const redisUrl = process.env.REDIS_URL;
  let fanOutBackend: FanOutBackend | undefined;
  if (redisUrl) {
    fanOutBackend = createRedisFanOutBackend(redisUrl);
    console.log('loombox relay: Redis-backed fan-out enabled (multi-instance, REDIS_URL set)');
  } else {
    console.log('loombox relay: in-process fan-out (single instance; set REDIS_URL to scale out)');
  }

  // #161: self-owned VAPID push — `VAPID_SUBJECT` is required to enable it
  // at all (RFC 8292 mandates a `sub` claim; there is no safe default to
  // fall back to), an operator-supplied `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
  // pair wins outright, otherwise a keypair is generated and persisted to
  // `store` on first boot (`push.ts`'s `resolveVapidKeys`).
  const vapidSubject = process.env.VAPID_SUBJECT;
  const push = vapidSubject
    ? {
        vapidKeys: await resolveVapidKeys(store.vapidKeys, {
          subject: vapidSubject,
          envKeys:
            process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
              ? {
                  publicKey: process.env.VAPID_PUBLIC_KEY,
                  privateKey: process.env.VAPID_PRIVATE_KEY,
                }
              : undefined,
        }),
        subject: vapidSubject,
      }
    : undefined;
  console.log(
    push
      ? 'loombox relay: self-owned Web Push enabled (VAPID_SUBJECT set)'
      : 'loombox relay: Web Push disabled (set VAPID_SUBJECT to enable, SPEC §7.11)',
  );

  const { url, close } = await startRelay({
    host,
    port,
    logger: true,
    store,
    auth,
    rateLimit: { max: rateLimitMax, timeWindow: rateLimitWindowMs },
    maxAccountStorageBytes,
    fanOutBackend,
    push,
  });
  console.log(
    `loombox relay listening on ${url}${databaseUrl ? ' (Postgres-backed)' : ' (in-memory)'}`,
  );
  return {
    url,
    close: async () => {
      await close();
      if (pool) await pool.end();
    },
  };
}

interface StartedRelayHandle {
  url: string;
  close: () => Promise<void>;
}

const isMainModule = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (isMainModule) {
  start().catch((error: unknown) => {
    console.error('loombox relay failed to start', error);
    process.exitCode = 1;
  });
}
