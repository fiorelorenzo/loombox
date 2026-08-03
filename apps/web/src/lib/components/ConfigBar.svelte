<script lang="ts">
  /**
   * The model/mode/reasoning-effort bar (SPEC.md §7.24 "Model, mode &
   * reasoning effort", issue #149): one persistent bar next to the
   * composer, bound directly to the session's negotiated ACP config-option
   * list — never a settings modal. `mode` renders as its own segmented
   * control (it drives the permission behavior); every other category
   * (`model`, `model_config`, `thought_level`, or any future/unrecognized
   * one) renders as a generic labeled selector grouped near the model
   * picker, per ACP's own recommendation — an unrecognized category name is
   * never dropped. A per-session context-fill percentage meter (excluding
   * any usage attributable to a subagent tool call, SPEC.md §7.9/§16) sits
   * at the end of the bar.
   *
   * Always driven straight off `options` (a prop): there is no internal
   * "currently selected" state duplicated here, so a user pick and an
   * unprompted `config_option_update` both re-render the full control set
   * identically — the caller (see `RelayClient.setConfigOption`) just
   * replaces `options` wholesale, which is exactly what §7.24 asks for
   * ("never patch one control in isolation").
   *
   * Warp Deck restyle (docs/design/redesign.md §4/§6, issue #439): "moves
   * into a slim toolbar row directly above the composer" — this component
   * itself stays chrome-less (no background/border of its own) so it
   * composes cleanly as a quiet control strip inside the caller's own
   * mini-toolbar frame (`+page.svelte`'s `.composer-toolbar-controls`,
   * which also holds `AttachmentBar`'s trigger and collapses together
   * behind the "···" affordance below `--bp-mobile`/480px). The mode
   * segmented control's selection crossfades (`status-crossfade`, §2)
   * rather than snapping.
   *
   * Deck migration (redesign v2 design spec, issue #471): the mode
   * segmented control's choices now route through the shared `Button`
   * (`ghost`, `sm`) instead of a hand-rolled `<button>`. `Button` has no
   * built-in "selected" concept (unlike `IconButton`'s `pressed`), so the
   * selected tint is applied via a plain class merged into its `class`
   * prop, styled here with `:global()` the same way `AttachmentBar`'s
   * `.pick-button` override reaches into a child component's own root
   * element (the accessible role/name resolve the same way regardless:
   * `Button` renders its `children` snippet verbatim inside the native
   * `<button>`).
   *
   * Deck v3 restyle (redesign v3 design spec §3.5, issue #502): every
   * category picker now renders through the shared `ui/Select` primitive
   * instead of a native `<select>`, so the bar never mixes two visual
   * languages again (defect `C8`) — `Select`'s own trigger reads the same
   * `--radius-md`/`--color-border` tokens and the same `sm` size scale as
   * the `mode` segmented control's `Button` (`ghost`, `sm`) choices, so
   * the two control idioms share height/radius/border by construction,
   * not by coincidence. The context/cost meter now gets its own
   * right-aligned, bordered-off slot with the percentage as the primary
   * figure and the cost muted beside it (previously undifferentiated grey
   * text jammed against the controls), plus a `title` spelling out both
   * numbers for anyone hovering.
   *
   * Composer strip (Lorenzo's ask, 2026-07-30): this bar moved from a strip
   * of its own ABOVE the composer to the one control row directly under the
   * textarea, so the composer owns one strip instead of two. Three changes
   * came with the move:
   *
   *  - The visible word "Model" is gone. The value already reads as a model
   *    name ("Sonnet 4.5"), so the label spent a word to say nothing; the
   *    agent's own name stands in front of the picker instead, which is the
   *    fact that was missing ("which agent am I talking to"). The `Select`
   *    keeps `Model` as its ACCESSIBLE name — the agent name is a sibling
   *    fact, never marked up as that control's label.
   *  - The meter reports the context in use AGAINST ITS MAXIMUM ("76k /
   *    200k") rather than a bare percentage, plus a 3px track that carries
   *    the percentage pre-attentively: context exhaustion is the one thing
   *    you want to notice without reading, and the track tints amber at 80%
   *    and red at 95%. No figure is encoded twice — the track IS the
   *    percentage, the numbers ARE the absolutes, and the `title` spells
   *    both out in words.
   *  - `compact` is for a caller with no room (below `--bp-mobile`, where it
   *    collapses the pickers behind a "···"): the pickers and the agent name
   *    go, and the meter drops the denominator, keeping the track, the used
   *    count and the cost. Measured, not guessed — at 390px the full meter is
   *    215px of a ~300px content width, which wrapped Send onto a line of its
   *    own and cost the composer half the screen. The ratio is not lost with
   *    the denominator: the track IS the ratio, and the `title` still spells
   *    every figure out. The old strip hid all of it behind the "···", so the
   *    first thing to disappear on a phone was the number a user watches.
   *
   * Segmented-control a11y (issue #549): the mode control's selection lived
   * only in a background tint — `role="group"` around two plain buttons —
   * so a screen reader heard "Auto, button. Plan, button." with no way to
   * tell which one was current. Decided as `role="radiogroup"` with
   * `role="radio"`/`aria-checked` per segment and a roving `tabindex`
   * (arrow keys move focus AND the selection, one tab stop for the whole
   * group), not the topbar panel switch's `aria-pressed`: `mode` is
   * mutually exclusive and ALWAYS has exactly one value, which is exactly
   * what a radio group means and `aria-pressed` (independently on/off,
   * legitimately all-off) does not. The panel switch is a genuinely
   * different control — `toggleDrawer` in `+page.svelte` closes the open
   * panel on a second click of the same segment, so "none selected" is a
   * real state there — so it keeps `aria-pressed` rather than picking up
   * this pattern too. `Button` gained plain pass-through `role`/
   * `ariaChecked`/`tabindex`/`onkeydown` props for this rather than a
   * hand-rolled `<button>` here, so the segmented-control idiom stays one
   * shared primitive.
   */
  import { tick } from 'svelte';
  import type { AcpConfigOption, UsageRecord } from '@loombox/providers-core/browser';
  import { PROVIDER_LABELS } from '$lib/providers';
  import Button from './ui/Button.svelte';
  import Select from './ui/Select.svelte';

  interface Props {
    options: AcpConfigOption[];
    usage: UsageRecord | undefined;
    cumulativeCostUsd: number;
    onChange: (category: string, optionId: string) => void;
    /** The session's ACP provider id — named in front of the model picker so the row says which agent is answering. */
    providerId?: string | undefined;
    /** For a caller with no room: pickers and agent name hidden, meter shortened to track + used + cost. */
    compact?: boolean;
  }

  const {
    options,
    usage,
    cumulativeCostUsd,
    onChange,
    providerId,
    compact = false,
  }: Props = $props();

  const modeOption = $derived(options.find((option) => option.category === 'mode'));
  const otherOptions = $derived(options.filter((option) => option.category !== 'mode'));

  /** The radiogroup root, for moving focus onto the newly-selected segment when an arrow key changes it (see `handleModeKeydown`). */
  let modeGroupEl = $state<HTMLDivElement | undefined>(undefined);

  // Falls back to the raw id rather than dropping the fact: an unrecognized
  // provider still tells a user more than a blank does (same reasoning as
  // `NewSessionDialog`'s own `PROVIDER_LABELS[id]?.name ?? id`).
  const agentName = $derived(
    providerId ? (PROVIDER_LABELS[providerId]?.name ?? providerId) : undefined,
  );

  // §7.9/§16: the live percentage meter excludes usage attributable to a
  // subagent tool call; the cumulative cost figure never does (folded in
  // regardless by the reducer itself, `transcript.ts`'s `reduceUsage`).
  const contextPercent = $derived(
    usage && !usage.attributedToSubagent && usage.tokensUsed !== undefined && usage.contextWindow
      ? Math.min(100, Math.round((usage.tokensUsed / usage.contextWindow) * 100))
      : undefined,
  );

  /** The context figures behind the meter, present only when the same §7.9 guard `contextPercent` applies holds — a used count with no window to measure it against is noise, not information. */
  const contextTokens = $derived(
    contextPercent !== undefined && usage?.tokensUsed !== undefined && usage.contextWindow
      ? { used: usage.tokensUsed, max: usage.contextWindow }
      : undefined,
  );

  // Bullet 2 of the v3 Controls slice: a clear, hoverable explanation of
  // both meter figures — the percentage is turn-scoped and subagent-free,
  // the cost is the whole session and always includes subagent spend
  // (see the `contextPercent` comment above). It is also where the
  // percentage is stated in words now that the track carries it visually.
  const meterTitle = $derived(
    contextTokens
      ? `${contextPercent}% of the context window used this turn (${contextTokens.used.toLocaleString('en-US')} of ${contextTokens.max.toLocaleString('en-US')} tokens) · $${cumulativeCostUsd.toFixed(2)} spent this session`
      : `$${cumulativeCostUsd.toFixed(2)} spent this session`,
  );

  function categoryLabel(category: string): string {
    return category
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /** Token counts abbreviated to the unit a context window is discussed in ("76k / 200k"), so the pair stays readable at caption size in a row that also holds controls. */
  function formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
    return `${count}`;
  }

  /**
   * WAI-ARIA APG "radio group" arrow-key navigation: Left/Up selects the
   * previous segment, Right/Down the next, wrapping at the ends. A native
   * radio group moves focus and the selection together on arrow keys (not
   * just focus, the way a listbox/tablist does), so this calls `onChange`
   * immediately rather than waiting for Enter/Space.
   *
   * `modeOption.current` itself only moves once the caller's round trip
   * replaces `options` (this component keeps no internal selection state,
   * see the header comment) — the same one-way data flow a mouse click
   * already waits on. Focus does not wait for that: it moves to the
   * chosen segment straight away, by index, the same way a click's own
   * target is already focused by the browser before `onChange` returns.
   */
  function handleModeKeydown(event: KeyboardEvent): void {
    if (!modeOption) return;
    const { choices, current } = modeOption;
    if (choices.length === 0) return;

    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    event.preventDefault();

    const currentIndex = choices.findIndex((choice) => choice.id === current);
    const nextIndex = (Math.max(currentIndex, 0) + delta + choices.length) % choices.length;
    const nextChoice = choices[nextIndex];
    if (!nextChoice) return;

    onChange('mode', nextChoice.id);
    tick().then(() => {
      const radios = modeGroupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios?.[nextIndex]?.focus();
    });
  }
