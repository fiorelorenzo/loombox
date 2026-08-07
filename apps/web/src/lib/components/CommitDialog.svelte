<script lang="ts">
  /**
   * The hunk-staging view's own "Commit" confirm step (SPEC §7.6; issue
   * #233's own acceptance line: "committing with no edits uses the draft
   * verbatim... user can edit the drafted message before committing").
   * `WorktreeDiffViewer`'s staging surface opens this from a "Commit"
   * button (that component's own file doc comment) once it has at least
   * one staged hunk to commit.
   *
   * Two-phase, mirroring `PrOpenDialog`'s own "load a read-only preview
   * the moment the dialog opens, only an explicit click acts" split
   * (that file's own doc comment) — except here the auto-loaded step is
   * an AI-DRAFTED message, not a read-only preview: the moment the
   * dialog opens it requests `git_commit_draft_request` (generated
   * node-side by prompting the session's own live agent — never a new,
   * separately-configured provider call, issue #233's own constraint)
   * and shows the result in an editable textarea. Only the explicit
   * "Commit" click — never anything automatic — calls `client.
   * commitStaged`; an unedited textarea sends the draft verbatim, an
   * edited one sends whatever text is currently there. Nothing is ever
   * committed just because a draft arrived.
   *
   * `client` is narrowed to the two calls this dialog needs (mirrors
   * `ArchiveSessionDialog`/`PrOpenDialog`'s identical DI pattern),
   * satisfied structurally by the real `RelayClient` with no adapter
   * needed.
   */
  import type {
    GitCommitDraftResponsePayloadV1,
    GitCommitResponsePayloadV1,
  } from '@loombox/protocol';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import TextArea from './ui/TextArea.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The two calls this dialog needs off `RelayClient` — see the file doc comment's DI note. Both resolve their whole outcome union (`'ok'` or `'error'`) rather than throwing for a failure — `RelayClient`'s own documented contract for these two calls. */
  export interface CommitDialogClient {
    requestGitCommitDraft(sessionId: string): Promise<GitCommitDraftResponsePayloadV1>;
    commitStaged(
      sessionId: string,
      params: { message: string },
    ): Promise<GitCommitResponsePayloadV1>;
  }

  interface Props {
    open: boolean;
    sessionId: string;
    client: CommitDialogClient | undefined;
    onClose: () => void;
    /** Fired after a successful commit, before `onClose` — the caller re-fetches the hunk viewer (and typically the whole-file viewer too), mirroring `DiscardHunkDialog`'s own `onDiscarded` contract: the staged content this dialog just committed is now gone from the index. */
    onCommitted: () => void;
  }

  const { open, sessionId, client, onClose, onCommitted }: Props = $props();

  let draftLoading = $state(false);
  let draftError = $state<string | undefined>(undefined);
  let message = $state('');

  let committing = $state(false);
  let commitError = $state<string | undefined>(undefined);
  let committed = $state<{ sha: string } | undefined>(undefined);

  async function loadDraft(
    currentSessionId: string,
    currentClient: CommitDialogClient,
  ): Promise<void> {
    draftLoading = true;
    draftError = undefined;
    try {
      const result = await currentClient.requestGitCommitDraft(currentSessionId);
      if (result.outcome === 'ok') {
        message = result.message;
      } else {
        draftError = result.message;
      }
    } catch (err) {
      draftError = loadErrorMessage('The commit draft', err);
    } finally {
      draftLoading = false;
    }
  }

  /** One tagged value, not two independent flags — issue #650. No `loaded` content of its own: the `Field`/`TextArea` below is unconditional (draftable by hand even after a failed draft), so this only ever drives which of loading/error/nothing shows above it. */
  const draftState = $derived<AsyncPanelState<undefined>>(
    draftLoading
      ? { status: 'loading' }
      : draftError
        ? { status: 'error', message: draftError, retryable: true }
        : { status: 'loaded', data: undefined },
  );

  // Resets every time the dialog opens for a (possibly different)
  // session, same "open is this effect's only reactive read" convention
  // `PrOpenDialog`/`ArchiveSessionDialog` already use.
  $effect(() => {
    if (!open) return;
    draftLoading = false;
    draftError = undefined;
    message = '';
    committing = false;
    commitError = undefined;
    committed = undefined;
    if (client) void loadDraft(sessionId, client);
  });

  async function confirmCommit(): Promise<void> {
    if (!client || committing) return;
    const trimmed = message.trim();
    if (!trimmed) return;
    committing = true;
    commitError = undefined;
    try {
      const result = await client.commitStaged(sessionId, { message: trimmed });
      if (result.outcome === 'error') {
        commitError = result.message;
        return;
      }
      committed = { sha: result.sha };
      onCommitted();
    } catch (err) {
      console.warn('CommitDialog: commitStaged failed', err);
      const raw = err instanceof Error ? err.message : String(err);
      commitError = raw.includes('timed out waiting')
        ? 'Nothing answered in time. The node may be asleep, offline, or on an older relay. Nothing was committed.'
        : raw;
    } finally {
      committing = false;
    }
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void confirmCommit();
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  {#if committed}
    <p class="commit-result" data-testid="commit-result">
      Committed as <code>{committed.sha.slice(0, 12)}</code>.
    </p>
    <div class="actions">
      <Button onclick={handleClose} dataTestId="commit-done">Done</Button>
    </div>
  {:else}
    <form class="commit-form" onsubmit={handleSubmit}>
      <AsyncPanel
        state={draftState}
        loadingLabel="Loading"
        loadingTestId="commit-draft-loading"
        loadingText="Asking the agent to draft a commit message from the staged diff…"
        onRetry={() => void (client && loadDraft(sessionId, client))}
      >
        {#snippet content()}{/snippet}
      </AsyncPanel>
      <Field label="Commit message">
        {#snippet children({ id, describedBy, errorId, invalid, required })}
          <TextArea
            {id}
            {describedBy}
            {errorId}
            {invalid}
            {required}
            placeholder={draftLoading ? 'Drafting…' : 'Describe the staged change'}
            disabled={draftLoading}
            bind:value={message}
            dataTestId="commit-message-input"
          />
        {/snippet}
      </Field>
      {#if commitError}
        <ErrorNotice message={`Could not commit: ${commitError}`} />
      {/if}
      <div class="actions">
        <Button variant="secondary" onclick={handleClose}>Cancel</Button>
        <Button
          type="submit"
          loading={committing}
          disabled={message.trim().length === 0}
          dataTestId="commit-confirm"
        >
          Commit
        </Button>
      </div>
    </form>
  {/if}
{/snippet}

<Dialog {open} label="Commit staged changes" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Commit staged changes</h2>
  {/snippet}
</Dialog>

<style>
  .commit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .commit-result {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
