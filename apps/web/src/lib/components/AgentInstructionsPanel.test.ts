// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentInstructionsFileStateV1,
  AgentInstructionsGetResponsePayloadV1,
  AgentInstructionsSetResponsePayloadV1,
} from '@loombox/protocol';
import AgentInstructionsPanel, {
  type AgentInstructionsClient,
} from './AgentInstructionsPanel.svelte';

afterEach(() => cleanup());

function fakeClient(overrides: Partial<AgentInstructionsClient> = {}): AgentInstructionsClient {
  return {
    getAgentInstructions: vi.fn().mockResolvedValue({ outcome: 'ok', files: [] }),
    setAgentInstructions: vi.fn(),
    ...overrides,
  };
}

function okGet(files: AgentInstructionsFileStateV1[]): AgentInstructionsGetResponsePayloadV1 {
  return { outcome: 'ok', files };
}

describe('AgentInstructionsPanel (SPEC §7.18; issue #260)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(AgentInstructionsPanel, { props: { projectPath: '/proj-a', client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.getAgentInstructions).not.toHaveBeenCalled();
  });

  it('neither file exists: defaults to AGENTS.md as an empty, clearly-labeled create draft', async () => {
    const client = fakeClient();
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => expect(client.getAgentInstructions).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => {
      expect(screen.getByTestId('agent-instructions-create-hint').textContent).toContain(
        'AGENTS.md',
      );
      expect((screen.getByTestId('agent-instructions-editor') as HTMLTextAreaElement).value).toBe(
        '',
      );
      expect(screen.getByTestId('agent-instructions-save').textContent).toContain(
        'Create AGENTS.md',
      );
    });
  });

  it('AGENTS.md already exists: loads its content into the editor, labeled Save not Create', async () => {
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: '# hi', hash: 'h1' }])),
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => {
      expect((screen.getByTestId('agent-instructions-editor') as HTMLTextAreaElement).value).toBe(
        '# hi',
      );
      expect(screen.getByTestId('agent-instructions-save').textContent?.trim()).toBe('Save');
    });
  });

  it('only CLAUDE.md exists: defaults to the file that actually exists, not AGENTS.md', async () => {
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'CLAUDE.md', content: '@AGENTS.md', hash: 'h2' }])),
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => {
      expect((screen.getByTestId('agent-instructions-editor') as HTMLTextAreaElement).value).toBe(
        '@AGENTS.md',
      );
    });
  });

  it('switching tabs to a file that does not exist yet offers to create it', async () => {
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: 'agents body', hash: 'h1' }])),
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    await waitFor(() =>
      expect((screen.getByTestId('agent-instructions-editor') as HTMLTextAreaElement).value).toBe(
        'agents body',
      ),
    );

    await fireEvent.click(screen.getByTestId('agent-instructions-tab-CLAUDE.md'));

    expect((screen.getByTestId('agent-instructions-editor') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('agent-instructions-create-hint').textContent).toContain('CLAUDE.md');
  });

  it('creating a new file sends baseHash: null and reflects the saved content back', async () => {
    const setAgentInstructions = vi.fn().mockResolvedValue({
      outcome: 'ok',
      fileName: 'AGENTS.md',
      content: 'new instructions',
      hash: 'new-hash',
    } satisfies AgentInstructionsSetResponsePayloadV1);
    const client = fakeClient({ setAgentInstructions });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    await waitFor(() => expect(client.getAgentInstructions).toHaveBeenCalled());

    const editor = (await screen.findByTestId('agent-instructions-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'new instructions' } });
    await fireEvent.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() =>
      expect(setAgentInstructions).toHaveBeenCalledWith('sess-1', {
        fileName: 'AGENTS.md',
        content: 'new instructions',
        baseHash: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-instructions-save').textContent?.trim()).toBe('Save'),
    );
  });

  it('the create button is disabled for a blank draft, so an empty file is never created by accident', async () => {
    const client = fakeClient();
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() =>
      expect((screen.getByTestId('agent-instructions-save') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it('editing an existing file sends the loaded hash as baseHash — never overwrites blindly on the happy path', async () => {
    const setAgentInstructions = vi.fn().mockResolvedValue({
      outcome: 'ok',
      fileName: 'AGENTS.md',
      content: 'edited',
      hash: 'h2',
    } satisfies AgentInstructionsSetResponsePayloadV1);
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: 'original', hash: 'h1' }])),
      setAgentInstructions,
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    const editor = (await screen.findByTestId('agent-instructions-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('original'));

    await fireEvent.input(editor, { target: { value: 'edited' } });
    await fireEvent.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() =>
      expect(setAgentInstructions).toHaveBeenCalledWith('sess-1', {
        fileName: 'AGENTS.md',
        content: 'edited',
        baseHash: 'h1',
      }),
    );
  });

  it('a conflict outcome never applies silently: shows what is on disk now and requires an explicit reload before saving again', async () => {
    const setAgentInstructions = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: { fileName: 'AGENTS.md', content: 'changed underneath', hash: 'h-new' },
    } satisfies AgentInstructionsSetResponsePayloadV1);
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: 'original', hash: 'h1' }])),
      setAgentInstructions,
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    const editor = (await screen.findByTestId('agent-instructions-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('original'));

    await fireEvent.input(editor, { target: { value: 'my stale edit' } });
    await fireEvent.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('changed on disk'),
    );
    // The stale draft is still shown — never silently discarded or force-applied.
    expect(editor.value).toBe('my stale edit');
    expect(setAgentInstructions).toHaveBeenCalledTimes(1);

    client.getAgentInstructions = vi
      .fn()
      .mockResolvedValue(
        okGet([{ fileName: 'AGENTS.md', content: 'changed underneath', hash: 'h-new' }]),
      );
    await fireEvent.click(screen.getByTestId('agent-instructions-reload'));

    // Reload briefly shows the loading state, which unmounts and remounts
    // the textarea — re-query rather than trust the pre-reload node.
    await waitFor(async () => {
      const reloadedEditor = (await screen.findByTestId(
        'agent-instructions-editor',
      )) as HTMLTextAreaElement;
      expect(reloadedEditor.value).toBe('changed underneath');
    });
    expect(screen.queryByTestId('ui-error-notice')).toBeFalsy();
  });

  it('reports current: null on the conflict banner when the file was deleted underneath the edit', async () => {
    const setAgentInstructions = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: null,
    } satisfies AgentInstructionsSetResponsePayloadV1);
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: 'original', hash: 'h1' }])),
      setAgentInstructions,
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    const editor = (await screen.findByTestId('agent-instructions-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('original'));

    await fireEvent.input(editor, { target: { value: 'my stale edit' } });
    await fireEvent.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('deleted on disk'),
    );
  });

  it('surfaces a save failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      getAgentInstructions: vi
        .fn()
        .mockResolvedValue(okGet([{ fileName: 'AGENTS.md', content: 'original', hash: 'h1' }])),
      setAgentInstructions: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });
    await screen.findByTestId('agent-instructions-editor');

    await fireEvent.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });

  it('surfaces a load failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      getAgentInstructions: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(AgentInstructionsPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });
});
