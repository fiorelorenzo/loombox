// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/projects';
import { addCustomAgent, createInMemoryCustomAgentStorage } from '$lib/custom-agent-store';
import {
  addMcpServerConfig,
  createInMemoryMcpServerConfigStorage,
  setMcpServerEnabled,
} from '$lib/mcp-server-store';
import { AGENT_CATALOGUE, parseMcpServerConfig } from '@loombox/providers-core/browser';
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

describe('NewSessionDialog (issue #385; IA v4 project-inherited target/folder, design spec §3.4, issue #507; forms + real providers design spec §2/§3; title-first field order, issue #563; starting prompt removed, issue #761)', () => {
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

  it('the submit button is enabled with an empty form, since the title is optional', () => {
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

  it('has no starting-prompt field at all (issue #761): a session is always created empty, and the first thing said goes through the composer afterwards', () => {
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

    expect(screen.queryByTestId('new-session-prompt')).toBeNull();
    expect(screen.queryByText(/starting prompt/i)).toBeNull();
  });

  it('orders the fields Title, Agent, Workspace (issue #563: the task, not the first thing said, identifies a session)', () => {
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

    expect(title.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(agent.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('focuses the title field when the dialog opens (issue #563)', async () => {
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

  it("submitting an empty form calls client.createSession with the project's target/path, provider claude, the default isolated-worktree choice, and lets title default via title: undefined (never a prompt — issue #761), then reports the new session and closes", async () => {
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

    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1', 'claude'));
    expect(client.createSession).toHaveBeenCalledWith({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/loombox',
      worktree: true,
      title: undefined,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forwards the Config panel's currently-enabled MCP server list into createSession's mcpServerConfigs, excluding a disabled one (issue #750, D2-2; #794)", async () => {
    const client = fakeClient();
    const onCreated = vi.fn();
    const mcpStorage = createInMemoryMcpServerConfigStorage();
    const enabledConfig = parseMcpServerConfig({
      name: 'filesystem',
      transport: 'stdio',
      command: '/usr/local/bin/mcp-filesystem',
      args: [],
      env: [],
    });
    const disabledConfig = parseMcpServerConfig({
      name: 'disabled-one',
      transport: 'stdio',
      command: '/usr/local/bin/disabled-one',
      args: [],
      env: [],
    });
    addMcpServerConfig(mcpStorage, enabledConfig);
    addMcpServerConfig(mcpStorage, disabledConfig);
    setMcpServerEnabled(mcpStorage, disabledConfig.name, false);

    render(NewSessionDialog, {
      props: {
        open: true,
        project: PROJECT,
        client,
        providers: PROVIDERS,
        targetLabel: TARGET_LABEL,
        onCreated,
        onClose: vi.fn(),
        mcpStorage,
      },
    });

    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerConfigs: [enabledConfig] }),
    );
  });

  it('omits mcpServerConfigs entirely when the Config panel has nothing enabled for this project, rather than sending an empty array (issue #794)', async () => {
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
        mcpStorage: createInMemoryMcpServerConfigStorage(),
      },
    });

    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const call = vi.mocked(client.createSession).mock.calls[0]?.[0];
    expect(call && 'mcpServerConfigs' in call).toBe(false);
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

      await fireEvent.click(screen.getByTestId('new-session-workspace-in-place'));
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith({
          targetId: 'local',
          provider: 'claude',
          projectPath: '/home/dev/loombox',
          worktree: false,
          title: undefined,
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

      const submit = screen.getByTestId('new-session-submit') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(screen.queryByTestId('new-session-provider')).toBeNull();
      expect(screen.queryByTestId('new-session-agent-fact')).toBeNull();
      expect(screen.getByText(/no agent cli/i).textContent).toContain('Build server');

      await fireEvent.click(submit);
      expect(client.createSession).not.toHaveBeenCalled();
    });
  });

  describe('custom ACP agents (D1-3, issue #748)', () => {
    it('renders the "+ Define a custom agent" affordance even in the zero-provider state, and it never blocks submission of an ordinary provider session', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: [],
          targetLabel: 'Build server',
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: createInMemoryCustomAgentStorage(),
        },
      });
      expect(screen.getByTestId('new-session-custom-agent-toggle')).toBeTruthy();
      expect(screen.queryByTestId('new-session-custom-agent-name')).toBeNull();
    });

    it('defining a custom agent adds it to the (now real) Agent Select, selects it, and hides the form again', async () => {
      const storage = createInMemoryCustomAgentStorage();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId('new-session-custom-agent-toggle'));
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-name'), {
        target: { value: 'My internal agent' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-command'), {
        target: { value: 'omp' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-args'), {
        target: { value: 'acp' },
      });
      await fireEvent.click(screen.getByTestId('new-session-custom-agent-submit'));

      // Persisted (mirrors mcp-server-store's CRUD contract)…
      expect(storage.get()).toEqual([{ name: 'My internal agent', command: 'omp', args: ['acp'] }]);
      // …and it is now the sole pickable agent: the fact line, not a Select
      // (agentOptions.length === 1, same rule an ordinary sole provider gets).
      await waitFor(() =>
        expect(screen.getByTestId('new-session-agent-fact').textContent).toContain(
          'My internal agent (custom)',
        ),
      );
      expect(screen.queryByTestId('new-session-custom-agent-name')).toBeNull();
    });

    it('submitting a session with a custom agent selected sends provider: "custom" and the full customAgent record, including parsed env', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const client = fakeClient();
      const onCreated = vi.fn();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated,
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId('new-session-custom-agent-toggle'));
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-name'), {
        target: { value: 'My internal agent' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-command'), {
        target: { value: 'omp' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-args'), {
        target: { value: 'acp --profile=work' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-env'), {
        target: { value: 'FOO=bar\n\nBAZ=qux\nignored-line-with-no-equals' },
      });
      await fireEvent.click(screen.getByTestId('new-session-custom-agent-submit'));
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1', 'custom'));
      expect(client.createSession).toHaveBeenCalledWith({
        targetId: 'local',
        provider: 'custom',
        projectPath: '/home/dev/loombox',
        worktree: true,
        title: undefined,
        customAgent: {
          name: 'My internal agent',
          command: 'omp',
          args: ['acp', '--profile=work'],
          env: { FOO: 'bar', BAZ: 'qux' },
        },
      });
    });

    it('a name shared with a registered provider option cannot collide: the two entries stay independently selectable and independently submittable', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const client = fakeClient();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId('new-session-custom-agent-toggle'));
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-name'), {
        target: { value: 'claude' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-command'), {
        target: { value: 'omp' },
      });
      await fireEvent.click(screen.getByTestId('new-session-custom-agent-submit'));

      await fireEvent.click(screen.getByTestId('new-session-provider-trigger'));
      expect(screen.getByTestId('new-session-provider-option-claude').textContent).toContain(
        'Claude Code',
      );
      expect(
        screen.getByTestId('new-session-provider-option-custom-agent:claude').textContent,
      ).toContain('claude (custom)');

      await fireEvent.click(screen.getByTestId('new-session-provider-option-claude'));
      await fireEvent.click(screen.getByTestId('new-session-submit'));
      await waitFor(() =>
        expect(client.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ provider: 'claude' }),
        ),
      );
    });

    it('rejects an empty name or command with a visible error, without touching storage', async () => {
      const storage = createInMemoryCustomAgentStorage();
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId('new-session-custom-agent-toggle'));
      await fireEvent.click(screen.getByTestId('new-session-custom-agent-submit'));

      expect(screen.getByText(/name and command are required/i)).toBeTruthy();
      expect(storage.get()).toEqual([]);
    });

    it('rejects a duplicate custom agent name with a visible error naming the duplicate', async () => {
      const storage = createInMemoryCustomAgentStorage();
      addCustomAgent(storage, { name: 'My internal agent', command: 'omp', args: [] });
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: ['claude'],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId('new-session-custom-agent-toggle'));
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-name'), {
        target: { value: 'My internal agent' },
      });
      await fireEvent.input(screen.getByTestId('new-session-custom-agent-command'), {
        target: { value: 'omp' },
      });
      await fireEvent.click(screen.getByTestId('new-session-custom-agent-submit'));

      expect(screen.getByText(/duplicate/i)).toBeTruthy();
      expect(storage.get()).toEqual([{ name: 'My internal agent', command: 'omp', args: [] }]);
    });
  });

  describe('curated agent catalogue quick-add (D1-3 second half, issue #749)', () => {
    it('renders one quick-add button per catalogue entry, with its blurb and verified-against metadata visible (not just a source comment)', () => {
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: createInMemoryCustomAgentStorage(),
        },
      });

      for (const entry of AGENT_CATALOGUE) {
        expect(screen.getByTestId(`agent-catalogue-add-${entry.id}`).textContent).toContain(
          entry.config.name,
        );
        const verified = screen.getByTestId(`agent-catalogue-verified-${entry.id}`).textContent;
        expect(verified).toContain(entry.verification.against);
        expect(verified).toContain(entry.verification.verifiedOn);
      }
    });

    it('quick-adding a catalogue entry pre-fills it correctly: persists the exact catalogue command/args and selects it as the sole agent', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const geminiEntry = AGENT_CATALOGUE.find((e) => e.id === 'gemini-cli')!;
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId(`agent-catalogue-add-${geminiEntry.id}`));

      expect(storage.get()).toEqual([{ name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }]);
      await waitFor(() =>
        expect(screen.getByTestId('new-session-agent-fact').textContent).toContain(
          'Gemini CLI (custom)',
        ),
      );
    });

    it('submitting right after a quick-add sends provider: "custom" with the catalogue-derived customAgent record verbatim', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const client = fakeClient();
      const onCreated = vi.fn();
      const qwenEntry = AGENT_CATALOGUE.find((e) => e.id === 'qwen-code')!;
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client,
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated,
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId(`agent-catalogue-add-${qwenEntry.id}`));
      await fireEvent.click(screen.getByTestId('new-session-submit'));

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1', 'custom'));
      expect(client.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'custom',
          customAgent: { name: 'Qwen Code', command: 'qwen', args: ['--acp'] },
        }),
      );
    });

    it('still refuses cleanly when the node has not allowlisted the picked command: probes it and shows a visible, honest refusal, without blocking the add itself', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const geminiEntry = AGENT_CATALOGUE.find((e) => e.id === 'gemini-cli')!;
      const probeCustomAgent = vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', available: true, allowed: false });
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient({ probeCustomAgent }),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId(`agent-catalogue-add-${geminiEntry.id}`));

      expect(probeCustomAgent).toHaveBeenCalledWith({
        nodeId: 'node_1',
        targetId: 'local',
        command: 'gemini',
      });
      // The record was still added and selected (convenience-only: the
      // probe never gates the add itself)...
      expect(storage.get()).toEqual([{ name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }]);
      // ...but the refusal is visible, in plain language, right away.
      await waitFor(() =>
        expect(screen.getByText(/not on this node's allowlist yet/i)).toBeTruthy(),
      );
    });

    it('shows a ready/allowed state distinctly when the node has allowlisted the picked command', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const qwenEntry = AGENT_CATALOGUE.find((e) => e.id === 'qwen-code')!;
      const probeCustomAgent = vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', available: true, allowed: true });
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient({ probeCustomAgent }),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId(`agent-catalogue-add-${qwenEntry.id}`));

      await waitFor(() =>
        expect(screen.getByTestId('agent-catalogue-probe-ok').textContent).toContain('Ready'),
      );
    });

    it('a fake client with no probeCustomAgent at all still lets the quick-add succeed, with no probe result rendered', async () => {
      const storage = createInMemoryCustomAgentStorage();
      const geminiEntry = AGENT_CATALOGUE.find((e) => e.id === 'gemini-cli')!;
      render(NewSessionDialog, {
        props: {
          open: true,
          project: PROJECT,
          client: fakeClient(),
          providers: [],
          targetLabel: TARGET_LABEL,
          onCreated: vi.fn(),
          onClose: vi.fn(),
          customAgentStorage: storage,
        },
      });

      await fireEvent.click(screen.getByTestId(`agent-catalogue-add-${geminiEntry.id}`));

      expect(storage.get()).toEqual([{ name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }]);
      expect(screen.queryByTestId('agent-catalogue-probe-result')).toBeNull();
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
     *
     * Originally measured against the starting-prompt field. Issue #761
     * removed that field, but `resetForm()` still resets Title the exact
     * same way, so these now exercise the same effect through Title instead.
     */
    it('keeps a typed title when providers arrives as a new array with identical contents', async () => {
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

      const title = screen.getByTestId('new-session-title') as HTMLInputElement;
      await fireEvent.input(title, { target: { value: 'do not lose this' } });
      expect(title.value).toBe('do not lose this');

      for (let i = 0; i < 3; i += 1) {
        await rerender({ providers: ['claude'] });
      }

      expect((screen.getByTestId('new-session-title') as HTMLInputElement).value).toBe(
        'do not lose this',
      );
    });

    it('keeps a typed title even when the provider list genuinely changes under it', async () => {
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

      const title = screen.getByTestId('new-session-title') as HTMLInputElement;
      await fireEvent.input(title, { target: { value: 'still here' } });
      // A second agent finishing installation on the target is not a reason to
      // throw away the sentence the operator is halfway through.
      await rerender({ providers: ['claude', 'ohmypi'] });

      expect((screen.getByTestId('new-session-title') as HTMLInputElement).value).toBe(
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

      await fireEvent.input(screen.getByTestId('new-session-title'), {
        target: { value: 'from the previous session' },
      });
      await rerender({ open: false });
      await rerender({ open: true });

      await waitFor(() =>
        expect((screen.getByTestId('new-session-title') as HTMLInputElement).value).toBe(''),
      );
    });
  });
});
