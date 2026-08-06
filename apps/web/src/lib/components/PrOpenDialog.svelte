<script lang="ts">
  /**
   * The row-menu "Open pull request…" confirm step (SPEC §7.14; issue
   * #238) — a dialog, not a permanent workbench sub-tab (unlike
   * `RunnerPanel`, a recurring loop an operator returns to throughout a
   * work session, opening a PR happens once, near the end, for whichever
   * session earned it — the same "occasional, per-session, not always
   * relevant" shape `ArchiveSessionDialog`'s row-menu confirm and the row
   * menu's "Export transcript" already have, not Files/Config/Runner's
   * "relevant for the whole session" shape). Reached from the session row
   * menu (`+page.svelte`'s `sessionRowMenuFor`) exactly like those two,
   * on ANY session row — unlike "Export transcript" it needs nothing
   * beyond `sessionId` a row already has, so it is never gated to only
   * the currently-open session.
   *
   * Two-phase, matching the node's own `previewPrOpen`/`openPr` split
   * (`packages/node/src/pr-open.ts`): loads a READ-ONLY preview
   * automatically the moment the dialog opens (branch, base, commit
   * count, or one of `PrOpenFailureCategory`'s named reasons — never
   * pushes or creates anything by itself), then shows title/body fields.
   * Only the explicit "Push & open pull request" click — never anything
   * automatic — calls `client.openPr`, per issue #238's "the flow must
   * show exactly what it is about to do before it does it" / "nothing is
   * pushed without an explicit confirmation step". The already-visible
   * preview (branch/base/commit count) IS that "what it is about to do".
   *
   * No AI-drafted body here (issue #233's scope, not this one's) — title/
   * body are plain operator-typed text.
   *
   * `client` is narrowed to just the two calls this dialog needs (mirrors
   * `ArchiveSessionDialog`'s identical DI pattern), satisfied structurally
   * by the real `RelayClient` with no adapter needed.
   */
  import type {
    PrOpenFailureCategory,
    PrOpenOutcome,
    PrOpenPreviewOutcome,
  } from '@loombox/protocol';
  import type { ClientSessionMeta } from '$lib/relay-client';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import TextArea from './ui/TextArea.svelte';
  import WovenLoader from './WovenLoader.svelte';

  /** The two calls this dialog needs off `RelayClient` — see the file doc comment's DI note. Both resolve their whole outcome union (`'ok'` or `'failure'`) rather than throwing for a failure — `RelayClient`'s own documented contract for these two calls. */
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
    open: boolean;
    session: ClientSessionMeta;
    client: PrOpenClient | undefined;
    onClose: () => void;
  }

  const { open, session, client, onClose }: Props = $props();

  let preview = $state<PrOpenPreviewOutcome | undefined>(undefined);
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);

  let title = $state('');
  let body = $state('');
  let opening = $state(false);
  let openOutcome = $state<PrOpenOutcome | undefined>(undefined);
  let openError = $state<string | undefined>(undefined);

  async function load(sessionId: string, currentClient: PrOpenClient): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      preview = await currentClient.previewPrOpen(sessionId);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Resets every time the dialog opens for a (possibly different)
  // session, same "open is this effect's only reactive read" convention
  // `ArchiveSessionDialog`/`AddProjectDialog`/`NewSessionDialog` already
  // use.
  $effect(() => {
    if (!open) return;
    preview = undefined;
    loadError = undefined;
    title = '';
    body = '';
    opening = false;
    openOutcome = undefined;
    openError = undefined;
    if (client) void load(session.id, client);
  });

  async function confirmOpen(): Promise<void> {
    if (!client || opening) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    opening = true;
    openError = undefined;
    try {
      openOutcome = await client.openPr(session.id, { title: trimmedTitle, body });
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

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="pr-open-context" data-testid="pr-open-context">
    Open a pull request from <strong>{session.title}</strong>'s branch.
  </p>

  {#if loadError}
    <ErrorNotice
      message={`Could not preview opening a pull request: ${loadError}`}
      retryable
      onRetry={() => void (client && load(session.id, client))}
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
      onRetry={() => void (client && load(session.id, client))}
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
      <div class="actions">
        <Button onclick={handleClose} dataTestId="pr-open-done">Done</Button>
      </div>
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
          <ErrorNotice message={`${FAILURE_LABEL[openOutcome.category]} (${openOutcome.reason})`} />
        {/if}
        {#if openError}
          <ErrorNotice message={`Could not open the pull request: ${openError}`} />
        {/if}
        <div class="actions">
          <Button variant="secondary" onclick={handleClose}>Cancel</Button>
          <Button
            type="submit"
            loading={opening}
            disabled={title.trim().length === 0}
            dataTestId="pr-open-confirm"
          >
            Push &amp; open pull request
          </Button>
        </div>
      </form>
    {/if}
  {/if}
{/snippet}

<Dialog {open} label="Open pull request" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Open pull request</h2>
  {/snippet}
</Dialog>

<style>
  .pr-open-context {
    margin: 0;
    color: var(--color-text-secondary);
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
  }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
