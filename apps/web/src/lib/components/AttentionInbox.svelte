<script lang="ts">
  /**
   * The cross-project, cross-node attention inbox (SPEC.md §7.13, issues
   * #167/#168/#169): one list of every item across every project/node that
   * needs the user now, sorted oldest-waiting first
   * (`RelayClient.attentionInbox()`'s own sort, not re-sorted here). Renders
   * all four classes SPEC §7.13 names, each visually distinguishable via its
   * `data-kind` attribute and a `.kind-badge` label:
   * - `'permission'` — an actionable pending tool-call approval.
   * - `'awaiting_input'` — a session waiting on the user's next message.
   * - `'session_outcome'` — a session that finished (`outcome: 'exited'`) or
   *   errored (`outcome: 'error'`).
   * - `'ci_failure'` / `'review_request'` — modeled and rendered here so the
   *   inbox already has a distinct look for them, but `RelayClient` never
   *   produces one in v1: neither has a live event source in this client
   *   yet (that needs the git/CI/tracker integration work, SPEC §7.10/§7.14,
   *   v2). This is a forward-looking extension point, not a fake stub — no
   *   item of either kind is ever synthesized.
   *
   * Every item has an Open action (`onOpenSession`) that jumps to its
   * originating session. A `'permission'` item is additionally actionable
   * inline (issue #168): its approve/deny buttons reuse `PermissionCard`,
   * the exact same component the session's own `PermissionQueueBar` renders,
   * wired to the same `onResolve` callback a caller backs with
   * `RelayClient.resolvePermission` — approving here and approving from the
   * session's own view are the same write to the same queue store, not two
   * independent "resolve" paths that could drift (issue #169's
   * single-source-of-truth requirement). An `'awaiting_input'` item
   * additionally gets an inline reply composer: `onReply` is expected to be
   * backed by the exact same `RelayClient.sendPrompt`/`prompt_inject` path a
   * session's own composer form uses, so replying from the inbox is not a
   * second, divergent "send" path.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4/§6,
   * issue #436): rows stay a quiet left-edge color stripe keyed by
   * `data-kind` rather than a tinted background, so a long inbox stays
   * scannable (`PermissionCard` is the one deliberate exception — it keeps
   * its own full `floating` tier untouched, per the redesign brief's
   * elevation ladder). The empty state adopts the shared `EmptyState`
   * primitive; rows get a capped, staggered `beat-in` reveal. All
   * `data-testid`s, DOM structure the tests query, and every callback
   * contract are unchanged.
   */
  import type { AcpPermissionOption } from '@loombox/providers-core';
  import type { AttentionInboxItem } from '../relay-client';
  import PermissionCard from './PermissionCard.svelte';
  import EmptyState from './ui/EmptyState.svelte';

  interface Props {
    items: AttentionInboxItem[];
    onResolve: (sessionId: string, requestId: string, option: AcpPermissionOption) => void;
    onOpenSession: (sessionId: string) => void;
    onReply: (sessionId: string, text: string) => void;
  }

  const { items, onResolve, onOpenSession, onReply }: Props = $props();

  // Keyed by sessionId — one reply composer per awaiting_input item, and
  // there is at most one such item per session (`attentionInbox()`'s own
  // per-session doc comment).
  let replyDrafts = $state<Record<string, string>>({});

  function itemKey(item: AttentionInboxItem): string {
    return item.kind === 'permission' && item.permission
      ? `permission:${item.permission.requestId}`
      : `${item.kind}:${item.sessionId}`;
  }

  function needLabel(item: AttentionInboxItem): string {
    switch (item.kind) {
      case 'permission': {
        const toolCall = item.permission?.toolCall;
        return `Needs approval: ${toolCall?.title ?? toolCall?.id ?? 'a tool call'}`;
      }
      case 'awaiting_input':
        return 'Waiting for your reply';
      case 'session_outcome':
        return item.outcome === 'error'
          ? `Errored${item.stopReason ? `: ${item.stopReason}` : ''}`
          : `Finished${item.stopReason ? `: ${item.stopReason}` : ''}`;
      case 'ci_failure':
        return 'CI check failed';
      case 'review_request':
        return 'Review requested';
    }
  }

  /** A short, class-identifying label shown alongside `needLabel` — color (`data-kind`) alone should never be the only way to tell classes apart. */
  function kindBadge(item: AttentionInboxItem): string {
    switch (item.kind) {
      case 'permission':
        return 'Approval';
      case 'awaiting_input':
        return 'Reply';
      case 'session_outcome':
        return item.outcome === 'error' ? 'Errored' : 'Finished';
      case 'ci_failure':
        return 'CI';
      case 'review_request':
        return 'Review';
    }
  }

  function submitReply(sessionId: string): void {
    const text = (replyDrafts[sessionId] ?? '').trim();
    if (text === '') return;
    onReply(sessionId, text);
    replyDrafts[sessionId] = '';
  }
