// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/projects';
import NewSessionDialog, { type NewSessionClient } from './NewSessionDialog.svelte';

afterEach(() => cleanup());

// Closing the dialog runs `Overlay.svelte`'s exit transition, which calls
// `element.animate()` - absent in jsdom. Same minimal no-op stub as
// `routes/page.test.ts` and `TargetStatusView.test.ts`, for the same reason.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

const PROJECT: Project = {
  id: 'proj_1',
  name: 'loombox',
  nodeId: 'node_1',
  targetId: 'local',
  path: '/home/dev/loombox',
  isGitRepo: true,
  createdAt: 0,
};

/** The default fixture used by every test that isn't specifically about the
 * Agent field itself: exactly one available provider, matching this
 * suite's pre-existing `provider: 'claude'` assertions from before real
 * providers existed. */
const PROVIDERS = ['claude'];
const TARGET_LABEL = 'local';

function fakeClient(overrides: Partial<NewSessionClient> = {}): NewSessionClient {
  return {
    createSession: vi.fn().mockResolvedValue('sess_new_1'),
    ...overrides,
  };
}

async function fillPrompt(): Promise<void> {
  await fireEvent.input(screen.getByTestId('new-session-prompt'), {
    target: { value: 'get started' },
  });
}

describe('NewSessionDialog (issue #385; IA v4 project-inherited target/folder, design spec §3.4, issue #507; forms + real providers design spec §2/§3; title-first, optional-prompt reorder, issue #563)', () => {
  it('is not rendered while closed', () => {
    render(NewSessionDialog, {
      props: {
        open: false,
        project: PROJECT,
        client: fakeClient(),
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
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
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
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

  it('the submit button is enabled with an empty form, since both the title and the starting prompt are optional', () => {
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client: fakeClient(),
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    const submit = screen.getByTestId('new-session-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('submitting an empty form omits prompt entirely (not an empty string), and lets title default via title: undefined', async () => {
    const client = fakeClient();
    const onCreated = vi.fn();
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated,
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1'));
    expect(client.createSession).toHaveBeenCalledWith({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/loombox',
      worktree: true,
      title: undefined,
      prompt: undefined,
    });
  });

  it('orders the fields Title, Agent, Workspace, Starting prompt (issue #563: the task, not the first thing said, identifies a session)', () => {
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client: fakeClient(),
        providers: ['claude', 'codex'],
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    const title = screen.getByTestId('new-session-title');
    const agent = screen.getByTestId('new-session-provider');
    const workspace = screen.getByTestId('new-session-workspace');
    const prompt = screen.getByTestId('new-session-prompt');

    expect(title.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(agent.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(workspace.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  it('focuses the title field when the dialog opens, not the (now-optional, no-longer-first) starting prompt', async () => {
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client: fakeClient(),
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    await tick();
    expect(document.activeElement).toBe(screen.getByTestId('new-session-title'));
  });

  it("submitting calls client.createSession with the project's target/path, provider claude, the default isolated-worktree choice, and the prompt, then reports the new session and closes", async () => {
    const client = fakeClient();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated,
        onClose,
      },
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
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose,
      },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(screen.getByText('relay unreachable')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rephrases a transport timeout instead of leaking the wire identifier, and does not claim the session failed (issue #505 precedent)', async () => {
    const client = fakeClient({
      createSession: vi
        .fn()
        .mockRejectedValue(
          new Error('RelayClient.createSession: timed out waiting for session sess_abc'),
        ),
    });
    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    // The node creates the worktree before the agent is up and only announces
    // afterwards, so a timeout here is not evidence the session failed - the
    // copy must not say it did, and must not name a wire message either.
    const notice = await screen.findByTestId('ui-error-notice');
    expect(notice.textContent).not.toContain('sess_abc');
    expect(notice.textContent).not.toContain('RelayClient');
    expect(notice.textContent).toContain('may still appear');
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
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
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
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose,
      },
    });

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('issues no browseDirectory call at all — the workspace probe is gone (forms + real providers design spec §1/§3, defect #2)', async () => {
    const browseDirectory = vi.fn();
    // A real `RelayClient` still has `browseDirectory` (it serves other
    // callers, e.g. `AddProjectDialog`); this fixture keeps it present but
    // unused, so the assertion below proves this component genuinely never
    // calls it rather than merely lacking the method to call.
    const client = { ...fakeClient(), browseDirectory };
    render(NewSessionDialog, {
      props: {
        open: true,
        project: { ...PROJECT, isGitRepo: undefined },
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated: vi.fn(),
        onClose: vi.fn(),
      },
    });

    await fillPrompt();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(client.createSession).toHaveBeenCalled());
    expect(browseDirectory).not.toHaveBeenCalled();
  });

  describe('the Workspace control (SPEC §7.1 per-session worktree choice)', () => {
    it('is absent when the project is confirmed not a git repo', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: false },
          client: fakeClient(),
          providers: PROVIDERS,
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
    });

    it('is absent, with no probe or loading state, when the project has never been resolved as a git repo at all', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: { ...PROJECT, isGitRepo: undefined },
          client: fakeClient(),
          providers: PROVIDERS,
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });
      expect(screen.queryByTestId('new-session-workspace')).toBeNull();
    });

    it('is present, defaulting to Isolated worktree, when the project is a confirmed git repo', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: PROVIDERS,
          targetLabel: TARGET_LABEL,
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
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: PROVIDERS,
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
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
  });

  describe('the Agent field (forms + real providers design spec §2/§3, defect #1: real per-target providers, never a hardcoded guess)', () => {
    it('renders no Select and no zero-agent notice when exactly one provider is available; the sole agent instead appears as a fact in the context line', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['codex'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });
      expect(screen.queryByTestId('new-session-provider')).toBeNull();
      expect(screen.getByTestId('new-session-agent-fact').textContent).toContain('Codex');
    });

    it('submits the sole available provider even though no Select was ever rendered for it', async () => {
      const client = fakeClient();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: ['codex'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      await fillPrompt();
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ provider: 'codex' }),
        ),
      );
    });

    it('renders a real Select, labelled from the shared provider names, when two or more providers are available, and submits whichever one is picked', async () => {
      const client = fakeClient();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: ['claude', 'codex'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      expect(screen.queryByTestId('new-session-agent-fact')).toBeNull();
      await fireEvent.click(screen.getByTestId('new-session-provider-trigger'));
      expect(screen.getByTestId('new-session-provider-option-claude').textContent).toContain(
        'Claude Code',
      );
      expect(screen.getByTestId('new-session-provider-option-codex').textContent).toContain(
        'Codex',
      );

      await fireEvent.click(screen.getByTestId('new-session-provider-option-codex'));
      await fillPrompt();
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ provider: 'codex' }),
        ),
      );
    });

    it('disables submission and explains why, naming the target, when the target has no agent CLI at all — never falling back to a hardcoded claude', async () => {
      const client = fakeClient();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: [],
          targetLabel: 'Build server',
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      await fillPrompt();
      const submit = screen.getByTestId('new-session-submit') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(screen.queryByTestId('new-session-provider')).toBeNull();
      expect(screen.queryByTestId('new-session-agent-fact')).toBeNull();
      expect(screen.getByText(/no agent cli/i).textContent).toContain('Build server');

      await fireEvent.click(submit);
      expect(client.createSession).not.toHaveBeenCalled();
    });
  });

  describe('the open form survives prop churn (measured against a real relay)', () => {
    /**
     * `providers` gets a new array identity on every parent render: `+page.svelte`
     * derives it from the polled target list, and issue #269's health sampler
     * repolls every few seconds. `resetForm()` reads `providers`, so before
     * `untrack` the reset effect depended on it and wiped whatever was typed -
     * within one second, over and over, driving the built app against the
     * deployed relay. Same contents, new identity, is the whole scenario.
     */
    it('keeps a typed prompt when providers arrives as a new array with identical contents', async () => {
      const { rerender } = render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      const prompt = screen.getByTestId('new-session-prompt') as HTMLTextAreaElement;
      await fireEvent.input(prompt, { target: { value: 'do not lose this' } });
      expect(prompt.value).toBe('do not lose this');

      for (let i = 0; i < 3; i += 1) {
        await rerender({ providers: ['claude'] });
      }

      expect((screen.getByTestId('new-session-prompt') as HTMLTextAreaElement).value).toBe(
        'do not lose this',
      );
    });

    it('keeps a typed prompt even when the provider list genuinely changes under it', async () => {
      const { rerender } = render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      const prompt = screen.getByTestId('new-session-prompt') as HTMLTextAreaElement;
      await fireEvent.input(prompt, { target: { value: 'still here' } });
      // A second agent finishing installation on the target is not a reason to
      // throw away the sentence the operator is halfway through.
      await rerender({ providers: ['claude', 'ohmypi'] });

      expect((screen.getByTestId('new-session-prompt') as HTMLTextAreaElement).value).toBe(
        'still here',
      );
    });

    it('still resets when the dialog is genuinely reopened', async () => {
      const { rerender } = render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
        },
      });

      await fireEvent.input(screen.getByTestId('new-session-prompt'), {
        target: { value: 'from the previous session' },
      });
      await rerender({ open: false });
      await rerender({ open: true });

      await waitFor(() =>
        expect((screen.getByTestId('new-session-prompt') as HTMLTextAreaElement).value).toBe(''),
      );
    });
  });
});
