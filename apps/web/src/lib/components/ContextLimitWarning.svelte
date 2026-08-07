<script lang="ts">
  /**
   * The distinct, dismissable near-context-limit warning (SPEC.md §7.9's
   * "surfaces when a session is near its context limit" clause; issue
   * #250) — separate from `StatusBar`'s own subtle meter-track colour
   * shift + `.sr-only` span (issue #248's own acceptance only asked for
   * "the warning on the meter itself"; `packages/providers/core/
   * CHANGELOG.md`'s note on that PR explicitly left this broader
   * surfacing for #250). Mounted once per session view (`+page.svelte`'s
   * canvas footer, right above the composer — the exact point a user is
   * about to decide "keep going or wrap up"), driven by the SAME
   * `contextFillPercent`/`CONTEXT_NEAR_LIMIT_THRESHOLD` `StatusBar` and
   * the attention-inbox `'context_limit'` item (`relay-client.ts`'s
   * `recomputeAttentionInbox`) both read — one source, never a second
   * guess. See `contextFillPercent`'s own doc comment for exactly what
   * "no data" means (no `usage_update` ever arrived, or this provider
   * never reports `size`/`used`) and why it is never guessed at: this
   * component renders nothing at all in that case, same as the meter.
   *
   * `usage.tokensUsed`/`usage.contextWindow` already exclude a
   * subagent-attributed update by construction — `transcript.ts`'s
   * `reduceUsage` freezes both to the last real PARENT-turn record while
   * `UsageRecord.attributedToSubagent` is true, rather than adopting the
   * subagent's own much-smaller numbers — so this component needs no
   * subagent-specific branch of its own to satisfy issue #250's "does not
   * fire from subagent-attributed usage" acceptance line; it inherits that
   * guarantee for free from the one place it's actually enforced.
   *
   * Dismissal is scoped to ONE crossing, not silenced forever: the instant
   * `usage` next reports a percentage below the threshold — a genuine
   * LATER `usage_update`, e.g. after the agent's own auto-compaction
   * reports fewer tokens in context (`tokensUsed`/`contextWindow` are
   * always the LATEST reported figures, never frozen outside a
   * subagent-attributed update) — this resets, so a later, separate
   * crossing shows fresh rather than staying silenced by a dismissal of a
   * different, already-resolved overfull episode. Per issue #250's own
   * framing, "a wrong warning here is worse than none": a dismiss that
   * never re-arms would eventually train the user to ignore it just as
   * badly as a false positive would.
   */
  import {
    CONTEXT_NEAR_LIMIT_THRESHOLD,
    contextFillPercent,
    type UsageRecord,
  } from '@loombox/providers-core/browser';
  import Icon from './icons/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    usage: UsageRecord | undefined;
  }

  const { usage }: Props = $props();

  const contextPercent = $derived(contextFillPercent(usage));

  const contextTokens = $derived(
    contextPercent !== undefined && usage?.tokensUsed !== undefined && usage.contextWindow
      ? { used: usage.tokensUsed, max: usage.contextWindow }
      : undefined,
  );

  const isNearLimit = $derived(
    contextPercent !== undefined && contextPercent >= CONTEXT_NEAR_LIMIT_THRESHOLD,
  );

  let dismissed = $state(false);

  // Re-arms the moment this episode ends (see the file doc comment above)
  // rather than only on mount, so switching away from a near-limit session
  // and back never leaves a stale dismissal from an earlier, already-freed
  // crossing.
  $effect(() => {
    if (!isNearLimit) dismissed = false;
  });

  function dismiss(): void {
    dismissed = true;
  }
</script>

{#if isNearLimit && contextTokens && !dismissed}
  <div class="context-limit-warning" role="status" data-testid="context-limit-warning">
    <Icon name="alert" size="16" />
    <span class="context-limit-warning-text">
      Context window nearly full — {contextPercent}% used ({contextTokens.used.toLocaleString(
        'en-US',
      )} of {contextTokens.max.toLocaleString('en-US')} tokens). Wrap up soon, or start a fresh session.
    </span>
    <IconButton
      label="Dismiss context warning"
      size="sm"
      dataTestId="context-limit-warning-dismiss"
      onclick={dismiss}
    >
      <Icon name="close" size="14" />
    </IconButton>
  </div>
{/if}

<style>
  .context-limit-warning {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-warning-subtle);
    border: 1px solid var(--color-warning);
    color: var(--color-warning);
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .context-limit-warning-text {
    flex: 1;
    font-size: var(--text-small-size);
    line-height: var(--text-small-line);
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
</style>
