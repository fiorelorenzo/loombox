import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';

/**
 * The Kysely-compatible database handle Better Auth accepts (SPEC §8, §16;
 * issues #119-#122). In production this is a `pg.Pool` (Postgres, sharing
 * the relay's own database per SPEC §8's "no separate auth service to
 * operate"); the hermetic test suite hands it a `better-sqlite3` in-memory
 * `Database` instead — Better Auth's built-in Kysely adapter accepts either,
 * and both support `getMigrations`/`runMigrations` for schema setup.
 */
export type BetterAuthDatabase = Parameters<typeof betterAuth>[0]['database'];

export interface RelayAuthConfig {
  /** Postgres (prod) or sqlite (hermetic tests) — see {@link BetterAuthDatabase}. */
  database: BetterAuthDatabase;
  /** `RELAY_PUBLIC_URL` — the base URL Better Auth builds OAuth callback/redirect URLs from. */
  baseURL: string;
  /** Better Auth's session/cookie signing secret. */
  secret: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  /**
   * Test-only escape hatch: enables Better Auth's `emailAndPassword`
   * provider so a hermetic test can create a real session by hitting
   * `/api/auth/*` over HTTP, without any real GitHub/Google network call.
   * Never set in production — SPEC §8 scopes loombox login to Google/GitHub
   * OAuth only.
   */
  enableEmailPasswordForTests?: boolean;
}

/**
 * Builds the relay's Better Auth instance (#119). Registers only the social
 * providers whose env-supplied credentials are actually present (#120) —
 * missing Google credentials, say, must not crash startup, they just mean
 * Google login isn't offered. `read:user user:email`-class scopes are each
 * provider's own default; no `repo`/tracker-style scope is ever requested
 * here (that's the separate, more-privileged connected-account flow, SPEC
 * §7.26, not this login).
 *
 * The Bearer plugin (#121) is always enabled: it is what lets the relay's
 * own WebSocket handshake (a non-cookie client) convert an `Authorization:
 * Bearer` header into an internal Better Auth session — deliberately not
 * the JWT plugin, which Better Auth's own docs describe as for handing a
 * verifiable token to a separate/third-party service, not as a
 * session-auth replacement (`docs/content/docs/plugins/bearer.mdx` vs.
 * `plugins/jwt.mdx`). The `multiSession` plugin is deliberately not
 * enabled — SPEC §8: v1 is scoped to a single self-hosting operator.
 */
export function createRelayAuth(config: RelayAuthConfig) {
  const socialProviders: NonNullable<Parameters<typeof betterAuth>[0]['socialProviders']> = {};
  if (config.github) socialProviders.github = config.github;
  if (config.google) socialProviders.google = config.google;

  return betterAuth({
    database: config.database,
    baseURL: config.baseURL,
    secret: config.secret,
    socialProviders,
    emailAndPassword: config.enableEmailPasswordForTests ? { enabled: true } : undefined,
    plugins: [bearer()],
  });
}

/**
 * The relay's Better Auth instance type — deliberately `ReturnType<typeof
 * createRelayAuth>` (inferred from this file's own call to `betterAuth`)
 * rather than the generic `ReturnType<typeof betterAuth>`: the latter
 * resolves to `Auth<BetterAuthOptions>` with no way to recover the specific
 * options this relay actually configures, which `Auth<T>`'s invariant
 * `$context` makes non-assignable from the concrete instance this factory
 * returns.
 */
export type RelayAuth = ReturnType<typeof createRelayAuth>;

/** Where Better Auth's own routes live on the relay's Fastify instance (#119). */
export const BETTER_AUTH_ROUTE_PREFIX = '/api/auth/*';

/**
 * Mounts Better Auth's handler on the relay's existing Fastify server
 * (#119) — no separate auth service/process. Follows Better Auth's
 * documented Fastify recipe (`docs/content/docs/integrations/fastify.mdx`,
 * confirmed via context7 `/better-auth/better-auth`): convert the Fastify
 * request to a standard `Request`, hand it to `auth.handler`, and mirror
 * the response back onto `reply`.
 */
export function mountBetterAuth(app: FastifyInstance, auth: RelayAuth): void {
  app.route({
    method: ['GET', 'POST'],
    url: BETTER_AUTH_ROUTE_PREFIX,
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      const headers = fromNodeHeaders(request.headers);
      const init: RequestInit = { method: request.method, headers };
      if (request.body !== undefined && request.body !== null) {
        init.body = JSON.stringify(request.body);
      }
      const response = await auth.handler(new Request(url, init));
      void reply.status(response.status);
      response.headers.forEach((value, key) => {
        void reply.header(key, value);
      });
      const text = await response.text();
      return reply.send(text.length > 0 ? text : null);
    },
  });
}

/**
 * Applies Better Auth's own schema (its `user` / `session` / `account` /
 * `verification` tables) to the configured database. Better Auth does not
 * create these lazily on Postgres, so the relay runs this on boot alongside
 * its own migrations (see `main.ts`), which is what makes a fresh
 * `docker compose up` reach a working login rather than 500ing on a missing
 * `verification` relation. This is the exact call the hermetic auth tests use
 * to set up their sqlite schema, so prod and tests share one migration path.
 */
export async function migrateBetterAuth(auth: RelayAuth): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * Resolves an `Authorization: Bearer` token (the relay WS handshake's
 * `authToken`, SPEC §8) against Better Auth's session store, returning the
 * account it belongs to — or `undefined` for a missing/invalid/expired
 * token, which the caller must treat as a rejection (#121, #122: the
 * device registry's `owner_account_id` and account-scoped session listing
 * both key off this).
 */
export async function resolveAccountIdViaBetterAuth(
  auth: RelayAuth,
  authToken: string,
): Promise<string | undefined> {
  try {
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${authToken}` }),
    });
    return session?.user.id;
  } catch {
    return undefined;
  }
}

/**
 * The default, unauthenticated account resolver used when no Better Auth
 * instance is configured — the relay's zero-config dev/self-host-without-
 * Postgres mode, and the shape this package's own hermetic routing tests
 * and `scripts/v1-e2e-harness.mjs` still rely on (both construct
 * `startRelay()` without a `DATABASE_URL`/auth resolver, so every device
 * that presents the same `authToken` string is scoped to the same account,
 * with no real verification). Once Better Auth is configured (`DATABASE_URL`
 * set — see `store-factory.ts`/`main.ts`), {@link resolveAccountIdViaBetterAuth}
 * replaces this as the connection's actual `AccountResolver`, so an
 * invalid/absent bearer token is genuinely rejected rather than accepted.
 */
export function deriveAccountIdStub(authToken: string): string {
  return authToken;
}
