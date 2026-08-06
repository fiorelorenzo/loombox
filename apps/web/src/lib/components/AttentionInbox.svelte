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
   * - `'ci_failure'` — a session whose watched PR's latest CI check state
   *   aggregates to failing (`RelayClient.attentionInbox()`, issue #243);
   *   shows which check(s) failed and a link to the PR.
   * - `'review_request'` — modeled and rendered here so the inbox already
   *   has a distinct look for it, but `RelayClient` never produces one in
   *   v1: it has no live event source in this client yet (that needs the
   *   tracker integration work, SPEC §7.10, v2). This is a forward-looking
   *   extension point, not a fake stub — no item of this kind is ever
   *   synthesized.
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
   * selector, since the class lands on `Button`'s own scope, not this
   * component's.
   *
   * Row primitive (v6 design-system audit, issue #579): `.item` composes
   * the shared `Row` (`as="li"`, no `onclick` of its own — only the nested
   * Open `Button` is clickable) instead of hand-rolling its own leading/
   * content/trailing flex layout. Leading is the `StatusDot`, trailing is
   * the status label, and content is everything else (Open, the message,
   * and the inline `PermissionCard`/reply form) — `Row`'s content region
   * is a column, not a single line, exactly because this row's own content
   * already wasn't one. `data-kind`/`data-testid` reach `Row`'s root
   * through its own `data-*` passthrough, so the existing
   * `attention-inbox-item` selector and `dataset.kind` reads are
   * unchanged. `surface` (issue #665) draws the card background/border
   * directly on `Row`'s own root — the `:global(.item)` rule below only
   * ever adds padding/animation on top of it, never fights it for a
   * property `Row` already owns (issue #665's guard test,
   * `primitive-override-scope.test.ts`).
   *
   * v7 card-per-session inbox (E1-3/E2-1/E3-1, issue #671, spec §5):
   *
   * - **E1-3, amended.** The row's old one-line derived "need" label
   *   (`needLabel`, still used as a fallback below) is replaced by the
   *   agent's actual last message, rendered in full through the same
   *   sanitised `$lib/markdown` pipeline the transcript itself uses
   *   (`AttentionInboxItem.agentMessage`, plumbed by #662) — nothing is
   *   summarised or hidden behind a click. The amendment strips the
   *   digit badge `PermissionCard`'s option buttons used to print; see
   *   that component's own doc comment.
   * - **E2-1.** Answering (a permission option, or a reply send) no
   *   longer calls `onResolve`/`onReply` synchronously. It schedules the
   *   real call `ANSWER_LINGER_MS` out (`scheduleAnswer`), and the row
   *   swaps its live control for a dimmed outcome + Undo. Undo
   *   (`undoAnswer`) cancels the pending timer *before* the real call
   *   ever fires, so it is a true no-op restore, not a race against an
   *   already-sent resolution — the upstream item is still sitting in
   *   `items` untouched the whole time, since nothing has told
   *   `RelayClient` anything yet.
   * - **E3-1.** `j`/`k` move `focusedIndex`, a list-wide cursor
   *   (independent of literal DOM focus — this is a Gmail-style
   *   keyboard cursor, not a roving-tabindex one, so it works whether or
   *   not the mouse has ever touched the page) rendered via `Row`'s own
   *   `active` prop. A digit key resolves the focused row's permission
   *   options by position, same binding `PermissionCard`'s own `#148`
   *   keydown handler already provides when it holds real focus
   *   directly — `event.defaultPrevented` is checked first specifically
   *   to not double-fire when both paths would otherwise answer the same
   *   keystroke. Enter focuses the reply `<input>` of an `awaiting_input`
   *   focused row. The conflict between E1-3's amendment and E3-1's
   *   reliance on digits is resolved in the spec: the bindings stay, the
   *   on-button badge goes, and the hint bar below the list is now the
   *   only place a digit shortcut is advertised — load-bearing, not
   *   decoration.
   */
  import type {
    AcpPermissionOption,
    PendingPermissionRequest,
  } from '@loombox/providers-core/browser';
  import { SvelteMap } from 'svelte/reactivity';
  import type { AttentionInboxItem } from '../relay-client';
  import { isTypingTarget } from '$lib/keyboard';
  import { renderMarkdownToHtml } from '$lib/markdown';
  import { triggerHapticFeedback } from '$lib/haptics';
  import PermissionCard from './PermissionCard.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Row from './ui/Row.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import { SESSION_STATUS_LABELS, SESSION_STATUS_TONES } from '$lib/session-status';

  interface Props {
    items: AttentionInboxItem[];
    onResolve: (sessionId: string, requestId: string, option: AcpPermissionOption) => void;
    onOpenSession: (sessionId: string) => void;
    onReply: (sessionId: string, text: string) => void;
  }

  const { items, onResolve, onOpenSession, onReply }: Props = $props();

  /** How long an answered row lingers, dimmed, before its real callback fires (E2-1: "clears after a couple of seconds"). */
  const ANSWER_LINGER_MS = 2200;

  // Keyed by sessionId — one reply composer per awaiting_input item, and
  // there is at most one such item per session (`attentionInbox()`'s own
  // per-session doc comment).
  let replyDrafts = $state<Record<string, string>>({});

  // `$state` (not a plain object) so `bind:this` below tracks each row's
  // input element reactively — `openFocusedReply` (E3-1: "Enter drops into
  // the reply box") then moves real focus into whichever row's input the
  // list cursor currently points at.
  let replyInputEls = $state<Record<string, HTMLInputElement>>({});

  interface PendingAnswer {
    /** What the row shows in place of its live control while dimmed. */
    outcome: string;
    /** The real `onResolve`/`onReply` call, deferred until the linger window elapses (or dropped entirely on Undo). */
    commit: () => void;
    timerId: ReturnType<typeof setTimeout>;
  }

  /** Answered-but-not-yet-committed rows (E2-1), keyed by `itemKey`. `SvelteMap` (`svelte/reactivity`), not a plain `$state(new Map())` — a bare `Map`'s `.set`/`.delete` bypass `$state`'s proxy traps (they mutate the built-in's internal slots, not a property `Proxy` can intercept), so only the reactive wrapper class actually re-renders on mutation. */
  const pendingAnswers = new SvelteMap<string, PendingAnswer>();

  /** The list-wide keyboard cursor (E3-1). Not tied to literal DOM focus — see the file doc comment. */
  let focusedIndex = $state(0);

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
        return item.failingChecks && item.failingChecks.length > 0
          ? `CI check failed: ${item.failingChecks.join(', ')}`
          : 'CI check failed';
      case 'review_request':
        return 'Review requested';
    }
  }

  /**
   * The row's own message body (E1-3, amended): the agent's real last
   * message in full for a `permission`/`awaiting_input` item that has one
   * (`AttentionInboxItem.agentMessage`, issue #662) — never a summary, never
   * truncated. Falls back to the old derived `needLabel` when there is no
   * agent message yet (a permission request on a session's very first
   * turn) or for a kind that never carries one (`session_outcome`/
   * `ci_failure`/`review_request` keep their own short label).
   */
  function messageSource(item: AttentionInboxItem): string {
    if ((item.kind === 'permission' || item.kind === 'awaiting_input') && item.agentMessage) {
      return item.agentMessage;
    }
    return needLabel(item);
  }

  /**
   * Maps an inbox item onto the shared session-status tone/label
   * vocabulary (`$lib/session-status.ts`) wherever it genuinely
   * corresponds to one of `AcpSessionStatus`'s five states — the same
   * "one wording, never re-derived" rule the sidebar and command palette
   * follow (redesign v3 design spec §3.6). `ci_failure`/`review_request`
   * have no `AcpSessionStatus` equivalent at all (a PR's CI state and a
   * review request are properties of the PR, not the session's own live
   * status), so those two keep a short label of their own rather than
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

  function isPendingAnswer(item: AttentionInboxItem): boolean {
    return pendingAnswers.has(itemKey(item));
  }

  function outcomeFor(item: AttentionInboxItem): string {
    return pendingAnswers.get(itemKey(item))?.outcome ?? '';
  }

  function truncateForOutcome(text: string, max = 80): string {
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  }

  /** Schedules `commit` to run after the linger window — see the file doc comment's E2-1 paragraph for why the real call is deferred rather than fired-then-undone. */
  function scheduleAnswer(item: AttentionInboxItem, outcome: string, commit: () => void): void {
    const key = itemKey(item);
    const existing = pendingAnswers.get(key);
    if (existing) clearTimeout(existing.timerId);
    const timerId = setTimeout(() => {
      pendingAnswers.delete(key);
      commit();
    }, ANSWER_LINGER_MS);
    pendingAnswers.set(key, { outcome, commit, timerId });
  }

  /** Undo (E2-1): cancels the pending timer before `commit` ever runs, so nothing was ever actually resolved/sent — a true restore, not a cancelled countdown on top of an already-fired action. */
  function undoAnswer(item: AttentionInboxItem): void {
    const key = itemKey(item);
    const pending = pendingAnswers.get(key);
    if (!pending) return;
    clearTimeout(pending.timerId);
    pendingAnswers.delete(key);
  }

  // Safety net, not the primary cleanup path (that's `scheduleAnswer`'s own
  // timer callback): if an item leaves `items` for a reason other than our
  // own deferred commit — resolved from another device, the session's
  // status moved on its own — drop the now-stale pending entry rather than
  // firing a commit for an item nobody can act on any more.
  $effect(() => {
    const liveKeys = new Set(items.map(itemKey));
    for (const [key, pending] of pendingAnswers) {
      if (!liveKeys.has(key)) {
        clearTimeout(pending.timerId);
        pendingAnswers.delete(key);
      }
    }
  });

  // Keeps the cursor in range as the list shrinks/grows (an item resolving
  // elsewhere, or a new one arriving) — mirrors `CommandPalette`'s own
  // `activeIndex` re-clamp.
  $effect(() => {
    if (focusedIndex >= items.length) focusedIndex = Math.max(0, items.length - 1);
  });

  function beginPermissionAnswer(
    item: AttentionInboxItem,
    request: PendingPermissionRequest,
    option: AcpPermissionOption,
  ): void {
    scheduleAnswer(item, `Answered: ${option.name}`, () =>
      onResolve(item.sessionId, request.requestId, option),
    );
  }

  function submitReply(item: AttentionInboxItem): void {
    const text = (replyDrafts[item.sessionId] ?? '').trim();
    if (text === '') return;
    scheduleAnswer(item, `Replied: “${truncateForOutcome(text)}”`, () =>
      onReply(item.sessionId, text),
    );
    replyDrafts[item.sessionId] = '';
  }

  function moveFocus(delta: number): void {
    if (items.length === 0) return;
    focusedIndex = (focusedIndex + delta + items.length) % items.length;
  }

  /** Digit answer for the cursor-focused row (E3-1) — the same binding `PermissionCard`'s own `#148` handler exposes when it holds literal focus directly; see `handleWindowKeydown`'s `defaultPrevented` guard for why the two never double-fire. */
  function answerFocused(digit: number): void {
    const item = items[focusedIndex];
    if (!item || item.kind !== 'permission' || !item.permission || isPendingAnswer(item)) return;
    const option = item.permission.options[digit - 1];
    if (!option) return;
    triggerHapticFeedback();
    beginPermissionAnswer(item, item.permission, option);
  }

  function openFocusedReply(): void {
    const item = items[focusedIndex];
    if (!item || item.kind !== 'awaiting_input' || isPendingAnswer(item)) return;
    replyInputEls[itemKey(item)]?.focus();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    // Already handled — e.g. a directly-focused `PermissionCard`'s own
    // digit/Esc handler ran first during the bubble phase and called
    // `preventDefault()`. Acting again here would double-answer the same
    // keystroke.
    if (event.defaultPrevented) return;
    if (isTypingTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (items.length === 0) return;
    if (event.key === 'j') {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === 'k') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === 'Enter') {
      openFocusedReply();
      return;
    }
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      answerFocused(digit);
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="attention-inbox" data-testid="attention-inbox">
  {#if items.length === 0}
    <EmptyState message="Nothing needs your attention." />
  {:else}
    <div class="hints" data-testid="attention-inbox-hints">
      <span>j/k move</span>
      <span>1–9 answer</span>
      <span>Enter reply</span>
    </div>
    <ul>
      {#each items as item, index (itemKey(item))}
        {@const status = itemStatus(item)}
        {@const answered = isPendingAnswer(item)}
        <Row
          as="li"
          class="item"
          surface
          active={index === focusedIndex}
          data-kind={item.kind}
          dataTestId="attention-inbox-item"
        >
          {#snippet leading()}
            <StatusDot tone={status.tone} label={status.label} />
          {/snippet}
          {#snippet trailing()}
            <span class="status-label" data-testid="attention-inbox-kind-badge">{status.label}</span
            >
          {/snippet}
          <div class="item-body" class:answered>
            <Button
              variant="ghost"
              class="open"
              align="start"
              onclick={() => onOpenSession(item.sessionId)}
              dataTestId="attention-inbox-open"
            >
              <strong>{item.sessionTitle}</strong>
              <small class="font-mono">{item.projectPath} · {item.nodeId}</small>
            </Button>
            <!-- $lib/markdown's own sanitised output (rehype-sanitize), the same pipeline MessageItem renders the transcript through — never raw agent text. -->
            <div class="message md-body" data-testid="attention-inbox-need">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdownToHtml(messageSource(item))}
            </div>
            {#if item.kind === 'ci_failure' && item.prUrl}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- the node's own CI check state carries GitHub's PR URL (github.com/.../pull/N), never an internal SvelteKit route; the rule can't statically prove that from a dynamic href. -->
              <a
                href={item.prUrl}
                target="_blank"
                rel="noreferrer"
                class="ci-pr-link"
                data-testid="attention-inbox-ci-pr-link"
              >
                View PR{item.prNumber ? ` #${item.prNumber}` : ''}
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {/if}
            {#if answered}
              <div class="answer-outcome" data-testid="attention-inbox-answer-outcome">
                <span>{outcomeFor(item)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => undoAnswer(item)}
                  dataTestId="attention-inbox-answer-undo"
                >
                  Undo
                </Button>
              </div>
            {:else if item.kind === 'permission' && item.permission}
              {@const request = item.permission}
              <PermissionCard
                {request}
                actionable={true}
                onResolve={(option) => beginPermissionAnswer(item, request, option)}
              />
            {:else if item.kind === 'awaiting_input'}
              <form
                class="reply"
                data-testid="attention-inbox-reply"
                onsubmit={(event) => {
                  event.preventDefault();
                  submitReply(item);
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
                  bind:this={replyInputEls[itemKey(item)]}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  dataTestId="attention-inbox-reply-send">Send</Button
                >
              </form>
            {/if}
          </div>
        </Row>
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

  /* Load-bearing, not decoration (E3-1/spec §0's conflict resolution): once
     `PermissionCard`'s option buttons stopped printing a digit of their
     own, this is the only place the `1`–`9` binding is advertised at all. */
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
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
     inline below) keeps its own full `floating` tier untouched. `Row`'s
     own `surface` prop (issue #665, following `ToolCard`'s #576
     precedent) now draws the background/border/hover treatment; this is
     only the padding and the row's own beat-in reveal on top of it.
     `:global()` because `Row` renders its own root in its own component
     scope. */
  :global(.item) {
    padding: var(--space-sm) var(--space-md);
    /* beat-in (redesign brief §2): 4px upward slide + fade, staggered
       20ms/item, capped at 5 rows. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  :global(.item:nth-child(2)) {
    animation-delay: 20ms;
  }

  :global(.item:nth-child(3)) {
    animation-delay: 40ms;
  }

  :global(.item:nth-child(4)) {
    animation-delay: 60ms;
  }

  :global(.item:nth-child(n + 5)) {
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

  /* Sentence-case status wording next to the leading `StatusDot` (redesign
     v3 design spec §3.6) — color lives on the dot alone now, never
     duplicated as a second per-kind tint on this text. `Row`'s own
     trailing region already supplies `margin-left: auto` (issue #579). */
  .status-label {
    flex-shrink: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .item-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    min-width: 0;
    transition: opacity var(--duration-base) var(--ease-beat);
  }

  /* E2-1: dims to show the outcome instead of vanishing outright — the
     title/message stay legible (context for the Undo decision), only the
     control area below swaps for the outcome + Undo. */
  .item-body.answered {
    opacity: 0.55;
  }

  /* `:global` — the `open` class lands on `Button`'s own root `<button>`,
     which carries `Button`'s own scope hash, not this component's, so a
     plain (non-`:global`) selector would never match (same rationale
     `CommandPalette`'s `:global(.command-palette-panel)` documents).
     `Button`'s `align="start"` prop (issue #665) now supplies the
     left-aligned, stacked title/subtitle layout and drops the
     hover-underline; this is only the padding this quiet trigger still
     wants on top of it — `.item`'s own hover feedback (via `Row`'s
     `surface`) already carries the row's own hover treatment. */
  :global(.open) {
    padding: 0;
  }

  :global(.open) small {
    color: var(--color-text-secondary);
  }

  /* The agent's real last message (E1-3, amended) — `.md-body`'s own
     paragraph/list/code/link rules are declared `:global` in
     `MessageItem.svelte` and therefore already apply here verbatim; this
     is only the size this container itself needs (unset elsewhere on
     `.md-body`, which is only ever a class name, never a container with
     its own base rule). */
  .message {
    font-size: var(--text-small-size);
  }

  .ci-pr-link {
    align-self: flex-start;
    font-size: var(--text-small-size);
    color: var(--color-accent);
  }

  .ci-pr-link:hover {
    text-decoration: underline;
  }

  .answer-outcome {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
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
