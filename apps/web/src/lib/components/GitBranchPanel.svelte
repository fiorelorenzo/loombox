<script lang="ts">
  /**
   * Branch create/switch/merge and stash save/pop (SPEC §7.6; issue
   * #234) — the client surface for `@loombox/protocol`'s `git-branch.ts`/
   * `git-stash.ts` wire pairs. Self-contained like `DiscardHunkDialog`
   * (this file's own doc comment: "the [surface] that triggers a real
   * relay call owns that call, and owns its own loading/error state"):
   * loads its own branch/stash lists on mount and re-loads them after
   * every mutating action, rather than a host page threading loaded
   * state and a dozen callback props through — nothing here needs
   * `WorktreeDiffViewer`'s "the host owns the fetch, the view is dumb"
   * shape, since a host page only ever needs to know "something
   * changed" ({@link Props.onChanged}), never the branch/stash lists
   * themselves.
   *
   * `client` is narrowed to the nine calls this panel needs (mirrors
   * `DiscardHunkDialog`/`ArchiveSessionDialog`/`PrOpenDialog`'s identical
   * DI pattern), satisfied structurally by the real `RelayClient` with no
   * adapter needed.
   *
   * Three failure modes get their own honest, actionable rendering
   * instead of a generic error line (issue #234's own acceptance bar):
   * - `switchBranch`/`createBranch`'s `'dirty_worktree'` outcome lists the
   *   real conflicting paths and points at the Stash section as the way
   *   forward.
   * - `switchBranch`/`createBranch`'s `'session_branch_fixed'` outcome
   *   (a worktree-isolated session can never switch its own fixed
   *   branch) explains why, rather than presenting as a bug.
   * - `mergeBranch`'s `'conflict'` outcome lists the real conflicted
   *   files and renders an "Abort merge" action — resolve (elsewhere:
   *   the file tree/editor, §7.4, or an integrated terminal, §7.5) or
   *   abort, this panel's own persistent banner until one of those
   *   happens. `popStash`'s `'conflict'` outcome mirrors it exactly,
   *   noting the stash itself was kept (nothing lost) and pointing at
   *   "Drop" as the way to conclude once resolved.
   */
  import type {
    GitBranchCreateResponsePayloadV1,
    GitBranchListResponsePayloadV1,
    GitBranchMergeAbortResponsePayloadV1,
    GitBranchMergeResponsePayloadV1,
    GitBranchSummaryV1,
    GitBranchSwitchResponsePayloadV1,
    GitStashDropResponsePayloadV1,
    GitStashListResponsePayloadV1,
    GitStashPopResponsePayloadV1,
    GitStashSaveResponsePayloadV1,
    GitStashSummaryV1,
  } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import WovenLoader from './WovenLoader.svelte';

  export interface GitBranchPanelClient {
    requestBranches(sessionId: string): Promise<GitBranchListResponsePayloadV1>;
    createBranch(
      sessionId: string,
      params: { name: string; startPoint?: string | null; checkout?: boolean },
    ): Promise<GitBranchCreateResponsePayloadV1>;
    switchBranch(
      sessionId: string,
      params: { name: string },
    ): Promise<GitBranchSwitchResponsePayloadV1>;
    mergeBranch(sessionId: string, params: { name: string }): Promise<GitBranchMergeResponsePayloadV1>;
    abortBranchMerge(sessionId: string): Promise<GitBranchMergeAbortResponsePayloadV1>;
    saveStash(
      sessionId: string,
      params: { message?: string | null },
    ): Promise<GitStashSaveResponsePayloadV1>;
    requestStashes(sessionId: string): Promise<GitStashListResponsePayloadV1>;
    popStash(sessionId: string, params?: { index?: number | null }): Promise<GitStashPopResponsePayloadV1>;
    dropStash(sessionId: string, params: { index: number }): Promise<GitStashDropResponsePayloadV1>;
  }

  interface Props {
    sessionId: string;
    client: GitBranchPanelClient | undefined;
    /** Fired after any action that actually changed branch/stash state (a successful create/switch/merge/merge-abort/stash-save/stash-pop/stash-drop) — a host page re-fetches its own worktree diff in response, mirroring `DiscardHunkDialog`'s own `onDiscarded` contract. Never fired for a rendered-but-inert outcome (`dirty_worktree`, `session_branch_fixed`, `conflict`, a `not_found`/`error`/`already_exists`). */
    onChanged?: () => void;
  }

  const { sessionId, client, onChanged }: Props = $props();

  type BranchesState =
    | { status: 'loading' }
    | { status: 'loaded'; branches: GitBranchSummaryV1[] }
    | { status: 'error'; message: string };
  type StashesState =
    | { status: 'loading' }
    | { status: 'loaded'; stashes: GitStashSummaryV1[] }
    | { status: 'error'; message: string };

  let branchesState = $state<BranchesState>({ status: 'loading' });
  let stashesState = $state<StashesState>({ status: 'loading' });

  let newBranchName = $state('');
  let newBranchCheckout = $state(true);
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  let switchingName = $state<string | undefined>(undefined);
  let switchError = $state<string | undefined>(undefined);
  let switchDirtyPaths = $state<string[] | undefined>(undefined);
  let switchFixedMessage = $state<string | undefined>(undefined);

  let mergeTarget = $state('');
  let merging = $state(false);
  let mergeError = $state<string | undefined>(undefined);
  let mergeConflict = $state<{ message: string; conflictedPaths: string[] } | undefined>(undefined);
  let aborting = $state(false);
  let abortError = $state<string | undefined>(undefined);

  let stashMessage = $state('');
  let stashing = $state(false);
  let stashError = $state<string | undefined>(undefined);
  let stashNothingToSave = $state(false);

  let poppingIndex = $state<number | undefined>(undefined);
  let popError = $state<string | undefined>(undefined);
  let popConflict = $state<
    { index: number; message: string; conflictedPaths: string[] } | undefined
  >(undefined);
  let droppingIndex = $state<number | undefined>(undefined);
  let dropError = $state<string | undefined>(undefined);

  async function loadBranches(): Promise<void> {
    if (!client) return;
    branchesState = { status: 'loading' };
    try {
      const result = await client.requestBranches(sessionId);
      branchesState =
        result.outcome === 'ok'
          ? { status: 'loaded', branches: result.branches }
          : { status: 'error', message: result.message };
    } catch (error) {
      branchesState = { status: 'error', message: errorMessage(error) };
    }
  }

  async function loadStashes(): Promise<void> {
    if (!client) return;
    stashesState = { status: 'loading' };
    try {
      const result = await client.requestStashes(sessionId);
      stashesState =
        result.outcome === 'ok'
          ? { status: 'loaded', stashes: result.stashes }
          : { status: 'error', message: result.message };
    } catch (error) {
      stashesState = { status: 'error', message: errorMessage(error) };
    }
  }

  function errorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.includes('timed out waiting')
      ? 'Nothing answered in time. The node may be asleep, offline, or on an older relay.'
      : raw;
  }

  // Loads once per session, mirroring `fileTreeFor`'s own lazy-once
  // load: `sessionId` is this effect's only reactive read, so switching
  // to a different session's panel re-loads for it.
  $effect(() => {
    void sessionId;
    void loadBranches();
    void loadStashes();
  });

  async function handleCreateBranch(): Promise<void> {
    if (!client || creating || !newBranchName.trim()) return;
    creating = true;
    createError = undefined;
    try {
      const result = await client.createBranch(sessionId, {
        name: newBranchName.trim(),
        checkout: newBranchCheckout,
      });
      if (result.outcome === 'ok') {
        newBranchName = '';
        await loadBranches();
        onChanged?.();
        return;
      }
      if (result.outcome === 'dirty_worktree') {
        switchDirtyPaths = result.paths;
        createError = result.message;
        await loadBranches(); // the branch itself was still created
        return;
      }
      createError = result.message;
    } catch (error) {
      createError = errorMessage(error);
    } finally {
      creating = false;
    }
  }

  async function handleSwitch(name: string): Promise<void> {
    if (!client || switchingName) return;
    switchingName = name;
    switchError = undefined;
    switchDirtyPaths = undefined;
    switchFixedMessage = undefined;
    try {
      const result = await client.switchBranch(sessionId, { name });
      if (result.outcome === 'ok') {
        await loadBranches();
        onChanged?.();
        return;
      }
      if (result.outcome === 'dirty_worktree') {
        switchDirtyPaths = result.paths;
        switchError = result.message;
        return;
      }
      if (result.outcome === 'session_branch_fixed') {
        switchFixedMessage = result.message;
        return;
      }
      switchError = result.message;
    } catch (error) {
      switchError = errorMessage(error);
    } finally {
      switchingName = undefined;
    }
  }

  async function handleMerge(): Promise<void> {
    if (!client || merging || !mergeTarget.trim()) return;
    merging = true;
    mergeError = undefined;
    try {
      const result = await client.mergeBranch(sessionId, { name: mergeTarget.trim() });
      if (result.outcome === 'ok') {
        mergeTarget = '';
        await loadBranches();
        onChanged?.();
        return;
      }
      if (result.outcome === 'conflict') {
        mergeConflict = { message: result.message, conflictedPaths: result.conflictedPaths };
        return;
      }
      mergeError = result.message;
    } catch (error) {
      mergeError = errorMessage(error);
    } finally {
      merging = false;
    }
  }

  async function handleAbortMerge(): Promise<void> {
    if (!client || aborting) return;
    aborting = true;
    abortError = undefined;
    try {
      const result = await client.abortBranchMerge(sessionId);
      if (result.outcome === 'ok') {
        mergeConflict = undefined;
        await loadBranches();
        onChanged?.();
        return;
      }
      abortError = result.message;
    } catch (error) {
      abortError = errorMessage(error);
    } finally {
      aborting = false;
    }
  }

  async function handleSaveStash(): Promise<void> {
    if (!client || stashing) return;
    stashing = true;
    stashError = undefined;
    stashNothingToSave = false;
    try {
      const result = await client.saveStash(sessionId, {
        message: stashMessage.trim() || null,
      });
      if (result.outcome === 'ok') {
        stashNothingToSave = !result.created;
        stashMessage = '';
        await loadStashes();
        if (result.created) onChanged?.();
        return;
      }
      stashError = result.message;
    } catch (error) {
      stashError = errorMessage(error);
    } finally {
      stashing = false;
    }
  }

  async function handlePop(index: number): Promise<void> {
    if (!client || poppingIndex !== undefined) return;
    poppingIndex = index;
    popError = undefined;
    try {
      const result = await client.popStash(sessionId, { index });
      if (result.outcome === 'ok') {
        popConflict = undefined;
        await loadStashes();
        onChanged?.();
        return;
      }
      if (result.outcome === 'conflict') {
        popConflict = {
          index,
          message: result.message,
          conflictedPaths: result.conflictedPaths,
        };
        return;
      }
      popError = result.message;
    } catch (error) {
      popError = errorMessage(error);
    } finally {
      poppingIndex = undefined;
    }
  }

  async function handleDrop(index: number): Promise<void> {
    if (!client || droppingIndex !== undefined) return;
    droppingIndex = index;
    dropError = undefined;
    try {
      const result = await client.dropStash(sessionId, { index });
      if (result.outcome === 'ok') {
        if (popConflict?.index === index) popConflict = undefined;
        await loadStashes();
        onChanged?.();
        return;
      }
      dropError = result.message;
    } catch (error) {
      dropError = errorMessage(error);
    } finally {
      droppingIndex = undefined;
    }
  }
