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
   */
  import { untrack } from 'svelte';
  import type { TranscriptMessageItem } from '@loombox/providers-core';
  import { itemCopyText } from '$lib/copy';
  import { TextPacer } from '$lib/text-pacer';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';

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
      <button type="button" class="expand" onclick={() => (expanded = true)}>Show thought</button>
    {:else if role === 'thought'}
      <p class="text thought-body" data-testid="thought-body">{displayText}</p>
    {:else}
      <p class="text" data-testid="message-text">{displayText}</p>
    {/if}
    <CopyButton text={itemCopyText(item)} label={`Copy ${role} message`} />
  </div>
</div>

<style>
  .message-item {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-lg);
    background: var(--color-fill-subtle);
  }

  .message-item.user {
    align-self: flex-end;
    background: var(--color-accent-subtle);
  }

  .message-item.thought {
    opacity: 0.65;
    font-style: italic;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
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
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    padding: 0;
  }
</style>
