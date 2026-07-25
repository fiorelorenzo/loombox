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
   * Warp Deck restyle (`docs/design/redesign.md` §6, issue #432): the root
   * `.message-item` is itself the flex item that drives role-based
   * alignment (fixing the old dead `align-self` rule, which needed a flex
   * *parent* it never had) — `user` turns right-align a real accent-subtle
   * bubble capped at ~70ch; `agent`/`thought` rows stay left-aligned, full
   * width, `flat`-tier (elevation ladder §3). A plain CSS `animation`
   * (`beat-in`, `--duration-base`/`--ease-beat`) plays once when the root
   * element is first mounted into the keyed `{#each item.id}` list and
   * never replays on the in-place prop updates that stream text into the
   * same DOM node (verified by the existing "DOM node stays the same
   * instance" test) — the un-staggered single beat-in the brief specifies
   * for live-streamed arrivals. Reduced motion is handled for free: this
   * animation is written entirely against `--duration-base`/`--ease-*`,
   * which `tokens.css` already zeroes under `prefers-reduced-motion`.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the "Show thought" disclosure affordance draws its chevron from
   * the shared `Icon` component (`collapse-chevron` — the same glyph the
   * sessions rail uses for its own expand/collapse toggle) instead of
   * relying on text alone; decorative (`aria-hidden`, no `label`), since the
   * button's own visible text already carries the accessible name.
   */
  import { untrack } from 'svelte';
  import type { TranscriptMessageItem } from '@loombox/providers-core';
  import { itemCopyText } from '$lib/copy';
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
  }

  const { item, thinking = false, turnActive = false }: Props = $props();

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
  class:thought={role === 'thought'}
  data-testid="message-item"
>
  <div class="row">
    <span class="role">{role}</span>
    {#if role === 'thought'}
      {#if thinking}
        <WovenLoader size="sm" variant="working" label="Agent thinking" />
      {/if}
      <span class="thinking-timer" data-testid="thinking-timer">{thinkingLabel}</span>
    {/if}
    {#if role === 'thought' && !expanded}
      <button type="button" class="expand" onclick={() => (expanded = true)}>
        <Icon name="collapse-chevron" size="0.75em" class="expand-icon" />
        Show thought
      </button>
    {:else if role === 'thought'}
      <p class="text thought-body" data-testid="thought-body">{displayText}</p>
    {:else}
      <p class="text" data-testid="message-text">{displayText}</p>
    {/if}
    <CopyButton text={itemCopyText(item)} label={`Copy ${role} message`} />
  </div>
</div>

<style>
  /* The root is the actual flex item that drives alignment (fixes the old
     dead `align-self` rule — that needed a flex *parent*, which the
     `<li>` wrapper in the transcript list never provided). */
  .message-item {
    display: flex;
    width: 100%;
    justify-content: flex-start;
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .message-item.user {
    justify-content: flex-end;
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

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
    max-width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-lg);
    /* flat tier (elevation ladder §3): agent/thought rows are plain,
       full-width, conversational text — not a boxed card. */
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
  }

  /* User turns: a real right-aligned accent-subtle bubble, capped so a
     one-line reply doesn't stretch across the whole canvas. */
  .message-item.user .row {
    max-width: min(70ch, 100%);
    background: var(--color-accent-subtle);
    border-color: transparent;
  }

  .message-item.thought .row {
    opacity: 0.65;
    font-style: italic;
  }

  .role {
    flex-shrink: 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    opacity: 0.6;
    padding-top: var(--space-3xs);
  }

  .text {
    flex: 1;
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
    font-size: 0.7rem;
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
</style>
