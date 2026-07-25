// @vitest-environment jsdom
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createRelayAuth, startRelay, type RelayAuth, type StartedRelay } from '@loombox/relay';

import {
  AuthStore,
  createInMemoryAuthStorage,
  createLocalStorageAuthStorage,
  type AuthStorage,
} from './auth-store';

/**
 * Applies Better Auth's own schema to the hermetic sqlite database — the
 * exact same call `packages/relay/src/auth.ts`'s `migrateBetterAuth` makes
 * (`better-auth/db/migration`'s `getMigrations`/`runMigrations`), inlined
 * here rather than imported because `migrateBetterAuth` isn't part of
 * `@loombox/relay`'s public `index.ts` export surface and this PR does not
 * touch `packages/relay` to add it.
 */
async function migrateBetterAuth(auth: RelayAuth): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * Hermetic Better Auth setup mirroring `packages/relay/src/auth.test.ts`'s
 * `buildTestAuth`: a `better-sqlite3` in-memory database, and
 * `enableEmailPasswordForTests` standing in for a real GitHub OAuth
 * provider so this suite can drive a real sign-in over real HTTP without
 * ever calling out to GitHub — this file never imports/uses
 * `signInWithGithub` for exactly that reason.
 */
async function startAuthedRelay(): Promise<StartedRelay> {
  const database = new Database(':memory:');
  const auth: RelayAuth = createRelayAuth({
    database,
    baseURL: 'http://127.0.0.1:0',
    secret: 'hermetic-test-secret-hermetic-test-secret',
    enableEmailPasswordForTests: true,
  });
  await migrateBetterAuth(auth);
  return startRelay({ auth });
}

/** `ws://host:port/ws` (what `StartedRelay.url` is) -> `http://host:port` (Better Auth's routes live on the same Fastify instance). */
function httpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

let relay: StartedRelay;
let relayBaseUrl: string;

beforeEach(async () => {
  relay = await startAuthedRelay();
  relayBaseUrl = httpBaseUrl(relay.url);
});

afterEach(async () => {
  await relay.close();
});

