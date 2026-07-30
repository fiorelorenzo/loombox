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
  import { AuthStore, type StoredAuthSession } from '$lib/auth-store';
  import { approveDevice, denyDevice, type DeviceApprovalOutcome } from '$lib/device-approve';
  import DeviceApprove from '$lib/components/DeviceApprove.svelte';
  import GateShell from '$lib/components/GateShell.svelte';
  import WovenLoader from '$lib/components/WovenLoader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import ErrorNotice from '$lib/components/ui/ErrorNotice.svelte';

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

<GateShell width="wide">
  <Card elevation="floating" padding="lg" class="device-approve-card">
    <h2>Link a device</h2>

    {#if !authChecked}
      <div class="gate-checking">
        <WovenLoader size="md" label="Checking session" />
        <p>Checking session…</p>
      </div>
    {:else if !authSession}
      <div class="sign-in">
        <p>Sign in to approve this device.</p>
        <Button variant="primary" fullWidth onclick={signInWithGithub}>Sign in with GitHub</Button>
        {#if authError}
          <ErrorNotice message={authError} />
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
  </Card>
</GateShell>

<style>
  /* The composition (centring, the woven field, the lockup + tagline, the
     theme control) is `GateShell`'s — this route used to hand-roll its own
     top-aligned `max-width` column with a duplicate header, which is why it
     and the sign-in gate drifted apart in the first place. */

  /* `Card` renders its own outer element in its own component scope (see
     that file's `Card`-vs-`className` doc comment); `:global()` here is the
     documented way to reach it, mirroring `EmptyState`'s own doc comment
     for the identical situation — this route has no other
     `.device-approve-card`-classed element, so an unscoped `:global()` is
     safe here (unlike `RecoveryCodeCard.svelte`, which narrows it under a
     local ancestor class). */
  :global(.device-approve-card) {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  :global(.device-approve-card) h2 {
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
  }

  /* Matches the sign-in gate's own checking state (`routes/+page.svelte`), so
     the two screens that can both say "Checking session…" say it identically:
     the woven motif at `md`, centred, not a 12px speck inline with the text. */
  .gate-checking {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-md);
    padding: var(--space-md) 0;
  }

  .gate-checking p {
    margin: 0;
    color: var(--color-text-secondary);
  }
</style>
