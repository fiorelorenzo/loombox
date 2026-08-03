<script lang="ts">
  /**
   * The one container every tool-call surface in the transcript shares
   * (`GenericToolRow` and every `tool-widgets/*` bespoke widget render
   * their header row through this) — but as of design spec
   * `2026-08-03-cockpit-v6-design.md` §3.4 (issue #576 "one level of
   * chrome instead of two") it no longer always draws a card. A bordered
   * box wrapping a second inset surface for the payload (a `<pre>` fill,
   * `TerminalOutput`'s own console screen, `DiffViewer`'s own raised
   * card) was two levels of chrome for one fact — this component is now
   * the single place that decides which one survives, via the required
   * `surface` prop, rather than four widgets each hand-rolling their own
   * border/background:
   *
   * - `surface={true}`: this component draws the border/background/
   *   padding — for content with no surface of its own (`TodoWidget`'s
   *   checklist, `GenericToolRow`'s own multi-line output/entries block).
   *   This is the v5 treatment, kept for exactly the cases that still
   *   need it.
   * - `surface={false}`: this component draws nothing but layout — for a
   *   single-line row (the payload folds onto the header line itself,
   *   nothing left to box) or for a widget whose body already carries its
   *   own surface (`BashWidget`'s `TerminalOutput`, `EditWriteWidget`'s
   *   `DiffViewer`) and would otherwise sit inside a redundant second
   *   frame.
   *
   * `PlanCard` converges on the identical `background`/`border`/
   * `border-radius` declarations for its own header/body (see its own
   * `.tool-card` rule) rather than importing this component, for the same
   * reason as before: consolidating both into `ui/Card.svelte`'s `flat`
   * tier is a natural follow-up once this wave's concurrent edits to
   * `ui/` settle, not this issue's job.
   *
   * `flex: 1; min-width: 0;` (fill the row next to the gutter, and allow
   * its own text to truncate/wrap) lives HERE rather than in each
   * caller's own rule for the same scoped-CSS reason as before: a class
   * name handed to this component via its `class` prop is only ever
   * textually written on the root element inside *this* file's template,
   * so a caller's own same-named selector would compile to nothing.
   *
   * Note for anyone editing this comment: do not write a literal style or
   * script tag in it — Svelte would see a phantom block and stop
   * compiling.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** Additional class name(s) merged onto the root element, for a caller that needs an extra hook beyond the shared treatment. */
    class?: string;
    /** Whether this instance draws the shared border/background/padding (see the file doc comment) — required so every call site names its own choice rather than inheriting a silent default. */
    surface: boolean;
    children: Snippet;
  }

  const { class: className = '', surface, children }: Props = $props();
</script>

<div
  class={`tool-card ${surface ? 'tool-card-surface' : 'tool-card-plain'} ${className}`.trim()}
  data-testid="tool-card"
  data-surface={surface}
>
  {@render children()}
</div>

<style>
  .tool-card {
    flex: 1;
    min-width: 0;
  }

  .tool-card-surface {
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-xs) var(--space-sm);
  }

  /* No border, no background: the row's own header text (or a bespoke
     widget's own body surface, e.g. TerminalOutput/DiffViewer) is the only
     thing on screen. The top offset matches ToolCallGutter's own
     `padding-top` so a plain row's text still sits on the icon's baseline
     rather than a hair above it. */
  .tool-card-plain {
    padding-top: var(--space-2xs);
  }
</style>
