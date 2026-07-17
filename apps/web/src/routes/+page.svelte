<script lang="ts">
  import { onMount } from 'svelte';
  import type { TranscriptItem, TranscriptState } from '@loombox/providers-core';
  import { APP_NAME, APP_TAGLINE } from '$lib/constants';
  import { RelayClient, type ClientSessionMeta, type ConnectionStatus } from '$lib/relay-client';

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
  let draft = $state('');

  const canConnect = $derived(status === 'idle' || status === 'closed' || status === 'error');

  // All logic (the WS connection, the E2E-encrypted session list, the
  // transcript decrypt+reduce, the composer's send path) lives in
  // $lib/relay-client.ts, unit-tested there against a real in-process relay
  // plus a fake independently-keyed node — no browser. This component just
  // renders that module's stores and wires the composer's submit to it
  // (SPEC §5.4, §7.3). Transcript rendering here is deliberately a plain
  // append-only log (v0-equivalent scope): tool-call widgets, diffs, and the
  // plan sidebar are Wave D.2, not this client core.
  let client: RelayClient | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeTranscript: (() => void) | undefined;

  function itemText(item: TranscriptItem): string {
    if (item.type === 'message') return item.text;
    return `[${item.toolKind ?? 'tool'}] ${item.title ?? item.id} (${item.status ?? 'pending'})`;
  }

  function itemRole(item: TranscriptItem): string {
    if (item.type === 'tool_call') return 'tool';
    if (item.kind === 'user_message_chunk') return 'user';
    if (item.kind === 'agent_thought_chunk') return 'thought';
    return 'agent';
  }

  function selectSession(id: string): void {
    selectedSessionId = id;
    unsubscribeTranscript?.();
    transcript = undefined;
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
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
    client?.close();
    client = undefined;
    status = 'idle';
    sessions = [];
    selectedSessionId = undefined;
    transcript = undefined;
  }

  function submitPrompt(event: Event): void {
    event.preventDefault();
    const text = draft.trim();
    if (!client || !selectedSessionId || text === '') return;
    client.sendPrompt(selectedSessionId, text);
    draft = '';
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
        <ol>
          {#each transcript?.items ?? [] as item (item.id)}
            <li class={itemRole(item)}>
              <span class="role">{itemRole(item)}</span>
              <span class="text">{itemText(item)}</span>
            </li>
          {/each}
        </ol>

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
    gap: 0.75rem;
  }

  .transcript ol {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .transcript li {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: rgba(127, 127, 127, 0.1);
  }

  .transcript li.user {
    align-self: flex-end;
    background: rgba(79, 70, 229, 0.15);
  }

  .transcript li.tool {
    background: rgba(234, 179, 8, 0.15);
  }

  .transcript .role {
    display: block;
    font-size: 0.7rem;
    text-transform: uppercase;
    opacity: 0.6;
  }

  .transcript .text {
    white-space: pre-wrap;
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
