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
});