describe('AuthStore', () => {
  it('signUpWithEmailPassword resolves a bearer token + accountId and persists them', async () => {
    const storage = createInMemoryAuthStorage();
    const store = new AuthStore({ relayBaseUrl, storage });

    expect(get(store.session)).toBeUndefined();

    const session = await store.signUpWithEmailPassword(
      'alice@example.com',
      'correct horse battery staple',
    );

    expect(session.token).toBeTruthy();
    expect(session.accountId).toBeTruthy();
    expect(get(store.session)).toEqual(session);
    expect(storage.get()).toEqual(session);
  });

  it('two different accounts resolve to two different accountIds', async () => {
    const storeA = new AuthStore({ relayBaseUrl, storage: createInMemoryAuthStorage() });
    const storeB = new AuthStore({ relayBaseUrl, storage: createInMemoryAuthStorage() });

    const sessionA = await storeA.signUpWithEmailPassword(
      'a@example.com',
      'correct horse battery staple',
    );
    const sessionB = await storeB.signUpWithEmailPassword(
      'b@example.com',
      'correct horse battery staple',
    );

    expect(sessionA.accountId).not.toBe(sessionB.accountId);
  });

  it('signInWithEmailPassword, on a SECOND "device", resolves to the SAME accountId as the original sign-up', async () => {
    const deviceA = new AuthStore({ relayBaseUrl, storage: createInMemoryAuthStorage() });
    const original = await deviceA.signUpWithEmailPassword(
      'shared-account@example.com',
      'correct horse battery staple',
    );

    const deviceB = new AuthStore({ relayBaseUrl, storage: createInMemoryAuthStorage() });
    const second = await deviceB.signInWithEmailPassword(
      'shared-account@example.com',
      'correct horse battery staple',
    );

    expect(second.accountId).toBe(original.accountId);
    // Each device still gets its own bearer token, not a shared one.
    expect(second.token).not.toBe(original.token);
  });

  it('restoreSession recovers a persisted session on a fresh AuthStore instance (simulating a reload), without a new sign-in', async () => {
    const storage = createInMemoryAuthStorage();
    const first = new AuthStore({ relayBaseUrl, storage });
    const original = await first.signUpWithEmailPassword(
      'bob@example.com',
      'correct horse battery staple',
    );

    // A brand-new AuthStore over the SAME storage, as if the page reloaded:
    // it hydrates synchronously from storage (no flash of "signed out" while
    // the network round trip below is in flight)...
    const second = new AuthStore({ relayBaseUrl, storage });
    expect(get(second.session)).toEqual(original);

    // ...and restoreSession() confirms it against the relay over real HTTP.
    const restored = await second.restoreSession();

    expect(restored).toEqual(original);
    expect(get(second.session)).toEqual(original);
  });

  it('restoreSession returns undefined and touches nothing when there is no stored/cookie session', async () => {
    const storage = createInMemoryAuthStorage();
    const store = new AuthStore({ relayBaseUrl, storage });

    const restored = await store.restoreSession();

    expect(restored).toBeUndefined();
    expect(get(store.session)).toBeUndefined();
    expect(storage.get()).toBeUndefined();
  });

  it('signOut clears both the reactive store and the underlying storage', async () => {
    const storage = createInMemoryAuthStorage();
    const store = new AuthStore({ relayBaseUrl, storage });
    await store.signUpWithEmailPassword('carol@example.com', 'correct horse battery staple');
    expect(get(store.session)).toBeDefined();

    await store.signOut();

    expect(get(store.session)).toBeUndefined();
    expect(storage.get()).toBeUndefined();
  });

  it('persists through a REAL window.localStorage (jsdom), the browser-default AuthStorage', async () => {
    localStorage.clear();
    const storage: AuthStorage = createLocalStorageAuthStorage();
    const store = new AuthStore({ relayBaseUrl, storage });

    const session = await store.signUpWithEmailPassword(
      'dana@example.com',
      'correct horse battery staple',
    );

    const raw = localStorage.getItem('loombox:auth-session');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? '{}')).toEqual(session);

    // A fresh AuthStore reading the same real localStorage restores it.
    const reloaded = new AuthStore({ relayBaseUrl, storage: createLocalStorageAuthStorage() });
    const restored = await reloaded.restoreSession();
    expect(restored).toEqual(session);

    localStorage.clear();
  });

  it('restoreSession recovers a cookie-only OAuth session from the get-session BODY when there is no set-auth-token header', async () => {
    // Reproduces the production GitHub-OAuth login loop: the OAuth callback
    // sets the session cookie and emits set-auth-token only on that redirect
    // response (Better Auth's Bearer plugin bails unless the response carries
    // a `set-cookie`), which the app JS never sees. The follow-up get-session
    // is authed purely by cookie, so it carries NO set-auth-token header — the
    // token has to come from the response body's `session.token`, or every
    // reload/callback clears the session and bounces back to the login screen.
    const storage = createInMemoryAuthStorage();
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('get-session')) {
        // Valid session, cookie-authed: user + session.token in the body,
        // deliberately WITHOUT a set-auth-token response header.
        return new Response(
          JSON.stringify({
            user: { id: 'acct-oauth' },
            session: { token: 'cookie-session-token' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const store = new AuthStore({ relayBaseUrl: 'http://relay.test', storage, fetchImpl });

    const restored = await store.restoreSession();

    const expected = { token: 'cookie-session-token', accountId: 'acct-oauth' };
    expect(restored).toEqual(expected);
    expect(storage.get()).toEqual(expected);
    expect(get(store.session)).toEqual(expected);
  });

  it("the get-session body's raw session.token is itself a valid bearer against the real relay", async () => {
    // The fix above persists `session.token` from the get-session body for the
    // OAuth flow. That token is the RAW (unsigned) form, different from the
    // signed `set-auth-token` header value — so this proves the relay actually
    // accepts it as a bearer (bearer() with no requireSignature re-signs a
    // dot-less token server-side), against real HTTP, not a mock.
    const store = new AuthStore({ relayBaseUrl, storage: createInMemoryAuthStorage() });
    const signed = await store.signUpWithEmailPassword(
      'oauth-shape@example.com',
      'correct horse battery staple',
    );

    // Read the body's raw session.token (what restoreSession would persist).
    const bodyRes = await fetch(`${relayBaseUrl}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${signed.token}` },
    });
    const body = (await bodyRes.json()) as { session?: { token?: string } };
    const rawToken = body.session?.token;
    expect(rawToken).toBeTruthy();
    expect(rawToken).not.toBe(signed.token); // unsigned, differs from the header bearer

    // The raw token, presented as a bearer, resolves the SAME account.
    const asBearerRes = await fetch(`${relayBaseUrl}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const asBearer = (await asBearerRes.json()) as { user?: { id?: string } };
    expect(asBearer.user?.id).toBe(signed.accountId);
  });
});
