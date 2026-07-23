<script lang="ts">
  /**
   * The device-authorization approval screen (issue #387): a signed-in
   * operator lands here — either by typing the URL directly, or by
   * following the `verification_uri_complete` a resident node printed
   * (`?user_code=...`, pre-filling the field) — and approves or denies the
   * pending request. Its own SvelteKit route (not folded into the main
   * `routes/+page.svelte` cockpit shell) since it's reachable from a
   * completely different entry point (a node's printed link, not the app's
   * own navigation) and has nothing to do with any live session.
   *
   * Reuses the exact same relay-URL/AuthStore construction and sign-in gate
   * `routes/+page.svelte` uses (`DEFAULT_RELAY_URL`, `RELAY_URL_STORAGE_KEY`,
   * `AuthStore`/`restoreSession`) so a self-hoster's customized relay URL and
   * an already-signed-in session both carry over between the two pages.
   */
  import { onMount } from 'svelte';
  import { env as publicEnv } from '$env/dynamic/public';
  import { APP_TAGLINE } from '$lib/constants';
  import { AuthStore, type StoredAuthSession } from '$lib/auth-store';
  import { approveDevice, denyDevice, type DeviceApprovalOutcome } from '$lib/device-approve';
  import BrandLockup from '$lib/components/BrandLockup.svelte';
  import DeviceApprove from '$lib/components/DeviceApprove.svelte';
  import WovenLoader from '$lib/components/WovenLoader.svelte';

  const DEFAULT_RELAY_URL = publicEnv.PUBLIC_LOOMBOX_RELAY_URL || 'wss://relay.loombox.dev';
  const RELAY_URL_STORAGE_KEY = 'loombox:relay-url';

  /** `ws(s)://host:port/ws` -> `http(s)://host:port` — mirrors `routes/+page.svelte`'s own copy; `/device/*` is mounted on the relay's same Fastify server as Better Auth's `/api/auth/*`. */
  function relayHttpBaseUrl(wsUrl: string): string {
    return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  let relayUrl = $state(DEFAULT_RELAY_URL);

  let authStore: AuthStore | undefined;
  let authSession = $state<StoredAuthSession | undefined>(undefined);
  let authChecked = $state(false);
  let authError = $state<string | undefined>(undefined);

  let initialUserCode = $state('');
  let busy = $state(false);
  let outcome = $state<'approved' | 'denied' | undefined>(undefined);
  let error = $state<string | undefined>(undefined);

  function messageFor(result: Extract<DeviceApprovalOutcome, { status: string }>): string {
    switch (result.status) {
      case 'invalid_code':
        return "That code doesn't match a pending request. Double-check it and try again.";
      case 'expired':
        return 'That code has expired. Restart the login on the node and try again.';
      case 'already_resolved':
        return 'That request was already approved or denied.';
      case 'unauthorized':
        return 'Your session expired — sign in again.';
      case 'error':
        return result.message;
      default:
        return 'Something went wrong. Try again.';
    }
  }

  async function ensureAuthStore(): Promise<AuthStore> {
    authStore ??= new AuthStore({ relayBaseUrl: relayHttpBaseUrl(relayUrl) });
    return authStore;
  }

  async function signInWithGithub(): Promise<void> {
    const store = await ensureAuthStore();
    await store.signInWithGithub(window.location.href);
  }

  async function handleApprove(userCode: string): Promise<void> {
    if (!authSession) return;
    busy = true;
    error = undefined;
    const result = await approveDevice({
      relayBaseUrl: relayHttpBaseUrl(relayUrl),
      authToken: authSession.token,
      userCode,
    });
    busy = false;
    if (result.status === 'approved') {
      outcome = 'approved';
    } else {
      error = messageFor(result);
    }
  }

  async function handleDeny(userCode: string): Promise<void> {
    if (!authSession) return;
    busy = true;
    error = undefined;
    const result = await denyDevice({
      relayBaseUrl: relayHttpBaseUrl(relayUrl),
      authToken: authSession.token,
      userCode,
    });
    busy = false;
    if (result.status === 'denied') {
      outcome = 'denied';
    } else {
      error = messageFor(result);
    }
  }

  onMount(() => {
    const persistedRelayUrl = localStorage.getItem(RELAY_URL_STORAGE_KEY);
    if (persistedRelayUrl) relayUrl = persistedRelayUrl;

    const params = new URLSearchParams(window.location.search);
    initialUserCode = params.get('user_code') ?? '';

    authStore = new AuthStore({ relayBaseUrl: relayHttpBaseUrl(relayUrl) });
    const store = authStore;

    const unsubscribe = store.session.subscribe((value) => {
      authSession = value;
    });

    store
      .restoreSession()
      .catch((err: unknown) => {
        authError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        authChecked = true;
      });

    return unsubscribe;
  });
</script>

<main>
  <header>
    <h1 class="brand-heading"><BrandLockup /></h1>
    <p>{APP_TAGLINE}</p>
  </header>

  <section class="device-approve-card">
    <h2>Link a device</h2>

    {#if !authChecked}
      <p class="empty loading-line">
        <WovenLoader label="Checking session" />
        Checking session…
      </p>
    {:else if !authSession}
      <div class="sign-in">
        <p>Sign in to approve this device.</p>
        <button type="button" onclick={signInWithGithub}>Sign in with GitHub</button>
        {#if authError}
          <p class="error" role="alert">{authError}</p>
        {/if}
      </div>
    {:else}
      <p class="hint">Enter (or confirm) the code your node printed to link it to your account.</p>
      <DeviceApprove
        {initialUserCode}
        onApprove={handleApprove}
        onDeny={handleDeny}
        {busy}
        {outcome}
        {error}
      />
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 32rem;
    margin: 0 auto;
    padding: var(--space-xl) var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  header p {
    color: var(--color-text-secondary);
    margin: var(--space-2xs) 0 0;
  }

  .device-approve-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .device-approve-card h2 {
    margin: 0;
  }

  .hint {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    margin: 0;
  }

  .sign-in {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    align-items: flex-start;
  }

  .sign-in button {
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-sm) var(--space-lg);
    cursor: pointer;
    font-weight: 600;
  }

  .sign-in button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .empty {
    color: var(--color-text-muted);
  }

  .loading-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
