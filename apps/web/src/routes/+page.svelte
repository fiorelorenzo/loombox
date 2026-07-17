<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type {
    AcpConfigOption,
    AcpPermissionOption,
    AcpSessionStatus,
    PermissionQueueState,
    TranscriptState,
  } from '@loombox/providers-core';
  import { createPermissionQueueState, headPermissionRequest } from '@loombox/providers-core';
  import { APP_NAME, APP_TAGLINE } from '$lib/constants';
  import { copyToClipboard, exportTranscriptText } from '$lib/copy';
  import { RelayClient, type ClientSessionMeta, type ConnectionStatus } from '$lib/relay-client';
  import { AuthStore, type StoredAuthSession } from '$lib/auth-store';
  import { createLocalStorageAmkStorage, loadOrCreateAmk } from '$lib/amk-store';
  import { hasBlockingAttachments, type ComposerAttachment } from '$lib/attachments';
  import type { QueuedPrompt } from '$lib/outbox';
  import AttachmentBar from '$lib/components/AttachmentBar.svelte';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import MessageItem from '$lib/components/MessageItem.svelte';
  import PermissionQueueBar from '$lib/components/PermissionQueueBar.svelte';
  import PlanCard from '$lib/components/PlanCard.svelte';
  import QueuedPromptBar from '$lib/components/QueuedPromptBar.svelte';
  import ToolCallRow from '$lib/components/ToolCallRow.svelte';

  // Disposable v1 relay (SPEC §12): no default deployment, so the operator
  // points the PWA at whatever host/port the relay printed (loopback here;
  // a phone on the tailnet types the tailnet URL). Better Auth's routes
  // (`/api/auth/*`, SPEC §8) live on that same relay, on the http(s)
  // counterpart of this ws(s) URL.
  const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8787/ws';
  const RELAY_URL_STORAGE_KEY = 'loombox:relay-url';

  /** `ws(s)://host:port/ws` -> `http(s)://host:port` — Better Auth is mounted on the relay's own Fastify server, not a separate host. */
  function relayHttpBaseUrl(wsUrl: string): string {
    return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  let relayUrl = $state(DEFAULT_RELAY_URL);

  // Real Better Auth login (SPEC §8): GitHub OAuth only, no manually-typed
  // account id. `authStore`/`amkStorage` are only ever constructed client-
  // side (onMount below) — this file is also rendered SSR by
  // `routes/page.test.ts`, where `window`/`localStorage` don't exist.
  let authStore: AuthStore | undefined;
  let amkStorage: ReturnType<typeof createLocalStorageAmkStorage> | undefined;
  let authSession = $state<StoredAuthSession | undefined>(undefined);
  // Distinguishes "haven't checked yet" from "checked, not signed in" so the
  // sign-in gate doesn't flash before `restoreSession()` resolves.
  let authChecked = $state(false);
  let authError = $state<string | undefined>(undefined);

  let status = $state<ConnectionStatus>('idle');
  let sessions = $state<ClientSessionMeta[]>([]);
  let selectedSessionId = $state<string | undefined>(undefined);
  let transcript = $state<TranscriptState | undefined>(undefined);
  let permissionQueue = $state<PermissionQueueState>(createPermissionQueueState());
  let configOptions = $state<AcpConfigOption[]>([]);
  let attachments = $state<ComposerAttachment[]>([]);
  let queuedPrompts = $state<QueuedPrompt[]>([]);
  let draft = $state('');
  // A plan's collapse state persists per session for as long as this tab
  // stays open (SPEC §7.24 "remembers collapse state during the session"),
  // keyed by session id so switching sessions and back preserves it.
  // `SvelteMap` (not a plain `Map` wrapped in `$state`) so `.set()` itself
  // triggers reactivity instead of requiring a clone-and-reassign dance.
  const planCollapsedBySession = new SvelteMap<string, boolean>();

  // Live per-session status badge for the session list (SPEC §7.13/§7.24;
  // issue #126 "list updates live as session status changes"). Every
  // currently-listed session gets its own `RelayClient.statusFor`
  // subscription — not only the selected one, since the badge must be
  // visible for every session in the list, not just the one currently open.
  const sessionStatuses = new SvelteMap<string, AcpSessionStatus | undefined>();
  const sessionStatusUnsubscribers = new SvelteMap<string, () => void>();

  /** (Re)syncs `sessionStatuses`' subscriptions to exactly the currently-listed sessions — called every time `client.sessions` emits. */
  function syncSessionStatusSubscriptions(list: ClientSessionMeta[]): void {
    if (!client) return;
    const activeClient = client;
    const currentIds = new Set(list.map((session) => session.id));
    for (const [id, unsubscribe] of sessionStatusUnsubscribers) {
      if (currentIds.has(id)) continue;
      unsubscribe();
      sessionStatusUnsubscribers.delete(id);
      sessionStatuses.delete(id);
    }
    for (const session of list) {
      if (sessionStatusUnsubscribers.has(session.id)) continue;
      const unsubscribe = activeClient
        .statusFor(session.id)
        .subscribe((value) => sessionStatuses.set(session.id, value));
      sessionStatusUnsubscribers.set(session.id, unsubscribe);
    }
  }

  function clearSessionStatusSubscriptions(): void {
    for (const unsubscribe of sessionStatusUnsubscribers.values()) unsubscribe();
    sessionStatusUnsubscribers.clear();
    sessionStatuses.clear();
  }

  // Persists an operator-edited relay URL as soon as it changes (not just on
  // submit) so it survives the full-page reload a real OAuth redirect does —
  // see `onMount`'s restore of the same key. `$effect` is client/DOM-only in
  // Svelte 5 (never runs during `routes/page.test.ts`'s SSR render).
  $effect(() => {
    localStorage.setItem(RELAY_URL_STORAGE_KEY, relayUrl);
  });

  const planCollapsed = $derived(
    selectedSessionId ? (planCollapsedBySession.get(selectedSessionId) ?? false) : false,
  );
  const permissionHead = $derived(
    selectedSessionId ? headPermissionRequest(permissionQueue, selectedSessionId) : undefined,
  );
  // Issue #155's send-gate: disabled while any attachment is mid-upload or failed.
  const sendDisabled = $derived(draft.trim() === '' || hasBlockingAttachments(attachments));

  // Most logic (the WS connection, the E2E-encrypted session list, the
  // transcript decrypt+reduce, the permission queue, config options, and the
  // composer's send path) lives in $lib/relay-client.ts, unit-tested there
  // against a real in-process relay plus a fake independently-keyed node —
  // no browser. This component renders that module's stores through the
  // Wave D.2 widget set ($lib/components/*): tier-1/tier-2 tool-call
  // widgets, the diff viewer, the inline plan card, the permission FIFO
  // queue bar, and the config bar, each unit-tested on its own against fixed
  // fixtures rather than through this page.
  let client: RelayClient | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeTranscript: (() => void) | undefined;
  let unsubscribePermissionQueue: (() => void) | undefined;
  let unsubscribeConfigOptions: (() => void) | undefined;
  let unsubscribeAttachments: (() => void) | undefined;
  let unsubscribeQueuedPrompts: (() => void) | undefined;

  function selectSession(id: string): void {
    selectedSessionId = id;
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    attachments = [];
    queuedPrompts = [];
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
    unsubscribePermissionQueue = client
      .permissionQueueFor(id)
      .subscribe((value) => (permissionQueue = value));
    unsubscribeConfigOptions = client
      .configOptionsFor(id)
      .subscribe((value) => (configOptions = value));
    unsubscribeAttachments = client.attachmentsFor(id).subscribe((value) => (attachments = value));
    unsubscribeQueuedPrompts = client
      .queuedPromptsFor(id)
      .subscribe((value) => (queuedPrompts = value));
  }

  /**
   * Connects the relay's WS session once this device has both halves of
   * real v1 auth (SPEC §8): a Better Auth bearer token (the WS handshake's
   * `authToken` — no longer a stub) and this device's own persisted AMK
   * (`amk-store.ts`'s `loadOrCreateAmk`, generated once and reused, not
   * injected). Both come from `session`/`amkStorage`, never from a form
   * field.
   */
  function connect(session: StoredAuthSession): void {
    if (typeof window === 'undefined' || client || !amkStorage) return;
    const amk = loadOrCreateAmk(session.accountId, amkStorage);
    client = new RelayClient({
      relayUrl,
      amk,
      accountId: session.accountId,
      authToken: session.token,
    });
    unsubscribeStatus = client.status.subscribe((value) => (status = value));
    unsubscribeSessions = client.sessions.subscribe((value) => {
      sessions = value;
      syncSessionStatusSubscriptions(value);
      if (!selectedSessionId && value[0]) selectSession(value[0].id);
    });
    client.connect();
  }

  function disconnect(): void {
    unsubscribeStatus?.();
    unsubscribeSessions?.();
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    clearSessionStatusSubscriptions();
    client?.close();
    client = undefined;
    status = 'idle';
    sessions = [];
    selectedSessionId = undefined;
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    attachments = [];
    queuedPrompts = [];
  }

  function ensureAuthStore(): AuthStore {
    authStore ??= new AuthStore({ relayBaseUrl: relayHttpBaseUrl(relayUrl) });
    return authStore;
  }

  /** SPEC §8: login is Google/GitHub OAuth only — this starts the real browser redirect to the relay's Better Auth. */
  async function signInWithGithub(): Promise<void> {
    authError = undefined;
    try {
      await ensureAuthStore().signInWithGithub(window.location.href);
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
    }
  }

  async function signOut(): Promise<void> {
    disconnect();
    await authStore?.signOut();
  }

  function submitPrompt(event: Event): void {
    event.preventDefault();
    const text = draft.trim();
    if (!client || !selectedSessionId || text === '' || sendDisabled) return;
    const attachmentIds = attachments.map((a) => a.id);
    client.sendPrompt(selectedSessionId, text, attachmentIds);
    draft = '';
  }

  /** Wired to `AttachmentBar`'s `onFiles` (paste/drop/pick, SPEC §7.25) — attaches each picked file to the current session, starting its encrypt+upload immediately. */
  function attachFiles(files: File[]): void {
    if (!client || !selectedSessionId) return;
    for (const file of files) {
      client.attachFile(selectedSessionId, file);
    }
  }

  function retryAttachment(id: string): void {
    if (!client || !selectedSessionId) return;
    client.retryAttachment(selectedSessionId, id);
  }

  function removeAttachment(id: string): void {
    if (!client || !selectedSessionId) return;
    client.removeAttachment(selectedSessionId, id);
  }

  function togglePlanCollapsed(): void {
    if (!selectedSessionId) return;
    planCollapsedBySession.set(
      selectedSessionId,
      !(planCollapsedBySession.get(selectedSessionId) ?? false),
    );
  }

  function resolvePermission(requestId: string, option: AcpPermissionOption): void {
    if (!client || !selectedSessionId) return;
    client.resolvePermission(selectedSessionId, requestId, option);
  }

  function stopSession(): void {
    if (!client || !selectedSessionId) return;
    client.cancelPermissionRequests(selectedSessionId);
  }

  function changeConfigOption(category: string, optionId: string): void {
    if (!client || !selectedSessionId) return;
    client.setConfigOption(selectedSessionId, category, optionId);
  }

  async function exportTranscript(): Promise<void> {
    if (!transcript) return;
    await copyToClipboard(exportTranscriptText(transcript));
  }

  onMount(() => {
    amkStorage = createLocalStorageAmkStorage();

    // Restores an operator-customized relay URL before constructing
    // `authStore` against it, so a self-hoster who edits this field, then
    // signs in (a full-page OAuth redirect that reloads this component from
    // scratch on return), lands back on the SAME relay's session rather than
    // silently falling back to `DEFAULT_RELAY_URL`.
    const persistedRelayUrl = localStorage.getItem(RELAY_URL_STORAGE_KEY);
    if (persistedRelayUrl) relayUrl = persistedRelayUrl;

    const store = ensureAuthStore();

    const unsubscribeAuthSession = store.session.subscribe((value) => {
      authSession = value;
      if (value) {
        connect(value);
      } else {
        disconnect();
      }
    });

    // Picks up a session this device already had (a stored bearer token) or
    // just received (this is the page Better Auth's OAuth callback
    // redirected back to) before showing the sign-in gate.
    store
      .restoreSession()
      .catch((error: unknown) => {
        authError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        authChecked = true;
      });

    return () => {
      unsubscribeAuthSession();
      disconnect();
    };
  });
</script>

<main>
  <header>
    <h1>{APP_NAME}</h1>
    <p>{APP_TAGLINE}</p>
  </header>

  {#if !authChecked}
    <section class="connection">
      <p class="empty">Checking session…</p>
    </section>
  {:else if !authSession}
    <section class="connection sign-in">
      <label for="relay-url">Relay URL</label>
      <input id="relay-url" type="text" bind:value={relayUrl} />
      <button type="button" onclick={signInWithGithub}>Sign in with GitHub</button>
      {#if authError}
        <p class="error" role="alert">{authError}</p>
      {/if}
    </section>
  {:else}
    <section class="connection">
      <span class="account">{authSession.accountId}</span>
      <span class="status" data-status={status}>status: {status}</span>
      <button type="button" onclick={signOut}>Sign out</button>
      {#if authError}
        <p class="error" role="alert">{authError}</p>
      {/if}
    </section>

    <div class="cockpit">
      <aside class="sessions">
        <h2>Sessions</h2>
        {#if status === 'connecting' || status === 'idle'}
          <p class="empty">Loading sessions…</p>
        {:else if sessions.length === 0}
          <p class="empty">No sessions yet.</p>
        {:else}
          <ul>
            {#each sessions as session (session.id)}
              <li>
                <button
                  type="button"
                  class="session"
                  class:selected={session.id === selectedSessionId}
                  onclick={() => selectSession(session.id)}
                >
                  <span class="session-title-row">
                    <strong>{session.title}</strong>
                    {#if sessionStatuses.get(session.id)}
                      <span
                        class="status-badge"
                        data-status={sessionStatuses.get(session.id)}
                        data-testid="session-status-badge"
                      >
                        {sessionStatuses.get(session.id)}
                      </span>
                    {/if}
                  </span>
                  <small>{session.provider} · {session.projectPath} · {session.targetId}</small>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <section class="transcript">
        {#if !selectedSessionId}
          <p class="empty">Select a session to view its live transcript.</p>
        {:else}
          <div class="transcript-toolbar">
            <ConfigBar
              options={configOptions}
              usage={transcript?.usage}
              cumulativeCostUsd={transcript?.cumulativeCostUsd ?? 0}
              onChange={changeConfigOption}
            />
            <CopyButton
              text={transcript ? exportTranscriptText(transcript) : ''}
              label="Export transcript"
              copyFn={exportTranscript}
            />
          </div>

          <ol class="items">
            {#each transcript?.items ?? [] as item (item.id)}
              <li>
                {#if item.type === 'message'}
                  <MessageItem {item} />
                {:else}
                  <ToolCallRow
                    {item}
                    awaitingPermission={permissionHead?.toolCall.id === item.id}
                  />
                {/if}
              </li>
            {/each}
          </ol>

          {#if transcript && transcript.plan.length > 0}
            <PlanCard
              entries={transcript.plan}
              collapsed={planCollapsed}
              onToggle={togglePlanCollapsed}
            />
          {/if}

          <QueuedPromptBar prompts={queuedPrompts} />

          <PermissionQueueBar
            sessionId={selectedSessionId}
            queue={permissionQueue}
            onResolve={resolvePermission}
            onStop={stopSession}
          />

          <form class="composer" onsubmit={submitPrompt}>
            <AttachmentBar
              {attachments}
              onFiles={attachFiles}
              onRetry={retryAttachment}
              onRemove={removeAttachment}
            />
            <div class="composer-row">
              <input
                type="text"
                bind:value={draft}
                placeholder="Send a follow-up prompt…"
                aria-label="Follow-up prompt"
              />
              <button type="submit" disabled={sendDisabled}>Send</button>
            </div>
          </form>
        {/if}
      </section>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    gap: 1rem;
    padding: 1rem;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

  header {
    text-align: center;
  }

  h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  header p {
    margin: 0.25rem 0 0;
    opacity: 0.7;
  }

  .connection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .connection input {
    flex: 1;
    min-width: 10rem;
  }

  .status {
    opacity: 0.7;
    font-size: 0.85rem;
  }

  .account {
    font-family: monospace;
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .error {
    color: #e5484d;
    margin: 0;
    font-size: 0.85rem;
    width: 100%;
  }

  .cockpit {
    display: flex;
    flex: 1;
    gap: 1rem;
    min-height: 0;
  }

  .sessions {
    width: 16rem;
    flex-shrink: 0;
  }

  .sessions h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }

  .sessions ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .session {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
  }

  .session.selected {
    border-color: currentColor;
  }

  .session small {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    min-width: 0;
  }

  .session-title-row strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Session-status badge (SPEC §7.13/§7.24; issue #126) — a neutral default,
     overridden per status so a glance at the list shows what needs attention. */
  .status-badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: rgba(127, 127, 127, 0.2);
    opacity: 0.85;
  }

  .status-badge[data-status='working'] {
    background: rgba(79, 70, 229, 0.25);
  }

  .status-badge[data-status='permission_required'] {
    background: rgba(217, 119, 6, 0.3);
  }

  .status-badge[data-status='error'] {
    background: rgba(229, 72, 77, 0.3);
  }

  .status-badge[data-status='exited'] {
    background: rgba(127, 127, 127, 0.35);
  }

  .transcript {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    gap: 0.6rem;
  }

  .transcript-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid rgba(127, 127, 127, 0.2);
    padding-bottom: 0.4rem;
  }

  .items {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .composer-row {
    display: flex;
    gap: 0.5rem;
  }

  .composer-row input {
    flex: 1;
  }

  .empty {
    opacity: 0.6;
  }
</style>