</script>

<div class="attention-inbox" data-testid="attention-inbox">
  {#if items.length === 0}
    <EmptyState message="Nothing needs your attention." />
  {:else}
    <ul>
      {#each items as item (itemKey(item))}
        <li class="item" data-kind={item.kind} data-testid="attention-inbox-item">
          <div class="item-header">
            <span class="kind-badge" data-testid="attention-inbox-kind-badge"
              >{kindBadge(item)}</span
            >
            <button
              type="button"
              class="open"
              onclick={() => onOpenSession(item.sessionId)}
              data-testid="attention-inbox-open"
            >
              <strong>{item.sessionTitle}</strong>
              <small>{item.projectPath} · {item.nodeId}</small>
            </button>
            <span class="need" data-testid="attention-inbox-need">{needLabel(item)}</span>
          </div>
          {#if item.kind === 'permission' && item.permission}
            {@const request = item.permission}
            <PermissionCard
              {request}
              actionable={true}
              onResolve={(option) => onResolve(item.sessionId, request.requestId, option)}
            />
          {:else if item.kind === 'awaiting_input'}
            <form
              class="reply"
              data-testid="attention-inbox-reply"
              onsubmit={(event) => {
                event.preventDefault();
                submitReply(item.sessionId);
              }}
            >
              <input
                type="text"
                value={replyDrafts[item.sessionId] ?? ''}
                oninput={(event) =>
                  (replyDrafts[item.sessionId] = (event.currentTarget as HTMLInputElement).value)}
                placeholder="Send a follow-up without leaving the inbox…"
                aria-label={`Reply to ${item.sessionTitle}`}
                data-testid="attention-inbox-reply-input"
              />
              <button type="submit" data-testid="attention-inbox-reply-send">Send</button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .attention-inbox {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* Flat elevation tier (redesign brief §3): a list row is quiet chrome,
     not a boxed card — a left-edge color stripe carries the per-kind
     signal instead of a tinted background, so a long inbox stays
     scannable. `PermissionCard` (rendered inline below) keeps its own
     full `floating` tier untouched. */
  .item {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-left-width: var(--space-2xs);
    border-radius: var(--radius-lg);
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
    /* beat-in (redesign brief §2): 4px upward slide + fade, staggered
       20ms/item, capped at 5 rows. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .item:hover {
    background: var(--color-fill-subtle);
  }

  .item:nth-child(2) {
    animation-delay: 20ms;
  }

  .item:nth-child(3) {
    animation-delay: 40ms;
  }

  .item:nth-child(4) {
    animation-delay: 60ms;
  }

  .item:nth-child(n + 5) {
    animation-delay: 80ms;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Each class gets its own border-left color, in addition to the
     text `.kind-badge` — color is never the only signal (accessibility). */
  .item[data-kind='permission'] {
    border-left-color: var(--color-warning);
  }

  .item[data-kind='awaiting_input'] {
    border-left-color: var(--color-accent);
  }

  .item[data-kind='session_outcome'] {
    border-left-color: var(--color-success);
  }

  .item[data-kind='ci_failure'] {
    border-left-color: var(--color-danger);
  }

  .item[data-kind='review_request'] {
    border-left-color: var(--color-info);
  }

  .item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .kind-badge {
    font-size: var(--text-small-size);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: var(--space-3xs) var(--space-xs);
    border: 1px solid currentColor;
    border-radius: var(--radius-full);
    white-space: nowrap;
    /* Text is colored to match the row's left-edge stripe (below) — a
       quiet, still-legible reinforcement, never a filled background. */
    color: var(--color-text-secondary);
  }

  .item[data-kind='permission'] .kind-badge {
    color: var(--color-warning);
  }

  .item[data-kind='awaiting_input'] .kind-badge {
    color: var(--color-accent);
  }

  .item[data-kind='session_outcome'] .kind-badge {
    color: var(--color-success);
  }

  .item[data-kind='ci_failure'] .kind-badge {
    color: var(--color-danger);
  }

  .item[data-kind='review_request'] .kind-badge {
    color: var(--color-info);
  }

  .open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3xs);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .open:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .open small {
    color: var(--color-text-secondary);
  }

  .need {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .reply {
    display: flex;
    gap: var(--space-xs);
  }

  .reply input {
    flex: 1;
    min-width: 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    font: inherit;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .reply input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-color: var(--color-border-strong);
  }

  .reply button {
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-md);
    cursor: pointer;
    font: inherit;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .reply button:hover {
    background: var(--color-fill-subtle);
  }

  /* tension-press (redesign brief §2): darken + scale(0.98), no bounce. */
  .reply button:active {
    background: var(--color-fill);
    transform: scale(0.98);
  }

  .reply button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
