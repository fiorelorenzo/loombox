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
   * never dropped.
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
   * not by coincidence.
   *
   * Composer strip (Lorenzo's ask, 2026-07-30): this bar moved from a strip
   * of its own ABOVE the composer to the one control row directly under the
   * textarea, so the composer owns one strip instead of two. The visible
   * word "Model" went with it: the value already reads as a model name
   * ("Sonnet 4.5"), so the label spent a word to say nothing; the agent's
   * own name stands in front of the picker instead, which is the fact that
   * was missing ("which agent am I talking to"). The `Select` keeps `Model`
   * as its ACCESSIBLE name — the agent name is a sibling fact, never marked
   * up as that control's label.
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
   *
   * The context/cost meter (SPEC §7.9, issue #248's usage-meter
   * correctness fixes) used to sit at the end of this bar. Zed-parity
   * decision B1-1 (issue #736) moved it to `StatusBar.svelte` — the
   * permanent status bar every page now renders, not only the composer —
   * rather than leaving it duplicated here; see that file's own doc
   * comment for what it inherits and this file's git history for how
   * issue #248's three correctness fixes were made in the first place.
   *
   * One consolidated control (cockpit v8 decision E1-2, issue #711): model,
   * thinking and mode used to sit inline as three-plus separate controls in
   * the row; they now collapse behind one trigger reading e.g. "Opus 5 ·
   * High" that opens a single popover holding all three. The trade Lorenzo
   * accepted is explicit — a second click, for the narrowest footprint of
   * the layouts considered (`docs/design/ux-review-2026-08-05/
   * section-e-model-effort.html`, option E1-2) — so this is presentation
   * only, laid on top of whatever `options` already carries; it does not
   * change which categories exist or what their choices are. The trigger's
   * own text is every non-`mode` category's current selection, dot-joined
   * in the order `options` lists them (today that's `model` then
   * `thought_level`, i.e. "effort" — never a hardcoded pair: a third
   * non-`mode` category, present or future, just extends the join instead
   * of vanishing, same as it already renders as one more generic section
   * inside the popover below). `mode` stays out of the trigger text (it
   * drives permission behavior, not a value you'd summarize the same way)
   * but still opens in the same popover, as its existing segmented control,
   * unchanged.
   *
   * `modes` — ACP's separate `{availableModes, currentModeId}` field a real
   * `omp acp` binary sends alongside a `configOptions` entry whose category
   * is already `'mode'` — is not this component's problem: `client.ts`'s
   * `mapConfigOptions` (issue #705) folds it into that same entry before
   * `options` ever reaches here, so exactly one `mode` category ever
   * arrives and exactly one mode picker ever renders. If two ever showed up
   * here it would mean that fold broke, not something to deduplicate in
   * this file.
   *
   * The popover itself is `Select`'s own "anchored popover, no `Overlay`
   * scrim" contract (see that component's file doc comment) extended to a
   * compound panel: `Select` keeps focus on its trigger the whole time
   * (`aria-activedescendant` over a single listbox), which works only
   * because it hosts one widget. This popover hosts three unrelated widgets
   * (one `Select` per non-`mode` category, plus the `mode` radiogroup), so
   * focus genuinely has to move inside it for every control to be
   * keyboard-reachable — it borrows `Dialog`'s own Tab-trap
   * (`focusableElements`/`handlePanelKeydown`) instead, minus `Dialog`'s
   * `Overlay` backdrop and minus its focus-trap's modality: clicking outside
   * closes it exactly like `Select`'s own click-outside (a plain `window`
   * `pointerdown` listener, not a click-swallowing scrim), and it opens
   * upward when the trigger sits too close to the viewport's bottom edge
   * for the same reason `Select` already does — this bar lives directly
   * above the composer.
   *
   * Remembered defaults, project override (Zed-parity decision D4-3, issue
   * #753): a session used to start entirely at the agent's own defaults,
   * every time. Now the caller (`+page.svelte`) resolves each category
   * against an account-wide "last used" value and a project-scoped
   * override that beats it, applying the winner via a real
   * `setConfigOption` round trip the moment a brand-new session's catalog
   * first arrives — this component never resolves or applies anything
   * itself, it only renders whatever `options` already carries, same as
   * always. What IS this component's own job, and the pick's own named
   * cost: `sources` (keyed by category) says which layer produced the
   * CURRENT value — a `Badge` per category plus a `title` summary on the
   * trigger — and `onPinToProject`/`onUnpinFromProject` add a `pin`
   * `IconButton` per category to set or clear that project's override
   * directly from here, the one place a user is already looking at the
   * value worth pinning.
   */
  import { tick } from 'svelte';
  import { type AcpConfigOption } from '@loombox/providers-core/browser';
  import { PROVIDER_LABELS } from '$lib/providers';
  import type { ConfigOptionSource } from '$lib/config-option-resolution';
  import Badge, { type BadgeTone } from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Select from './ui/Select.svelte';
  import Icon from './icons/Icon.svelte';

  interface Props {
    options: AcpConfigOption[];
    onChange: (category: string, optionId: string) => void;
    /** The session's ACP provider id — named in front of the model picker so the row says which agent is answering. */
    providerId?: string | undefined;
    /** For a caller with no room: pickers and agent name hidden. */
    compact?: boolean;
    /**
     * Which layer produced each category's CURRENT value (issue #753,
     * decision D4-3) — `'project'`/`'account'`/`'default'`, keyed by
     * category. Omitted entirely, or missing a given category, renders no
     * source badge and no pin control for it: a caller that hasn't wired
     * D4-3's resolution at all looks identical to "nothing to attribute",
     * so every call site written before this issue needs no change.
     */
    sources?: Record<string, ConfigOptionSource>;
    /** Pins `category`'s CURRENT choice as this project's override (issue #753). Omit to hide the pin control entirely — paired with {@link onUnpinFromProject}, both or neither. */
    onPinToProject?: (category: string) => void;
    /** Clears `category`'s project override (issue #753), falling back to the account default or the agent's own. Omit alongside {@link onPinToProject}. */
    onUnpinFromProject?: (category: string) => void;
  }

  const {
    options,
    onChange,
    providerId,
    compact = false,
    sources,
    onPinToProject,
    onUnpinFromProject,
  }: Props = $props();

  const modeOption = $derived(options.find((option) => option.category === 'mode'));
  /** Every category besides `mode` — what the trigger summarizes and the popover lists as its own `Select` section (see the file doc comment's "One consolidated control" paragraph). */
  const pickerOptions = $derived(options.filter((option) => option.category !== 'mode'));

  /** The trigger root, for the click-outside listener (`handleWindowPointerDown`) to test containment against, same convention as `Select`'s own `rootEl`. */
  let triggerRootEl = $state<HTMLDivElement | undefined>(undefined);
  let triggerEl = $state<HTMLButtonElement | undefined>(undefined);
  /** The popover panel, for `focusableElements()` (the Tab-trap) and the initial focus-on-open effect below. */
  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  let popoverOpen = $state(false);
  /** Flips the popover above the trigger instead of below — see `Select.svelte`'s identical `openUpward`, and this file's own doc comment for why this bar specifically needs it. */
  let openUpward = $state(false);

  /** The radiogroup root, for moving focus onto the newly-selected segment when an arrow key changes it (see `handleModeKeydown`). */
  let modeGroupEl = $state<HTMLDivElement | undefined>(undefined);

  // Falls back to the raw id rather than dropping the fact: an unrecognized
  // provider still tells a user more than a blank does (same reasoning as
  // `NewSessionDialog`'s own `PROVIDER_LABELS[id]?.name ?? id`).
  const agentName = $derived(
    providerId ? (PROVIDER_LABELS[providerId]?.name ?? providerId) : undefined,
  );

  function categoryLabel(category: string): string {
    return category
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /** The value a category currently shows, for both the trigger text and (implicitly, via `Select`) the popover — falls back to the category's own label when nothing is selected yet, rather than an empty string. */
  function currentChoiceLabel(option: AcpConfigOption): string {
    return (
      option.choices.find((choice) => choice.id === option.current)?.name ??
      categoryLabel(option.category)
    );
  }

  /** "Opus 5 · High": every non-`mode` category's current value, dot-joined in `options`' own order. Falls back to `mode`'s own value when there is no other category at all, so a trigger still reads as something rather than nothing. */
  const triggerParts = $derived(
    pickerOptions.length > 0
      ? pickerOptions.map(currentChoiceLabel)
      : modeOption
        ? [currentChoiceLabel(modeOption)]
        : [],
  );
  const triggerText = $derived(triggerParts.join(' · '));
  const hasOptions = $derived(pickerOptions.length > 0 || modeOption !== undefined);

  /** "Project" / "Account" / "Agent default" — issue #753's own acceptance line: "the ConfigBar shows the source of the current value". */
  function sourceLabel(source: ConfigOptionSource): string {
    switch (source) {
      case 'project':
        return 'Project';
      case 'account':
        return 'Account';
      default:
        return 'Agent default';
    }
  }

  /** Only `'project'` gets a distinct tone: it is the one layer a user just deliberately pinned, so it is the one worth a glance without reading the label. `'account'`/`'default'` share the quiet neutral tone the label text alone already distinguishes. */
  function sourceTone(source: ConfigOptionSource): BadgeTone {
    return source === 'project' ? 'info' : 'neutral';
  }

  /** "Model: Project · Effort: Account" — every non-`mode` category's source, dot-joined the same way `triggerText` joins values, so a hover explains "why is this session on low effort" without opening the popover. `undefined` (the caller hasn't wired D4-3 at all) renders no `title`, same "absent means untouched" convention `sources` itself follows. */
  const sourceSummary = $derived(
    sources
      ? pickerOptions
          .map(
            (option) =>
              `${categoryLabel(option.category)}: ${sourceLabel(sources[option.category] ?? 'default')}`,
          )
          .join(' · ')
      : undefined,
  );

  // The rough pixel height the popover budgets for (a handful of sections,
  // each a `Select` trigger or a row of mode segments) — same rough-budget
  // convention as `Select.svelte`'s own `LISTBOX_BUDGET_PX`, not a
  // layout-critical measurement.
  const POPOVER_BUDGET_PX = 320;

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]';

  /** Every real tab stop inside the open popover — one trigger button per `Select` (its own listbox stays `aria-activedescendant`-only, never a tab stop, per that component's own ARIA pattern) plus `mode`'s single roving-tabindex-0 segment. The `tabindex="-1"` filter has to run as a second pass, not folded into `FOCUSABLE_SELECTOR` itself: `mode`'s unselected segments are plain `<button>`s, which `button:not([disabled])` alone already matches regardless of their own `tabindex` — a `:not([tabindex="-1"])` suffix only ever reached the selector's last, unrelated `[tabindex]` branch. Used both for the initial focus-on-open and the Tab-trap below. */
  function focusableElements(): HTMLElement[] {
    if (!panelEl) return [];
    return Array.from(panelEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getAttribute('tabindex') !== '-1',
    );
  }

  // Focus-on-open (mirrors `Dialog.svelte`'s identical effect): moves focus
  // onto the popover's first real control the moment it opens, so "every
  // control inside is reachable without a mouse" doesn't depend on a user
  // discovering they have to Tab in from the trigger first.
  $effect(() => {
    if (popoverOpen) focusableElements()[0]?.focus();
  });

  function openPopover(): void {
    if (!hasOptions) return;
    if (triggerEl && typeof window !== 'undefined') {
      const rect = triggerEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      openUpward = spaceBelow < POPOVER_BUDGET_PX && rect.top > spaceBelow;
    }
    popoverOpen = true;
  }

  function closePopover(): void {
    popoverOpen = false;
  }

  function handleTriggerClick(): void {
    if (popoverOpen) {
      closePopover();
      triggerEl?.focus();
    } else {
      openPopover();
    }
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        if (popoverOpen) return;
        event.preventDefault();
        openPopover();
        break;
      case 'Escape':
        if (!popoverOpen) return;
        event.preventDefault();
        closePopover();
        break;
      default:
        break;
    }
  }

  /** Escape backs all the way out (closes the popover, returns focus to the trigger) and doubles as the Tab-trap while the popover is open — the same pairing `Dialog.svelte`'s `handleKeydown`/`focusableElements` use, minus `Overlay` (see the file doc comment for why this popover isn't `Overlay`-backed). */
  function handlePanelKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePopover();
      triggerEl?.focus();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Mirrors `Select.svelte`'s own `handleWindowPointerDown` exactly: a
  // `window` `pointerdown` listener that no-ops for anything inside this
  // component's own trigger/popover root, closing without stealing focus
  // (the click itself is never swallowed — no preventDefault/
  // stopPropagation — so whatever was actually clicked still reacts).
  function handleWindowPointerDown(event: PointerEvent): void {
    if (!popoverOpen) return;
    const target = event.target;
    if (triggerRootEl && target instanceof Node && triggerRootEl.contains(target)) return;
    closePopover();
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

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="config-bar" data-testid="config-bar">
  {#if !compact}
    {#if agentName}
      <span class="agent" data-testid="config-agent">{agentName}</span>
    {/if}

    {#if hasOptions}
      <div class="control config-trigger-root" bind:this={triggerRootEl}>
        <button
          type="button"
          class="config-trigger"
          class:config-trigger-expanded={popoverOpen}
          bind:this={triggerEl}
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-controls="config-popover"
          aria-label={`Model, thinking and mode: ${triggerText}`}
          title={sourceSummary}
          onclick={handleTriggerClick}
          onkeydown={handleTriggerKeydown}
          data-testid="config-trigger"
        >
          <span class="config-trigger-value">{triggerText}</span>
          <Icon name="chevron-down" class="config-trigger-chevron" />
        </button>
        {#if popoverOpen}
          <div
            class="config-popover"
            class:config-popover-up={openUpward}
            role="dialog"
            aria-modal="false"
            aria-label="Model, thinking and mode"
            id="config-popover"
            bind:this={panelEl}
            onkeydown={handlePanelKeydown}
            tabindex="-1"
            data-testid="config-popover"
          >
            {#each pickerOptions as option (option.category)}
              <div class="config-popover-section" data-testid={`config-option-${option.category}`}>
                <div class="config-popover-section-head">
                  <span class="label">{categoryLabel(option.category)}</span>
                  {#if sources?.[option.category]}
                    <Badge
                      size="sm"
                      tone={sourceTone(sources[option.category])}
                      dataTestId={`config-source-${option.category}`}
                    >
                      {sourceLabel(sources[option.category])}
                    </Badge>
                  {/if}
                </div>
                <div class="config-popover-section-row">
                  <Select
                    value={option.current ?? ''}
                    options={option.choices.map((choice) => ({
                      id: choice.id,
                      label: choice.name,
                    }))}
                    onChange={(optionId) => onChange(option.category, optionId)}
                    label={categoryLabel(option.category)}
                    size="sm"
                  />
                  {#if onPinToProject && onUnpinFromProject}
                    <IconButton
                      label={sources?.[option.category] === 'project'
                        ? `Unpin ${categoryLabel(option.category)} from this project`
                        : `Pin ${categoryLabel(option.category)} to this project`}
                      size="sm"
                      pressed={sources?.[option.category] === 'project'}
                      dataTestId={`config-pin-${option.category}`}
                      onclick={() =>
                        sources?.[option.category] === 'project'
                          ? onUnpinFromProject(option.category)
                          : onPinToProject(option.category)}
                    >
                      <Icon name="pin" />
                    </IconButton>
                  {/if}
                </div>
              </div>
            {/each}

            {#if modeOption}
              <div class="config-popover-section">
                <div class="config-popover-section-head">
                  <span class="label">Mode</span>
                  {#if sources?.mode}
                    <Badge
                      size="sm"
                      tone={sourceTone(sources.mode)}
                      dataTestId="config-source-mode"
                    >
                      {sourceLabel(sources.mode)}
                    </Badge>
                  {/if}
                </div>
                <div class="config-popover-section-row">
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
                  {#if onPinToProject && onUnpinFromProject}
                    <IconButton
                      label={sources?.mode === 'project'
                        ? 'Unpin Mode from this project'
                        : 'Pin Mode to this project'}
                      size="sm"
                      pressed={sources?.mode === 'project'}
                      dataTestId="config-pin-mode"
                      onclick={() =>
                        sources?.mode === 'project'
                          ? onUnpinFromProject('mode')
                          : onPinToProject('mode')}
                    >
                      <Icon name="pin" />
                    </IconButton>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
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

  /* Anchors the popover the same way `Select.svelte`'s own `.ui-select` root
     does — a `position: relative` box the popover floats against. */
  .config-trigger-root {
    position: relative;
  }

  .config-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    max-width: 14rem;
    padding: var(--space-2xs) var(--space-md);
    background: var(--color-surface);
    color: inherit;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font: inherit;
    font-size: var(--text-small-size);
    cursor: pointer;
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      background-color var(--duration-fast) var(--ease-beat);
  }

  .config-trigger:hover {
    border-color: var(--color-border-strong);
  }

  .config-trigger:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* A long model name (e.g. "Claude 3.5 Haiku (Legacy, Extended Vision)")
     truncates rather than pushing Send off the row — same discipline as
     `.config-bar`'s own doc comment above, one control earlier. */
  .config-trigger-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* No `flex-shrink` here: `Icon`'s own `.icon` root rule already sets it,
     and a class handed to a primitive cannot outrank the primitive's own
     scoped root (issue #665, guarded by `primitive-override-scope.test.ts`). */
  :global(.config-trigger-chevron) {
    color: var(--color-text-secondary);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  /* `Icon`'s own `class` prop lands inside its own component scope, so
     `:global()` under this local ancestor class reaches it — same pattern
     as `Select.svelte`'s identical `.ui-select-trigger-expanded` rule. */
  .config-trigger-expanded :global(.config-trigger-chevron) {
    transform: rotate(180deg);
  }

  /* Anchored, no scrim — `Select.svelte`'s own contract, extended to a
     compound panel (see the file doc comment). Floated at `--z-sticky`,
     same layer `Select`'s own listbox uses. */
  .config-popover {
    position: absolute;
    z-index: var(--z-sticky);
    top: calc(100% + var(--space-2xs));
    left: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    width: max-content;
    min-width: 14rem;
    max-height: 20rem;
    overflow-y: auto;
    padding: var(--space-md);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  .config-popover:focus-visible {
    /* Focus lands on the first real control inside (see the file doc
       comment's focus-on-open effect), never on this panel itself — an
       outline here would be a second, redundant focus indicator. */
    outline: none;
  }

  .config-popover-up {
    top: auto;
    bottom: calc(100% + var(--space-2xs));
  }

  .config-popover-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  /* Holds the category label and its D4-3 source badge (issue #753) on one row, badge right-aligned against the label. */
  .config-popover-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
  }

  /* Holds the picker/mode-switch control and its D4-3 pin/unpin `IconButton` (issue #753) side by side. */
  .config-popover-section-row {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
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

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same
     coarse-pointer convention `Button`/`IconButton` already use —
     `var(--touch-target-min)`, not a `2.75rem` literal (A2-1, issue #734:
     see that token's own note in `tokens.css`). */
  @media (pointer: coarse) {
    .config-trigger {
      min-height: var(--touch-target-min);
    }

    :global(.mode-choice) {
      min-height: var(--touch-target-min);
    }
  }
</style>
