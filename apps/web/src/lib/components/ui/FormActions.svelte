<script lang="ts">
  /**
   * The shared submit row (coherence v5 design spec §1, issue #508):
   * `NewSessionDialog`, `AddProjectDialog`, and every step of
   * `AddTargetWizard` each hand-rolled an identical `.actions { display:
   * flex; justify-content: flex-end; gap: var(--space-sm); margin-top:
   * var(--space-sm); }`; `DeviceApprove`'s Approve/Deny row and
   * `RecoveryCodeEntryForm`'s single submit button used a start-aligned
   * variant of the same idea. One primitive, one `align` axis, instead of
   * each surface laying itself out differently.
   */
  import type { Snippet } from 'svelte';

  export type FormActionsAlign = 'start' | 'end';

  interface Props {
    align?: FormActionsAlign;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
    children: Snippet;
  }

  const { align = 'end', class: className = '', children }: Props = $props();
</script>

<div
  class={`ui-form-actions ui-form-actions-${align} ${className}`.trim()}
  data-testid="ui-form-actions"
>
  {@render children()}
</div>

<style>
  .ui-form-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }

  .ui-form-actions-end {
    justify-content: flex-end;
  }

  .ui-form-actions-start {
    justify-content: flex-start;
  }
</style>
