import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  BETTER_AUTH_ROUTE_PREFIX,
  createRelayAuth,
  deriveAccountIdStub,
  migrateBetterAuth,
  mountBetterAuth,
  resolveAccountIdViaBetterAuth,
  type RelayAuth,
} from './auth';

/**
 * Hermetic Better Auth tests (#119, #120, #121, #122): a `better-sqlite3`
 * in-memory database stands in for Postgres (Better Auth's Kysely adapter
 * accepts either), and `emailAndPassword` stands in for a real OAuth
 * provider so a session can be created by hitting `/api/auth/*` over real
 * HTTP without ever calling out to GitHub/Google — never do that here.
 */
async function buildTestAuth(
  overrides: Parameters<typeof createRelayAuth>[0] extends infer T ? Partial<T> : never = {},
): Promise<RelayAuth> {
  const database = new Database(':memory:');
  const auth = createRelayAuth({
    database,
    baseURL: 'http://127.0.0.1:0',
    secret: 'hermetic-test-secret-hermetic-test-secret',
    enableEmailPasswordForTests: true,
    ...overrides,
  });
  // Exercise the exact production boot migration path (main.ts calls this too),
  // so the tests would catch a regression where Better Auth's schema is not set up.
  await migrateBetterAuth(auth);
  return auth;
}

/** Signs a fresh user up and returns a bearer token good for that session (via Better Auth's `set-auth-token` header). */
async function bearerTokenForNewUser(auth: RelayAuth, email: string): Promise<string> {
  const response = await auth.api.signUpEmail({
    body: { email, password: 'correct horse battery staple', name: email },
    asResponse: true,
  });
  const token = response.headers.get('set-auth-token');
  if (!token) throw new Error('test setup: no set-auth-token header on sign-up response');
  return token;
}

describe('Better Auth mounted on the relay (#119)', () => {
  it('mounts at /api/auth/* on the relay Fastify instance and completes a session end to end over real HTTP', async () => {
    const auth = await buildTestAuth();
    const app = Fastify();
    mountBetterAuth(app, auth);
    await app.ready();

    const signUp = await app.inject({
      method: 'POST',
      url: BETTER_AUTH_ROUTE_PREFIX.replace('*', 'sign-up/email'),
      payload: {
        email: 'relay-auth-test@example.com',
        password: 'correct horse battery staple',
        name: 'Test',
      },
    });
    expect(signUp.statusCode).toBe(200);
    const setAuthToken = signUp.headers['set-auth-token'];
    expect(typeof setAuthToken).toBe('string');

    const getSession = await app.inject({
      method: 'GET',
      url: BETTER_AUTH_ROUTE_PREFIX.replace('*', 'get-session'),
      headers: { authorization: `Bearer ${String(setAuthToken)}` },
    });
    expect(getSession.statusCode).toBe(200);
    const body = JSON.parse(getSession.body) as { user?: { email?: string } };
    expect(body.user?.email).toBe('relay-auth-test@example.com');

    await app.close();
  });
});

describe('social provider registration is env-gated (#120)', () => {
  it('registers github when its credentials are supplied', async () => {
    const auth = await buildTestAuth({
      github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
    });
    expect(auth.options.socialProviders?.github).toMatchObject({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
    });
  });

  it('does not register google when its credentials are absent, and startup does not crash', async () => {
    const auth = await buildTestAuth({
      github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
    });
    expect(auth.options.socialProviders?.google).toBeUndefined();
  });

  it('registers neither provider when no OAuth env is configured at all', async () => {
    const auth = await buildTestAuth();
    expect(auth.options.socialProviders?.github).toBeUndefined();
    expect(auth.options.socialProviders?.google).toBeUndefined();
  });
});

describe('resolveAccountIdViaBetterAuth — the Bearer resolver (#121, #122)', () => {
  it('resolves a valid bearer token to its accountId (the Better Auth user id)', async () => {
    const auth = await buildTestAuth();
    const token = await bearerTokenForNewUser(auth, 'valid@example.com');

    const accountId = await resolveAccountIdViaBetterAuth(auth, token);
    expect(accountId).toBeDefined();
    expect(typeof accountId).toBe('string');
  });

  it('rejects an invalid bearer token', async () => {
    const auth = await buildTestAuth();
    const accountId = await resolveAccountIdViaBetterAuth(auth, 'not-a-real-token');
    expect(accountId).toBeUndefined();
  });

  it('rejects an absent/empty bearer token', async () => {
    const auth = await buildTestAuth();
    const accountId = await resolveAccountIdViaBetterAuth(auth, '');
    expect(accountId).toBeUndefined();
  });

  it('two devices presenting the same account bearer resolve to the same accountId', async () => {
    const auth = await buildTestAuth();
    const tokenDeviceA = await bearerTokenForNewUser(auth, 'shared-account@example.com');

    // A second "device" logging back in as the same user gets its own session/token,
    // but both must resolve to the SAME underlying accountId.
    const signIn = await auth.api.signInEmail({
      body: { email: 'shared-account@example.com', password: 'correct horse battery staple' },
      asResponse: true,
    });
    const tokenDeviceB = signIn.headers.get('set-auth-token');
    expect(tokenDeviceB).toBeTruthy();

    const accountIdA = await resolveAccountIdViaBetterAuth(auth, tokenDeviceA);
    const accountIdB = await resolveAccountIdViaBetterAuth(auth, tokenDeviceB ?? '');
    expect(accountIdA).toBeDefined();
    expect(accountIdA).toBe(accountIdB);
  });

  it('account A never resolves to account B: two distinct accounts stay distinct', async () => {
    const auth = await buildTestAuth();
    const tokenA = await bearerTokenForNewUser(auth, 'account-a@example.com');
    const tokenB = await bearerTokenForNewUser(auth, 'account-b@example.com');

    const accountIdA = await resolveAccountIdViaBetterAuth(auth, tokenA);
    const accountIdB = await resolveAccountIdViaBetterAuth(auth, tokenB);
    expect(accountIdA).toBeDefined();
    expect(accountIdB).toBeDefined();
    expect(accountIdA).not.toBe(accountIdB);
  });
});

describe('deriveAccountIdStub — the zero-config dev/hermetic-test fallback', () => {
  it('is a pass-through, not real authentication (documented, deliberate)', () => {
    expect(deriveAccountIdStub('anything')).toBe('anything');
  });
});

describe('migrateBetterAuth — boot-time schema setup (#119)', () => {
  it('creates Better Auth tables so login works; without it the store 500s on a missing relation', async () => {
    const database = new Database(':memory:');
    const auth = createRelayAuth({
      database,
      baseURL: 'http://127.0.0.1:0',
      secret: 'hermetic-test-secret-hermetic-test-secret',
      enableEmailPasswordForTests: true,
    });

    // Before migrating, Better Auth's own tables do not exist: any operation
    // that touches them fails (this is exactly the prod deploy regression —
    // "relation \"verification\" does not exist").
    await expect(
      auth.api.signUpEmail({
        body: { email: 'pre@example.com', password: 'correct horse battery staple', name: 'pre' },
        asResponse: true,
      }),
    ).rejects.toThrow();

    await migrateBetterAuth(auth);

    // After migrating, the same call succeeds and issues a session token.
    const response = await auth.api.signUpEmail({
      body: { email: 'post@example.com', password: 'correct horse battery staple', name: 'post' },
      asResponse: true,
    });
    expect(response.headers.get('set-auth-token')).toBeTruthy();
  });
});
