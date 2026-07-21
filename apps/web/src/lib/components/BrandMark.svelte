<script lang="ts">
  /**
   * The "Warp & Weft" mark (issue #194, SPEC.md §4's logo: "a minimal
   * monoline mark — interwoven warp/weft lines forming (or passing
   * through) a square 'box'"): a 2x2 plain weave (real over-under, drawn
   * with genuine stroke gaps rather than a crossing-lines illusion, so it
   * reads correctly as monochrome on any ground) inside a rounded-square
   * frame — loom + box. This exact geometry (viewBox, stroke widths, path
   * data) is a locked design decision; do not redraw it here.
   *
   * `stroke="currentColor"` is the whole theming story: this component
   * carries no color of its own, so it inherits whatever `color` the
   * caller sets (e.g. `BrandLockup.svelte` sets it to
   * `var(--color-accent)`; the static favicon/PWA icon assets instead bake
   * in a literal azure, since a `<link rel="icon">`/manifest icon can't
   * read CSS custom properties — see `scripts/gen-brand-assets.mjs`).
   */
  interface Props {
    /** Additional class name(s) merged onto the root `<svg>`. */
    class?: string;
    /** Decorative by default (paired with visible wordmark/UI text elsewhere) — pass `false` when the mark stands alone as the accessible name for its surroundings (e.g. a bare icon-only link). */
    decorative?: boolean;
    /** Accessible label used only when `decorative` is `false`. */
    label?: string;
  }

  const { class: className = '', decorative = true, label = 'loombox' }: Props = $props();
</script>

<svg
  viewBox="0 0 64 64"
  fill="none"
  stroke="currentColor"
  stroke-width="3.4"
  stroke-linecap="round"
  class={`brand-mark ${className}`.trim()}
  role={decorative ? undefined : 'img'}
  aria-hidden={decorative ? 'true' : undefined}
  aria-label={decorative ? undefined : label}
  data-testid="brand-mark"
>
  <rect x="8" y="8" width="48" height="48" rx="14" stroke-width="3.2" />
  <path d="M24 16 V36" /><path d="M24 44 V48" />
  <path d="M40 16 V20" /><path d="M40 28 V48" />
  <path d="M16 24 H20" /><path d="M28 24 H48" />
  <path d="M16 40 H36" /><path d="M44 40 H48" />
</svg>

<style>
  .brand-mark {
    width: 1em;
    height: 1em;
    display: inline-block;
    flex-shrink: 0;
  }
</style>
