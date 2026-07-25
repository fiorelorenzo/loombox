<script lang="ts">
  /**
   * The shared elevation-ladder container (redesign brief
   * `docs/design/redesign.md` §3/§4, issue #428): `flat` | `raised` |
   * `floating`, mapped exactly to the three tiers documented on
   * `/style-reference`'s "Elevation in use" section (issue #427).
   * Everything currently hand-rolling `border + radius + background`
   * (session rows, tool-call rows, `PlanCard`, target cards, MCP/plugin
   * config cards, …) should compose this rather than reinventing its own
   * ladder position. Call-site migration is a later, per-surface issue;
   * this ships the primitive plus a `/style-reference` proof-of-use only.
   */
  import type { Snippet } from 'svelte';

  export type CardElevation = 'flat' | 'raised' | 'floating';
  export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

  interface Props {
    elevation?: CardElevation;
    padding?: CardPadding;
    /** Additional class name(s) merged onto the root element. */
    class?: string;
    children: Snippet;
  }

  const { elevation = 'flat', padding = 'md', class: className = '', children }: Props = $props();
</script>

<div
  class={`ui-card ui-card-${elevation} ui-card-padding-${padding} ${className}`.trim()}
  data-testid="ui-card"
  data-elevation={elevation}
>
  {@render children()}
</div>

<style>
  .ui-card {
    border-radius: var(--radius-lg);
    border: 1px solid transparent;
  }

  .ui-card-padding-none {
    padding: 0;
  }

  .ui-card-padding-sm {
    padding: var(--space-sm);
  }

  .ui-card-padding-md {
    padding: var(--space-lg);
  }

  .ui-card-padding-lg {
    padding: var(--space-xl);
  }

  /* Elevation ladder (redesign brief §3) — one documented job per tier. */
  .ui-card-flat {
    background: var(--color-surface);
    border-color: var(--color-border-subtle);
  }

  .ui-card-raised {
    background: var(--color-surface-raised);
    border-color: var(--color-border);
    box-shadow: var(--shadow-sm);
  }

  .ui-card-floating {
    background: var(--color-surface-raised);
    border-color: var(--color-border-strong);
    box-shadow: var(--shadow-lg);
  }
</style>
