<script lang="ts">
  /**
   * The shared icon primitive (redesign v2 §2 "Icon system", issue #457):
   * one component every surface pulls a hand-drawn glyph from, instead of
   * each call site inlining its own letter/unicode placeholder (the rail's
   * S/I/N spans, the `⌘K` glyph, the session-group `▾` chevron, tool-call
   * glyphs, file/folder marks, attach/copy icons — call-site swaps are
   * later wave-2/3 issues, not this one).
   *
   * Draws whatever `icon-paths.ts` has under `name` inside the exact same
   * `viewBox="0 0 64 64"` / `stroke="currentColor"` / `stroke-width: 3.4` /
   * `stroke-linecap: round` convention as `BrandMark.svelte`'s "Warp &
   * Weft" mark — those presentation attributes live once on this
   * component's `<svg>` root (never per-path) so the whole set reads as
   * one family. `fill="none"` throughout: every glyph is stroke-only, same
   * as the mark.
   *
   * Accessible name follows `BrandMark`'s own convention: `aria-hidden` by
   * default (an icon is almost always paired with visible text or an
   * `IconButton`/`Button`'s own `label`), with a `label` prop opting the
   * icon itself into being the accessible name (`role="img"`).
   *
   * An unrecognized `name` (e.g. a stale value from data, or a typo that
   * slipped past the `IconName` type at a JS call site) falls back to
   * `FALLBACK_ICON_PATHS` — a visible-but-inert glyph — rather than
   * throwing, since a missing icon should never crash the surface that
   * asked for it.
   */
  import { FALLBACK_ICON_PATHS, ICON_PATHS, type IconName } from './icon-paths';

  interface Props {
    /** Which glyph to draw; falls back to a plain placeholder if unrecognized. */
    name: IconName;
    /** Sets the rendered `<svg>` width/height. Defaults to `1em`, so the icon scales with the surrounding text like `BrandMark` does. */
    size?: number | string;
    /** Accessible name. Omit for a decorative icon (the default — `aria-hidden`); pass one to make the icon itself the accessible name (`role="img"`). */
    label?: string;
    /** Additional class name(s) merged onto the root `<svg>`. */
    class?: string;
  }

  const { name, size = '1em', label, class: className = '' }: Props = $props();

  const paths = $derived(ICON_PATHS[name] ?? FALLBACK_ICON_PATHS);
  const decorative = $derived(!label);
</script>

<svg
  viewBox="0 0 64 64"
  fill="none"
  stroke="currentColor"
  stroke-width="3.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  width={size}
  height={size}
  class={`icon ${className}`.trim()}
  role={decorative ? undefined : 'img'}
  aria-hidden={decorative ? 'true' : undefined}
  aria-label={decorative ? undefined : label}
  data-testid="icon"
  data-icon-name={name}
>
  {#each paths as d, index (index)}
    <path {d} />
  {/each}
</svg>

<style>
  .icon {
    display: inline-block;
    flex-shrink: 0;
  }
</style>