</script>

<div class="config-bar" data-testid="config-bar">
  {#if !compact}
    {#if agentName}
      <span class="agent" data-testid="config-agent">{agentName}</span>
    {/if}

    {#each otherOptions as option (option.category)}
      <div class="control" data-testid={`config-option-${option.category}`}>
        <!-- The model picker's own value already reads as a model name, so it
             takes the agent name above as its visible neighbour instead of a
             label repeating the category. Every other category keeps its word:
             a bare "High" would not say what it measures. -->
        {#if option.category !== 'model'}
          <span class="label">{categoryLabel(option.category)}</span>
        {/if}
        <Select
          value={option.current ?? ''}
          options={option.choices.map((choice) => ({ id: choice.id, label: choice.name }))}
          onChange={(optionId) => onChange(option.category, optionId)}
          label={categoryLabel(option.category)}
          size="sm"
        />
      </div>
    {/each}

    {#if modeOption}
      <div
        class="control mode"
        role="radiogroup"
        aria-label="Mode"
        data-testid="config-option-mode"
        bind:this={modeGroupEl}
      >
        {#each modeOption.choices as choice (choice.id)}
          <Button
            variant="ghost"
            size="sm"
            class={`mode-choice ${modeOption.current === choice.id ? 'selected' : ''}`.trim()}
            role="radio"
            ariaChecked={modeOption.current === choice.id}
            tabindex={modeOption.current === choice.id ? 0 : -1}
            onclick={() => onChange('mode', choice.id)}
            onkeydown={handleModeKeydown}
          >
            {choice.name}
          </Button>
        {/each}
      </div>
    {/if}
  {/if}

  <div class="meter" data-testid="context-meter" title={meterTitle}>
    {#if contextTokens}
      <!-- The track is the percentage; the numbers are the absolutes. Hidden
           from the accessibility tree because it re-states, in pixels, what
           the figures beside it and the `title` already say in words. -->
      <span
        class="track"
        class:high={contextPercent !== undefined && contextPercent >= 80}
        class:full={contextPercent !== undefined && contextPercent >= 95}
        data-testid="context-track"
        data-fill={contextPercent}
        aria-hidden="true"
      >
        <span class="track-fill" style:width={`${contextPercent}%`}></span>
      </span>
      <span class="meter-primary">{formatTokens(contextTokens.used)}</span>
      {#if !compact}
        <span class="meter-sep" aria-hidden="true">/</span>
        <span class="meter-max">{formatTokens(contextTokens.max)}</span>
      {/if}
      <span class="meter-sep" aria-hidden="true">·</span>
    {/if}
    <span class="meter-cost">${cumulativeCostUsd.toFixed(2)}</span>
  </div>
</div>

<style>
  /* Takes the row's spare width so `.meter`'s `margin-left: auto` right-aligns
     the figures against the send controls, instead of the whole bar shrinking
     to its content and leaving the meter jammed against the last picker.

     Deliberately NOT `min-width: 0`: that let the bar shrink below its own
     min-content on a phone, and the meter — which must not break a figure
     across lines — overflowed straight over the Send button (caught in a 390px
     capture, where "$1.74" was painted through "Send"). At `auto` the row wraps
     Send onto its own line instead, which is what a flex row is for. */
  .config-bar {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
  }

  .control {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
  }

  .label {
    color: var(--color-text-secondary);
  }

  /* The agent answering, not a control: same secondary register as a picker's
     label, but in the app's own voice rather than uppercase chrome. */
  .agent {
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .mode {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  /* `Button`'s own scope hides `.mode-choice`/`.selected` from this file's
     hash — reach in with `:global()`, same pattern as `AttachmentBar`'s
     `.pick-button` override. Base hover/focus/status-crossfade transition
     are already `Button`'s (`ghost` variant); only the color/background
     tint this segmented control needs on top is declared here. */
  :global(.mode-choice) {
    color: var(--color-text-secondary);
    border-radius: 0;
  }

  :global(.mode-choice:hover) {
    text-decoration: none;
    background: var(--color-fill-subtle);
  }

  :global(.mode-choice.selected) {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  /* Right-aligned against the send controls (v3 §3.5). The vertical rule this
     slot used to carry is gone: it separated the meter from pickers sitting
     right beside it in the old strip, and in the composer row — where
     `margin-left: auto` already opens a gap of real space — it read as an
     orphan pipe with nothing on its left. */
  .meter {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: var(--space-2xs);
    /* One figure per side of the slash, never a number split across lines. */
    white-space: nowrap;
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
    font-size: var(--text-small-size);
  }

  .meter-primary {
    color: var(--color-text-primary);
    font-weight: 600;
  }

  .meter-sep,
  .meter-max,
  .meter-cost {
    color: var(--color-text-muted);
  }

  /* 3px of pre-attentive signal: you register "nearly full" without reading a
     number. Centred against a baseline-aligned row, so it sits with the digits
     rather than on them. */
  .track {
    align-self: center;
    width: 2.5rem;
    height: 3px;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--color-border);
    overflow: hidden;
  }

  .track-fill {
    display: block;
    height: 100%;
    background: var(--color-text-secondary);
    transition: width var(--duration-base) var(--ease-beat);
  }

  /* Amber approaching the wall, red at it: the two points where what you do
     next changes (wrap up the turn / expect a compaction). */
  .track.high .track-fill {
    background: var(--color-warning);
  }

  .track.full .track-fill {
    background: var(--color-danger);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same
     coarse-pointer convention `Button`/`IconButton` already use. */
  @media (pointer: coarse) {
    :global(.mode-choice) {
      min-height: 2.75rem;
    }
  }
</style>
