<script lang="ts">
  /**
   * The row-menu "Archive session…" confirm step (SPEC §7.2's board
   * archive affordance; issue #512) — the first control that ever removes
   * a session from the board, so it is deliberately a confirm step rather
   * than `removeProject`'s immediate one-tap action: unlike that (which
   * only ever forgets a local registry entry), this can also delete real
   * git state with no undo — the session's isolated worktree and its
   * `loombox/session-<id>` branch.
   *
   * `session.worktree` (decrypted private meta, `@loombox/protocol`'s
   * `sessionPrivateMetaV1.worktree`) decides which confirmation copy
   * renders: `undefined`/`true` means an isolated worktree (offers the
   * "also delete" checkbox, checked by default — the cleanup #512 is
   * mostly about, since forgetting it is how a repo accumulates one
   * worktree per session forever); `false` means the session runs
   * directly in the project folder, where there is nothing of the
   * project's own to remove, so the checkbox is replaced with a plain
   * statement instead of a control that would do nothing either way.
   *
   * Calls `client.archiveSession` itself and owns its own loading/error
   * state, mirroring `NewSessionDialog`'s own create/error/loading shape
   * rather than reporting a raw checkbox value up for `+page.svelte` to
   * act on — the same "the dialog that triggers a real relay call owns
   * that call" convention `AddTargetWizard`'s decommission/provision calls
   * already follow.
   */
  import type { ClientSessionMeta } from '$lib/relay-client';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  export interface ArchiveSessionClient {
    archiveSession: (sessionId: string, options: { removeWorktree: boolean }) => Promise<void>;
  }

  interface Props {
    open: boolean;
    session: ClientSessionMeta;
    client: ArchiveSessionClient | undefined;
    onClose: () => void;
  }

  const { open, session, client, onClose }: Props = $props();

  /**
   * Absent means the node's own per-target default applies, which is
   * isolate (see `sessionPrivateMetaV1.worktree`'s own doc comment) — so
   * only an explicit `false` means "runs in place", never `undefined`.
   */
  const isIsolatedWorktree = $derived(session.worktree !== false);

  let removeWorktree = $state(true);
  let archiving = $state(false);
  let archiveError = $state<string | undefined>(undefined);

  // Resets every time the dialog opens for a (possibly different) session,
  // same "open is this effect's only reactive read" convention
  // `AddProjectDialog`/`NewSessionDialog` already use.
  $effect(() => {
    if (!open) return;
    removeWorktree = true;
    archiving = false;
    archiveError = undefined;
  });

  async function handleConfirm(): Promise<void> {
    if (!client || archiving) return;
    archiving = true;
    archiveError = undefined;
    try {
      await client.archiveSession(session.id, {
        // Never sent as true for an in-place session — there is no
        // worktree of its own to remove, and the checkbox offering it is
        // hidden (see the file doc comment above).
        removeWorktree: isIsolatedWorktree && removeWorktree,
      });
      onClose();
    } catch (error) {
      // A timeout here means nothing answered at all, and its `Error#message`
      // is wire/internal phrasing written for a developer console
      // ("RelayClient: timed out waiting for session_archive_response"), not
      // for this screen — the same leak issue #505 fixed in
      // `DirectoryPicker`. A sleeping laptop, a dropped node, or a relay too
      // old to route this are all ordinary causes, and none of them are the
      // user's fault or their vocabulary. The node's own errors (git refusing
      // to remove a worktree, say) are written for a human already, so those
      // are shown verbatim; only the transport timeout gets rephrased. The
      // real message still reaches a developer via `console.warn`.
      console.warn('ArchiveSessionDialog: archiveSession failed', error);
      const raw = error instanceof Error ? error.message : String(error);
      archiveError = raw.includes('timed out waiting')
        ? 'Nothing answered in time. The node may be asleep, offline, or on an older relay. Nothing was archived.'
        : raw;
    } finally {
      archiving = false;
    }
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="archive-context" data-testid="archive-session-context">
    Archive <strong>{session.title}</strong> from
    <span class="font-mono">{session.projectPath}</span>? It drops off the board on every device.
  </p>

  {#if isIsolatedWorktree}
    <label class="archive-checkbox">
      <input
        type="checkbox"
        bind:checked={removeWorktree}
        data-testid="archive-session-remove-worktree"
      />
      Also delete its git worktree and branch
    </label>
  {:else}
    <p class="archive-inplace-note" data-testid="archive-session-inplace-note">
      This session runs directly in the project folder — archiving leaves it untouched.
    </p>
  {/if}

  {#if archiveError}
    <ErrorNotice message={archiveError} />
  {/if}

  <div class="actions">
    <Button variant="secondary" onclick={handleClose}>Cancel</Button>
    <Button
      variant="danger"
      loading={archiving}
      onclick={handleConfirm}
      dataTestId="archive-session-confirm"
    >
      Archive session
    </Button>
  </div>
{/snippet}

<Dialog {open} label="Archive session" onClose={handleClose} size="sm" children={dialogBody}>
  {#snippet header()}
    <h2>Archive session</h2>
  {/snippet}
</Dialog>

<style>
  .archive-context {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .archive-checkbox {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
  }

  .archive-inplace-note {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
