<script lang="ts" module>
  /**
   * Every currently-open {@link Overlay}, in open order — the last entry is
   * the top-most one and the only one an Escape keypress may close, so a
   * Dialog opened over a pinned Drawer closes one layer per press instead
   * of both at once. Module scope (not per-instance) because that ordering
   * is a property of the app's overlay stack, not of any one overlay.
   */
  const escapeStack: symbol[] = [];
</script>

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
   * Escape is bound on `window`, not on the backdrop element. A keydown
   * listener on the backdrop `div` only fires when focus is already INSIDE
   * the overlay — true for `Dialog` (it focus-traps its panel), false for
   * every other caller: the account menu and the Drawer both leave focus on
   * their trigger button up in the header, outside the overlay subtree, so
   * "press Escape to close" silently did nothing for exactly the two
   * surfaces the IA cleanup added it for.
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

  /** This instance's identity in {@link escapeStack} — see that constant's doc comment. */
  const token = Symbol('overlay');

  $effect(() => {
    if (!open) return;
    escapeStack.push(token);
    return () => {
      const index = escapeStack.lastIndexOf(token);
      if (index !== -1) escapeStack.splice(index, 1);
    };
  });

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
    if (!open || event.key !== 'Escape') return;
    if (escapeStack[escapeStack.length - 1] !== token) return;
    event.preventDefault();
    onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class={`overlay-backdrop ${className}`.trim()}
    style={`z-index: var(${zIndex});`}
    role="presentation"
    onclick={onClose}
    in:backdropFade
    out:backdropFade
    data-testid={testid}
  >
    {@render children()}
  </div>
{/if}

<style>
  /* `--overlay-top` lets a caller pull the backdrop's top edge down without
     fighting this scoped rule's specificity (a `:global(.my-backdrop)` rule
     at the call site loses to `.overlay-backdrop.svelte-hash`, and winning by
     source order is not a contract). The cockpit's Drawer sets it to the
     topbar's height: the backdrop is the click-to-dismiss surface, so while it
     covered the topbar it INTERCEPTED the very control that opens the Drawer.
     `tokens.css` declares the 0 default — a full-viewport scrim, which is what
     every other caller gets. */
  .overlay-backdrop {
    position: fixed;
    top: var(--overlay-top);
    right: 0;
    bottom: 0;
    left: 0;
    background: var(--color-overlay);
  }
</style>
