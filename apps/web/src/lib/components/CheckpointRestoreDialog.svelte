<script lang="ts">
  /**
   * The "Restore…" confirm step for one checkpoint row (SPEC §7.20; issue
   * #268, on top of #603/PR #805's wire surface) — kept in its own file,
   * separate from `CheckpointPanel.svelte`'s list, per the #747 (rewind)
   * coordination: that issue consumes the same `GitCheckpointStore`
   * engine from the transcript side and must never collide with this
   * list+dialog surface's own diff region.
   *
   * Two-phase, mirroring `PrOpenDialog`'s own preview/confirm split:
   * loads a READ-ONLY `checkpoint_restore_preview` the moment the dialog
   * opens — never a side effect — then only the explicit "Restore
   * checkpoint" click calls `client.restoreCheckpoint` with
   * `confirm: true`. Sending `confirm: true` unconditionally here is
   * correct, not reckless: this dialog itself IS the confirmation step
   * the wire protocol's own `confirmation_required` outcome exists to
   * gate on, and the preview shown just above the button is drawn
   * straight from the same `RestorePreview` the node would otherwise
   * reply with — the human has already seen exactly what will be
   * discarded before this click is even possible to make.
   *
   * `preview.message`/`restoreOutcome`'s error `message` are shown
   * verbatim, never resummarized: every named `CheckpointErrorTypeV1`
   * reason (`turn_in_progress`, `unsupported_target`, `checkpoint_not_found`,
   * …) is already node-composed prose (`NodeDaemon`'s
   * `CHECKPOINT_TURN_IN_PROGRESS_MESSAGE`/`CHECKPOINT_UNSUPPORTED_TARGET_MESSAGE`,
   * or a `GitCheckpointStore` error class's own message) — the same
   * "the node's own errors are already written for a human, show them
   * verbatim" convention `ArchiveSessionDialog` documents. Only a raw
   * transport timeout gets rephrased, same as that dialog.
   *
   * `client` is narrowed to just the two calls this dialog needs (mirrors
   * `PrOpenDialog`/`ArchiveSessionDialog`'s identical DI pattern),
   * satisfied structurally by the real `RelayClient` with no adapter
   * needed.
   */
  import type {
    CheckpointRestorePreviewResultPayloadV1,
    CheckpointRestoreResultPayloadV1,
    GitCheckpointV1,
  } from '@loombox/protocol';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import { loadErrorMessage, writeErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The two calls this dialog needs off `RelayClient` — both resolve their whole outcome union rather than throwing for a named error, `RelayClient`'s own documented contract for every checkpoint call. */
  export interface CheckpointRestoreClient {
    previewCheckpointRestore(
      sessionId: string,
      checkpointId: string,
    ): Promise<CheckpointRestorePreviewResultPayloadV1>;
    restoreCheckpoint(
      sessionId: string,
      checkpointId: string,
      confirm: boolean,
    ): Promise<CheckpointRestoreResultPayloadV1>;
  }

  interface Props {
    open: boolean;
    sessionId: string;
    checkpoint: GitCheckpointV1;
    client: CheckpointRestoreClient | undefined;
    onClose: () => void;
  }

  const { open, sessionId, checkpoint, client, onClose }: Props = $props();

  let preview = $state<CheckpointRestorePreviewResultPayloadV1 | undefined>(undefined);
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);

  let restoring = $state(false);
  let restoreOutcome = $state<CheckpointRestoreResultPayloadV1 | undefined>(undefined);
  let restoreError = $state<string | undefined>(undefined);

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
  }

  async function load(
    currentSessionId: string,
    checkpointId: string,
    currentClient: CheckpointRestoreClient,
  ): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      preview = await currentClient.previewCheckpointRestore(currentSessionId, checkpointId);
    } catch (err) {
      loadError = loadErrorMessage('This restore preview', err);
    } finally {
      loading = false;
    }
  }

  /** One tagged value, not three independent flags — issue #650. `preview?.outcome === 'error'` (a structured, already-human reply) and a caught transport `loadError` both render identically (a retryable `ErrorNotice`), so both fold into the same `error` status. */
  const previewState = $derived<
    AsyncPanelState<Extract<CheckpointRestorePreviewResultPayloadV1, { outcome: 'ok' }>['preview']>
  >(
    loading
      ? { status: 'loading' }
      : loadError
        ? { status: 'error', message: loadError, retryable: true }
        : preview?.outcome === 'error'
          ? { status: 'error', message: preview.message, retryable: true }
          : preview?.outcome === 'ok'
            ? { status: 'loaded', data: preview.preview }
            : { status: 'loading' },
  );

  // Resets every time the dialog opens for a (possibly different)
  // checkpoint, same "open is this effect's only reactive read"
  // convention `ArchiveSessionDialog`/`PrOpenDialog` already use.
  $effect(() => {
    if (!open) return;
    preview = undefined;
    loadError = undefined;
    restoring = false;
    restoreOutcome = undefined;
    restoreError = undefined;
    if (client) void load(sessionId, checkpoint.id, client);
  });

  async function confirmRestore(): Promise<void> {
    if (!client || restoring) return;
    restoring = true;
    restoreError = undefined;
    try {
      // See the file doc comment for why an unconditional `true` here is
      // correct: this dialog IS the confirmation step.
      restoreOutcome = await client.restoreCheckpoint(sessionId, checkpoint.id, true);
    } catch (err) {
      console.warn('CheckpointRestoreDialog: restoreCheckpoint failed', err);
      restoreError = writeErrorMessage('restored', err);
    } finally {
      restoring = false;
    }
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="checkpoint-restore-context" data-testid="checkpoint-restore-context">
    Restore to <strong>{checkpoint.message}</strong>, taken {formatDate(checkpoint.createdAt)}?
  </p>

  {#if loading || loadError || preview}
    <AsyncPanel
      state={previewState}
      loadingLabel="Loading"
      loadingTestId="checkpoint-restore-loading"
      loadingText="Checking what this restore would do…"
      onRetry={() => void (client && load(sessionId, checkpoint.id, client))}
    >
      {#snippet content(info)}
        <p class="checkpoint-restore-preview" data-testid="checkpoint-restore-preview">
          {#if info.hasUncommittedChangesToDiscard}
            This will discard the worktree's current uncommitted changes{info.isWorkInPlace
              ? " — this session runs directly in your project folder, so those may be your own edits, not just the agent's"
              : ''} and reset every file to exactly this checkpoint's state.
          {:else}
            There is nothing uncommitted to discard right now — restoring will still reset every
            file to exactly this checkpoint's state.
          {/if}
          {#if info.commitsSinceCheckpoint > 0}
            {info.commitsSinceCheckpoint} real {info.commitsSinceCheckpoint === 1
              ? 'commit'
              : 'commits'} made since this checkpoint will stay untouched in the branch's history.
          {/if}
        </p>

        {#if restoreOutcome?.outcome === 'ok'}
          <p class="checkpoint-restore-result" data-testid="checkpoint-restore-result">
            Restored. {restoreOutcome.result.discardedUncommittedChanges
              ? 'Uncommitted changes were discarded.'
              : 'There was nothing uncommitted to discard.'}
            {restoreOutcome.result.commitsPreserved > 0
              ? `${restoreOutcome.result.commitsPreserved} ${restoreOutcome.result.commitsPreserved === 1 ? 'commit stays' : 'commits stay'} untouched.`
              : ''}
          </p>
          <div class="actions">
            <Button onclick={handleClose} dataTestId="checkpoint-restore-done">Done</Button>
          </div>
        {:else}
          {#if restoreOutcome?.outcome === 'error'}
            <ErrorNotice message={restoreOutcome.message} />
          {:else if restoreOutcome?.outcome === 'confirmation_required'}
            <ErrorNotice
              message="The worktree changed since this preview loaded — reload and try again."
              retryable
              onRetry={() => void (client && load(sessionId, checkpoint.id, client))}
            />
          {/if}
          {#if restoreError}
            <ErrorNotice message={restoreError} />
          {/if}
          <div class="actions">
            <Button variant="secondary" onclick={handleClose} disabled={restoring}>Cancel</Button>
            <Button
              variant="danger"
              onclick={confirmRestore}
              loading={restoring}
              dataTestId="checkpoint-restore-confirm"
            >
              Restore checkpoint
            </Button>
          </div>
        {/if}
      {/snippet}
    </AsyncPanel>
  {/if}
{/snippet}

<Dialog {open} label="Restore checkpoint" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Restore checkpoint</h2>
  {/snippet}
</Dialog>

<style>
  .checkpoint-restore-context {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .checkpoint-restore-preview {
    margin: 0;
    color: var(--color-text-primary);
  }

  .checkpoint-restore-result {
    margin: 0;
    color: var(--color-text-primary);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
