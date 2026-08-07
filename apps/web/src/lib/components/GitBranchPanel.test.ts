// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GitBranchCreateResponsePayloadV1,
  GitBranchListResponsePayloadV1,
  GitBranchMergeAbortResponsePayloadV1,
  GitBranchMergeResponsePayloadV1,
  GitBranchSwitchResponsePayloadV1,
  GitPushResponsePayloadV1,
  GitStashDropResponsePayloadV1,
  GitStashListResponsePayloadV1,
  GitStashPopResponsePayloadV1,
  GitStashSaveResponsePayloadV1,
} from '@loombox/protocol';
import GitBranchPanel, { type GitBranchPanelClient } from './GitBranchPanel.svelte';

afterEach(() => cleanup());

/** A fully-stubbed `GitBranchPanelClient`, every method resolving a harmless default so mounting the panel (which fires `requestBranches`/`requestStashes` immediately) never leaves an unhandled rejection — a test overrides only the calls it actually exercises. */
function fakeClient(overrides: Partial<GitBranchPanelClient> = {}): GitBranchPanelClient {
  return {
    requestBranches: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branches: [],
    } satisfies GitBranchListResponsePayloadV1),
    createBranch: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'unused',
      checkedOut: false,
    } satisfies GitBranchCreateResponsePayloadV1),
    switchBranch: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'unused',
    } satisfies GitBranchSwitchResponsePayloadV1),
    mergeBranch: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'unused',
      fastForward: true,
    } satisfies GitBranchMergeResponsePayloadV1),
    abortBranchMerge: vi
      .fn()
      .mockResolvedValue({ outcome: 'ok' } satisfies GitBranchMergeAbortResponsePayloadV1),
    pushBranch: vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'unused',
      setUpstream: false,
      forced: false,
    } satisfies GitPushResponsePayloadV1),
    saveStash: vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', created: true } satisfies GitStashSaveResponsePayloadV1),
    requestStashes: vi.fn().mockResolvedValue({
      outcome: 'ok',
      stashes: [],
    } satisfies GitStashListResponsePayloadV1),
    popStash: vi.fn().mockResolvedValue({ outcome: 'ok' } satisfies GitStashPopResponsePayloadV1),
    dropStash: vi.fn().mockResolvedValue({ outcome: 'ok' } satisfies GitStashDropResponsePayloadV1),
    ...overrides,
  };
}

