<script lang="ts">
  /**
   * The checkpoint list + manual "checkpoint now" surface (SPEC §7.20;
   * issue #268, on top of #603's wiring PR #805 built — the wire
   * protocol, `NodeDaemon`'s automatic per-turn checkpoint, and the
   * `RestorePreview`/`RestoreResult` this panel and its dialog render).
   *
   * Lives as its own right-sidebar sub-tab (`+page.svelte`'s
   * `WORKBENCH_TABS`), the same "Files/Config/Runner" shell
   * `RunnerPanel`/`TestRunnerConfigPanel` already use — a session's
   * checkpoints are relevant throughout its whole lifetime, not a one-off
   * row-menu action like `PrOpenDialog`/`ArchiveSessionDialog` (opening a
   * PR happens once, near the end; a checkpoint accumulates continuously
   * as the agent works).
   *
   * Restoring is its own dialog (`CheckpointRestoreDialog.svelte`), kept
   * deliberately in a separate file/diff region: issue #747 (rewind)
   * consumes the same `GitCheckpointStore` engine from the transcript
   * side in parallel and must never collide with this list+dialog
   * surface's own files.
   *
   * An `ssh:` session's `checkpoint_list` answers
   * `errorType: 'unsupported_target'` — rendered here as its own
   * dedicated state (`unsupported`), never a generic `ErrorNotice` and
   * never a "Checkpoint now" button sitting above a list that would only
   * ever fail (issue #268's "the UI must reflect each of those states
   * rather than discovering them as errors").
   *
   * A new checkpoint is appended to the local list directly from
   * `createCheckpoint`'s own `'ok'` reply rather than triggering a full
   * `listCheckpoints` round trip — `GitCheckpointStore.checkpoint()`
   * already returns the exact record a follow-up list call would, and a
   * restore never adds/removes a checkpoint (`GitCheckpointStore.restore`'s
   * own contract), so nothing here ever needs to refetch after either
   * action completes.
   *
   * `client` is narrowed to just the calls this panel and the dialog it
   * mounts need (mirrors `RunnerPanel`'s identical DI pattern), satisfied
   * structurally by the real `RelayClient` with no adapter needed.
   */
  import type {
    CheckpointListResultPayloadV1,
    CheckpointResultPayloadV1,
    GitCheckpointV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Input from './ui/Input.svelte';
  import Row from './ui/Row.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import { Icon } from './icons';
  import CheckpointRestoreDialog, {
    type CheckpointRestoreClient,
  } from './CheckpointRestoreDialog.svelte';

  /** The calls this panel needs off `RelayClient`, on top of the two `CheckpointRestoreDialog` needs (it mounts one) — see the file doc comment's DI note. */
  export interface CheckpointListClient extends CheckpointRestoreClient {
    createCheckpoint(sessionId: string, message?: string): Promise<CheckpointResultPayloadV1>;
    listCheckpoints(sessionId: string): Promise<CheckpointListResultPayloadV1>;
  }

  interface Props {
    sessionId?: string;
    client?: CheckpointListClient;
  }

  const { sessionId, client }: Props = $props();

  let checkpoints = $state<GitCheckpointV1[]>([]);
  let loading = $state(true);
  let loadError = $state<string | undefined>(undefined);
  /** `true` once `checkpoint_list` has answered `errorType: 'unsupported_target'` for the current session — see the file doc comment. */
  let unsupported = $state(false);

  let labelInput = $state('');
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  /** The checkpoint a just-opened `CheckpointRestoreDialog` previews/restores; `undefined` when none is open yet — same split `+page.svelte`'s `archivingSession`/`archiveSessionOpen` uses, so the dialog's own exit transition still has real content to render while it plays out. */
  let restoringCheckpoint = $state<GitCheckpointV1 | undefined>(undefined);
  let restoreDialogOpen = $state(false);

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
  }

  async function load(
    currentSessionId: string,
    currentClient: CheckpointListClient,
  ): Promise<void> {
    loading = true;
    loadError = undefined;
    unsupported = false;
    try {
      const result = await currentClient.listCheckpoints(currentSessionId);
      if (result.outcome === 'ok') {
        checkpoints = result.checkpoints;
      } else if (result.errorType === 'unsupported_target') {
        unsupported = true;
        checkpoints = [];
      } else {
        loadError = result.message;
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Reloads whenever the selected session (or, in a test, the injected
  // client) changes — this panel stays mounted across a session switch,
  // same "not a one-shot onMount" reasoning `RunnerPanel`'s identical
  // effect documents.
  $effect(() => {
    const currentSessionId = sessionId;
    const currentClient = client;
    labelInput = '';
    createError = undefined;
    if (!currentSessionId || !currentClient) {
      checkpoints = [];
      loading = false;
      unsupported = false;
      return;
    }
    void load(currentSessionId, currentClient);
  });

  async function createNow(): Promise<void> {
    if (!sessionId || !client || creating) return;
    creating = true;
    createError = undefined;
    try {
      const result = await client.createCheckpoint(sessionId, labelInput);
      if (result.outcome === 'ok') {
        checkpoints = [...checkpoints, result.checkpoint];
        labelInput = '';
      } else {
        createError = result.message;
      }
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creating = false;
    }
  }

  function handleCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void createNow();
  }

  function openRestoreDialog(checkpoint: GitCheckpointV1): void {
    restoringCheckpoint = checkpoint;
    restoreDialogOpen = true;
  }

  function closeRestoreDialog(): void {
    restoreDialogOpen = false;
  }
</script>

<div class="checkpoint-panel" data-testid="checkpoint-panel">
  {#if !sessionId}
    <EmptyState message="Select a session to see its checkpoints." />
  {:else if loading}
    <p class="loading" data-testid="checkpoint-list-loading">
      <WovenLoader size="sm" label="Loading" />
      Loading checkpoints…
    </p>
  {:else if unsupported}
    <EmptyState
      message="Checkpoint/rollback needs a local git worktree this node can reach directly — this session runs on a remote (ssh:) target, so checkpoints aren't available here."
    />
  {:else}
    <Card elevation="raised" padding="md" class="checkpoint-create">
      <form class="checkpoint-create-form" onsubmit={handleCreateSubmit}>
        <Input
          bind:value={labelInput}
          placeholder="Label (optional)"
          ariaLabel="Checkpoint label"
          disabled={creating}
          dataTestId="checkpoint-label-input"
        />
        <Button type="submit" size="sm" loading={creating} dataTestId="checkpoint-create-button">
          Checkpoint now
        </Button>
      </form>
      {#if createError}
        <ErrorNotice message={createError} />
      {/if}
    </Card>

    {#if loadError}
      <ErrorNotice
        message={`Could not load checkpoints: ${loadError}`}
        retryable
        onRetry={() => void (sessionId && client && load(sessionId, client))}
      />
    {:else if checkpoints.length === 0}
      <EmptyState
        message="No checkpoints yet. Take one now, or wait for the automatic checkpoint before the next turn."
      />
    {:else}
      <ul class="checkpoint-rows" data-testid="checkpoint-list">
        {#each [...checkpoints].reverse() as checkpoint (checkpoint.id)}
          <li>
            <Row as="div" dataTestId={`checkpoint-row-${checkpoint.id}`}>
              {#snippet leading()}
                <Icon name="checkpoint" />
              {/snippet}
              <span class="checkpoint-label">{checkpoint.message}</span>
              <span class="checkpoint-time">{formatDate(checkpoint.createdAt)}</span>
              {#snippet trailing()}
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => openRestoreDialog(checkpoint)}
                  dataTestId={`checkpoint-restore-${checkpoint.id}`}
                >
                  Restore…
                </Button>
              {/snippet}
            </Row>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

{#if restoringCheckpoint && sessionId}
  <CheckpointRestoreDialog
    open={restoreDialogOpen}
    {sessionId}
    checkpoint={restoringCheckpoint}
    {client}
    onClose={closeRestoreDialog}
  />
{/if}

<style>
  .checkpoint-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .checkpoint-create-form {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .checkpoint-create-form :global(.ui-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .checkpoint-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checkpoint-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-primary);
  }

  .checkpoint-time {
    flex: 0 0 auto;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
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
