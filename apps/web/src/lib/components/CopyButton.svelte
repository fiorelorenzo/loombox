<script lang="ts">
  /**
   * The one copy affordance every transcript item (message, thought, diff,
   * raw tool command/output) shares (SPEC.md §7.24 "Copy & export", issue
   * #150). Grounded in emdash's `chat-ui/CopyButton.tsx` (SPEC.md §16): a
   * tiny icon button that copies fixed text and flashes a "Copied"
   * acknowledgement.
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
   *
   * Redesign v3 (§3.4 "Copy affordances", defect: a copy icon sat
   * permanently visible at the right of nearly every row, adding noise):
   * `revealOnHover` is the opt-in for a row-scoped reveal — hidden until
   * the button's own containing row signals hover/focus-within by
   * overriding this button's opacity back to 1 (each transcript row's own
   * stylesheet does that with a `.row:hover :global(.copy-button-reveal)`
   * rule reaching into this shared component, since only the row's
   * stylesheet can see its own `:hover`/`:focus-within` state). Defaults to
   * `false` so call sites outside a hoverable row (e.g. `RecoveryCodeCard`,
   * the canvas toolbar's "Export transcript" button) keep the original
   * always-visible-but-dim treatment unchanged. Either way the button is
   * never actually removed, and a coarse (touch) pointer — which has no
   * hover to reveal it with — always sees it.
   *
   * `prominent` is the opposite opt-in (Lorenzo's ask, 2026-07-31): full
   * strength, no dimming at all. The 0.5 resting opacity exists because this
   * icon repeats on every single transcript row; a lone "Export transcript"
   * in the topbar has no such repetition to apologise for, and sitting at
   * half strength beside full-strength neighbours it read as disabled.
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
    /** Hidden until the containing row is hovered/focus-within instead of permanently dim-visible (redesign v3 §3.4 "Copy affordances"); opt-in per call site — see the file doc comment. */
    revealOnHover?: boolean;
    /** Full strength, no dimming — for a standalone call site (e.g. the topbar's "Export transcript") where the resting dim above reads as disabled rather than as quiet. */
    prominent?: boolean;
  }

  const {
    text,
    label = 'Copy',
    copyFn = copyToClipboard,
    revealOnHover = false,
    prominent = false,
  }: Props = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const classNames = $derived(
    [
      'copy-button',
      copied && 'copied',
      revealOnHover && 'copy-button-reveal',
      prominent && 'copy-button-prominent',
    ]
      .filter(Boolean)
      .join(' '),
  );

  async function handleClick(): Promise<void> {
    await copyFn(text);
    copied = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }
</script>

<IconButton {label} onclick={handleClick} class={classNames}>
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

  /* Two classes, so this wins over the dim resting state above and over the
     coarse-pointer rule at the bottom of this file regardless of source
     order. */
  :global(.copy-button.copy-button-prominent) {
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

  /* Row-scoped reveal (redesign v3 §3.4 "Copy affordances"): opted into per
     call site via `revealOnHover`. Hidden by default; the containing row's
     own stylesheet is what actually reveals it on hover/focus-within (see
     the file doc comment) — this button only owns its own hover/focus and
     the coarse-pointer fallback below. The extra `.copy-button-reveal`
     class keeps this at higher specificity than the plain `.copy-button`
     rule above regardless of CSS source order. */
  :global(.copy-button.copy-button-reveal) {
    opacity: 0;
  }

  :global(.copy-button.copy-button-reveal:hover),
  :global(.copy-button.copy-button-reveal:focus-visible) {
    opacity: 1;
  }

  @media (hover: none) {
    :global(.copy-button.copy-button-reveal) {
      opacity: 0.7;
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