describe('GitBranchPanel: branches (SPEC §7.6; issue #234)', () => {
  it('loads and renders branches on mount, tagging the current one and omitting a Switch button for it', async () => {
    const client = fakeClient({
      requestBranches: vi.fn().mockResolvedValue({
        outcome: 'ok',
        branches: [
          { name: 'main', current: true },
          { name: 'feature', current: false },
        ],
      } satisfies GitBranchListResponsePayloadV1),
    });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });

    const rows = await screen.findAllByTestId('git-branch-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('main')).toBeTruthy();
    expect(within(rows[0]!).getByText('current')).toBeTruthy();
    expect(within(rows[0]!).queryByTestId('git-branch-switch-main')).toBeNull();
    expect(within(rows[1]!).getByTestId('git-branch-switch-feature')).toBeTruthy();
  });

  it('shows a loading indicator, then an error notice with Retry when requestBranches reports outcome: error', async () => {
    const client = fakeClient({
      requestBranches: vi
        .fn()
        .mockResolvedValue({ outcome: 'error', message: 'git is not available' }),
    });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });

    expect(await screen.findByText('git is not available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('switching to a branch calls switchBranch and reloads the list on success', async () => {
    const requestBranches = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'ok',
        branches: [
          { name: 'main', current: true },
          { name: 'feature', current: false },
        ],
      } satisfies GitBranchListResponsePayloadV1)
      .mockResolvedValue({
        outcome: 'ok',
        branches: [
          { name: 'main', current: false },
          { name: 'feature', current: true },
        ],
      } satisfies GitBranchListResponsePayloadV1);
    const switchBranch = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'feature',
    } satisfies GitBranchSwitchResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ requestBranches, switchBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });

    await fireEvent.click(await screen.findByTestId('git-branch-switch-feature'));

    expect(switchBranch).toHaveBeenCalledWith('sess-1', { name: 'feature' });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requestBranches).toHaveBeenCalledTimes(2);
  });

  it('renders the real conflicting paths for a dirty_worktree switch outcome, and never fires onChanged', async () => {
    const switchBranch = vi.fn().mockResolvedValue({
      outcome: 'dirty_worktree',
      message: 'switching to "feature" would overwrite local changes',
      paths: ['src/f.ts'],
    } satisfies GitBranchSwitchResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({
      requestBranches: vi.fn().mockResolvedValue({
        outcome: 'ok',
        branches: [{ name: 'feature', current: false }],
      } satisfies GitBranchListResponsePayloadV1),
      switchBranch,
    });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });

    await fireEvent.click(await screen.findByTestId('git-branch-switch-feature'));

    const banner = await screen.findByTestId('git-branch-dirty-worktree');
    expect(within(banner).getByText('src/f.ts')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('renders a fixed-branch message for a worktree-isolated session, without pretending the switch happened', async () => {
    const switchBranch = vi.fn().mockResolvedValue({
      outcome: 'session_branch_fixed',
      message: 'this session\'s worktree is fixed to "loombox/session-1" for its whole life',
    } satisfies GitBranchSwitchResponsePayloadV1);
    const client = fakeClient({
      requestBranches: vi.fn().mockResolvedValue({
        outcome: 'ok',
        branches: [{ name: 'main', current: false }],
      } satisfies GitBranchListResponsePayloadV1),
      switchBranch,
    });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });

    await fireEvent.click(await screen.findByTestId('git-branch-switch-main'));

    const banner = await screen.findByTestId('git-branch-session-fixed');
    expect(banner.textContent).toContain('fixed to "loombox/session-1"');
  });

  it('creates a branch with the checkout toggle, clears the input, and reloads on success', async () => {
    const createBranch = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'new-work',
      checkedOut: true,
    } satisfies GitBranchCreateResponsePayloadV1);
    const requestBranches = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branches: [],
    } satisfies GitBranchListResponsePayloadV1);
    const client = fakeClient({ createBranch, requestBranches });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    const input = screen.getByTestId('git-branch-create-name') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'new-work' } });
    await fireEvent.click(screen.getByTestId('git-branch-create-submit'));

    expect(createBranch).toHaveBeenCalledWith('sess-1', { name: 'new-work', checkout: true });
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(requestBranches).toHaveBeenCalledTimes(2);
  });

  it('shows the real message for an already_exists outcome', async () => {
    const createBranch = vi
      .fn()
      .mockResolvedValue({ outcome: 'already_exists', message: 'branch "dupe" already exists' });
    const client = fakeClient({ createBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.input(screen.getByTestId('git-branch-create-name'), {
      target: { value: 'dupe' },
    });
    await fireEvent.click(screen.getByTestId('git-branch-create-submit'));

    expect(await screen.findByText('branch "dupe" already exists')).toBeTruthy();
  });
});

describe('GitBranchPanel: merge (SPEC §7.6; issue #234)', () => {
  it('merges a branch and reloads on success', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'main',
      fastForward: false,
    } satisfies GitBranchMergeResponsePayloadV1);
    const requestBranches = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branches: [],
    } satisfies GitBranchListResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ mergeBranch, requestBranches });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.input(screen.getByTestId('git-branch-merge-name'), {
      target: { value: 'feature' },
    });
    await fireEvent.click(screen.getByTestId('git-branch-merge-submit'));

    expect(mergeBranch).toHaveBeenCalledWith('sess-1', { name: 'feature' });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requestBranches).toHaveBeenCalledTimes(2);
  });

  it('a conflict outcome renders the real conflicted files and an Abort merge action — resolve or abort, never a silent failure', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      message: 'merging "feature" produced conflicts',
      conflictedPaths: ['src/a.ts', 'src/b.ts'],
    } satisfies GitBranchMergeResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ mergeBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.input(screen.getByTestId('git-branch-merge-name'), {
      target: { value: 'feature' },
    });
    await fireEvent.click(screen.getByTestId('git-branch-merge-submit'));

    const banner = await screen.findByTestId('git-branch-merge-conflict');
    expect(within(banner).getByText('src/a.ts')).toBeTruthy();
    expect(within(banner).getByText('src/b.ts')).toBeTruthy();
    expect(within(banner).getByTestId('git-branch-merge-abort')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Abort merge clears the conflict banner and reloads', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      message: 'merging "feature" produced conflicts',
      conflictedPaths: ['src/a.ts'],
    } satisfies GitBranchMergeResponsePayloadV1);
    const abortBranchMerge = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok' } satisfies GitBranchMergeAbortResponsePayloadV1);
    const requestBranches = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branches: [],
    } satisfies GitBranchListResponsePayloadV1);
    const client = fakeClient({ mergeBranch, abortBranchMerge, requestBranches });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.input(screen.getByTestId('git-branch-merge-name'), {
      target: { value: 'feature' },
    });
    await fireEvent.click(screen.getByTestId('git-branch-merge-submit'));
    await fireEvent.click(await screen.findByTestId('git-branch-merge-abort'));

    expect(abortBranchMerge).toHaveBeenCalledWith('sess-1');
    await vi.waitFor(() => expect(screen.queryByTestId('git-branch-merge-conflict')).toBeNull());
    expect(requestBranches).toHaveBeenCalledTimes(2);
  });
});

