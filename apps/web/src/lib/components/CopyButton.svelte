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
   * hover/focus treatment) rather than importing the primitive — mirrors
   * `PermissionCard`'s own overflow-toggle rationale: this button's glyph
   * swap (copy mark -> checkmark) and its one-time `copied` confirmation
   * pulse don't compose cleanly onto `IconButton`'s fixed icon-only-
   * children/`aria-pressed` toggle model. The confirmation itself is a
   * `scale` pulse crossfading to `--color-success`, written against
   * `--duration-base`/`--ease-tension` so `prefers-reduced-motion` (which
   * zeroes those tokens globally, see `tokens.css`) collapses it to an
   * instant color change for free — no separate reduced-motion branch.
   */
  import { copyToClipboard } from '$lib/copy';

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

<button
  type="button"
  class="copy-button"
  class:copied
  title={label}
  aria-label={label}
  onclick={handleClick}
>
  <span class="icon" aria-hidden="true">{copied ? '✓' : '⧉'}</span>
</button>

<style>
  .copy-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    border-radius: var(--radius-sm);
    opacity: 0.5;
    font-size: var(--text-small-size);
    line-height: 1;
    color: inherit;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      opacity var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .copy-button:hover,
  .copy-button:focus-visible {
    opacity: 1;
    background: var(--color-fill-subtle);
  }

  .copy-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .copy-button:active {
    transform: scale(0.98);
  }

  /* The copied-confirmation micro-interaction: a crossfade to
     --color-success plus a one-time scale pulse. */
  .copy-button.copied {
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
     pointer — which has no hover — needs a real, adequately-sized tap
     target instead of the compact desktop sizing above. */
  @media (pointer: coarse) {
    .copy-button {
      width: 2.75rem;
      height: 2.75rem;
      font-size: 1.1rem;
      opacity: 0.7;
    }
  }
</style>
