import { createAuthClient } from 'better-auth/client';
import { writable, type Readable } from 'svelte/store';

/**
 * The Better Auth session this client actually needs (SPEC §8): the bearer
 * `token` to present as the WS handshake's `authToken`, and the `accountId`
 * (Better Auth's `user.id`) every session key is derived under
 * (`@loombox/crypto`'s `deriveSessionKey(amk, accountId, sessionId)`) — the
 * exact same id the relay's own `resolveAccountIdViaBetterAuth` resolves
 * the same bearer token to server-side, so a client that persists this pair
 * always derives what the node encrypted.
 */
export interface StoredAuthSession {
  token: string;
  accountId: string;
}

/**
 * Where the bearer/account pair is persisted between reloads, so a returning
 * user isn't asked to click "Sign in with GitHub" every time they open the
 * app. Injectable so tests never touch the real browser `localStorage`
 * global unless they explicitly opt into a jsdom-backed one (see
 * `createLocalStorageAuthStorage` below).
 */
export interface AuthStorage {
  get(): StoredAuthSession | undefined;
  set(session: StoredAuthSession | undefined): void;
}

const STORAGE_KEY = 'loombox:auth-session';

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.token === 'string' && typeof candidate.accountId === 'string';
}

/** The real, `window.localStorage`-backed `AuthStorage` (browser + jsdom). */
export function createLocalStorageAuthStorage(
  storage: Storage = globalThis.localStorage,
): AuthStorage {
  return {
    get() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isStoredAuthSession(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    set(session) {
      if (session) storage.setItem(STORAGE_KEY, JSON.stringify(session));
      else storage.removeItem(STORAGE_KEY);
    },
  };
}

/** An `AuthStorage` that keeps its session only in memory — the default when no browser storage is available (SSR) or wanted (tests). */
export function createInMemoryAuthStorage(): AuthStorage {
  let current: StoredAuthSession | undefined;
  return {
    get: () => current,
    set: (session) => {
      current = session;
    },
  };
}

export interface AuthStoreOptions {
  /** The relay's HTTP(S) origin Better Auth's routes are mounted on (`/api/auth/*`) — SPEC §8. */
  relayBaseUrl: string;
  /** Defaults to a real `localStorage`-backed store when `window` exists, else an in-memory one (SSR-safe). */
  storage?: AuthStorage;
  /** Override for hermetic tests (a local relay); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface FetchOnSuccessContext {
  response: Response;
}

/**
 * Owns this device's Better Auth session (SPEC §8): login is Google/GitHub
 * OAuth only in production — `signInWithGithub` starts that browser redirect,
 * which is not something a hermetic test can drive (no real GitHub call is
 * ever made from this codebase). `signInWithEmailPassword` exists purely so
 * a hermetic test can exercise the exact same bearer-token + account-id
 * plumbing against a local relay configured with Better Auth's
 * `enableEmailPasswordForTests` escape hatch (`packages/relay/src/auth.ts`) —
 * it is never wired to any UI.
 *
 * Every sign-in path converges on {@link finalizeSession}: capture the
 * bearer token Better Auth's Bearer plugin returns in the `set-auth-token`
 * response header (`docs/content/docs/plugins/bearer.mdx`, confirmed via
 * context7 `/better-auth/better-auth`), then resolve `accountId` by calling
 * `getSession` with that token — the identical call
 * `resolveAccountIdViaBetterAuth` makes server-side, so this client always
 * agrees with the relay on which account a session belongs to.
 */
export class AuthStore {
  readonly session: Readable<StoredAuthSession | undefined>;

  private readonly sessionStore = writable<StoredAuthSession | undefined>(undefined);
  private readonly storage: AuthStorage;
  private readonly client: ReturnType<typeof createAuthClient>;

  constructor(options: AuthStoreOptions) {
    this.storage =
      options.storage ??
      (typeof localStorage === 'undefined'
        ? createInMemoryAuthStorage()
        : createLocalStorageAuthStorage());
    this.session = this.sessionStore;

    const initial = this.storage.get();
    if (initial) this.sessionStore.set(initial);

    this.client = createAuthClient({
      baseURL: options.relayBaseUrl,
      ...(options.fetchImpl ? { fetchOptions: { customFetchImpl: options.fetchImpl } } : {}),
    });
  }

  /** Starts the real Google/GitHub-style OAuth redirect (SPEC §8). The browser navigates away; call {@link restoreSession} on the page that receives the callback. */
  async signInWithGithub(callbackURL?: string): Promise<void> {
    await this.client.signIn.social({ provider: 'github', callbackURL });
  }

  /**
   * Test-only escape hatch (see class docstring): registers + signs in a
   * fresh account against a local relay's `emailAndPassword` provider over
   * real HTTP, never GitHub — the client-side counterpart of
   * `packages/relay/src/auth.test.ts`'s `bearerTokenForNewUser`.
   */
  async signUpWithEmailPassword(email: string, password: string): Promise<StoredAuthSession> {
    let capturedToken: string | undefined;
    const { error } = await this.client.signUp.email(
      { email, password, name: email },
      {
        onSuccess: (ctx: FetchOnSuccessContext) =>
          this.captureToken(ctx, (token) => (capturedToken = token)),
      },
    );
    if (error) {
      throw new Error(`AuthStore: sign-up failed: ${error.message ?? 'unknown error'}`);
    }
    if (!capturedToken) {
      throw new Error('AuthStore: sign-up response carried no bearer token');
    }
    return this.finalizeSession(capturedToken);
  }

  /**
   * Test-only escape hatch (see class docstring): signs in an EXISTING
   * email/password account (created via {@link signUpWithEmailPassword})
   * against a local relay, over real HTTP, never GitHub — used to prove a
   * second "device" signing back in as the same user resolves to the same
   * `accountId` (mirrors `auth.test.ts`'s "two devices" case).
   */
  async signInWithEmailPassword(email: string, password: string): Promise<StoredAuthSession> {
    let capturedToken: string | undefined;
    const { error } = await this.client.signIn.email(
      { email, password },
      {
        onSuccess: (ctx: FetchOnSuccessContext) =>
          this.captureToken(ctx, (token) => (capturedToken = token)),
      },
    );
    if (error) {
      throw new Error(`AuthStore: sign-in failed: ${error.message ?? 'unknown error'}`);
    }
    if (!capturedToken) {
      throw new Error('AuthStore: sign-in response carried no bearer token');
    }
    return this.finalizeSession(capturedToken);
  }

  /**
   * Picks up whatever session already exists: a bearer token this device
   * persisted from a prior sign-in, or (on the page Better Auth's OAuth
   * callback redirected back to) a fresh session cookie. Clears any stale
   * local session if neither resolves. Call once on app mount.
   */
  async restoreSession(): Promise<StoredAuthSession | undefined> {
    const stored = this.storage.get();
    let capturedToken: string | undefined;
    const { data } = await this.client.getSession({
      fetchOptions: {
        ...(stored?.token ? { headers: { Authorization: `Bearer ${stored.token}` } } : {}),
        onSuccess: (ctx: FetchOnSuccessContext) =>
          this.captureToken(ctx, (token) => (capturedToken = token)),
      },
    });

    const userId = data?.user.id;
    const token = capturedToken ?? stored?.token;
    if (!userId || !token) {
      this.clearSession();
      return undefined;
    }

    const session: StoredAuthSession = { token, accountId: userId };
    this.persist(session);
    return session;
  }

  async signOut(): Promise<void> {
    await this.client.signOut().catch(() => {
      // Best-effort: the local session is cleared regardless (e.g. the
      // bearer was already expired/invalid server-side).
    });
    this.clearSession();
  }

  private async finalizeSession(token: string): Promise<StoredAuthSession> {
    const { data, error } = await this.client.getSession({
      fetchOptions: { headers: { Authorization: `Bearer ${token}` } },
    });
    if (error || !data?.user.id) {
      throw new Error('AuthStore: could not resolve an account id for the new session');
    }
    const session: StoredAuthSession = { token, accountId: data.user.id };
    this.persist(session);
    return session;
  }

  private captureToken(ctx: FetchOnSuccessContext, assign: (token: string) => void): void {
    const token = ctx.response.headers.get('set-auth-token');
    if (token) assign(token);
  }

  private persist(session: StoredAuthSession): void {
    this.storage.set(session);
    this.sessionStore.set(session);
  }

  private clearSession(): void {
    this.storage.set(undefined);
    this.sessionStore.set(undefined);
  }
}