describe('GitBranchPanel: stash (SPEC §7.6; issue #234)', () => {
  it('renders "No stashed changes" for an empty stash stack', async () => {
    const client = fakeClient();
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    expect(await screen.findByTestId('git-stash-empty')).toBeTruthy();
  });

  it('saves a stash, clears the message, reloads, and fires onChanged when created', async () => {
    const saveStash = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', created: true } satisfies GitStashSaveResponsePayloadV1);
    const requestStashes = vi.fn().mockResolvedValue({
      outcome: 'ok',
      stashes: [{ index: 0, message: 'On main: wip' }],
    } satisfies GitStashListResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ saveStash, requestStashes });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });
    await screen.findByTestId('git-stash-list-loading');

    const input = screen.getByTestId('git-stash-message') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'wip' } });
    await fireEvent.click(screen.getByTestId('git-stash-save-submit'));

    expect(saveStash).toHaveBeenCalledWith('sess-1', { message: 'wip' });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('');
    expect(await screen.findByText('On main: wip')).toBeTruthy();
  });

  it('reports created: false as a plain note, never onChanged, when there was nothing to stash', async () => {
    const saveStash = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', created: false } satisfies GitStashSaveResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ saveStash });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });
    await screen.findByTestId('git-stash-empty');

    await fireEvent.click(screen.getByTestId('git-stash-save-submit'));

    expect(await screen.findByTestId('git-stash-nothing-to-save')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('pops a stash and reloads on success', async () => {
    const popStash = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok' } satisfies GitStashPopResponsePayloadV1);
    const requestStashes = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'ok',
        stashes: [{ index: 0, message: 'On main: wip' }],
      } satisfies GitStashListResponsePayloadV1)
      .mockResolvedValue({ outcome: 'ok', stashes: [] } satisfies GitStashListResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ popStash, requestStashes });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });

    await fireEvent.click(await screen.findByTestId('git-stash-pop-0'));

    expect(popStash).toHaveBeenCalledWith('sess-1', { index: 0 });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requestStashes).toHaveBeenCalledTimes(2);
  });

  it('a stash that cannot pop renders a conflict banner noting the stash was kept, and never fires onChanged', async () => {
    const popStash = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      message: 'popping "stash@{0}" produced conflicts',
      conflictedPaths: ['src/f.ts'],
      stashKept: true,
    } satisfies GitStashPopResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({
      requestStashes: vi.fn().mockResolvedValue({
        outcome: 'ok',
        stashes: [{ index: 0, message: 'On main: wip' }],
      } satisfies GitStashListResponsePayloadV1),
      popStash,
    });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });

    await fireEvent.click(await screen.findByTestId('git-stash-pop-0'));

    const banner = await screen.findByTestId('git-stash-pop-conflict');
    expect(within(banner).getByText('src/f.ts')).toBeTruthy();
    expect(within(banner).getByText(/stash was kept/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('drops a stash, clearing a matching pop-conflict banner, and reloads', async () => {
    const popStash = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      message: 'popping "stash@{0}" produced conflicts',
      conflictedPaths: ['src/f.ts'],
      stashKept: true,
    } satisfies GitStashPopResponsePayloadV1);
    const dropStash = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok' } satisfies GitStashDropResponsePayloadV1);
    const requestStashes = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'ok',
        stashes: [{ index: 0, message: 'On main: wip' }],
      } satisfies GitStashListResponsePayloadV1)
      .mockResolvedValue({ outcome: 'ok', stashes: [] } satisfies GitStashListResponsePayloadV1);
    const client = fakeClient({ popStash, dropStash, requestStashes });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });

    await fireEvent.click(await screen.findByTestId('git-stash-pop-0'));
    await screen.findByTestId('git-stash-pop-conflict');
    await fireEvent.click(screen.getByTestId('git-stash-drop-0'));

    expect(dropStash).toHaveBeenCalledWith('sess-1', { index: 0 });
    await vi.waitFor(() => expect(requestStashes).toHaveBeenCalledTimes(2));
  });
});

