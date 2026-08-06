<script lang="ts">
  /**
   * Open a pull request from a session's own pushed branch (SPEC §7.14;
   * issue #238). A control on the session, not a project-wide config
   * panel (mirrors `RunnerPanel`'s placement reasoning, not
   * `TestRunnerConfigPanel`'s): opening a PR is a session-scoped ACTION
   * with a real side effect, not a saved setting.
   *
   * Two-phase, matching the node's own `previewPrOpen`/`openPr` split
   * (`packages/node/src/pr-open.ts`): loads a READ-ONLY preview
   * automatically on mount/session-change (branch, base, commit count, or
   * one of `PrOpenFailureCategory`'s named reasons — never pushes or
   * creates anything by itself), then shows title/body fields the
   * operator fills in. Only the explicit "Push & open pull request" click
   * below — never anything automatic — calls `client.openPr`, per issue
   * #238's "the flow must show exactly what it is about to do before it
   * does it" / "nothing is pushed without an explicit confirmation step".
   * The already-visible preview (branch/base/commit count) IS that "what
   * it is about to do" — mirrors `TestRunnerConfigPanel`'s identical
   * "the suggestion was already visibly displayed first, so this click
   * itself IS the required confirmation" contract for `acceptSuggestion`.
   *
   * No AI-drafted body here (issue #233's scope, not this one's) — title/
   * body are plain operator-typed text.
   *
   * `client` is narrowed to just the two calls this panel needs (mirrors
   * `TestRunnerConfigPanel`/`RunnerPanel`'s identical DI pattern),
   * satisfied structurally by the real `RelayClient` with no adapter
   * needed.
   */
  import type {
    PrOpenFailureCategory,
    PrOpenOutcome,
    PrOpenPreviewOutcome,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import TextArea from './ui/TextArea.svelte';
  import WovenLoader from './WovenLoader.svelte';

  /** The two calls this panel needs off `RelayClient` — see the file doc comment's DI note. Both resolve their whole outcome union (`'ok'` or `'failure'`) rather than throwing for a failure — `RelayClient`'s own documented contract for these two calls. */
  export interface PrOpenClient {
    previewPrOpen(sessionId: string): Promise<PrOpenPreviewOutcome>;
    openPr(sessionId: string, pr: { title: string; body: string }): Promise<PrOpenOutcome>;
  }

  const FAILURE_LABEL: Record<PrOpenFailureCategory, string> = {
    no_branch: 'This session has no branch to open a pull request from.',
    no_commits: 'No commits to open a pull request for yet.',
    gh_missing: "The gh CLI isn't installed on this session's target.",
    gh_unauthenticated: "The gh CLI isn't signed in on this session's target.",
    repo_lookup_failed: "Couldn't look up this repository on GitHub.",
    push_failed: 'Pushing the branch failed.',
    create_failed: 'Creating the pull request failed.',
  };

  interface Props {
    sessionId?: string;
    client?: PrOpenClient;
  }

  const { sessionId, client }: Props = $props();

  let preview = $state<PrOpenPreviewOutcome | undefined>(undefined);
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);

  let title = $state('');
  let body = $state('');
  let opening = $state(false);
  let openOutcome = $state<PrOpenOutcome | undefined>(undefined);
  let openError = $state<string | undefined>(undefined);

  async function load(currentSessionId: string, currentClient: PrOpenClient): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      preview = await currentClient.previewPrOpen(currentSessionId);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Reloads whenever the selected session (or, in a test, the injected
  // client) changes — mirrors `RunnerPanel`/`TestRunnerConfigPanel`'s
  // identical effect, so this panel stays pointed at the right session
  // across a switch rather than a one-shot `onMount`.
  $effect(() => {
    if (!sessionId || !client) {
      preview = undefined;
      title = '';
      body = '';
      openOutcome = undefined;
      openError = undefined;
      return;
    }
    title = '';
    body = '';
    openOutcome = undefined;
    openError = undefined;
    void load(sessionId, client);
  });

  async function confirmOpen(): Promise<void> {
    if (!sessionId || !client) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    opening = true;
    openError = undefined;
    try {
      openOutcome = await client.openPr(sessionId, { title: trimmedTitle, body });
    } catch (err) {
      openError = err instanceof Error ? err.message : String(err);
    } finally {
      opening = false;
    }
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void confirmOpen();
  }
</script>

<div class="pr-open" data-testid="pr-open-panel">
  {#if !sessionId}
    <EmptyState message="Select a session to open a pull request from its branch." />
  {:else}
    <Card elevation="raised" padding="md" class="pr-open-section">
      {#if loadError}
        <ErrorNotice
          message={`Could not preview opening a pull request: ${loadError}`}
          retryable
          onRetry={() => void (sessionId && client && load(sessionId, client))}
        />
      {/if}
      {#if loading}
        <p class="loading" data-testid="pr-open-loading">
          <WovenLoader size="sm" label="Loading" />
          Checking what opening a pull request would do…
        </p>
      {:else if preview?.outcome === 'failure'}
        <ErrorNotice
          message={`${FAILURE_LABEL[preview.category]} (${preview.reason})`}
          retryable
          onRetry={() => void (sessionId && client && load(sessionId, client))}
        />
      {:else if preview?.outcome === 'ok'}
        <p class="preview" data-testid="pr-open-preview">
          This will push <code>{preview.branch}</code> ({preview.commitCount}
          {preview.commitCount === 1 ? 'commit' : 'commits'}) to <code>origin</code> and open a pull
          request into <code>{preview.base}</code>.
        </p>

        {#if openOutcome?.outcome === 'ok'}
          <p class="opened" data-testid="pr-open-result-url">
            Opened
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- gh's own created-PR URL (github.com/.../pull/N), never an internal SvelteKit route; the rule can't statically prove that from a dynamic href. -->
            <a href={openOutcome.url} target="_blank" rel="noreferrer">{openOutcome.url}</a>
            (#{openOutcome.number}).
          </p>
        {:else}
          <form class="pr-form" onsubmit={handleSubmit}>
            <Field label="Title">
              {#snippet children({ id, describedBy, errorId, invalid, required })}
                <Input
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  {required}
                  placeholder="e.g. Add widget support"
                  bind:value={title}
                  dataTestId="pr-open-title-input"
                />
              {/snippet}
            </Field>
            <Field label="Description">
              {#snippet children({ id, describedBy, errorId, invalid })}
                <TextArea
                  {id}
                  {describedBy}
                  {errorId}
                  {invalid}
                  placeholder="Optional — describe the change"
                  bind:value={body}
                  dataTestId="pr-open-body-input"
                />
              {/snippet}
            </Field>
            {#if openOutcome?.outcome === 'failure'}
              <ErrorNotice
                message={`${FAILURE_LABEL[openOutcome.category]} (${openOutcome.reason})`}
              />
            {/if}
            {#if openError}
              <ErrorNotice message={`Could not open the pull request: ${openError}`} />
            {/if}
            <Button
              type="submit"
              loading={opening}
              disabled={title.trim().length === 0}
              dataTestId="pr-open-confirm"
            >
              Push &amp; open pull request
            </Button>
          </form>
        {/if}
      {/if}
    </Card>
  {/if}
</div>

<style>
  .pr-open {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .pr-open :global(.pr-open-section) {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .preview {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .preview code {
    font-family: var(--font-mono);
    color: var(--color-text-primary);
  }

  .opened {
    margin: 0;
    color: var(--color-text-primary);
    font-size: var(--text-small-size);
  }

  .pr-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    align-items: flex-start;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }
</style>
