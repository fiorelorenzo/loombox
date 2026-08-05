<script lang="ts">
  /**
   * A message/thought transcript item (SPEC.md §7.24's append-by-id reducer
   * output). A thought renders as plain text, smaller and quieter than an
   * answer — no card, no italic (design spec
   * `2026-08-05-cockpit-v8-decisions.md` §2, decision B1-1, issue #709) —
   * expandable on tap, height-capped once expanded so one very long
   * thought never blows out the transcript layout (§7.24
   * "Thinking/reasoning"). While `thinking`
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
   * (`var(--gutter)`) and `.content` flowing in the remaining width —
   * never a bubble, never right-aligned; the old right-aligned
   * accent-subtle bubble and the agent's full-width "card" look are both
   * gone, every row reads the same shape. A plain CSS `animation`
   * (`beat-in`, `--duration-base`/`--ease-beat`) plays once when the root
   * element is first mounted into the keyed `{#each item.id}` list and
   * never replays on the in-place prop updates that stream text into the
   * same DOM node (verified by the existing "DOM node stays the same
   * instance" test) — the un-staggered single beat-in the brief specifies
   * for live-streamed arrivals. Reduced motion is handled for free: this
   * animation is written entirely against `--duration-base`/`--ease-*`,
   * which `tokens.css` already zeroes under `prefers-reduced-motion`.
   *
   * Turn delimitation v7 (`docs/superpowers/specs/2026-08-04-cockpit-v7-
   * decisions.md` §2, issue #667 — B1-2 amended + B2-4, superseding the v6
   * §3.4 glyph-plus-word scheme this doc comment used to describe): one
   * signal per role, and nothing sighted paints in the gutter at all
   * anymore. `user` gets an accent-tinted wash (v8 §2 decision B3-3, issue
   * #709 — `color-mix(in srgb, var(--color-accent) 8%, transparent)`,
   * fill only, no bar, replacing the old flat `--color-surface-raised`
   * that read three times starker in light than in dark); `agent` gets no
   * fill and runs straight into the page background; neither carries a
   * gutter accent bar — Lorenzo's amendment on B1-2 explicitly dropped the
   * bar the option was drawn with ("only the different background... do
   * not reintroduce a second mark to help"). `thought` dropped its own
   * v6-era `--color-surface` card in v8 §2's B1-1 (issue #709): the type
   * itself — size and colour — is the only thing that still marks where a
   * thought starts or ends.
   *
   * The gutter keeps its job as the shared alignment device — every
   * sibling row shape (`ToolCallGutter`, `PlanCard`, `QueuedPromptBar`,
   * the composer in `+page.svelte`) still reads `var(--gutter)`, narrowed
   * for v7 since nothing here needs to fit a word or an icon anymore (see
   * that token's own comment in `tokens.css`) — it just paints nothing:
   * no glyph, no bar, only the same visually-hidden `.sr-only` label every
   * turn has always carried (`PROVIDER_LABELS.role`/`"You"`), which is the
   * whole reason dropping the glyph is a design choice and not an
   * accessibility regression (B2-4's own acceptance bar). `showAttribution`
   * and `$lib/transcript-attribution.ts`'s consecutive-run grouping are
   * gone with the glyph they existed to hide — there was nothing left in
   * the gutter for them to suppress.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the thought disclosure toggle draws its chevron from the
   * shared `Icon` component (`collapse-chevron` — the same glyph the
   * sessions rail uses for its own expand/collapse toggle), rotated by
   * `aria-expanded` the same way `GenericToolRow`'s own disclosure does.
   * v8 §2's B2-1 (issue #709) turned the toggle icon-only — the label
   * moved above the thought and the button no longer carries visible text
   * — so the icon stays decorative (`aria-hidden`) while the button
   * itself carries the accessible name via `aria-label`, same convention
   * as every other icon-only control in this app.
   *
   * B2-1 also turned `expanded` from local, per-instance state into one
   * global preference (`$lib/expand-thoughts.ts`'s `expandThoughtsStore`,
   * shaped like `$lib/accent.ts`'s own store): a single `localStorage`
   * boolean, read once and applied to every thought in every session,
   * defaulting to expanded (Lorenzo's own ask — "di default espanso").
   * `displayExpanded` below ORs that preference with `thinking`: a thought
   * that is currently producing text stays visible regardless of the
   * resting preference, closing the collapsed-container collision this
   * decision calls out by name with issue #660 (a thought streaming into
   * a collapsed container is why #660's own fake stayed green for
   * months — see this file's tests for the reverted-fix proof).
   */
  import { untrack } from 'svelte';
  import type { TranscriptMessageItem } from '@loombox/providers-core/browser';
  import { itemCopyText } from '$lib/copy';
  import { expandThoughtsStore } from '$lib/expand-thoughts';
  import {
    highlightMarkdownToHtml,
    renderMarkdownToHtml,
    splitStreamingMarkdown,
  } from '$lib/markdown';
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
    /** The session's `ClientSessionMeta.provider` (e.g. `'claude'`) — only meaningful for an agent/thought row's `.sr-only` accessible label; a user row's label is always "You" regardless. Omitted falls back to the generic "Agent" label rather than guessing. */
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

  // Markdown (issue #574, design spec §3.4; async highlighting issue #600):
  // re-parsing the whole message through remark/rehype on every 32ms reveal
  // tick does not hold up on a long turn, so `splitStreamingMarkdown`
  // (`$lib/markdown`) finds the last position in `displayText` that is safe
  // to fully parse — every block opened so far has also closed — and only
  // that "stable" prefix goes through the real Markdown pipeline; a
  // still-forming block after it (`tailText`) renders as plain text, and a
  // still-open fenced code block (`openFence`) renders as a plain monospace
  // box, never syntax-highlighted until its closing fence actually arrives.
  // `lastStableSource`/`lastStableHtml` are plain (non-reactive) locals,
  // not `$state`: most ticks only grow `tailText`, so this cache is what
  // keeps the expensive parse+sanitize call from re-running on every one of
  // them — it only reruns when the stable boundary itself actually
  // advances.
  //
  // Highlighting (issue #600) is a second, independent, async trigger
  // layered on top: `renderMarkdownToHtml` never highlights any more, so
  // `lastStableHtml` is always ready the instant `stable` grows, as a plain
  // render — the same unhighlighted-monospace state `openFence` already
  // shows for a still-streaming fence, just for a now-closed one whose
  // grammar hasn't loaded yet. `requestHighlight` fires `$lib/markdown`'s
  // dynamic import in the background; when it resolves, it upgrades the
  // render in place only if `source` still matches the *current*
  // `lastStableSource` (reassigned synchronously, before the async call
  // starts) — a resolution for a `stable` the message has since grown past
  // is stale and silently dropped rather than clobbering a newer render
  // with older content, and `destroyed` drops one that outlives the
  // component itself. `highlightedHtml`/`highlightedForSource` are the only
  // pieces written from outside this derived (the async callback), which is
  // why `highlightedHtml` — unlike the two plain locals above — is
  // `$state`: it is what needs to trigger a re-render once highlighting
  // actually lands.
  let lastStableSource = '';
  let lastStableHtml = '';
  let highlightedForSource = '';
  let highlightedHtml = $state('');
  let destroyed = false;

  function requestHighlight(source: string) {
    void highlightMarkdownToHtml(source).then((html) => {
      if (html === null || destroyed || source !== lastStableSource) return;
      highlightedForSource = source;
      highlightedHtml = html;
    });
  }

  const rendered = $derived.by(() => {
    const split = splitStreamingMarkdown(displayText, !turnActive);
    if (split.stable !== lastStableSource) {
      lastStableSource = split.stable;
      lastStableHtml = renderMarkdownToHtml(split.stable);
      requestHighlight(split.stable);
    }
    // `highlightedHtml` is read unconditionally, before the branch that
    // decides whether to use it: Svelte only subscribes `rendered` to the
    // `$state` it actually reads during a given run, and a ternary
    // short-circuits its untaken branch, so gating this read behind the
    // `highlightedForSource === lastStableSource` check below would mean
    // `rendered` never re-runs the *first* time highlighting actually
    // lands for a given message (its own write happens on a run where the
    // check was still false, so `highlightedHtml` was never touched, so
    // there is no subscription to wake this derived back up).
    const upgraded = highlightedHtml;
    const html = highlightedForSource === lastStableSource ? upgraded : lastStableHtml;
    return { html, tailText: split.tailText, openFence: split.openFence };
  });

  $effect(() => {
    return () => {
      destroyed = true;
    };
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
  // and its content already reads as a thought via the timer and its own
  // smaller/quieter type (B1-1), so the accessible label doesn't need a
  // third value to say so again. This no longer paints as a visible word
  // (v6 §3.4) — it backs the `.sr-only` label below instead.
  const accessibleLabel = $derived(
    role === 'user' ? 'You' : (providerId && PROVIDER_LABELS[providerId]?.role) || 'Agent',
  );

  // B2-1 (design spec `2026-08-05-cockpit-v8-decisions.md` §2, issue #709):
  // one global boolean, applied to every thought — replaces the old
  // per-instance `let expanded = $state(false)`. `thinking` overrides it
  // one-directionally: a thought that is *currently producing text* must
  // stay visible no matter what the resting preference says (the #660
  // collision this decision calls out by name — a thought streaming into
  // a collapsed container is why #660's fake stayed green for months).
  // The instant `thinking` flips false this collapses right back to
  // whatever the shared preference is, same as every other thought.
  const expandThoughtsPreference = expandThoughtsStore.expanded;
  const displayExpanded = $derived($expandThoughtsPreference || thinking);

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
    <span class="sr-only">{accessibleLabel}</span>
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
      <div class="thought-wrap">
        <div class="thought-head">
          <button
            type="button"
            class="expand"
            aria-expanded={displayExpanded}
            aria-label={displayExpanded ? 'Collapse thought' : 'Expand thought'}
            onclick={() => expandThoughtsStore.toggle()}
          >
            <Icon name="collapse-chevron" size="0.75em" class="expand-icon" />
          </button>
          {#if thinking}
            <WovenLoader size="sm" variant="working" label="Agent thinking" />
          {/if}
          <span class="thinking-timer" data-testid="thinking-timer">{thinkingLabel}</span>
        </div>
        {#if displayExpanded}
          <div class="text thought-body md-body" data-testid="thought-body">
            {@render markdownBody()}
          </div>
        {/if}
      </div>
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

  /* Right-aligned inner edge, matching `ToolCallGutter`/`QueuedPromptBar`'s
     own copies of this rule even though nothing paints here anymore (v7
     turn delimitation, issue #667) — the alignment behaviour stays
     identical across every row type sharing this column regardless of
     which of them currently holds visible content. */
  .gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    padding-top: var(--space-sm);
    padding-right: var(--space-sm);
  }

  /* The real accessible name every turn still carries (issue #575 point 6):
     the same short word v5 painted visibly, now off-screen but present in
     the DOM in the exact position a sighted v5 reader's eye used to land on
     first, so a screen reader's reading order is unchanged. Present on
     EVERY turn — v7 dropped the glyph that used to sit beside it (issue
     #667), this label never depended on it being there. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* v7 turn delimitation (design spec §2, issue #667 — B1-2 amended): the
     user's own turn keeps its one signal, a fill — no gutter accent bar
     anymore, on this row or any other. "Exactly one signal per role," per
     Lorenzo's amendment on the option as drawn (which paired the fill
     with a bar): the different background carries the whole distinction
     alone.

     v8 §2's B3-3 (issue #709) replaced the flat `--color-surface-raised`
     fill with a wash derived from the accent token itself: one rule for
     both themes instead of a hand-tuned pair, because `--color-accent` is
     already identical across dark/light while `--color-surface-raised`
     measured ΔL* ≈ 2.8 in dark and ≈ 8.4 in light against the same rule —
     three times starker in light, the starkest edge on the page. 8% lands
     at ΔL* ≈ 4.5 dark / ≈ 2.4 light with no per-theme tuning. The named
     risk was tying the signal to the same blue links and Send use for
     "interactive" — verified at 8% against a real Markdown-rendered link
     and a real `ui/Button` "Send" in both themes, over CDP in a real
     Chromium, reading as a quiet fill rather than a control (screenshots,
     not just the numbers above). */
  .message-item.user {
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    border-radius: var(--radius-md);
    padding-inline: var(--space-sm);
    margin-inline: calc(var(--space-sm) * -1);
  }

  /* The agent's own signal is absence (v7 §2's own framing): no fill at
     all, so a long answer runs straight into the page background — the
     pre-v6 behaviour, restored on purpose; `.agent` carries no rule of its
     own here anymore.

     `.thought` dropped its own pre-v8 `--color-surface` card outright (v8
     §2's B1-1, issue #709): no fill, no radius, no inset padding — the
     gutter column stays the one alignment device, per that decision's own
     text, and is not a licence to reintroduce a gutter accent bar v7
     already removed. `.thought-body` below carries the whole
     distinction now, through type alone. */

  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: var(--space-xs);
    padding: var(--space-sm) 0;
  }

  /* B1-1 (issue #709): "nothing but the type itself now marks where a
     thought starts or ends" — a real size and colour step down from the
     answer's own ambient `--text-body-size`/`--color-text-primary`,
     replacing the old `opacity: 0.65; font-style: italic` that dimmed the
     whole row (including the toggle and the timer) without actually
     changing the type. Scoped to `.thought-body` alone, not the head row:
     the timer already carries its own distinct caption treatment below. */
  .message-item.thought .thought-body {
    font-size: var(--text-small-size);
    line-height: var(--text-small-line);
    color: var(--color-text-secondary);
  }

  /* B2-1's "label moves above the thought" (issue #709): a column, not
     the old single inline row that let the timer eat the first ~90px of
     every wrapped line. `.thought-head` holds the toggle, the live
     "thinking" motif, and the timer; `.thought-body` (when shown) sits
     below it at the column's full width. */
  .thought-wrap {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .thought-head {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
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
     `TerminalOutput`, so a closed fence and the still-open plain-monospace
     one it grew from (`.md-open-fence`, rendered directly rather than
     through `{@html}` — see the script's `rendered` derivation) never
     change shape, only colour. That now also covers the gap between a
     fence closing and its grammar loading (issue #600's async highlighter
     — see `$lib/markdown`'s doc comment): both states are the identical
     `.md-body pre`/`code.language-xxx` markup this selector already
     covers, `hljs-*` token spans are the only thing that turns on once
     highlighting actually lands. */
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

  /* Icon-only now (B2-1, issue #709 — the label moved above the thought
     and out of this button), so it no longer stretches to fill the row
     or left-aligns text; the accessible name lives entirely in the
     button's own `aria-label`. */
  .expand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
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

  /* Points at the thought when collapsed, down when open — the same
     `aria-expanded`-driven rotation `GenericToolRow`'s own disclosure
     chevron uses, not a second bespoke pattern. */
  :global(.expand-icon) {
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .expand[aria-expanded='false'] :global(.expand-icon) {
    transform: rotate(-90deg);
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

  /* Below `--bp-mobile` the role column collapses and moves above the turn
     (Lorenzo's ask, 2026-07-31) — still true post-v7 even though nothing
     paints in the column anymore: it survives purely as the shared
     alignment device every other row-shaped surface in the transcript
     still reads from. The measurement that forced the original move: on a
     390px phone the column spent 84px of the width on v5's six-letter
     word, leaving the prose a 244px measure that broke sentences every
     five or six words. v7's `--gutter` is already narrowed at every width
     (`tokens.css`), but the column still has to move as one piece with
     every other row sharing it, so the geometry stays.

     Every other surface sharing this column collapses at the same breakpoint
     (`QueuedPromptBar`, `ToolCallGutter` and its four widget rows,
     `PlanCard`, the composer in `+page.svelte`) — they have to move together
     or the timeline's one rule becomes several that nearly line up, which is
     the exact defect the gutter was introduced to fix. `composer-strip`'s
     Playwright guard measures them against each other for that reason.

     Nothing else here is mobile-specific anymore: v7 dropped the gutter
     accent bar everywhere, not just below this breakpoint, so there is no
     bar-reset override left to write — the user's own accent-tinted wash
     (v8 §2's B3-3) is still there on a phone regardless; the thought
     carries no surface cue at all anymore post-v8 (B1-1), only its own
     smaller/quieter type, which needs no breakpoint override either. */
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
  }
</style>
