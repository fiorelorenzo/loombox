<script lang="ts" generics="T">
  /**
   * The shared load/error/empty primitive (issue #650), alongside the
   * other Deck primitives (`Button`, `Card`, `ErrorNotice`, `EmptyState`,
   * ...): every panel that requests something over the relay used to
   * hand-roll its own loading/error/empty triple, and each copy had
   * quietly drifted from the others — two different bounded-wait timeout
   * sentences, a pin list that leaked a raw wire message
   * (`account_pin_get_request`) straight to the screen, a Runner tab that
   * rendered its timeout error AND "no commands configured" stacked on
   * top of each other. That last one is the reason this takes a single
   * tagged {@link AsyncPanelState}, not the four independent booleans
   * every hand-rolled copy used: "error and empty at once" needs to be
   * unrepresentable, not merely avoided by getting an `{:else if}` chain
   * right, because the Runner already proves that chain can drift wrong.
   *
   * Renders exactly one of the four states a caller's own request can be
   * in — never two at once, by construction, since it's one `{#if}` /
   * `{:else if}` ladder over one tagged value. `loaded` is rendered
   * through the `content` snippet (given `state.data`) rather than a
   * fixed shape, since every adopter's actual loaded content — a list of
   * branches, a commit graph, a form — has nothing in common but "not
   * loading, no error, something to show".
   *
   * The handful of optional props beyond `state` exist because this
   * replaced ~15 already-shipped call sites rather than inventing a
   * pattern greenfield, and each had already made one small, legitimate
   * choice this primitive still needs to honor: `loadingTestId` and
   * `errorTestId` keep each caller's own pre-existing `data-testid` hook
   * stable through the move; `loadingText` is omitted by the handful of
   * full-panel loads that only ever showed a bare spinner; `errorExtra`
   * is `TrackerPage`'s one resolution-error `Badge` shown above its
   * `ErrorNotice`. A panel whose own hand-rolled empty/zero-content
   * message was never the shared `EmptyState` primitive to begin with
   * (`DirectoryPicker`, `SpendReportPanel` — both intentionally compact,
   * inline messages, not `EmptyState`'s bigger dimmed-`BrandMark`
   * treatment) keeps that exact rendering inside its own `content`
   * snippet rather than going through this component's `empty` branch,
   * so adopting this primitive never silently reskins a state nobody
   * asked to change.
   */
  import type { Snippet } from 'svelte';
  import type { AsyncPanelState } from '$lib/async-panel';
  import WovenLoader from '../WovenLoader.svelte';
  import EmptyState from './EmptyState.svelte';
  import ErrorNotice from './ErrorNotice.svelte';

  interface Props {
    state: AsyncPanelState<T>;
    /** `WovenLoader`'s own accessible name for the `loading` branch. */
    loadingLabel: string;
    /** `data-testid` on the `loading` branch's wrapper. */
    loadingTestId: string;
    /** Visible text beside the spinner (e.g. "Loading…"). Omitted renders a bare spinner — the shape every full-panel `size="md"` load already used. */
    loadingText?: string;
    /** `WovenLoader` size for the `loading` branch; `'sm'` (default) sits inline with `loadingText`, `'md'` is a standalone panel load. */
    loadingSize?: 'sm' | 'md';
    /** Optional `data-testid` wrapping the `error` branch (e.g. `FileTreePanel`'s per-node `file-tree-error`). Omitted renders a bare `ErrorNotice`. */
    errorTestId?: string;
    /** Optional content rendered above the `ErrorNotice` message in the `error` branch (e.g. a resolution-reason `Badge`). */
    errorExtra?: Snippet;
    /** Re-runs the request that produced `state`; wired to `ErrorNotice`'s own Retry button when `state.retryable`. */
    onRetry?: () => void;
    /** Rendered for the `loaded` branch, given `state.data`. */
    content: Snippet<[T]>;
  }

  const {
    state,
    loadingLabel,
    loadingTestId,
    loadingText,
    loadingSize = 'sm',
    errorTestId,
    errorExtra,
    onRetry,
    content,
  }: Props = $props();
</script>

{#snippet errorBody()}
  {#if errorExtra}{@render errorExtra()}{/if}
  <ErrorNotice
    message={state.status === 'error' ? state.message : ''}
    retryable={state.status === 'error' && (state.retryable ?? false)}
    {onRetry}
  />
{/snippet}

{#if state.status === 'loading'}
  <div class="ui-async-panel-loading" data-testid={loadingTestId}>
    <WovenLoader size={loadingSize} label={loadingLabel} />
    {#if loadingText}{loadingText}{/if}
  </div>
{:else if state.status === 'error'}
  {#if errorTestId}
    <div data-testid={errorTestId}>
      {@render errorBody()}
    </div>
  {:else}
    {@render errorBody()}
  {/if}
{:else if state.status === 'empty'}
  <EmptyState message={state.message} cta={state.cta} />
{:else}
  {@render content(state.data)}
{/if}

<style>
  .ui-async-panel-loading {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }
</style>
