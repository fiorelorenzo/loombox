// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetListEntry } from '$lib/relay-client';
import NewSessionDialog, { type NewSessionClient } from './NewSessionDialog.svelte';

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  { nodeId: 'node_1', targetId: 'local', label: 'This machine', kind: 'local', reachable: true },
];

function fakeClient(overrides: Partial<NewSessionClient> = {}): NewSessionClient {
  return {
    listTargets: vi.fn().mockResolvedValue(TARGETS),
    createSession: vi.fn().mockResolvedValue('sess_new_1'),
    ...overrides,
  };
}

async function fillRequiredFields(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('target-option')).toBeTruthy());
  await fireEvent.click(screen.getByTestId('target-option'));
  await fireEvent.input(screen.getByTestId('new-session-project-path'), {
    target: { value: '/home/dev/project' },
  });
  await fireEvent.input(screen.getByTestId('new-session-prompt'), {
    target: { value: 'get started' },
  });
}

describe('NewSessionDialog (issue #385)', () => {
  it('is not rendered while closed', () => {
    render(NewSessionDialog, {
      props: { open: false, client: fakeClient(), onCreated: vi.fn(), onClose: vi.fn() },
    });
    expect(screen.queryByTestId('new-session-dialog')).toBeNull();
  });

  it('fetches targets from the client when opened and lists them via TargetPicker', async () => {
    const client = fakeClient();
    render(NewSessionDialog, {
      props: { open: true, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    expect(client.listTargets).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('target-option')).toBeTruthy());
    expect(screen.getByText('This machine')).toBeTruthy();
  });

  it('shows the no-targets empty state with a helpful CTA when listTargets resolves empty', async () => {
    const client = fakeClient({ listTargets: vi.fn().mockResolvedValue([]) });
    render(NewSessionDialog, {
      props: { open: true, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    await waitFor(() => expect(screen.getByTestId('new-session-no-targets')).toBeTruthy());
    expect(screen.getByTestId('new-session-no-targets').textContent).toMatch(
      /no nodes connected yet/i,
    );
  });

  it('the submit button is disabled until a target, a project folder, and a starting prompt are all provided', async () => {
    const client = fakeClient();
    render(NewSessionDialog, {
      props: { open: true, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    const submit = screen.getByTestId('new-session-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await fillRequiredFields();
    expect(submit.disabled).toBe(false);
  });

  it('submitting calls client.createSession with the target, provider claude, project path, and prompt, then reports the new session and closes', async () => {
    const client = fakeClient();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(NewSessionDialog, { props: { open: true, client, onCreated, onClose } });

    await fillRequiredFields();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sess_new_1'));
    expect(client.createSession).toHaveBeenCalledWith({
      targetId: 'local',
      provider: 'claude',
      projectPath: '/home/dev/project',
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
    render(NewSessionDialog, { props: { open: true, client, onCreated: vi.fn(), onClose } });

    await fillRequiredFields();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    await waitFor(() => expect(screen.getByText('relay unreachable')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the woven-thread loading motif while listing targets (issue #274)', async () => {
    let resolveTargets: (targets: typeof TARGETS) => void = () => {};
    const client = fakeClient({
      listTargets: vi.fn(
        () =>
          new Promise<typeof TARGETS>((resolve) => {
            resolveTargets = resolve;
          }),
      ),
    });
    render(NewSessionDialog, {
      props: { open: true, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    expect(screen.getByTestId('woven-loader')).toBeTruthy();
    resolveTargets(TARGETS);
    await waitFor(() => expect(screen.getByTestId('target-option')).toBeTruthy());
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
      props: { open: true, client, onCreated: vi.fn(), onClose: vi.fn() },
    });

    await fillRequiredFields();
    await fireEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.getByTestId('woven-loader')).toBeTruthy();
    resolveCreate('sess_new_1');
  });

  it('Cancel closes without creating a session', async () => {
    const client = fakeClient();
    const onClose = vi.fn();
    render(NewSessionDialog, { props: { open: true, client, onCreated: vi.fn(), onClose } });

    await waitFor(() => expect(screen.getByTestId('target-option')).toBeTruthy());
    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.createSession).not.toHaveBeenCalled();
  });
});
