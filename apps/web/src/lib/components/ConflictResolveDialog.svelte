<script lang="ts">
  /**
   * AI-assisted merge-conflict resolution's own review-and-apply dialog
   * (SPEC §7.6; issue #237) — `GitBranchPanel`'s `mergeConflict` banner's
   * "Resolve with AI" entry point, one dialog per conflicted path.
   * Two-phase, mirroring `CommitDialog`'s own "load an AI-generated draft
   * the moment the dialog opens, only an explicit click acts" split (that
   * file's own doc comment) — except here the auto-loaded step is a
   * `git_conflict_resolve_request` proposal, not a commit message, and
   * there are two more honest outcomes than `CommitDialog` ever has to
   * render (`'too_large'`, and a write-time `'conflict'` — see below).
   *
   * The design question this whole file exists to answer (Lorenzo's own
   * framing, issue #237): a proposal must be reviewable before it is
   * applied, and it must be obvious which side each decision came from.
   * So every hunk renders its own real `oursLabel`/`theirsLabel` markers
   * text ALONGSIDE a `Badge` naming the derived `origin` — never just the
   * assembled result. The one `TextArea` below that per-hunk breakdown is
   * the actual apply payload (`draft`, pre-filled from
   * `resolvedContent`, editable exactly like `FileEditor`'s own edit
   * mode) — a single free-text editor, not a rich per-hunk one (SPEC
   * §11's "not a full IDE" boundary, `FileEditor`'s own precedent).
   *
   * Applying is ONE deliberate action: `onApply` (real `writeFile` call
   * owned by the caller, `DiscardHunkDialog`'s "the surface that
   * triggers a real relay call owns that call" convention) with the
   * proposal's own `baseHash` — issue #205's conflict-safe write, reused
   * rather than reinvented. A write that lands after the file changed
   * underneath (another device, a human editing on disk, or the
   * session's own agent mid-turn — issue #260's contract, the same one
   * `FileEditor`'s doc comment documents) comes back `outcome:
   * 'conflict'`; this dialog never retries on its own, it shows what is
   * actually on disk now and requires an explicit "Reload proposal"
   * click (a fresh `git_conflict_resolve_request`) before applying
   * again. Declining is simply closing without ever calling `onApply` —
   * nothing has been written by the propose step, so the file is exactly
   * as it was.
   */
  import type {
    FsWriteResponsePayloadV1,
    GitConflictHunkOriginV1,
    GitConflictHunkV1,
    GitConflictResolutionHunkV1,
    GitConflictResolveResponsePayloadV1,
  } from '@loombox/protocol';
  import Badge, { type BadgeTone } from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import TextArea from './ui/TextArea.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import { loadErrorMessage, writeErrorMessage } from '$lib/async-panel';

  /** The two calls this dialog needs off `RelayClient` — see the file doc comment's DI note, mirrors `CommitDialogClient`. */
  export interface ConflictResolveDialogClient {
    requestGitConflictResolve(
      sessionId: string,
      params: { path: string },
    ): Promise<GitConflictResolveResponsePayloadV1>;
    writeFile(
      sessionId: string,
      params: { path: string; content: string; baseHash: string | null },
    ): Promise<FsWriteResponsePayloadV1>;
  }

  interface Props {
    open: boolean;
    sessionId: string;
    /** The conflicted file to propose a resolution for. */
    path: string;
    client: ConflictResolveDialogClient | undefined;
    onClose: () => void;
    /** Fired after a successful apply, before `onClose` — the caller re-fetches its own merge/branch state, mirroring `GitBranchPanel`'s own `onChanged` contract. */
    onApplied: () => void;
  }

  const { open, sessionId, path, client, onClose, onApplied }: Props = $props();

  type ProposalState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'too_large'; message: string; hunkCount: number; maxHunks: number }
    | {
        status: 'loaded';
        hunks: GitConflictHunkV1[];
        resolution: GitConflictResolutionHunkV1[];
        baseHash: string;
      };

  let proposal = $state<ProposalState>({ status: 'loading' });
  let draft = $state('');
  let applying = $state(false);
  let applyError = $state<string | undefined>(undefined);
  let applied = $state(false);
  /** `undefined`: no write-time conflict yet. `null`: the file was deleted underneath the last apply attempt. Otherwise what's actually on disk now (`fsWriteConflictV1`'s own `current`) — same shape `FileEditor`'s identical `conflict` state uses. */
  let writeConflict = $state<
    { content: string; hash: string; truncated: boolean } | null | undefined
  >(undefined);

  async function loadProposal(
    currentSessionId: string,
    currentPath: string,
    currentClient: ConflictResolveDialogClient,
  ): Promise<void> {
    proposal = { status: 'loading' };
    applyError = undefined;
    writeConflict = undefined;
    try {
      const result = await currentClient.requestGitConflictResolve(currentSessionId, {
        path: currentPath,
      });
      if (result.outcome === 'ok') {
        proposal = {
          status: 'loaded',
          hunks: result.hunks,
          resolution: result.resolution,
          baseHash: result.baseHash,
        };
        draft = result.resolvedContent;
      } else if (result.outcome === 'too_large') {
        proposal = {
          status: 'too_large',
          message: result.message,
          hunkCount: result.hunkCount,
          maxHunks: result.maxHunks,
        };
      } else {
        proposal = { status: 'error', message: result.message };
      }
    } catch (err) {
      proposal = { status: 'error', message: loadErrorMessage('The conflict proposal', err) };
    }
  }

  // Resets every time the dialog opens for a (possibly different)
  // session/path, same "open is this effect's only reactive read"
  // convention `CommitDialog`/`PrOpenDialog`/`ArchiveSessionDialog`
  // already use.
  $effect(() => {
    if (!open) return;
    proposal = { status: 'loading' };
    draft = '';
    applying = false;
    applyError = undefined;
    applied = false;
    writeConflict = undefined;
    if (client) void loadProposal(sessionId, path, client);
  });

  function retryLoad(): void {
    if (client) void loadProposal(sessionId, path, client);
  }

  async function confirmApply(): Promise<void> {
    if (!client || applying || proposal.status !== 'loaded') return;
    applying = true;
    applyError = undefined;
    writeConflict = undefined;
    try {
      const result = await client.writeFile(sessionId, {
        path,
        content: draft,
        baseHash: proposal.baseHash,
      });
      if (result.outcome === 'ok') {
        applied = true;
        onApplied();
        return;
      }
      if (result.outcome === 'conflict') {
        writeConflict = result.current;
        return;
      }
      applyError = result.message;
    } catch (err) {
      applyError = writeErrorMessage('applied', err);
    } finally {
      applying = false;
    }
  }

  function decline(): void {
    onClose();
  }

  const originTone: Record<GitConflictHunkOriginV1, BadgeTone> = {
    ours: 'neutral',
    theirs: 'info',
    rewritten: 'warning',
  };

  const originLabel: Record<GitConflictHunkOriginV1, string> = {
    ours: 'kept ours',
    theirs: 'kept theirs',
    rewritten: 'rewritten',
  };
