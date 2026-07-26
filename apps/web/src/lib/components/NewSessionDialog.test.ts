// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetFsListResponsePayloadV1 } from '@loombox/protocol';
import type { Project } from '$lib/projects';
import NewSessionDialog, { type NewSessionClient } from './NewSessionDialog.svelte';

afterEach(() => cleanup());

const PROJECT: Project = {
  id: 'proj_1',
  name: 'loombox',
  nodeId: 'node_1',
  targetId: 'local',
  path: '/home/dev/loombox',
  isGitRepo: true,
  createdAt: 0,
};

function fakeClient(overrides: Partial<NewSessionClient> = {}): NewSessionClient {
  return {
    createSession: vi.fn().mockResolvedValue('sess_new_1'),
    // Resolves the `isGitRepo` probe (issue #507) for tests that never
    // touch it directly: a project fixture with a known `isGitRepo`
    // never triggers a probe in the first place, so this default is only
    // ever exercised by the "probes when unknown" tests below.
    browseDirectory: vi.fn().mockResolvedValue({ outcome: 'ok', path: PROJECT.path, entries: [] }),
    ...overrides,
  };
}

async function fillPrompt(): Promise<void> {
  await fireEvent.input(screen.getByTestId('new-session-prompt'), {
    target: { value: 'get started' },
  });
}

