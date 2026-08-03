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
  import { renderMarkdownToHtml, splitStreamingMarkdown } from '$lib/markdown';
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

  // Markdown (issue #574, design spec §3.4): re-parsing the whole message
  // through remark/rehype on every 32ms reveal tick does not hold up on a
  // long turn, so `splitStreamingMarkdown` (`$lib/markdown`) finds the last
  // position in `displayText` that is safe to fully parse — every block
  // opened so far has also closed — and only that "stable" prefix goes
  // through the real Markdown pipeline; a still-forming block after it
  // (`tailText`) renders as plain text, and a still-open fenced code block
  // (`openFence`) renders as a plain monospace box, never syntax-highlighted
  // until its closing fence actually arrives. `lastStableSource`/
  // `lastStableHtml` are plain (non-reactive) locals, not `$state`: most
  // ticks only grow `tailText`, so this cache is what keeps the expensive
  // parse+sanitize+highlight call from re-running on every one of them —
  // it only reruns when the stable boundary itself actually advances.
  let lastStableSource = '';
  let lastStableHtml = '';
  const rendered = $derived.by(() => {
    const split = splitStreamingMarkdown(displayText, !turnActive);
    if (split.stable !== lastStableSource) {
      lastStableHtml = renderMarkdownToHtml(split.stable);
      lastStableSource = split.stable;
    }
    return { html: lastStableHtml, tailText: split.tailText, openFence: split.openFence };
  });

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
    <span class="role-label">{roleLabel}</span>
  </div>
  <div class="content">
    <!-- rendered.html is our own $lib/markdown pipeline's sanitised output
       (rehype-sanitize + a fixed rehype-highlight/target-blank plugin
       chain — see that module's doc comment), never raw agent text. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {#snippet markdownBody()}{#if rendered.html}{@html rendered.html}{/if}{#if rendered.tailText}<p
          class="md-tail"
        >
          {rendered.tailText}
        </p>{/if}{#if rendered.openFence}<pre
          class="md-open-fence"
          data-testid="md-open-fence"><code>{rendered.openFence.code}</code></pre>{/if}{/snippet}
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
        <div class="text thought-body md-body" data-testid="thought-body">
          {@render markdownBody()}
        </div>
      {/if}
    {:else}
      <div class="text md-body" data-testid="message-text">
        {@render markdownBody()}
      </div>
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

  /* Design spec v5 §4: the word every reader actually scans for, and now the
     only mark in this column. */
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

  /* The accent used to sit on a 4px dot above this word. On a right-aligned
     column it landed over the label's last letter, unattached to anything, and
     read as dirt on the screen rather than as a cue - and the tone it carried
     for an agent turn was `--color-text-muted`, which is to say nothing at all.
     The word carries it now: same information, legible, one mark per turn. */
  .message-item.user .role-label {
    color: var(--color-accent);
  }

  .message-item.thought .role-label {
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
  }

  /* Markdown (issue #574, design spec §3.4): Deck tokens throughout, never a
     library stylesheet, and no second code-block visual language beside the
     one tool-call widgets already use — `pre`/inline `code` here share the
     exact `--color-fill-subtle`/`--radius-md`/`--space-xs`+`--space-sm`
     recipe as `GenericToolRow`'s `.output` and `BashWidget`'s
     `TerminalOutput`, so a closed, highlighted fence and the still-open
     plain-monospace one it grew from (`.md-open-fence`, rendered directly
     rather than through `{@html}` — see the script's `rendered` derivation)
     never change shape, only colour, the instant highlighting turns on. */
  :global(.md-body > :first-child) {
    margin-top: 0;
  }

  :global(.md-body > :last-child) {
    margin-bottom: 0;
  }

  :global(.md-body p) {
    margin: var(--space-sm) 0;
  }

  :global(.md-body h1),
  :global(.md-body h2),
  :global(.md-body h3),
  :global(.md-body h4),
  :global(.md-body h5),
  :global(.md-body h6) {
    font-family: var(--font-ui);
    margin: var(--space-md) 0 var(--space-2xs);
    font-weight: var(--text-title-weight);
    line-height: var(--text-title-line);
  }

  :global(.md-body h1) {
    font-size: var(--text-title-size);
  }

  :global(.md-body h2),
  :global(.md-body h3) {
    font-size: var(--text-body-size);
  }

  :global(.md-body h4),
  :global(.md-body h5),
  :global(.md-body h6) {
    font-size: var(--text-small-size);
  }

  /* Real markers and indentation (issue #574 acceptance), nested lists
     included — `padding-inline-start` is what actually draws the marker
     column; the browser default list-style already gives `ul`/`ol` their
     bullets/numbers, this only spaces them onto the Deck scale. */
  :global(.md-body ul),
  :global(.md-body ol) {
    margin: var(--space-sm) 0;
    padding-inline-start: var(--space-lg);
  }

  :global(.md-body li) {
    margin: var(--space-3xs) 0;
  }

  :global(.md-body li > ul),
  :global(.md-body li > ol) {
    margin: var(--space-3xs) 0;
  }

  :global(.md-body blockquote) {
    margin: var(--space-sm) 0;
    padding-inline-start: var(--space-sm);
    border-inline-start: 2px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  /* Visibly links (underlined, accent) and open externally — `$lib/markdown`'s
     `externalLinks` rehype plugin is what actually sets target/rel; this is
     only the visual half. */
  :global(.md-body a) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  :global(.md-body strong) {
    font-weight: 650;
  }

  :global(.md-body em) {
    font-style: italic;
  }

  /* Inline code — the code surface's quiet inline cousin: a tight pill
     instead of the full `pre` block treatment, distinguishable from prose
     without competing with a real fenced block. `:not(pre) > code` is what
     excludes a fence's own `code` (styled below) from also picking this up. */
  :global(.md-body :not(pre) > code) {
    background: var(--color-fill-subtle);
    border-radius: var(--radius-sm);
    padding: 0.1em 0.35em;
    font-size: var(--text-code-size);
  }

  /* The one code surface, shared verbatim with the tool-call widgets'
     `.output`/`TerminalOutput` (`overflow-x: auto`, never `white-space:
     pre-wrap` — a long line scrolls the box horizontally rather than
     wrapping and growing the transcript vertically, same as those). */
  :global(.md-body pre),
  .md-open-fence {
    margin: var(--space-sm) 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
    font-size: var(--text-code-size);
    line-height: var(--text-code-line);
  }

  :global(.md-body pre code),
  .md-open-fence code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
  }

  /* Tables scroll horizontally inside the transcript measure instead of
     stretching the row (issue #574 acceptance) — `$lib/markdown`'s
     `wrapTables` rehype plugin adds this wrapper around every table. */
  :global(.md-table-scroll) {
    margin: var(--space-sm) 0;
    max-width: 100%;
    overflow-x: auto;
  }

  :global(.md-table-scroll table) {
    border-collapse: collapse;
    font-size: var(--text-small-size);
  }

  :global(.md-table-scroll th),
  :global(.md-table-scroll td) {
    border: 1px solid var(--color-border-subtle);
    padding: var(--space-3xs) var(--space-sm);
    text-align: left;
    white-space: nowrap;
  }

  :global(.md-table-scroll th) {
    background: var(--color-fill-subtle);
    font-weight: 600;
  }

  /* The still-streaming remainder after the last safe Markdown boundary
     (`$lib/markdown`'s `splitStreamingMarkdown`) — plain text, `pre-wrap` so
     a raw newline the eventual list/paragraph will use still reads as a
     line break rather than collapsing, exactly like `.text`'s old blanket
     behaviour, just scoped to only the part that isn't real Markdown yet. */
  .md-tail {
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

  /* Below `--bp-mobile` the role column collapses and the word moves above
     the turn (Lorenzo's ask, 2026-07-31). The measurement that forced it: on
     a 390px phone the column spent 84px of the width on a six-letter word,
     leaving the prose a 244px measure that broke sentences every five or six
     words. What design spec v5 §4 actually asks for is that every turn state
     its role in a word rather than a colour — it says nothing about the word
     sitting beside the text, and above it is where a phone reader already
     scans. So the word survives, the geometry goes.

     Every other surface sharing this column collapses at the same breakpoint
     (`QueuedPromptBar`, `ToolCallGutter` and its four widget rows,
     `PlanCard`, the composer in `+page.svelte`) — they have to move together
     or the timeline's one rule becomes several that nearly line up, which is
     the exact defect the gutter was introduced to fix. `composer-strip`'s
     Playwright guard measures them against each other for that reason.

     The gutter's accent thread goes with the column rather than moving to the
     row's own left edge, which sounds like the obvious relocation and paints
     nothing: a `user` row deliberately bleeds `--space-sm` outside the
     transcript list (the `margin-inline`/`padding-inline` pair above), and
     `.items` is an `overflow: auto` scroller, so it clips exactly the strip
     that thread would live in — measured at 390px, the row's border box sits
     at x=3.8 while the first painted pixel of its own background is at 11.4.
     Nothing is lost: this file's own comment above calls the raised surface a
     deliberately redundant second cue, and on a phone the white card and the
     accent word are both still there. */
  @media (max-width: 479px) {
    .message-item {
      flex-direction: column;
      align-items: stretch;
    }

    .gutter {
      flex: 0 0 auto;
      width: auto;
      align-items: flex-start;
      padding-right: 0;
    }

    .content {
      padding-top: var(--space-3xs);
    }

    /* The 2px thread this column used to carry would now be a stub floating
       beside the word — the "dirt on the screen" note above, again. */
    .message-item.user .gutter {
      box-shadow: none;
    }
  }
</style>
