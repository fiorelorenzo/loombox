// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetFsListResponsePayloadV1 } from '@loombox/protocol';
import type { TargetListEntry } from '$lib/relay-client';
import AddProjectDialog from './AddProjectDialog.svelte';
import type { DirectoryPickerClient } from './DirectoryPicker.svelte';

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  { nodeId: 'node_1', targetId: 'local', label: 'This machine', kind: 'local', reachable: true },
];

function fakeClient(
  responses: Record<string, TargetFsListResponsePayloadV1>,
): DirectoryPickerClient {
  return {
    browseDirectory: vi.fn(async ({ path }: { path: string }) => {
      const response = responses[path];
      if (!response) throw new Error(`fakeClient: no stubbed response for path "${path}"`);
      return response;
    }),
  };
}

describe('AddProjectDialog (design spec §3.4, §4.2; issue #507)', () => {
  it('is not rendered while closed', () => {
    render(AddProjectDialog, {
      props: {
        open: false,
        targets: TARGETS,
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  // Moved from NewSessionDialog.test.ts (issue #385's original target-picker
  // coverage): `targets` is now a prop the shell already keeps polled
  // (issue #269), not something this dialog fetches itself, so there is no
  // loading/error state of its own left to cover here: only "renders
  // whatever it's given".
  it('renders the given targets via TargetPicker, without fetching them itself', () => {
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: TARGETS,
        client: fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } }),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });
    expect(screen.getByTestId('target-picker')).toBeTruthy();
    expect(screen.getByText('This machine')).toBeTruthy();
  });

  // Moved from NewSessionDialog.test.ts's "no-targets empty state" test.
  // The CTA half of that assertion is dropped, not moved: "Add a target"
  // now lives on the Nodes page (design spec §3.1), and this dialog has no
  // `onAddTarget` prop to wire one through.
  it('shows the no-targets empty state, with the submit button disabled', () => {
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: [],
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });
    expect(screen.getByTestId('add-project-no-targets').textContent).toMatch(
      /no nodes connected yet/i,
    );
    expect((screen.getByTestId('add-project-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('auto-selects the first reachable target, skipping an unreachable one', () => {
    const targets: TargetListEntry[] = [
      { nodeId: 'node_1', targetId: 'flaky', label: 'Flaky box', kind: 'ssh', reachable: false },
      {
        nodeId: 'node_2',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
      },
    ];
    render(AddProjectDialog, {
      props: {
        open: true,
        targets,
        client: fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } }),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });
    const options = screen.getAllByTestId('target-option');
    const selected = options.find((el) => el.getAttribute('aria-checked') === 'true');
    expect(selected?.getAttribute('data-target-id')).toBe('local');
  });

  // Moved (and adapted) from NewSessionDialog.test.ts's "submit disabled
  // until target/folder/prompt" test: this dialog has no prompt field, and
  // a target is auto-selected the moment any are available, so the
  // observable gate here is the folder.
  it('the submit button is disabled until a folder is chosen', async () => {
    const client = fakeClient({ '': { outcome: 'ok', path: '/home/dev', entries: [] } });
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated: vi.fn() },
    });

    const submit = screen.getByTestId('add-project-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId('target-option').getAttribute('aria-checked')).toBe('true'),
    );
    expect(submit.disabled).toBe(true);

    await fireEvent.input(screen.getByTestId('add-project-path'), {
      target: { value: '/home/dev/project' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('the name field defaults to the folder basename and keeps following further navigation', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/loombox': {
        outcome: 'ok',
        path: '/home/lorenzo/loombox',
        entries: [],
        gitRepo: true,
      },
    });
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated: vi.fn() },
    });

    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));

    await waitFor(() =>
      expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('loombox'),
    );
  });

  it('stops auto-following the path once the user types their own name', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/loombox': {
        outcome: 'ok',
        path: '/home/lorenzo/loombox',
        entries: [{ name: 'nested', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/loombox/nested': {
        outcome: 'ok',
        path: '/home/lorenzo/loombox/nested',
        entries: [],
      },
    });
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated: vi.fn() },
    });

    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));
    await waitFor(() =>
      expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('loombox'),
    );

    await fireEvent.input(screen.getByTestId('add-project-name'), {
      target: { value: 'My project' },
    });

    await waitFor(() => expect(screen.getByText('nested')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));

    await waitFor(() =>
      expect((screen.getByTestId('add-project-path') as HTMLInputElement).value).toBe(
        '/home/lorenzo/loombox/nested',
      ),
    );
    expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('My project');
  });

  it('on confirm reports name/nodeId/targetId/path/isGitRepo from the browsed folder and closes, without creating anything itself', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/loombox': {
        outcome: 'ok',
        path: '/home/lorenzo/loombox',
        entries: [],
        gitRepo: true,
      },
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose, onCreated },
    });

    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));
    await waitFor(() =>
      expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('loombox'),
    );

    await fireEvent.click(screen.getByTestId('add-project-submit'));

    expect(onCreated).toHaveBeenCalledWith({
      name: 'loombox',
      nodeId: 'node_1',
      targetId: 'local',
      path: '/home/lorenzo/loombox',
      isGitRepo: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a name cleared back to blank is sent as undefined, not an empty string', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/loombox': { outcome: 'ok', path: '/home/lorenzo/loombox', entries: [] },
    });
    const onCreated = vi.fn();
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated },
    });

    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));
    await waitFor(() =>
      expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('loombox'),
    );

    await fireEvent.input(screen.getByTestId('add-project-name'), { target: { value: '  ' } });
    await fireEvent.click(screen.getByTestId('add-project-submit'));

    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: undefined }));
  });

  it('Cancel closes without creating a project', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: TARGETS,
        client: fakeClient({ '': { outcome: 'ok', path: '/home', entries: [] } }),
        onClose,
        onCreated,
      },
    });

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('switching the selected target clears a previously browsed folder (a different filesystem entirely)', async () => {
    const targets: TargetListEntry[] = [
      {
        nodeId: 'node_1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
      },
      { nodeId: 'node_2', targetId: 'devbox', label: 'Devbox', kind: 'ssh', reachable: true },
    ];
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
    });
    render(AddProjectDialog, {
      props: { open: true, targets, client, onClose: vi.fn(), onCreated: vi.fn() },
    });

    await waitFor(() =>
      expect((screen.getByTestId('add-project-path') as HTMLInputElement).value).toBe(
        '/home/lorenzo',
      ),
    );
    await fireEvent.input(screen.getByTestId('add-project-path'), { target: { value: '/tmp/x' } });
    expect((screen.getByTestId('add-project-path') as HTMLInputElement).value).toBe('/tmp/x');

    const options = screen.getAllByTestId('target-option');
    const other = options.find((el) => el.getAttribute('data-target-id') === 'devbox')!;
    await fireEvent.click(other);

    await waitFor(() =>
      expect((screen.getByTestId('add-project-path') as HTMLInputElement).value).not.toBe('/tmp/x'),
    );
    expect((screen.getByTestId('add-project-name') as HTMLInputElement).value).toBe('');
  });
});