</script>

<div class="git-branch-panel" data-testid="git-branch-panel">
  <Card elevation="raised" padding="md">
    <h3>Branches</h3>
    {#if branchesState.status === 'loading'}
      <div class="git-branch-loading" data-testid="git-branch-list-loading">
        <WovenLoader size="sm" label="Loading branches" />
      </div>
    {:else if branchesState.status === 'error'}
      <ErrorNotice message={branchesState.message} retryable onRetry={loadBranches} />
    {:else}
      <ul class="git-branch-list" data-testid="git-branch-list">
        {#each branchesState.branches as branch (branch.name)}
          <li class="git-branch-row" data-testid="git-branch-row">
            <span class="git-branch-name" class:git-branch-current={branch.current}>
              {branch.name}
              {#if branch.current}<span class="git-branch-current-tag">current</span>{/if}
            </span>
            {#if !branch.current}
              <Button
                variant="secondary"
                size="sm"
                loading={switchingName === branch.name}
                onclick={() => handleSwitch(branch.name)}
                dataTestId={`git-branch-switch-${branch.name}`}
              >
                Switch
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if switchError}
      <ErrorNotice message={switchError} class="git-branch-inline-error" />
    {/if}
    {#if switchDirtyPaths}
      <div class="git-branch-dirty" data-testid="git-branch-dirty-worktree">
        <p>Switching would overwrite local changes to:</p>
        <ul>
          {#each switchDirtyPaths as path (path)}
            <li>{path}</li>
          {/each}
        </ul>
        <p>Stash your changes below, then switch again.</p>
      </div>
    {/if}
    {#if switchFixedMessage}
      <div class="git-branch-fixed" data-testid="git-branch-session-fixed">
        <p>{switchFixedMessage}</p>
      </div>
    {/if}

    <div class="git-branch-create">
      <input
        type="text"
        placeholder="New branch name"
        bind:value={newBranchName}
        data-testid="git-branch-create-name"
      />
      <label class="git-branch-checkout-toggle">
        <input type="checkbox" bind:checked={newBranchCheckout} />
        Switch to it
      </label>
      <Button
        variant="primary"
        size="sm"
        loading={creating}
        disabled={!newBranchName.trim()}
        onclick={handleCreateBranch}
        dataTestId="git-branch-create-submit"
      >
        Create
      </Button>
    </div>
    {#if createError}
      <ErrorNotice message={createError} class="git-branch-inline-error" />
    {/if}

    <div class="git-branch-merge">
      <input
        type="text"
        placeholder="Branch to merge in"
        bind:value={mergeTarget}
        data-testid="git-branch-merge-name"
      />
      <Button
        variant="secondary"
        size="sm"
        loading={merging}
        disabled={!mergeTarget.trim()}
        onclick={handleMerge}
        dataTestId="git-branch-merge-submit"
      >
        Merge
      </Button>
    </div>
    {#if mergeError}
      <ErrorNotice message={mergeError} class="git-branch-inline-error" />
    {/if}
    {#if mergeConflict}
      <div class="git-branch-conflict" data-testid="git-branch-merge-conflict">
        <p>{mergeConflict.message}</p>
        <ul>
          {#each mergeConflict.conflictedPaths as path (path)}
            <li>{path}</li>
          {/each}
        </ul>
        <p>Resolve the conflicts (file tree, editor, or a terminal), then commit — or:</p>
        <Button
          variant="danger"
          size="sm"
          loading={aborting}
          onclick={handleAbortMerge}
          dataTestId="git-branch-merge-abort"
        >
          Abort merge
        </Button>
        {#if abortError}
          <ErrorNotice message={abortError} class="git-branch-inline-error" />
        {/if}
      </div>
    {/if}
  </Card>

  <Card elevation="raised" padding="md">
    <h3>Stash</h3>
    <div class="git-stash-save">
      <input
        type="text"
        placeholder="Stash message (optional)"
        bind:value={stashMessage}
        data-testid="git-stash-message"
      />
      <Button
        variant="secondary"
        size="sm"
        loading={stashing}
        onclick={handleSaveStash}
        dataTestId="git-stash-save-submit"
      >
        Stash changes
      </Button>
    </div>
    {#if stashError}
      <ErrorNotice message={stashError} class="git-branch-inline-error" />
    {/if}
    {#if stashNothingToSave}
      <p class="git-stash-empty-note" data-testid="git-stash-nothing-to-save">
        Nothing to stash — the worktree is already clean.
      </p>
    {/if}

    {#if stashesState.status === 'loading'}
      <div class="git-branch-loading" data-testid="git-stash-list-loading">
        <WovenLoader size="sm" label="Loading stashes" />
      </div>
    {:else if stashesState.status === 'error'}
      <ErrorNotice message={stashesState.message} retryable onRetry={loadStashes} />
    {:else if stashesState.stashes.length === 0}
      <p class="git-stash-empty-note" data-testid="git-stash-empty">No stashed changes.</p>
    {:else}
      <ul class="git-stash-list" data-testid="git-stash-list">
        {#each stashesState.stashes as stash (stash.index)}
          <li class="git-stash-row" data-testid="git-stash-row">
            <span class="git-stash-message">{stash.message}</span>
            <div class="git-stash-actions">
              <Button
                variant="secondary"
                size="sm"
                loading={poppingIndex === stash.index}
                onclick={() => handlePop(stash.index)}
                dataTestId={`git-stash-pop-${stash.index}`}
              >
                Pop
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={droppingIndex === stash.index}
                onclick={() => handleDrop(stash.index)}
                dataTestId={`git-stash-drop-${stash.index}`}
              >
                Drop
              </Button>
            </div>
            {#if popConflict?.index === stash.index}
              <div class="git-branch-conflict" data-testid="git-stash-pop-conflict">
                <p>{popConflict.message}</p>
                <ul>
                  {#each popConflict.conflictedPaths as path (path)}
                    <li>{path}</li>
                  {/each}
                </ul>
                <p>The stash was kept — nothing was lost. Resolve the conflicts, then Drop this entry, or discard the conflicted changes and try again.</p>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if popError}
      <ErrorNotice message={popError} class="git-branch-inline-error" />
    {/if}
    {#if dropError}
      <ErrorNotice message={dropError} class="git-branch-inline-error" />
    {/if}
  </Card>
</div>

<style>
  .git-branch-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  h3 {
    margin: 0 0 var(--space-sm) 0;
  }

  .git-branch-loading {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
  }

  .git-branch-list,
  .git-stash-list {
    list-style: none;
    margin: 0 0 var(--space-md) 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .git-branch-row,
  .git-stash-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    padding: var(--space-xs) 0;
  }

  .git-branch-current-tag {
    margin-left: var(--space-xs);
    font-size: 0.75em;
    color: var(--color-text-secondary);
  }

  .git-branch-create,
  .git-branch-merge,
  .git-stash-save {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }

  .git-branch-checkout-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: 0.875em;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  input[type='text'] {
    flex: 1;
    min-width: 0;
  }

  .git-branch-dirty,
  .git-branch-fixed,
  .git-branch-conflict {
    margin-top: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
  }

  .git-branch-fixed {
    background: var(--color-surface-raised);
    border-color: var(--color-border);
  }

  .git-branch-dirty ul,
  .git-branch-conflict ul {
    margin: var(--space-xs) 0;
    padding-left: var(--space-lg);
  }

  :global(.git-branch-inline-error) {
    margin-top: var(--space-sm);
  }

  .git-stash-empty-note {
    color: var(--color-text-secondary);
    margin: var(--space-sm) 0;
  }

  .git-stash-actions {
    display: flex;
    gap: var(--space-xs);
  }
</style>
