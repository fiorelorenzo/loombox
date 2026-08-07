<script lang="ts">
  /**
   * The in-transcript search bar (SPEC.md §7.19; issues #262/#263).
   * Opened by the `search-transcript` registry action (`Mod+F`, `$lib/
   * action-registry.ts`) or a header trigger; `+page.svelte` owns the
   * actual match list (`$lib/transcript/search.ts`'s `searchTranscript`,
   * run over the FULL `TranscriptState.items` — never just whatever
   * `TranscriptTimeline`'s own windowing (issue #755) currently has
   * mounted, see that module's own doc comment for why a windowed scan
   * would silently under-count) and the "jump to a match" wiring (the same
   * `TranscriptJumpTarget` mechanism issue #740 shipped for "jump to this
   * file's diff" — a match well outside the mounted window is exactly
   * what that mechanism exists for). This component is deliberately dumb:
   * an input, a count, next/prev, close — no search logic and no
   * transcript DOM of its own.
   *
   * Enter/Shift+Enter double as Next/Previous (mirrors a browser's own
   * find bar), so a keyboard-only search never has to reach for the
   * mouse; Escape closes. Both are handled locally rather than through
   * `$lib/action-registry.ts`'s global dispatcher, matching
   * `CommandPalette`'s own "the palette itself owns Esc/Arrow/Enter once
   * open" precedent — this bar's own input is an `isTypingTarget` match,
   * so the global dispatcher never sees these keys while it's focused
   * anyway.
   */
  import Icon from './icons/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Input from './ui/Input.svelte';

  interface Props {
    query: string;
    /** 0-based index into whatever match list the caller computed; unread while `matchCount` is 0. */
    activeIndex: number;
    matchCount: number;
    onQueryChange: (query: string) => void;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
  }

  const { query, activeIndex, matchCount, onQueryChange, onNext, onPrevious, onClose }: Props =
    $props();

  const countLabel = $derived(
    query.trim() === ''
      ? ''
      : matchCount === 0
        ? 'No results'
        : `${activeIndex + 1} of ${matchCount}`,
  );

  /**
   * Autofocuses the query field the moment this bar mounts — it only ever
   * mounts while open (`+page.svelte` gates it behind `{#if
   * transcriptSearchOpen}`), the same "a just-opened control grabs focus"
   * convention every dialog in this package follows. `Input.svelte` owns
   * its root `<input>` and exposes no ref of its own, so this reaches it
   * the same way `TranscriptTimeline.svelte`'s `jumpItemEl` reaches a row
   * outside its own control: a scoped `querySelector` off a Svelte action,
   * keyed by the same `data-testid` a test also asserts against.
   */
  function autofocusQueryInput(node: HTMLElement): void {
    node.querySelector<HTMLInputElement>('[data-testid="transcript-search-input"]')?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  }
</script>

<div class="search-bar" data-testid="transcript-search-bar" use:autofocusQueryInput>
  <Icon name="search" class="search-bar-icon" />
  <div class="search-bar-field">
    <Input
      value={query}
      oninput={(event) => onQueryChange(event.currentTarget.value)}
      onkeydown={handleKeydown}
      ariaLabel="Search this session's transcript"
      placeholder="Search this session…"
      dataTestId="transcript-search-input"
    />
  </div>
  <span class="search-bar-count" data-testid="transcript-search-count" aria-live="polite">
    {countLabel}
  </span>
  <IconButton
    label="Previous match"
    size="sm"
    disabled={matchCount === 0}
    onclick={onPrevious}
    dataTestId="transcript-search-prev"
  >
    <Icon name="chevron-down" class="search-bar-chevron-up" />
  </IconButton>
  <IconButton
    label="Next match"
    size="sm"
    disabled={matchCount === 0}
    onclick={onNext}
    dataTestId="transcript-search-next"
  >
    <Icon name="chevron-down" />
  </IconButton>
  <IconButton label="Close search" size="sm" onclick={onClose} dataTestId="transcript-search-close">
    <Icon name="close" />
  </IconButton>
</div>

<style>
  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    margin-bottom: var(--space-sm);
  }

  :global(.search-bar-icon) {
    color: var(--color-text-muted);
  }

  .search-bar-field {
    flex: 1;
    min-width: 0;
  }

  .search-bar-count {
    flex-shrink: 0;
    min-width: 6ch;
    text-align: right;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    white-space: nowrap;
  }

  :global(.search-bar-chevron-up) {
    transform: rotate(180deg);
  }
</style>