describe('NewSessionDialog (issue #385; IA v4 project-inherited target/folder, design spec §3.4, issue #507)', () => {
  it('is not rendered while closed', () => {
    render(NewSessionDialog, {
      props: {
        open: false,
        project: PROJECT,
        client: fakeClient(),
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('shows the project name and path as a read-only context line, with no target or folder picker (those moved to AddProjectDialog)', () => {
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client: fakeClient(),
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });
    const context = screen.getByTestId('new-session-project-context');
    expect(context.textContent).toContain('loombox');
    expect(context.textContent).toContain('/home/dev/loombox');
    expect(screen.queryByTestId('target-picker')).toBeNull();
    expect(screen.queryByTestId('directory-picker')).toBeNull();
  });

  it('the submit button is disabled until a starting prompt is provided', async () => {
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client: fakeClient(),
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    const submit = screen.getByTestId('new-session-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await fillPrompt();
    expect(submit.disabled).toBe(false);
  });

  it("submitting calls client.createSession with the project's target/path, provider claude, the default isolated-worktree choice, and the prompt, then reports the new session and closes", async () => {
    const client = fakeClient();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(NewSessionDialog, {
      props: { open: true, project: PROJECT, client, onCreated, onClose },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1'));
    expect(client.createSession).toHaveBeenCalledWith({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/loombox',
      worktree: true,
      title: undefined,
      prompt: 'get started',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a createSession failure without closing the dialog', async () => {
    const client = fakeClient({
      createSession: vi.fn().mockRejectedValue(new Error('relay unreachable')),
    });
    const onClose = vi.fn();
    render(NewSessionDialog, {
      props: { open: true, project: PROJECT, client, onCreated: vi.fn(), onClose },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(screen.getByText('relay unreachable')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the woven-thread loading motif on the submit button while creating', async () => {
    let resolveCreate: (id: string) => void = () => {};
    const client = fakeClient({
      createSession: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
    });
    render(NewSessionDialog, {
      props: { open: true, project: PROJECT, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.getByTestId('woven-loader')).toBeTruthy();
    resolveCreate('sess_new_1');
  });

  it('Cancel closes without creating a session', async () => {
    const client = fakeClient();
    const onClose = vi.fn();
    render(NewSessionDialog, {
      props: { open: true, project: PROJECT, client, onCreated: vi.fn(), onClose },
    });

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  describe('the Workspace control (SPEC §7.1 per-session worktree choice)', () => {
    it('is absent when the project is confirmed not a git repo', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: false },
          client: fakeClient(),
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
      expect(screen.queryByTestId('new-session-workspace-probing')).toBeNull();
    });

    it('is present, defaulting to Isolated worktree, when the project is a confirmed git repo', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });
      expect(
        screen.getByTestId('new-session-workspace-worktree').getAttribute('aria-checked'),
      ).toBe('true');
      expect(
        screen.getByTestId('new-session-workspace-in-place').getAttribute('aria-checked'),
      ).toBe('false');
      expect(screen.getByText(/Only one session at a time can do this/)).toBeTruthy();
    });

    it('picking In place sends worktree: false; the untouched default sends worktree: true', async () => {
      const client = fakeClient();
      render(NewSessionDialog, {
        props: { open: true, project: PROJECT, client, onCreated: vi.fn(), onClose: vi.fn() },
      });

      await fillPrompt();
      await fireEvent.click(screen.getByTestId('new-session-workspace-in-place'));
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith({
          targetId: 'local',
          provider: 'claude',
          projectPath: '/home/dev/loombox',
          worktree: false,
          title: undefined,
          prompt: 'get started',
        }),
      );
    });

    it('probes browseDirectory when isGitRepo is unknown, shows a loading state meanwhile, then renders the choice once resolved true and reports it via onGitRepoResolved', async () => {
      let resolveBrowse: (payload: TargetFsListResponsePayloadV1) => void = () => {};
      const client = fakeClient({
        browseDirectory: vi.fn(
          () =>
            new Promise<TargetFsListResponsePayloadV1>((resolve) => {
              resolveBrowse = resolve;
            }),
        ),
      });
      const onGitRepoResolved = vi.fn();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: undefined },
          client,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          onGitRepoResolved,
        },
      });

      expect(client.browseDirectory).toHaveBeenCalledWith({
        nodeId: 'node_1',
        targetId: 'local',
        path: '/home/dev/loombox',
      });
      expect(screen.getByTestId('new-session-workspace-probing')).toBeTruthy();
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();

      resolveBrowse({ outcome: 'ok', path: '/home/dev/loombox', entries: [], gitRepo: true });

      await waitFor(() => expect(screen.getByTestId('new-session-workspace')).toBeTruthy());
      expect(screen.queryByTestId('new-session-workspace-probing')).toBeNull();
      expect(onGitRepoResolved).toHaveBeenCalledWith(true);
    });

    it('drops the control and sends no worktree field when the probe resolves to a confirmed non-repo, reporting that via onGitRepoResolved', async () => {
      const client = fakeClient({
        browseDirectory: vi.fn().mockResolvedValue({
          outcome: 'ok',
          path: '/home/dev/loombox',
          entries: [],
          gitRepo: false,
        }),
      });
      const onGitRepoResolved = vi.fn();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: undefined },
          client,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          onGitRepoResolved,
        },
      });

      await waitFor(() => expect(screen.queryByTestId('new-session-workspace-probing')).toBeNull());
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
      expect(onGitRepoResolved).toHaveBeenCalledWith(false);

      await fillPrompt();
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith({
          targetId: 'local',
          provider: 'claude',
          projectPath: '/home/dev/loombox',
          title: undefined,
          prompt: 'get started',
        }),
      );
    });

    it('omits the control and sends no worktree field when the probe itself fails, without calling onGitRepoResolved', async () => {
      const client = fakeClient({
        browseDirectory: vi
          .fn()
          .mockRejectedValue(
            new Error('RelayClient: timed out waiting for target_fs_list_response'),
          ),
      });
      const onGitRepoResolved = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: undefined },
          client,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          onGitRepoResolved,
        },
      });

      await waitFor(() => expect(screen.queryByTestId('new-session-workspace-probing')).toBeNull());
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
      expect(onGitRepoResolved).not.toHaveBeenCalled();

      await fillPrompt();
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith({
          targetId: 'local',
          provider: 'claude',
          projectPath: '/home/dev/loombox',
          title: undefined,
          prompt: 'get started',
        }),
      );
      warnSpy.mockRestore();
    });

    it('omits the control and sends no worktree field when the node is too old to report gitRepo at all', async () => {
      const client = fakeClient({
        browseDirectory: vi
          .fn()
          .mockResolvedValue({ outcome: 'ok', path: '/home/dev/loombox', entries: [] }),
      });
      const onGitRepoResolved = vi.fn();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: undefined },
          client,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          onGitRepoResolved,
        },
      });

      await waitFor(() => expect(screen.queryByTestId('new-session-workspace-probing')).toBeNull());
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
      expect(onGitRepoResolved).not.toHaveBeenCalled();
    });
  });
});
