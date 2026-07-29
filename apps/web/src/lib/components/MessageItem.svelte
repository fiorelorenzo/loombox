<script lang="ts">
  /**
   * A message/thought transcript item (SPEC.md §7.24's append-by-id reducer
   * output). Thoughts render muted and collapsed by default, expandable on
   * tap, height-capped once expanded so one very long thought never blows
   * out the transcript layout (§7.24 "Thinking/reasoning"). While `thinking`
   * is true (the caller derives this per turn via `$lib/thinking.ts`'s
   * `isThoughtStillThinking`, since that needs the whole transcript's
   * `items`/`turnActive`, not just this one item) a live ticking "Thinking
   * Ns" header runs from this component's own mount time — a reasonable
   * proxy for "first thought chunk" since a fresh item id only ever mounts
   * this component the moment the reducer creates it — and freezes to a
   * static "Thought for Ns" the instant `thinking` flips false. The timer
   * is purely presentational local state: it never delays or gates
   * `item.text` itself from rendering, so normal (non-thought) message
   * content is never held up behind it. Every message/thought gets the
   * shared copy affordance (issue #150).
   *
   * `item.text` itself is also revealed at a smoothed, bounded rate rather
   * than dumped straight into the DOM (SPEC.md §7.24 "Streaming mechanics",
   * issue #137) via `$lib/text-pacer.ts`'s `TextPacer` — see that module's
   * doc comment for the reveal-rate rationale. A history/replay item (the
   * common case: `turnActive` defaults to `false`) renders in full
   * immediately, never "typed out"; only a genuinely live item (the caller
   * passes `turnActive={true}` for the session's current turn) paces its
   * reveal, and always flushes to the full text the instant `turnActive`
   * goes false — the real `turn_ended` signal, so nothing is ever left
   * partially revealed once a turn settles.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "Canvas and transcript" — one timeline metaphor): the root
   * `.message-item` is a full-width row split into a fixed `.gutter`
   * (`var(--gutter)`) carrying the role glyph, and `.content` flowing in
   * the remaining width — never a bubble, never right-aligned. `user` is
   * told apart from `agent` with a hairline/tint on the gutter itself,
   * never a different box — the old right-aligned accent-subtle bubble
   * and the agent's full-width "card" look are both gone; every row reads
   * the same shape. A plain CSS `animation` (`beat-in`,
   * `--duration-base`/`--ease-beat`) plays once when the root element is
   * first mounted into the keyed `{#each item.id}` list and never replays
   * on the in-place prop updates that stream text into the same DOM node
   * (verified by the existing "DOM node stays the same instance" test) —
   * the un-staggered single beat-in the brief specifies for live-streamed
   * arrivals. Reduced motion is handled for free: this animation is
   * written entirely against `--duration-base`/`--ease-*`, which
   * `tokens.css` already zeroes under `prefers-reduced-motion`.
   *
   * Design spec v5 §4 "every turn states its role": v3's `sr-only` role
   * label is now a real, visible `--text-caption-size` uppercase word in
   * the gutter — `You` for the user's own turns, the provider's display
   * name for an agent turn or its thought (`providerId`, mapped through
   * `$lib/providers`'s shared `PROVIDER_LABELS.role` map, defaulting to "Agent" for an
   * unrecognized or omitted id) — so telling a user turn from an agent
   * turn no longer depends on noticing the gutter dot's colour, and a
   * screen reader gets the same word a sighted reader does. The user's
   * own turns additionally sit on `--color-surface-raised`, a second,
   * redundant cue layered on top of the label rather than instead of it.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the "Show thought" disclosure affordance draws its chevron from
   * the shared `Icon` component (`collapse-chevron` — the same glyph the
   * sessions rail uses for its own expand/collapse toggle) instead of
   * relying on text alone; decorative (`aria-hidden`, no `label`), since the
   * button's own visible text already carries the accessible name.
   */
  import { untrack } from 'svelte';
  import type { TranscriptMessageItem } from '@loombox/providers-core/browser';
  import { itemCopyText } from '$lib/copy';
  import { PROVIDER_LABELS } from '$lib/providers';
  import { TextPacer } from '$lib/text-pacer';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Icon from './icons/Icon.svelte';

  interface Props {
    item: TranscriptMessageItem;
    /** True while this thought's turn is still streaming with no message content yet (issue #136); meaningless for a non-thought item. Defaults false so every other caller/test is unaffected. */
    thinking?: boolean;
    /** True while this item's own turn is still live (issue #137's flush-on-`turn_ended` trigger). Defaults false, which flushes immediately — the correct behavior for replayed history and for every caller that doesn't pass it. */
    turnActive?: boolean;
    /** The session's `ClientSessionMeta.provider` (e.g. `'claude'`) — only meaningful for an agent/thought row; a user row's label is always "You" regardless. Omitted falls back to the generic "Agent" label rather than guessing. */
    providerId?: string;
  }

  const { item, thinking = false, turnActive = false, providerId }: Props = $props();

  // Deliberately a one-time read of `item.text.length` at mount (`untrack`
  // opts out of the reactive dependency Svelte would otherwise warn about),
  // not a reactive binding: the actual reactive catch-up as `item.text`
  // grows happens through the `$effect` below calling `pacer.setTarget`,
  // which is the whole point of pacing it rather than mirroring it
  // directly.
  const initialTextLength = untrack(() => item.text.length);
  let revealedLength = $state(initialTextLength);
  const pacer = new TextPacer({
    initialLength: initialTextLength,
    onReveal: (length) => (revealedLength = length),
  });
  const displayText = $derived(item.text.slice(0, revealedLength));

  $effect(() => {
    pacer.setTarget(item.text.length);
  });

  $effect(() => {
    if (!turnActive) pacer.flush();
  });

  $effect(() => {
    return () => pacer.stop();
  });

  const role = $derived(
    item.kind === 'user_message_chunk'
      ? 'user'
      : item.kind === 'agent_thought_chunk'
        ? 'thought'
        : 'agent',
  );

  // "You" for the user; the provider's own name for both an agent message
  // and its thought — a thought is still the same speaker, just an aside,
  // and its content already reads as a thought via the timer/italic body
  // below, so the gutter word doesn't need a third value to say so again.
  const roleLabel = $derived(
    role === 'user' ? 'You' : (providerId && PROVIDER_LABELS[providerId]?.role) || 'Agent',
  );

  let expanded = $state(false);

  // The ticking header (issue #136): `elapsedSeconds` only ever advances
  // while `thinking` is true; it freezes at whatever it last reached the
  // instant `thinking` goes false, which is exactly the "settles the
  // instant real content starts arriving" behavior — no separate "final
  // value" bookkeeping needed, the interval simply stops running.
  const mountedAt = Date.now();
  let elapsedSeconds = $state(0);

  $effect(() => {
    if (role !== 'thought' || !thinking) return;
    const tick = () => {
      elapsedSeconds = Math.max(1, Math.round((Date.now() - mountedAt) / 1000));
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  });

  const thinkingLabel = $derived(
    thinking ? `Thinking ${elapsedSeconds}s` : `Thought for ${elapsedSeconds}s`,
  );
</script>

<div
  class="message-item"
  class:user={role === 'user'}
  class:agent={role === 'agent'}
  class:thought={role === 'thought'}
  data-testid="message-item"
>
  <div class="gutter">
    <span class="glyph" aria-hidden="true"></span>
    <span class="role-label">{roleLabel}</span>
  </div>
  <div class="content">
    {#if role === 'thought'}
      {#if thinking}
        <WovenLoader size="sm" variant="working" label="Agent thinking" />
      {/if}
      <span class="thinking-timer" data-testid="thinking-timer">{thinkingLabel}</span>
      {#if !expanded}
        <button type="button" class="expand" onclick={() => (expanded = true)}>
          <Icon name="collapse-chevron" size="0.75em" class="expand-icon" />
          Show thought
        </button>
      {:else}
        <p class="text thought-body" data-testid="thought-body">{displayText}</p>
      {/if}
    {:else}
      <p class="text" data-testid="message-text">{displayText}</p>
    {/if}
    <div class="copy-row">
      <CopyButton text={itemCopyText(item)} label={`Copy ${role} message`} revealOnHover />
    </div>
  </div>
</div>

<style>
  /* One timeline metaphor (redesign v3 design spec §3.4): a fixed gutter
     plus content, the identical shape for every role — never a bubble,
     never a right-aligned exception. */
  .message-item {
    display: flex;
    align-items: flex-start;
    width: 100%;
    animation: beat-in var(--duration-base) var(--ease-beat) both;
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

  /* Right-aligned, not centred: `CLAUDE` and `GEMINI` are wider than a
     centred 3.5rem column could hold, so they used to bleed out of the
     gutter and sit flush against the first word of the message. Aligning to
     the inner edge and reserving padding there means the labels form one
     clean rule against the content column however long the provider's name
     is, and nothing can ever touch the prose. */
  .gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    padding-top: var(--space-sm);
    padding-right: var(--space-sm);
    overflow: hidden;
  }

  .glyph {
    width: var(--space-xs);
    height: var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-text-muted);
  }

  /* Design spec v5 §4: the word every reader actually scans for; the dot
     above it stays as a secondary, at-a-glance cue. */
  .role-label {
    font-size: var(--text-caption-size);
    line-height: var(--text-caption-line);
    letter-spacing: var(--text-caption-tracking);
    font-weight: var(--text-caption-weight);
    text-transform: uppercase;
    color: var(--color-text-muted);
    text-align: right;
    white-space: nowrap;
  }

  /* Distinguish user from agent with a hairline/tint on the gutter itself
     — never a different box (the old right-aligned accent-subtle bubble,
     and the agent's competing full-width "card" look, are both gone).
     Design spec v5 §4 adds a second, redundant cue on top: the user's own
     turns additionally sit on `--color-surface-raised`, so the label word
     is never the *only* thing distinguishing the two — colour, tint, and
     word all agree. */
  .message-item.user {
    background: var(--color-surface-raised);
    border-radius: var(--radius-md);
    padding-inline: var(--space-sm);
    margin-inline: calc(var(--space-sm) * -1);
  }

  .message-item.user .gutter {
    box-shadow: inset 2px 0 0 0 var(--color-accent);
  }

  .message-item.user .glyph {
    background: var(--color-accent);
  }

  .message-item.thought .glyph {
    opacity: 0.5;
  }

  .message-item.thought .role-label {
    opacity: 0.5;
  }

  .message-item.thought .glyph {
    opacity: 0.5;
  }

  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
    padding: var(--space-sm) 0;
  }

  /* Thoughts stay a single quiet row — muted and italic, never a pill
     boxed on its own (redesign v3 design spec §3.4 "Thoughts"). */
  .message-item.thought .content {
    opacity: 0.65;
    font-style: italic;
  }

  .text {
    flex: 1;
    min-width: 0;
    margin: 0;
    white-space: pre-wrap;
  }

  /* Sane height limit (issue #136): a long thought scrolls internally
     instead of pushing the rest of the transcript out of view. */
  .thought-body {
    max-height: 12rem;
    overflow-y: auto;
  }

  .thinking-timer {
    flex-shrink: 0;
    font-size: var(--text-caption-size);
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
  }

  .expand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    padding: 0;
    border-radius: var(--radius-sm);
    transition: opacity var(--duration-fast) var(--ease-beat);
  }

  .expand:hover {
    opacity: 1;
  }

  .expand:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.expand-icon) {
    flex-shrink: 0;
  }

  .copy-row {
    flex-shrink: 0;
  }

  /* Copy affordances reveal on row hover/focus-within rather than sitting
     permanently visible (redesign v3 design spec §3.4 "Copy affordances");
     `CopyButton`'s own `revealOnHover` opts into this, and stays visible
     under `(hover: none)` regardless (see CopyButton.svelte). */
  .message-item:hover :global(.copy-button-reveal),
  .message-item:focus-within :global(.copy-button-reveal) {
    opacity: 1;
  }
</style>
