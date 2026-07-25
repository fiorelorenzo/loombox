<script lang="ts">
  /**
   * The shared inline error surface (redesign brief
   * `docs/design/redesign.md` §4, issue #428): the `raised` elevation tier
   * (redesign brief §3), tinted with the danger palette, plus a
   * `retryable` boolean that swaps a secondary Retry `Button` in for a
   * plain fatal-error read. Call-site migration is a later, per-surface
   * issue; this ships the primitive plus a `/style-reference`
   * proof-of-use only.
   *
   * Deliberately hand-rolls the raised tier's own background/border/shadow
   * rather than nesting `Card`: Svelte's per-component style scoping means
   * overriding a nested component's colors from the outside needs either a
   * `:global()` escape hatch or a token override passed as an inline
   * `style` — duplicating three CSS declarations here (same tokens, just
   * tinted) is the simpler, more obviously-correct choice.
   */
  import Button from './Button.svelte';

  interface Props {
    message: string;
    /** `true`: a recoverable error, shows a secondary Retry button. `false` (default): a fatal error, plain text only. */
    retryable?: boolean;
    onRetry?: () => void;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
  }

  const { message, retryable = false, onRetry, class: className = '' }: Props = $props();
</script>

<div class={`ui-error-notice ${className}`.trim()} role="alert" data-testid="ui-error-notice">
  <p class="ui-error-notice-message">{message}</p>
  {#if retryable}
    <Button variant="secondary" size="sm" onclick={onRetry}>Retry</Button>
  {/if}
</div>

<style>
  .ui-error-notice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-md) var(--space-lg);
    border-radius: var(--radius-lg);
    /* raised tier (redesign brief §3), tinted danger. */
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
    box-shadow: var(--shadow-sm);
    color: var(--color-text-primary);
  }

  .ui-error-notice-message {
    margin: 0;
    color: var(--color-danger);
  }
</style>
