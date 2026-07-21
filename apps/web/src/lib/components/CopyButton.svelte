<script lang="ts">
  /**
   * The one copy affordance every transcript item (message, thought, diff,
   * raw tool command/output) shares — reachable on hover (desktop, via the
   * caller's `.item:hover &` CSS revealing it) and long-press/tap (touch:
   * the button is a real, always-focusable target, never hover-only) (SPEC.md
   * §7.24 "Copy & export", issue #150). Grounded in emdash's
   * `chat-ui/CopyButton.tsx` (SPEC.md §16): a tiny icon button that copies
   * fixed text and flashes a "Copied" acknowledgement.
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
  {copied ? '✓' : '⧉'}
</button>

<style>
  .copy-button {
    border: none;
    background: transparent;
    cursor: pointer;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-sm);
    opacity: 0.5;
    font-size: var(--text-small-size);
    line-height: 1;
    color: inherit;
  }

  .copy-button:hover,
  .copy-button:focus-visible {
    opacity: 1;
    background: var(--color-fill-subtle);
  }

  .copy-button.copied {
    opacity: 1;
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133): reachable via
     hover on desktop (this file's own doc comment), so a coarse (touch)
     pointer — which has no hover — needs a real, adequately-sized tap
     target instead of the compact desktop padding above. */
  @media (pointer: coarse) {
    .copy-button {
      min-width: 2.75rem;
      min-height: 2.75rem;
      font-size: 1.1rem;
      opacity: 0.7;
    }
  }
</style>
