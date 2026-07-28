<script lang="ts">
  /**
   * The one container treatment every tool-call surface in the transcript
   * shares (design spec v5 §4 "one card language for tool calls"):
   * `GenericToolRow` and every `tool-widgets/*` bespoke widget render their
   * content through this instead of each staying unboxed (the pre-v5
   * state — none of them had a card at all) or reinventing their own
   * `border + radius + background` recipe. A quiet, flat tier — a shade off
   * the canvas, a hairline border, no shadow — deliberately lighter than
   * `PermissionCard`'s own raised/bordered treatment, which stays
   * hand-rolled on purpose: it is the single named exception, because
   * interrupting is its job (§4).
   *
   * `PlanCard` converges on the identical `background`/`border`/
   * `border-radius` declarations (see its own `.tool-card` rule) rather
   * than importing this component: its header/body already own their
   * padding, so wrapping it here would double it up. Same visual language,
   * two call sites — `ui/Card.svelte`'s own doc comment already names both
   * "tool-call rows" and "PlanCard" as future callers of its `flat` tier;
   * consolidating this into that shared primitive is a natural follow-up
   * once this wave's concurrent edits to `ui/` settle.
   *
   * `flex: 1; min-width: 0;` (fill the row next to the gutter, and allow
   * its own text to truncate/wrap) plus the card's own padding both live
   * HERE rather than in each caller's own rule: a class name handed to
   * this component via its `class` prop is only ever textually written on
   * the root element inside *this* file's template, so Svelte's scoped-CSS
   * analysis in a caller's own style block (which never sees that element)
   * prunes any same-named selector there as unused — the caller's rule
   * would compile to nothing. Every real call site is the second flex
   * child of a `display: flex` row, right after a `ToolCallGutter`, so
   * baking that contract in here is honest, not presumptuous.
   *
   * Note for anyone editing this comment: do not write a literal style or
   * script tag in it. Svelte locates those two blocks by scanning the file
   * as text before any JS is parsed, so one inside a comment opens a phantom
   * block and the component stops compiling with "`<script>` was left open".
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** Additional class name(s) merged onto the root element, for a caller that needs an extra hook beyond the shared treatment. */
    class?: string;
    children: Snippet;
  }

  const { class: className = '', children }: Props = $props();
</script>

<div class={`tool-card ${className}`.trim()} data-testid="tool-card">
  {@render children()}
</div>

<style>
  .tool-card {
    flex: 1;
    min-width: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-xs) var(--space-sm);
  }
</style>
