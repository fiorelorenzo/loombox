import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { createRelayAuth, type RelayAuth } from './auth';
import { runMigrations } from './migrate';
import { startRelay } from './relay';
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
 * never a crash); otherwise it falls back to the in-memory store and the
 * dev/hermetic auth stub, exactly as before — the shape this package's own
 * hermetic tests and `scripts/v1-e2e-harness.mjs` rely on.
 */
export async function start(): Promise<StartedRelayHandle> {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ? Number(process.env.PORT) : 8787;

  const databaseUrl = process.env.DATABASE_URL;
  let store: RelayStore | undefined;
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
    auth = createRelayAuth({
      database: pool,
      baseURL,
      secret,
      github:
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ? {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            }
          : undefined,
      google:
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          ? {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            }
          : undefined,
    });
  }

  const { url, close } = await startRelay({ host, port, logger: true, store, auth });
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
