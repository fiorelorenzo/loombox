<script lang="ts">
  /**
   * The one copy affordance every transcript item (message, thought, diff,
   * raw tool command/output) shares — reachable on hover (desktop, via the
   * caller's `.item:hover &` CSS revealing it) and long-press/tap (touch:
   * the button is a real, always-focusable target, never hover-only) (SPEC.md
   * §7.24 "Copy & export", issue #150). Grounded in emdash's
   * `chat-ui/CopyButton.tsx` (SPEC.md §16): a tiny icon button that copies
   * fixed text and flashes a "Copied" acknowledgement.
   *
   * Warp Deck restyle (docs/design/redesign.md §4/§6, issue #439):
   * hand-styled to match `IconButton`'s visual language (hit-target sizing,
   * hover/focus treatment) rather than importing the primitive.
   *
   * Deck migration (issue #469): now actually routes through the shared
   * `IconButton` primitive (a `class` override carries the dimmed/hover/
   * copied-confirmation styling below onto its root button), and the glyph
   * draws from the shared icon set (`icons/Icon.svelte`, issue #457) instead
   * of a bare `⧉` character. There is no bespoke checkmark glyph in that set
   * yet, so the "copied" acknowledgement stays the existing crossfade-to-
   * `--color-success` + one-time scale pulse rather than a glyph swap — a
   * `scale` pulse written against `--duration-base`/`--ease-tension` so
   * `prefers-reduced-motion` (which zeroes those tokens globally, see
   * `tokens.css`) collapses it to an instant color change for free, no
   * separate reduced-motion branch needed.
   */
  import { copyToClipboard } from '$lib/copy';
  import { Icon } from './icons';
  import IconButton from './ui/IconButton.svelte';

  interface Props {
    /** The exact text this button copies. */
    text: string;
    /** Accessible name; also the tooltip. Defaults to a generic "Copy". */
    label?: string;
    /** Injectable for tests; defaults to the real clipboard write. */
    copyFn?: (text: string) => Promise<void>;
  }

  const { text, label = 'Copy', copyFn = copyToClipboard }: Props = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleClick(): Promise<void> {
    await copyFn(text);
    copied = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }
</script>

<IconButton {label} onclick={handleClick} class={`copy-button ${copied ? 'copied' : ''}`.trim()}>
  <Icon name="copy" />
</IconButton>

<style>
  /* `IconButton` renders the actual `<button>`; `class` (above) carries
     these rules onto its root, so every selector below has to reach past
     this file's own scope with `:global(...)` (same pattern `AttachmentBar`
     uses for its `:global(.retry)`/`:global(.remove)`). */
  :global(.copy-button) {
    opacity: 0.5;
  }

  :global(.copy-button:hover),
  :global(.copy-button:focus-visible) {
    opacity: 1;
  }

  /* The copied-confirmation micro-interaction: a crossfade to
     --color-success plus a one-time scale pulse. */
  :global(.copy-button.copied) {
    opacity: 1;
    color: var(--color-success);
    animation: copy-confirm-pulse var(--duration-base) var(--ease-tension);
  }

  @keyframes copy-confirm-pulse {
    0% {
      transform: scale(1);
    }
    40% {
      transform: scale(1.35);
    }
    100% {
      transform: scale(1);
    }
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): reachable via
     hover on desktop (this file's own doc comment), so a coarse (touch)
     pointer — which has no hover — needs an adequately visible tap target
     instead of the more heavily dimmed desktop resting state above
     (`IconButton` itself already grows the hit target under
     `(pointer: coarse)`). */
  @media (pointer: coarse) {
    :global(.copy-button) {
      opacity: 0.7;
    }
  }
</style>
