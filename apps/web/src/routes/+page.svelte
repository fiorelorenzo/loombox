<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type {
    AcpConfigOption,
    AcpPermissionOption,
    PermissionQueueState,
    TranscriptState,
  } from '@loombox/providers-core';
  import { createPermissionQueueState, headPermissionRequest } from '@loombox/providers-core';
  import { APP_NAME, APP_TAGLINE } from '$lib/constants';
  import { copyToClipboard, exportTranscriptText } from '$lib/copy';
  import { RelayClient, type ClientSessionMeta, type ConnectionStatus } from '$lib/relay-client';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import MessageItem from '$lib/components/MessageItem.svelte';
  import PermissionQueueBar from '$lib/components/PermissionQueueBar.svelte';
  import PlanCard from '$lib/components/PlanCard.svelte';
  import ToolCallRow from '$lib/components/ToolCallRow.svelte';

  // Disposable v1 relay (SPEC §12): no auth, no default deployment, so the
  // operator points the PWA at whatever host/port the relay printed
  // (loopback here; a phone on the tailnet types the tailnet URL).
  const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8787/ws';

  let relayUrl = $state(DEFAULT_RELAY_URL);
  // The account this client's sessions are scoped under and its Account
  // Master Key (SPEC §8, §16). Real AMK-on-device delivery is the
  // pairing/escrow flow (out of scope here, see relay-client.ts's doc
  // comment) — this v1 client core takes both directly from the operator so
  // the encrypted loop is exercisable without that flow existing yet.
  let accountId = $state('dev-account');
  let amkBase64 = $state('');
  let status = $state<ConnectionStatus>('idle');
  let sessions = $state<ClientSessionMeta[]>([]);
  let selectedSessionId = $state<string | undefined>(undefined);
  let transcript = $state<TranscriptState | undefined>(undefined);
  let permissionQueue = $state<PermissionQueueState>(createPermissionQueueState());
  let configOptions = $state<AcpConfigOption[]>([]);
  let draft = $state('');
  // A plan's collapse state persists per session for as long as this tab
  // stays open (SPEC §7.24 "remembers collapse state during the session"),
  // keyed by session id so switching sessions and back preserves it.
  // `SvelteMap` (not a plain `Map` wrapped in `$state`) so `.set()` itself
  // triggers reactivity instead of requiring a clone-and-reassign dance.
  const planCollapsedBySession = new SvelteMap<string, boolean>();

  const canConnect = $derived(status === 'idle' || status === 'closed' || status === 'error');
  const planCollapsed = $derived(
    selectedSessionId ? (planCollapsedBySession.get(selectedSessionId) ?? false) : false,
  );
  const permissionHead = $derived(
    selectedSessionId ? headPermissionRequest(permissionQueue, selectedSessionId) : undefined,
  );

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

  function selectSession(id: string): void {
    selectedSessionId = id;
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
    unsubscribePermissionQueue = client
      .permissionQueueFor(id)
      .subscribe((value) => (permissionQueue = value));
    unsubscribeConfigOptions = client
      .configOptionsFor(id)
      .subscribe((value) => (configOptions = value));
  }

  function connect(): void {
    if (typeof window === 'undefined' || client) return;
    // A plain `crypto.getRandomValues` fallback (not `@loombox/crypto`'s
    // `generateAmk`, which pulls in `node:crypto`'s `createHmac` transitively
    // via key-tree.ts — Vite externalizes that for the browser build, so
    // calling it client-side would throw) when the operator leaves the AMK
    // field blank. Real AMK-on-device delivery is the pairing/escrow flow
    // (out of scope here, see relay-client.ts's doc comment).
    const amk = amkBase64.trim()
      ? new Uint8Array(
          atob(amkBase64.trim())
            .split('')
            .map((c) => c.charCodeAt(0)),
        )
      : crypto.getRandomValues(new Uint8Array(32));
    client = new RelayClient({ relayUrl, amk, accountId });
    unsubscribeStatus = client.status.subscribe((value) => (status = value));
    unsubscribeSessions = client.sessions.subscribe((value) => {
      sessions = value;
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
    client?.close();
    client = undefined;
    status = 'idle';
    sessions = [];
    selectedSessionId = undefined;
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
  }

  function submitPrompt(event: Event): void {
    event.preventDefault();
    const text = draft.trim();
    if (!client || !selectedSessionId || text === '') return;
    client.sendPrompt(selectedSessionId, text);
    draft = '';
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
    return () => disconnect();
  });
</script>

<main>
  <header>
    <h1>{APP_NAME}</h1>
    <p>{APP_TAGLINE}</p>
  </header>

  <section class="connection">
    <label for="relay-url">Relay URL</label>
    <input id="relay-url" type="text" bind:value={relayUrl} disabled={!canConnect} />
    <label for="account-id">Account</label>
    <input id="account-id" type="text" bind:value={accountId} disabled={!canConnect} />
    <label for="amk">AMK (base64, blank = generate)</label>
    <input id="amk" type="text" bind:value={amkBase64} disabled={!canConnect} />
    {#if canConnect}
      <button type="button" onclick={connect}>Connect</button>
    {:else}
      <button type="button" onclick={disconnect}>Disconnect</button>
    {/if}
    <span class="status" data-status={status}>status: {status}</span>
  </section>

  <div class="cockpit">
    <aside class="sessions">
      <h2>Sessions</h2>
      {#if sessions.length === 0}
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
                <strong>{session.title}</strong>
                <small>{session.provider} · {session.projectPath}</small>
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
                <ToolCallRow {item} awaitingPermission={permissionHead?.toolCall.id === item.id} />
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

        <PermissionQueueBar
          sessionId={selectedSessionId}
          queue={permissionQueue}
          onResolve={resolvePermission}
          onStop={stopSession}
        />

        <form class="composer" onsubmit={submitPrompt}>
          <input
            type="text"
            bind:value={draft}
            placeholder="Send a follow-up prompt…"
            aria-label="Follow-up prompt"
          />
          <button type="submit" disabled={draft.trim() === ''}>Send</button>
        </form>
      {/if}
    </section>
  </div>
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
    gap: 0.5rem;
  }

  .composer input {
    flex: 1;
  }

  .empty {
    opacity: 0.6;
  }
</style>
