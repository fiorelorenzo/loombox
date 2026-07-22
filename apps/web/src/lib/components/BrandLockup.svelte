<script lang="ts">
  /**
   * The wordmark lockup (issue #194): {@link BrandMark} plus "loombox" set
   * in the mono token (SPEC.md §4's typography role for the brand name
   * itself, distinct from `--font-ui`'s body/UI role), with the double-o
   * ("oo") picked out in the accent color. `+page.svelte`'s app-shell
   * header wraps this in the page's one `<h1>`; this component itself
   * stays heading-agnostic (a plain inline wrapper) so it can also be
   * reused anywhere a smaller, non-heading brand lockup is wanted later
   * (e.g. a settings panel, an about screen) without a second `<h1>`.
   *
   * The mark inherits `--color-accent` via `currentColor` (its own doc
   * comment) — set here, in one place (`:global(.brand-lockup-mark)`,
   * since `BrandMark`'s own scoped styles live in its own component and
   * can't be reached by an unqualified selector here), rather than on
   * every call site.
   */
  import BrandMark from './BrandMark.svelte';
</script>

<span class="brand-lockup" data-testid="brand-lockup">
  <BrandMark class="brand-lockup-mark" />
  <span class="wordmark font-mono"
    >l<span class="accent-oo" data-testid="accent-oo" style="color: var(--color-accent)">oo</span
    >mbox</span
  >
</span>

<style>
  .brand-lockup {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .brand-lockup :global(.brand-lockup-mark) {
    color: var(--color-accent);
    width: 1.4em;
    height: 1.4em;
  }

  .wordmark {
    font-weight: 600;
    letter-spacing: -0.01em;
  }
</style>
