<script lang="ts">
  /**
   * The hunk-staging view's discard confirmation (SPEC §7.6; issue #232's
   * own acceptance line: "discarding a hunk is confirmed before applying").
   * Discarding an unstaged hunk reverts the worktree for exactly those
   * lines with no undo — real, unrecoverable data loss for whatever the
   * agent or the user typed there — so this mirrors `ArchiveSessionDialog`/
   * `CheckpointRestoreDialog`'s own "the dialog that triggers a real relay
   * call owns that call, and owns its own loading/error state" convention
   * (`ArchiveSessionDialog`'s file doc comment) rather than reporting a
   * plain confirm boolean up for `WorktreeDiffViewer`/`+page.svelte` to act
   * on. Single-phase like `ArchiveSessionDialog` (not `CheckpointRestoreDialog`'s
   * preview/confirm split) — the hunk being discarded is already fully known
   * from the row that opened this dialog, there is nothing further to fetch.
   *
   * `client` is narrowed to the one call this dialog needs (mirrors
   * `ArchiveSessionDialog`/`PrOpenDialog`'s identical DI pattern), satisfied
   * structurally by the real `RelayClient` with no adapter needed.
   *
   * The confirmation copy names exactly what is about to be lost — the
   * file, the line the hunk starts at, and how many added/removed lines
   * it covers — rather than a generic "are you sure?", the same
   * specificity `ArchiveSessionDialog`'s own context line and
   * `CheckpointRestoreDialog`'s preview line already give.
   */
  import type { GitHunkActionResponsePayloadV1, GitHunkV1 } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  export interface DiscardHunkClient {
    applyGitHunkAction(
      sessionId: string,
      params: { path: string; hunkIndex: number; action: 'discard' },
    ): Promise<GitHunkActionResponsePayloadV1>;
  }

  interface Props {
    open: boolean;
    sessionId: string;
    client: DiscardHunkClient | undefined;
    /** The file whose hunk is about to be discarded. */
    path: string;
    /** This hunk's position in `computeHunkDiff`'s own `unstaged` array for `path` — see `@loombox/protocol`'s `git-hunks.ts` doc comment for why this addresses the hunk rather than any patch text. */
    hunkIndex: number;
    hunk: GitHunkV1;
    onClose: () => void;
    /** Fired after a successful discard, before `onClose` — the caller re-fetches the hunk viewer (and typically the whole-file viewer too) in response, mirroring `ArchiveSessionDialog`'s own "the caller's list refreshes because the archived session leaves it" contract. */
    onDiscarded: () => void;
  }

  const { open, sessionId, client, path, hunkIndex, hunk, onClose, onDiscarded }: Props = $props();

  let discarding = $state(false);
  let discardError = $state<string | undefined>(undefined);

  // Resets every time the dialog opens for a (possibly different) hunk,
  // same "open is this effect's only reactive read" convention
  // `ArchiveSessionDialog`/`CheckpointRestoreDialog` already use.
  $effect(() => {
    if (!open) return;
    discarding = false;
    discardError = undefined;
  });

  /** Names what a discard actually does to `hunk`'s lines — a pure addition only "removes N added line(s)", a pure deletion only "restores N removed line(s)", a mixed edit states both, so the copy never claims an effect this hunk doesn't have. */
  function describeDiscard(target: GitHunkV1): string {
    const added = target.lines.filter((line) => line.kind === 'added').length;
    const removed = target.lines.filter((line) => line.kind === 'removed').length;
    const parts: string[] = [];
    if (added > 0) parts.push(`remove ${added} added line${added === 1 ? '' : 's'}`);
    if (removed > 0) parts.push(`restore ${removed} removed line${removed === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(' and ') : 'revert this hunk';
  }

  const summary = $derived(describeDiscard(hunk));

  async function handleConfirm(): Promise<void> {
    if (!client || discarding) return;
    discarding = true;
    discardError = undefined;
    try {
      const result = await client.applyGitHunkAction(sessionId, {
        path,
        hunkIndex,
        action: 'discard',
      });
      if (result.outcome === 'error') {
        discardError = result.message;
        return;
      }
      onDiscarded();
      onClose();
    } catch (error) {
      // Same "a raw transport timeout is rephrased for a human, the node's
      // own errors are already written for one" convention
      // `ArchiveSessionDialog` documents; the real message still reaches a
      // developer via `console.warn`.
      console.warn('DiscardHunkDialog: applyGitHunkAction failed', error);
      const raw = error instanceof Error ? error.message : String(error);
      discardError = raw.includes('timed out waiting')
        ? 'Nothing answered in time. The node may be asleep, offline, or on an older relay. Nothing was discarded.'
        : raw;
    } finally {
      discarding = false;
    }
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="discard-hunk-context" data-testid="discard-hunk-context">
    Discard the uncommitted change at line {hunk.newStart} in <strong>{path}</strong>? This will {summary}.
    This cannot be undone.
  </p>

  {#if discardError}
    <ErrorNotice message={discardError} />
  {/if}

  <div class="actions">
    <Button variant="secondary" onclick={handleClose}>Cancel</Button>
    <Button
      variant="danger"
      loading={discarding}
      onclick={handleConfirm}
      dataTestId="discard-hunk-confirm"
    >
      Discard hunk
    </Button>
  </div>
{/snippet}

<Dialog {open} label="Discard hunk" onClose={handleClose} size="sm" children={dialogBody}>
  {#snippet header()}
    <h2>Discard hunk</h2>
  {/snippet}
</Dialog>

<style>
  .discard-hunk-context {
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
