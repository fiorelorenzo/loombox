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
    gap: 0.6rem;
    font-size: 0.8rem;
    padding: 0.4rem 0;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .label {
    opacity: 0.6;
  }

  .mode {
    display: inline-flex;
    border: 1px solid rgba(127, 127, 127, 0.3);
    border-radius: 0.4rem;
    overflow: hidden;
  }

  .mode-choice {
    border: none;
    background: transparent;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    color: inherit;
  }

  .mode-choice.selected {
    background: rgba(79, 70, 229, 0.2);
    font-weight: 600;
  }

  .meter {
    margin-left: auto;
    display: flex;
    gap: 0.6rem;
    opacity: 0.75;
  }
</style>
