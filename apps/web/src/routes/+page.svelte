<script lang="ts">
  import { onMount } from 'svelte';
  import type { SessionMeta } from '@loombox/protocol';
  import { APP_NAME, APP_TAGLINE } from '$lib/constants';
  import { RelayClient, type ConnectionStatus, type TranscriptEntry } from '$lib/relay-client';

  // Disposable v0 relay (SPEC §12): no auth, no default deployment, so the
  // operator points the PWA at whatever host/port `scripts/run-relay.sh`
  // printed (loopback here; a phone on the tailnet types the tailnet URL).
  const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8787/ws';

  let relayUrl = $state(DEFAULT_RELAY_URL);
  let status = $state<ConnectionStatus>('idle');
  let sessions = $state<SessionMeta[]>([]);
  let selectedSessionId = $state<string | undefined>(undefined);
  let transcript = $state<TranscriptEntry[]>([]);
  let busy = $state(false);
  let draft = $state('');

  const canConnect = $derived(status === 'idle' || status === 'closed' || status === 'error');

  // All logic (the WS connection, the session list, the transcript reducer,
  // the composer's send path) lives in $lib/relay-client.ts, unit-tested
  // there against a real in-process relay with no browser. This component
  // just renders that module's stores and wires the composer's submit to it
  // (SPEC §5.4, §7.3).
  let client: RelayClient | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeTranscript: (() => void) | undefined;
  let unsubscribeBusy: (() => void) | undefined;

  function selectSession(id: string): void {
    selectedSessionId = id;
    unsubscribeTranscript?.();
    unsubscribeBusy?.();
    transcript = [];
    busy = false;
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
    unsubscribeBusy = client.busyFor(id).subscribe((value) => (busy = value));
  }

  function connect(): void {
    if (typeof window === 'undefined' || client) return;
    client = new RelayClient({ relayUrl });
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
    unsubscribeBusy?.();
    client?.close();
    client = undefined;
    status = 'idle';
    sessions = [];
    selectedSessionId = undefined;
    transcript = [];
    busy = false;
  }

  function submitPrompt(event: Event): void {
    event.preventDefault();
    const text = draft.trim();
    if (!client || !selectedSessionId || busy || text === '') return;
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
                <strong>{session.title ?? session.id}</strong>
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
          {#each transcript as entry (entry.id)}
            <li class={entry.role}>
              <span class="role">{entry.role}</span>
              <span class="text">{entry.text}</span>
              {#if !entry.done && entry.role !== 'user'}
                <span class="streaming" aria-label="streaming">…</span>
              {/if}
            </li>
          {/each}
        </ol>

        <form class="composer" onsubmit={submitPrompt}>
          <input
            type="text"
            bind:value={draft}
            placeholder="Send a follow-up prompt…"
            disabled={busy}
            aria-label="Follow-up prompt"
          />
          <button type="submit" disabled={busy || draft.trim() === ''}>Send</button>
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

  .transcript li.error {
    background: rgba(220, 38, 38, 0.15);
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