</script>

{#snippet dialogBody()}
  {#if applied}
    <p class="conflict-resolve-result" data-testid="conflict-resolve-applied">
      Applied — the resolution for <code>{path}</code> was written. Commit or continue merging once every
      conflicted file is resolved.
    </p>
    <div class="conflict-resolve-actions">
      <Button onclick={onClose} dataTestId="conflict-resolve-done">Done</Button>
    </div>
  {:else if proposal.status === 'loading'}
    <div class="conflict-resolve-loading" data-testid="conflict-resolve-loading">
      <WovenLoader size="sm" label={`Asking the agent to resolve ${path}`} />
    </div>
  {:else if proposal.status === 'error'}
    <ErrorNotice message={proposal.message} retryable onRetry={retryLoad} />
    <div class="conflict-resolve-actions">
      <Button variant="secondary" onclick={decline} dataTestId="conflict-resolve-decline"
        >Close</Button
      >
    </div>
  {:else if proposal.status === 'too_large'}
    <div class="conflict-resolve-too-large" data-testid="conflict-resolve-too-large">
      <p>{proposal.message}</p>
      <p>
        {proposal.hunkCount} conflicted hunks in this file, over the {proposal.maxHunks}-hunk bound
        for one AI resolve. Resolve some by hand (the file tree/editor or a terminal), then reopen
        this dialog.
      </p>
    </div>
    <div class="conflict-resolve-actions">
      <Button variant="secondary" onclick={decline} dataTestId="conflict-resolve-decline"
        >Close</Button
      >
    </div>
  {:else}
    <ul class="conflict-resolve-hunks" data-testid="conflict-resolve-hunks">
      {#each proposal.hunks as hunk (hunk.index)}
        {@const resolved = proposal.resolution.find((r) => r.index === hunk.index)}
        <li class="conflict-resolve-hunk" data-testid="conflict-resolve-hunk">
          <div class="conflict-resolve-hunk-header">
            <span>Hunk {hunk.index + 1} of {proposal.hunks.length}</span>
            {#if resolved}
              <Badge tone={originTone[resolved.origin]} dataTestId="conflict-resolve-origin">
                {originLabel[resolved.origin]}
              </Badge>
            {/if}
          </div>
          <div class="conflict-resolve-side">
            <span class="conflict-resolve-side-label">"{hunk.oursLabel}" (ours)</span>
            <pre class="conflict-resolve-side-text font-mono">{hunk.oursText}</pre>
          </div>
          <div class="conflict-resolve-side">
            <span class="conflict-resolve-side-label">"{hunk.theirsLabel}" (theirs)</span>
            <pre class="conflict-resolve-side-text font-mono">{hunk.theirsText}</pre>
          </div>
        </li>
      {/each}
    </ul>

    <label class="conflict-resolve-draft-label" for="conflict-resolve-draft">
      Proposed resolution for {path} — review and edit before applying
    </label>
    <TextArea
      id="conflict-resolve-draft"
      bind:value={draft}
      monospace
      rows={10}
      dataTestId="conflict-resolve-draft"
    />

    {#if applyError}
      <ErrorNotice message={`Could not apply: ${applyError}`} />
    {/if}
    {#if writeConflict !== undefined}
      <div class="conflict-resolve-write-conflict" data-testid="conflict-resolve-write-conflict">
        <p>
          {path} changed on disk since this proposal was computed
          {writeConflict === null ? ' (it was deleted).' : '.'}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onclick={retryLoad}
          dataTestId="conflict-resolve-reload">Reload proposal</Button
        >
      </div>
    {/if}

    <div class="conflict-resolve-actions">
      <Button variant="secondary" onclick={decline} dataTestId="conflict-resolve-decline"
        >Decline</Button
      >
      <Button
        variant="primary"
        loading={applying}
        onclick={confirmApply}
        dataTestId="conflict-resolve-apply"
      >
        Apply
      </Button>
    </div>
  {/if}
{/snippet}

<Dialog
  {open}
  label={`Resolve conflict: ${path}`}
  onClose={decline}
  size="lg"
  children={dialogBody}
>
  {#snippet header()}
    <h2>Resolve conflict</h2>
    <p class="conflict-resolve-path font-mono">{path}</p>
  {/snippet}
</Dialog>

<style>
  .conflict-resolve-path {
    margin: 0;
    color: var(--color-text-secondary);
    /* A long path never forces the dialog header wider than its own
       panel (`Dialog`'s own `width: min(40rem, 100%)` at size="lg") —
       the 390px floor every dialog in this codebase already proves. */
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .conflict-resolve-result {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .conflict-resolve-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-xl) 0;
  }

  .conflict-resolve-too-large p {
    margin: 0 0 var(--space-sm) 0;
  }

  .conflict-resolve-hunks {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    margin: 0;
    padding: 0;
    list-style: none;
    /* A dialog body can only ever be as tall as the viewport allows
       (`Dialog`'s own `.dialog-body { overflow-y: auto }`) — several
       hunks get their own scroll region rather than pushing the
       textarea/actions below off-panel on a short 390×844 phone. */
    max-height: 40vh;
    overflow-y: auto;
  }

  .conflict-resolve-hunk {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    padding: var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
  }

  .conflict-resolve-hunk-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .conflict-resolve-side {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    /* Long/unbroken code never forces the whole dialog (or page) wider
       than the 390px viewport — this box scrolls its OWN horizontal
       overflow instead, the exact discipline `DiffViewer.svelte`'s
       `.diff-lines` already proves at that width. */
    min-width: 0;
    max-width: 100%;
  }

  .conflict-resolve-side-label {
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .conflict-resolve-side-text {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-sm);
    background: var(--color-surface-raised);
    white-space: pre;
    overflow-x: auto;
    max-width: 100%;
  }

  .conflict-resolve-draft-label {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .conflict-resolve-write-conflict {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
  }

  .conflict-resolve-write-conflict p {
    margin: 0;
  }

  .conflict-resolve-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }
</style>
