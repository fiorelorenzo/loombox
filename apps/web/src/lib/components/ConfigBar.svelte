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
   * element. `getByRole('button', { name })` in the tests still resolves
   * the same way: `Button` renders its `children` snippet verbatim inside
   * the native `<button>`.
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
   */
  import type { AcpConfigOption, UsageRecord } from '@loombox/providers-core/browser';
  import Button from './ui/Button.svelte';
  import Select from './ui/Select.svelte';

  interface Props {
    options: AcpConfigOption[];
    usage: UsageRecord | undefined;
    cumulativeCostUsd: number;
    onChange: (category: string, optionId: string) => void;
  }

  const { options, usage, cumulativeCostUsd, onChange }: Props = $props();

  const modeOption = $derived(options.find((option) => option.category === 'mode'));
  const otherOptions = $derived(options.filter((option) => option.category !== 'mode'));

  // §7.9/§16: the live percentage meter excludes usage attributable to a
  // subagent tool call; the cumulative cost figure never does (folded in
  // regardless by the reducer itself, `transcript.ts`'s `reduceUsage`).
  const contextPercent = $derived(
    usage && !usage.attributedToSubagent && usage.tokensUsed !== undefined && usage.contextWindow
      ? Math.min(100, Math.round((usage.tokensUsed / usage.contextWindow) * 100))
      : undefined,
  );

  // Bullet 2 of the v3 Controls slice: a clear, hoverable explanation of
  // both meter figures — the percentage is turn-scoped and subagent-free,
  // the cost is the whole session and always includes subagent spend
  // (see the `contextPercent` comment above).
  const meterTitle = $derived(
    contextPercent !== undefined
      ? `${contextPercent}% of the context window used this turn · $${cumulativeCostUsd.toFixed(2)} spent this session`
      : `$${cumulativeCostUsd.toFixed(2)} spent this session`,
  );

  function categoryLabel(category: string): string {
    return category
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
</script>

<div class="config-bar" data-testid="config-bar">
  {#each otherOptions as option (option.category)}
    <div class="control" data-testid={`config-option-${option.category}`}>
      <span class="label">{categoryLabel(option.category)}</span>
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
    <div class="control mode" role="group" aria-label="Mode" data-testid="config-option-mode">
      {#each modeOption.choices as choice (choice.id)}
        <Button
          variant="ghost"
          size="sm"
          class={`mode-choice ${modeOption.current === choice.id ? 'selected' : ''}`.trim()}
          onclick={() => onChange('mode', choice.id)}
        >
          {choice.name}
        </Button>
      {/each}
    </div>
  {/if}

  <div class="meter" data-testid="context-meter" title={meterTitle}>
    {#if contextPercent !== undefined}
      <span class="meter-primary">{contextPercent}% context</span>
      <span class="meter-sep" aria-hidden="true">·</span>
    {/if}
    <span class="meter-cost">${cumulativeCostUsd.toFixed(2)}</span>
  </div>
</div>

<style>
  .config-bar {
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

  /* A clear right-aligned slot (v3 §3.5): bordered off from the controls
     rather than jammed against them, percentage as the primary figure,
     cost muted beside it — see the `title` for the full explanation. */
  .meter {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: var(--space-2xs);
    padding-left: var(--space-md);
    border-left: 1px solid var(--color-border);
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
    font-size: var(--text-small-size);
  }

  .meter-primary {
    color: var(--color-text-primary);
    font-weight: 600;
  }

  .meter-sep,
  .meter-cost {
    color: var(--color-text-muted);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same
     coarse-pointer convention `Button`/`IconButton` already use. */
  @media (pointer: coarse) {
    :global(.mode-choice) {
      min-height: 2.75rem;
    }
  }
</style>
