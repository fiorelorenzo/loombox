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
   */
  import type { AcpConfigOption, UsageRecord } from '@loombox/providers-core';

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

  function categoryLabel(category: string): string {
    return category
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
</script>

<div class="config-bar" data-testid="config-bar">
  {#each otherOptions as option (option.category)}
    <label class="control" data-testid={`config-option-${option.category}`}>
      <span class="label">{categoryLabel(option.category)}</span>
      <select
        value={option.current ?? ''}
        onchange={(event) => onChange(option.category, (event.target as HTMLSelectElement).value)}
      >
        {#each option.choices as choice (choice.id)}
          <option value={choice.id}>{choice.name}</option>
        {/each}
      </select>
    </label>
  {/each}

  {#if modeOption}
    <div class="control mode" role="group" aria-label="Mode" data-testid="config-option-mode">
      {#each modeOption.choices as choice (choice.id)}
        <button
          type="button"
          class="mode-choice"
          class:selected={modeOption.current === choice.id}
          onclick={() => onChange('mode', choice.id)}
        >
          {choice.name}
        </button>
      {/each}
    </div>
  {/if}

  <div class="meter" data-testid="context-meter">
    {#if contextPercent !== undefined}
      <span>{contextPercent}% context</span>
    {/if}
    <span>${cumulativeCostUsd.toFixed(2)}</span>
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

  .control select {
    background: var(--color-surface);
    color: inherit;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-3xs) var(--space-xs);
    font: inherit;
    font-size: var(--text-small-size);
    cursor: pointer;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .control select:hover {
    border-color: var(--color-border-strong);
  }

  .control select:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .mode {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .mode-choice {
    border: none;
    background: transparent;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-small-size);
    /* status-crossfade (redesign brief §2): a selection change crossfades
       color/background rather than snapping. */
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      color var(--duration-fast) var(--ease-beat);
  }

  .mode-choice:hover {
    background: var(--color-fill-subtle);
  }

  .mode-choice:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .mode-choice.selected {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    font-weight: 600;
  }

  .meter {
    margin-left: auto;
    display: flex;
    gap: var(--space-sm);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
    font-size: var(--text-small-size);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): the same
     coarse-pointer convention `Button`/`IconButton` already use. */
  @media (pointer: coarse) {
    .mode-choice {
      min-height: 2.75rem;
    }

    .control select {
      min-height: 2.75rem;
    }
  }
</style>
