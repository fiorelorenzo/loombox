<script lang="ts">
  /**
   * The session row menu's "Checkpoints…" action (SPEC §7.20; issue #268,
   * on top of #603's wiring PR #805 built) — lists a session's checkpoints
   * with their label and time, offers a "Checkpoint now" affordance, and
   * opens `CheckpointRestoreDialog` per row. Kept in its own file/diff
   * region deliberately: issue #747 (rewind) consumes the same
   * `GitCheckpointStore` engine from the transcript side in parallel and
   * must never collide with this list+dialog surface's own files.
   *
   * Originally shipped as a fourth `WORKBENCH_TABS` sub-tab beside Files/
   * Config/Runner; moved here after `cockpit-shell.spec.ts` failed the
   * same way it did for PR #804's `PrOpenPanel` (issue #238) — v8's C1-3
   * deliberately settled that group at exactly Files/Config/Runner
   * (always applicable to an open session), and a checkpoint action is
   * occasional and session-scoped instead, the same shape "Archive
   * session…"/"Export transcript"/"Open pull request…" already have.
   * Reached from the row menu of ANY session, not gated to the
   * currently-open one (`+page.svelte`'s `sessionRowMenuFor`), mirroring
   * `PrOpenDialog`/`ArchiveSessionDialog` exactly — same `session`/`open`/
   * `client`/`onClose` prop shape, same "resets whenever `open` becomes
   * true" effect.
   *
   * Stacks `CheckpointRestoreDialog` as a second `Dialog`/`Overlay` layer
   * over this one when a row's "Restore…" is clicked, rather than
   * swapping this dialog's own body to a second view
   * (`TrackerManageTypesDialog`'s `view` convention): `Overlay.svelte`'s
   * own `escapeStack` is built exactly for this ("a Dialog opened over a
   * pinned Drawer closes one layer per press instead of both at once"),
   * and restoring is destructive enough — a distinct extra confirm step,
   * not a mere alternate view of the same list — that `CheckpointRestoreDialog`
   * keeps its own title/focus-trap/backdrop rather than borrowing this
   * one's.
   *
   * `client` is narrowed to just the calls this dialog and the restore
   * dialog it mounts need (mirrors `RunnerPanel`'s identical DI pattern),
   * satisfied structurally by the real `RelayClient` with no adapter
   * needed.
   */
  import type {
    CheckpointListResultPayloadV1,
    CheckpointResultPayloadV1,
    GitCheckpointV1,
  } from '@loombox/protocol';
  import type { ClientSessionMeta } from '$lib/relay-client';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Input from './ui/Input.svelte';
  import Row from './ui/Row.svelte';
  import { Icon } from './icons';
  import CheckpointRestoreDialog, {
    type CheckpointRestoreClient,
  } from './CheckpointRestoreDialog.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The calls this dialog needs off `RelayClient`, on top of the two `CheckpointRestoreDialog` needs (it mounts one) — see the file doc comment's DI note. */
  export interface CheckpointsClient extends CheckpointRestoreClient {
    createCheckpoint(sessionId: string, message?: string): Promise<CheckpointResultPayloadV1>;
    listCheckpoints(sessionId: string): Promise<CheckpointListResultPayloadV1>;
  }

  interface Props {
    open: boolean;
    session: ClientSessionMeta;
    client: CheckpointsClient | undefined;
    onClose: () => void;
  }

  const { open, session, client, onClose }: Props = $props();

  let checkpoints = $state<GitCheckpointV1[]>([]);
  let loading = $state(true);
  let loadError = $state<string | undefined>(undefined);
  /** `true` once `checkpoint_list` has answered `errorType: 'unsupported_target'` for this session — see the file doc comment. */
  let unsupported = $state(false);

  let labelInput = $state('');
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  /** The checkpoint a just-opened `CheckpointRestoreDialog` previews/restores; `undefined` when none is open yet. */
  let restoringCheckpoint = $state<GitCheckpointV1 | undefined>(undefined);
  let restoreDialogOpen = $state(false);

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
  }

  async function load(sessionId: string, currentClient: CheckpointsClient): Promise<void> {
    loading = true;
    loadError = undefined;
    unsupported = false;
    try {
      const result = await currentClient.listCheckpoints(sessionId);
      if (result.outcome === 'ok') {
        checkpoints = result.checkpoints;
      } else if (result.errorType === 'unsupported_target') {
        unsupported = true;
        checkpoints = [];
      } else {
        loadError = result.message;
      }
    } catch (err) {
      loadError = loadErrorMessage('The checkpoint list', err);
    } finally {
      loading = false;
    }
  }

  /**
   * One tagged value, not the three independent flags above (issue #650)
   * — `unsupported` is a genuine full-panel `empty` (nothing else in this
   * dialog is useful for an ssh: session, matching the existing
   * `checkpoint-create-button` must never appear test), so it folds into
   * `AsyncPanel`'s own `empty` branch. A merely-empty checkpoint LIST is
   * different: the "Checkpoint now" form must stay usable even with zero
   * checkpoints (or a failed load — see `createCard` below, rendered via
   * both `content` and `errorExtra`), so that case stays inline in
   * `content` rather than in `status: 'empty'`.
   */
  const checkpointsState = $derived<AsyncPanelState<GitCheckpointV1[]>>(
    loading
      ? { status: 'loading' }
      : unsupported
        ? {
            status: 'empty',
            message:
              "Checkpoint/rollback needs a local git worktree this node can reach directly — this session runs on a remote (ssh:) target, so checkpoints aren't available here.",
          }
        : loadError
          ? { status: 'error', message: loadError, retryable: true }
          : { status: 'loaded', data: checkpoints },
  );

  // Resets every time the dialog opens for a (possibly different) session,
  // same "open is this effect's only reactive read" convention
  // `ArchiveSessionDialog`/`PrOpenDialog` already use.
  $effect(() => {
    if (!open) return;
    checkpoints = [];
    loadError = undefined;
    unsupported = false;
    labelInput = '';
    creating = false;
    createError = undefined;
    restoringCheckpoint = undefined;
    restoreDialogOpen = false;
    if (client) void load(session.id, client);
  });

  async function createNow(): Promise<void> {
    if (!client || creating) return;
    creating = true;
    createError = undefined;
    try {
      const result = await client.createCheckpoint(session.id, labelInput);
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

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet createCard()}
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
{/snippet}

{#snippet dialogBody()}
  <p class="checkpoint-context" data-testid="checkpoints-context">
    Checkpoints for <strong>{session.title}</strong>.
  </p>

  <AsyncPanel
    state={checkpointsState}
    loadingLabel="Loading"
    loadingTestId="checkpoint-list-loading"
    loadingText="Loading checkpoints…"
    errorExtra={createCard}
    onRetry={() => void (client && load(session.id, client))}
  >
    {#snippet content(loadedCheckpoints)}
      {@render createCard()}

      {#if loadedCheckpoints.length === 0}
        <EmptyState
          message="No checkpoints yet. Take one now, or wait for the automatic checkpoint before the next turn."
        />
      {:else}
        <ul class="checkpoint-rows" data-testid="checkpoint-list">
          {#each [...loadedCheckpoints].reverse() as checkpoint (checkpoint.id)}
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
    {/snippet}
  </AsyncPanel>
{/snippet}

<Dialog {open} label="Checkpoints" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Checkpoints</h2>
  {/snippet}
</Dialog>

{#if restoringCheckpoint}
  <CheckpointRestoreDialog
    open={restoreDialogOpen}
    sessionId={session.id}
    checkpoint={restoringCheckpoint}
    {client}
    onClose={closeRestoreDialog}
  />
{/if}

<style>
  .checkpoint-context {
    margin: 0;
    color: var(--color-text-secondary);
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
</style>