describe('GitBranchPanel: push (SPEC §7.6/§7.14; issue #235)', () => {
  it('pushes and renders the ok outcome, noting upstream tracking on a first push — never fires onChanged (a push changes the remote, not this worktree)', async () => {
    const pushBranch = vi.fn().mockResolvedValue({
      outcome: 'ok',
      branch: 'feature',
      setUpstream: true,
      forced: false,
    } satisfies GitPushResponsePayloadV1);
    const onChanged = vi.fn();
    const client = fakeClient({ pushBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client, onChanged } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.click(screen.getByTestId('git-branch-push-submit'));

    expect(pushBranch).toHaveBeenCalledWith('sess-1', { force: false });
    const success = await screen.findByTestId('git-branch-push-success');
    expect(success.textContent).toContain('origin/feature');
    expect(success.textContent).toContain('upstream tracking set');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a rejected_non_fast_forward outcome renders the real message and a Push (force) action, distinct from a generic failure', async () => {
    const pushBranch = vi.fn().mockResolvedValue({
      outcome: 'rejected_non_fast_forward',
      message: 'origin/feature has commits this branch does not have',
    } satisfies GitPushResponsePayloadV1);
    const client = fakeClient({ pushBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.click(screen.getByTestId('git-branch-push-submit'));

    const banner = await screen.findByTestId('git-branch-push-rejected');
    expect(
      within(banner).getByText('origin/feature has commits this branch does not have'),
    ).toBeTruthy();
    expect(within(banner).getByTestId('git-branch-push-force')).toBeTruthy();
  });

  it('a rejected_stale_lease outcome explains the stale lease distinctly from an ordinary rejection, and Push (force) retries with force: true', async () => {
    const pushBranch = vi.fn().mockResolvedValue({
      outcome: 'rejected_stale_lease',
      message: "this worktree's view of origin/feature is stale",
    } satisfies GitPushResponsePayloadV1);
    const client = fakeClient({ pushBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.click(screen.getByTestId('git-branch-push-submit'));
    const banner = await screen.findByTestId('git-branch-push-rejected');
    expect(within(banner).getByText(/out of date/)).toBeTruthy();

    await fireEvent.click(within(banner).getByTestId('git-branch-push-force'));

    expect(pushBranch).toHaveBeenLastCalledWith('sess-1', { force: true });
  });

  it('a no_branch outcome (detached HEAD) is reported distinctly, never as a generic error', async () => {
    const pushBranch = vi.fn().mockResolvedValue({
      outcome: 'no_branch',
      message: 'This session has no named branch to push (detached HEAD, or not a git repository).',
    } satisfies GitPushResponsePayloadV1);
    const client = fakeClient({ pushBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.click(screen.getByTestId('git-branch-push-submit'));

    expect(
      await screen.findByText(
        'This session has no named branch to push (detached HEAD, or not a git repository).',
      ),
    ).toBeTruthy();
  });

  it('an auth_failed outcome is reported distinctly from a generic error', async () => {
    const pushBranch = vi.fn().mockResolvedValue({
      outcome: 'auth_failed',
      message: 'git push could not authenticate with the remote: Permission denied (publickey).',
    } satisfies GitPushResponsePayloadV1);
    const client = fakeClient({ pushBranch });
    render(GitBranchPanel, { props: { sessionId: 'sess-1', client } });
    await screen.findByTestId('git-branch-list');

    await fireEvent.click(screen.getByTestId('git-branch-push-submit'));

    expect(await screen.findByText(/could not authenticate with the remote/)).toBeTruthy();
  });
});
