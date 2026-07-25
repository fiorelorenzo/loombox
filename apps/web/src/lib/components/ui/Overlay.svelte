<script lang="ts">
  /**
   * The shared overlay root (redesign v2 design spec §2 "Drawer that closes
   * + IA cleanup", issue #461): a backdrop element that closes on a backdrop
   * click and on `Escape`, drawn at a caller-supplied z-index token from
   * `tokens.css`'s `--z-overlay`/`--z-modal`/`--z-toast` scale. This is the
   * ONE implementation of "click outside or press Escape to close" in the
   * app — `Dialog.svelte` renders its backdrop through this instead of its
   * own inline markup, and the account menu / drawer (shell issue) adopt it
   * too, so they stop fighting the header's own stacking context.
   *
   * Deliberately thin: this traps nothing else. No focus-trap logic lives
   * here — that stays `Dialog`'s own job (a generic overlay has no fixed
   * notion of "the panel's focusable elements"; a caller that needs a focus
   * trap keeps owning it on its own content, same as `Dialog` still does).
   *
   * Backdrop fade mirrors `Dialog`'s previous inline transition exactly
   * (`--duration-fast` cubic-out fade) so pulling it out here is a pure
   * refactor, not a visual change. `reducedMotion` forces the static
   * (durationless) fallback for callers/tests, same convention `Dialog`/
   * `WovenLoader` already use (jsdom doesn't evaluate
   * `prefers-reduced-motion`); the automatic case reads a live `matchMedia`
   * query, same as `$lib/theme.ts`/`$lib/accent.ts`.
   */
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';

  /** Matches `tokens.css`'s named z-index scale — pass the custom property name, not a raw number. */
  export type OverlayZIndex = '--z-overlay' | '--z-modal' | '--z-toast';

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Which layer of `tokens.css`'s z-index scale this overlay sits at. Defaults to `--z-overlay`. */
    zIndex?: OverlayZIndex;
    /** The overlay's content (e.g. a dialog panel, a drawer, a menu). */
    children: Snippet;
    /** Forces the static reduced-motion fallback regardless of the media query — see the file doc comment. */
    reducedMotion?: boolean;
    /** Additional class name(s) merged onto the backdrop element. */
    class?: string;
    /** Overrides the backdrop's `data-testid` (default `"overlay-backdrop"`), so callers with an existing selector (e.g. `Dialog`'s `"dialog-backdrop"`) keep it unchanged. */
    testid?: string;
  }

  const {
    open,
    onClose,
    zIndex = '--z-overlay',
    children,
    reducedMotion = false,
    class: className = '',
    testid = 'overlay-backdrop',
  }: Props = $props();

  function reduced(): boolean {
    return (
      reducedMotion ||
      (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    );
  }

  function backdropFade(_node: Element): TransitionConfig {
    const duration = reduced() ? 0 : 140; // tokens.css --duration-fast
    return { duration, easing: cubicOut, css: (t: number) => `opacity: ${t};` };
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  }
</script>

{#if open}
  <div
    class={`overlay-backdrop ${className}`.trim()}
    style={`z-index: var(${zIndex});`}
    role="presentation"
    onclick={onClose}
    onkeydown={handleKeydown}
    in:backdropFade
    out:backdropFade
    data-testid={testid}
  >
    {@render children()}
  </div>
{/if}

<style>
  .overlay-backdrop {
    position: fixed;
    inset: 0;
    background: var(--color-overlay);
  }
</style>
