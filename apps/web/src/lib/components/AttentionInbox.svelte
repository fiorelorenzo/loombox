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
   * issue #436): the empty state adopts the shared `EmptyState` primitive;
   * rows get a capped, staggered `beat-in` reveal. All `data-testid`s, DOM
   * structure the tests query, and every callback contract are unchanged.
   *
   * Session-row visual language (redesign v3 design spec §3.6): a row no
   * longer carries its own uppercase `APPROVAL`-style chip and heavy
   * left-edge accent border — it reads like a session row instead, a
   * leading `StatusDot` plus a plain sentence-case status label, both
   * keyed off the same `$lib/session-status.ts` tone/wording vocabulary
   * the sidebar and command palette use (see `itemStatus` below).
   * `PermissionCard` (rendered inline below a `'permission'` row) is the
   * one deliberate exception — it keeps its own full `floating` elevation
   * tier untouched, per the redesign brief's elevation ladder.
   *
   * Deck migration (redesign v2 §2 "One button language", issue #472): the
   * Open control and the reply composer's Send button now route through
   * the shared `Button` primitive (`ghost`/`secondary`) instead of two bare
   * hand-rolled `<button>`s, using its `dataTestId` override (issue #460)
   * so the existing `attention-inbox-open`/`attention-inbox-reply-send`
   * selectors are untouched. The Open control's stacked title/subtitle
   * layout and its own row-level hover (already provided by `.item:hover`)
   * don't match `Button`'s default centered/underline-on-hover ghost look,
   * so both are reset via the documented `class`-prop escape hatch
   * (`Dialog`'s own doc comment names this same pattern) with a `:global`
   * selector, since the class lands on `Button`'s own scope, not this
   * component's.
   */
  import type { AcpPermissionOption } from '@loombox/providers-core';
  import type { AttentionInboxItem } from '../relay-client';
  import PermissionCard from './PermissionCard.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import { SESSION_STATUS_LABELS, SESSION_STATUS_TONES } from '$lib/session-status';

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

  /**
   * Maps an inbox item onto the shared session-status tone/label
   * vocabulary (`$lib/session-status.ts`) wherever it genuinely
   * corresponds to one of `AcpSessionStatus`'s five states — the same
   * "one wording, never re-derived" rule the sidebar and command palette
   * follow (redesign v3 design spec §3.6). `ci_failure`/`review_request`
   * have no live session-status equivalent yet (`AttentionInboxItem`'s own
   * doc comment: neither has a wire producer in v1), so those two keep a
   * short label of their own rather than claiming a status they aren't.
   */
  function itemStatus(item: AttentionInboxItem): { tone: StatusTone; label: string } {
    switch (item.kind) {
      case 'permission':
        return {
          tone: SESSION_STATUS_TONES.permission_required,
          label: SESSION_STATUS_LABELS.permission_required,
        };
      case 'awaiting_input':
        return {
          tone: SESSION_STATUS_TONES.awaiting_input,
          label: SESSION_STATUS_LABELS.awaiting_input,
        };
      case 'session_outcome':
        return item.outcome === 'error'
          ? { tone: SESSION_STATUS_TONES.error, label: SESSION_STATUS_LABELS.error }
          : { tone: SESSION_STATUS_TONES.exited, label: SESSION_STATUS_LABELS.exited };
      case 'ci_failure':
        return { tone: 'danger', label: 'CI' };
      case 'review_request':
        return { tone: 'info', label: 'Review' };
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
        {@const status = itemStatus(item)}
        <li class="item" data-kind={item.kind} data-testid="attention-inbox-item">
          <div class="item-header">
            <StatusDot tone={status.tone} label={status.label} />
            <Button
              variant="ghost"
              class="open"
              onclick={() => onOpenSession(item.sessionId)}
              dataTestId="attention-inbox-open"
            >
              <strong>{item.sessionTitle}</strong>
              <small>{item.projectPath} · {item.nodeId}</small>
            </Button>
            <span class="status-label" data-testid="attention-inbox-kind-badge">{status.label}</span
            >
          </div>
          <p class="need" data-testid="attention-inbox-need">{needLabel(item)}</p>
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
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                dataTestId="attention-inbox-reply-send">Send</Button
              >
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
     not a boxed card. Session-row visual language (redesign v3 design
     spec §3.6): the per-kind signal now lives on the leading `StatusDot`
     alone, not a second colored border — `PermissionCard` (rendered
     inline below) keeps its own full `floating` tier untouched. */
  .item {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    transition: background-color var(--duration-fast) var(--ease-beat);
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

  .item-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  /* Sentence-case status wording next to the leading `StatusDot` (redesign
     v3 design spec §3.6) — color lives on the dot alone now, never
     duplicated as a second per-kind tint on this text. */
  .status-label {
    flex-shrink: 0;
    margin-left: auto;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  /* `:global` — the `open` class lands on `Button`'s own root `<button>`,
     which carries `Button`'s own scope hash, not this component's, so a
     plain (non-`:global`) selector would never match (same rationale
     `CommandPalette`'s `:global(.command-palette-panel)` documents).
     Resets `Button`'s ghost chrome (centered layout, padding, underline
     hover) back to a quiet, left-aligned, stacked title/subtitle control —
     `.item:hover` above already carries the row's own hover feedback. */
  :global(.open) {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3xs);
    padding: 0;
    text-align: left;
  }

  :global(.open .ui-button-label) {
    flex-direction: column;
    align-items: flex-start;
  }

  :global(.open:not(:disabled):hover) {
    background: transparent;
    text-decoration: none;
  }

  :global(.open) small {
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
</style>
