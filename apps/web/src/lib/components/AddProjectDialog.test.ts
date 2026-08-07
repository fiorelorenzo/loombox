// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetFsListResponsePayloadV1 } from '@loombox/protocol';
import type { TargetListEntry } from '$lib/relay-client';
import type { ProvisionLocalNodeOutcome } from '$lib/local-node-provision';
import AddProjectDialog from './AddProjectDialog.svelte';
import type { DirectoryPickerClient } from './DirectoryPicker.svelte';

// jsdom has no Web Animations API; `Dialog`'s panel-lift transition calls
// `element.animate()` once opened/closed reactively (see
// `TargetStatusView.test.ts`'s identical stub for why) — only exercised in
// this file by the open/close/reopen round trip in the local-node
// provisioning suite below.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
    providers: ['claude'],
  },
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
      {
        nodeId: 'node_1',
        targetId: 'flaky',
        label: 'Flaky box',
        kind: 'ssh',
        reachable: false,
        providers: ['claude'],
      },
      {
        nodeId: 'node_2',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        providers: ['claude'],
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

    // Submit is async now (it resolves the folder's git status first), so the
    // report lands a microtask later than it used to.
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: undefined })),
    );
  });

  // The submit-time git-status probe (forms wave). A path the operator TYPED
  // rather than browsed to never went through `DirectoryPicker`'s `gitRepo`
  // round trip, so without this the project would be registered with an
  // unknown git status and silently lose the isolated-worktree option in
  // `NewSessionDialog` even when it genuinely is a repo.
  it('resolves the git status of a typed path on submit, rather than registering it unknown', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      '/typed/repo': { outcome: 'ok', path: '/typed/repo', gitRepo: true, entries: [] },
    });
    const onCreated = vi.fn();
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated },
    });

    await fireEvent.input(screen.getByTestId('add-project-path'), {
      target: { value: '/typed/repo' },
    });
    await fireEvent.click(screen.getByTestId('add-project-submit'));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/typed/repo', isGitRepo: true }),
      ),
    );
  });

  it('refuses to register a folder it cannot read, naming the path and the target', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      '/nope': { outcome: 'error', reason: 'ENOENT' } as never,
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose, onCreated },
    });

    await fireEvent.input(screen.getByTestId('add-project-path'), { target: { value: '/nope' } });
    await fireEvent.click(screen.getByTestId('add-project-submit'));

    // One assertion on the whole sentence: "This machine" also appears in the
    // target picker, so matching it alone finds two nodes.
    await waitFor(() =>
      expect(
        screen.getByText('Could not read /nope on This machine. Check the path and try again.'),
      ).toBeTruthy(),
    );
    expect(onCreated).not.toHaveBeenCalled();
    // Still open, so the operator can fix the path instead of losing the form.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('registers a readable folder whose git status the node never reported, as unknown rather than false', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      // `ok`, no `gitRepo`: the folder reads fine, the status is just unknown.
      '/typed/plain': { outcome: 'ok', path: '/typed/plain', entries: [] },
    });
    const onCreated = vi.fn();
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated },
    });

    await fireEvent.input(screen.getByTestId('add-project-path'), {
      target: { value: '/typed/plain' },
    });
    await fireEvent.click(screen.getByTestId('add-project-submit'));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/typed/plain', isGitRepo: undefined }),
      ),
    );
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
        providers: ['claude'],
        reachable: true,
      },
      {
        nodeId: 'node_2',
        targetId: 'devbox',
        label: 'Devbox',
        kind: 'ssh',
        reachable: true,
        providers: ['claude'],
      },
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

  it('keeps every field the same shape — label + control, never prose swapped in for a control — even with no targets to pick', () => {
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: [],
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });

    const fields = screen.getAllByTestId('ui-field');
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const control = field.querySelector('.ui-field-control');
      expect(control?.querySelector('input, button, textarea, select, [role]')).not.toBeNull();
    }

    // The folder field keeps its labelled input shape, just disabled, with
    // the "pick a target" guidance moved to Field's help slot instead of
    // swapped in as the control (design spec §0.7).
    const pathInput = screen.getByTestId('add-project-path') as HTMLInputElement;
    expect(pathInput.disabled).toBe(true);
    expect(screen.getByText('Pick a target to browse its folders.').tagName).toBe('P');
  });

  it("gives the target picker a visible label, matching the folder and name fields' shape", () => {
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: TARGETS,
        client: fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } }),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });

    const fields = screen.getAllByTestId('ui-field');
    const labels = fields.map((field) => field.querySelector('.ui-field-label')?.textContent);
    expect(labels).toContain('Target');
    expect(labels).toContain('Project folder');
    expect(labels).toContain('Name');
    for (const field of fields) {
      const control = field.querySelector('.ui-field-control');
      expect(control?.querySelector('input, button, textarea, select, [role]')).not.toBeNull();
    }
  });

  it('the folder field help text disappears, and the control becomes usable, once a target is selected', async () => {
    const client = fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } });
    render(AddProjectDialog, {
      props: { open: true, targets: TARGETS, client, onClose: vi.fn(), onCreated: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.queryByText('Pick a target to browse its folders.')).toBeNull(),
    );
    expect((screen.getByTestId('add-project-path') as HTMLInputElement).disabled).toBe(false);
  });

  it('moves "Defaults to the folder name" into the field\'s help slot instead of the placeholder', () => {
    render(AddProjectDialog, {
      props: {
        open: true,
        targets: TARGETS,
        client: fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } }),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      },
    });

    const nameInput = screen.getByTestId('add-project-name') as HTMLInputElement;
    expect(nameInput.placeholder).toBe('');
    expect(screen.getByText('Defaults to the folder name')).toBeTruthy();
    expect(nameInput.getAttribute('aria-describedby')).toBeTruthy();
  });

  // Issue #654: the macOS-local resident node provisioning trigger. `onProvisionLocalNode`
  // is only ever supplied by `+page.svelte` inside the desktop shell, on macOS, with an
  // unlocked account session — every other test in this file omits it, which is what
  // exercises the plain "no nodes connected yet" fallback message the tests above assert on.
  describe('the "set up a node on this Mac" CTA (issue #654)', () => {
    function provisionOutcome(
      overrides: Partial<ProvisionLocalNodeOutcome> = {},
    ): ProvisionLocalNodeOutcome {
      return {
        ok: true,
        progress: [
          { step: 'runtime_bootstrap', status: 'ok', message: 'system Node runtime resolved' },
          { step: 'target_identity', status: 'ok', message: 'device identity ready' },
          { step: 'mint_node_token', status: 'ok', message: 'node token minted' },
          { step: 'amk_handoff', status: 'ok', message: 'account key handed off' },
          { step: 'resident_node_install', status: 'ok', message: 'loombox-node is now running' },
        ],
        deviceId: 'mac_device',
        nodeId: 'mac_node',
        ...overrides,
      };
    }

    it('offers the CTA instead of the plain no-nodes message when onProvisionLocalNode is supplied and there are no targets', () => {
      render(AddProjectDialog, {
        props: {
          open: true,
          targets: [],
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode: vi.fn(),
        },
      });

      expect(screen.getByTestId('add-project-no-targets').textContent).not.toMatch(
        /start a loombox node pointed at this relay/i,
      );
      expect(screen.getByTestId('add-project-provision-local-node').textContent).toMatch(
        /set up a node on this mac/i,
      );
    });

    it('never shows the CTA once targets exist, even with onProvisionLocalNode supplied', () => {
      render(AddProjectDialog, {
        props: {
          open: true,
          targets: TARGETS,
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode: vi.fn(),
        },
      });

      expect(screen.queryByTestId('add-project-provision-local-node')).toBeNull();
    });

    it('running it shows a working state, then a waiting-to-come-online state, which clears once the new node appears in targets', async () => {
      let resolveProvision: (outcome: ProvisionLocalNodeOutcome) => void = () => {};
      const onProvisionLocalNode = vi.fn(
        () =>
          new Promise<ProvisionLocalNodeOutcome>((resolve) => {
            resolveProvision = resolve;
          }),
      );
      const { rerender } = render(AddProjectDialog, {
        props: {
          open: true,
          targets: [],
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode,
        },
      });

      await fireEvent.click(screen.getByTestId('add-project-provision-local-node'));
      expect(onProvisionLocalNode).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('add-project-provisioning-local-node')).toBeTruthy();
      expect(screen.queryByTestId('add-project-provision-local-node')).toBeNull();

      resolveProvision(provisionOutcome());
      await waitFor(() =>
        expect(screen.getByTestId('add-project-local-node-provisioned')).toBeTruthy(),
      );
      expect(screen.queryByTestId('add-project-provisioning-local-node')).toBeNull();

      // The shell's own continuous `targets` poll (not this dialog) is what
      // eventually reports the new node — simulated here as a prop update.
      await rerender({
        open: true,
        targets: TARGETS,
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
        onProvisionLocalNode,
      });

      expect(screen.queryByTestId('add-project-local-node-provisioned')).toBeNull();
      expect(screen.getByTestId('target-picker')).toBeTruthy();
      expect(screen.getByText('This machine')).toBeTruthy();
    });

    it('surfaces a failed provisionLocalNode outcome, naming the step it stopped at, and leaves the CTA available to retry', async () => {
      const onProvisionLocalNode = vi.fn().mockResolvedValue(
        provisionOutcome({
          ok: false,
          failedStep: 'mint_node_token',
          progress: [
            { step: 'runtime_bootstrap', status: 'ok', message: 'system Node runtime resolved' },
            { step: 'target_identity', status: 'ok', message: 'device identity ready' },
            {
              step: 'mint_node_token',
              status: 'failed',
              message: 'the relay rejected the request',
            },
          ],
        }),
      );
      render(AddProjectDialog, {
        props: {
          open: true,
          targets: [],
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode,
        },
      });

      await fireEvent.click(screen.getByTestId('add-project-provision-local-node'));
      await waitFor(() =>
        expect(screen.getByTestId('add-project-provision-local-node')).toBeTruthy(),
      );
      const errorText = screen.getByText(/could not set up a node on this mac/i).textContent ?? '';
      expect(errorText).toMatch(/mint_node_token/);
      expect(errorText).toMatch(/the relay rejected the request/);
      expect(screen.queryByTestId('add-project-local-node-provisioned')).toBeNull();
    });

    it('surfaces a rejected provisionLocalNode call (e.g. the desktop bridge throwing) as the same error state', async () => {
      const onProvisionLocalNode = vi
        .fn()
        .mockRejectedValue(new Error('Setting up a node on this Mac requires the desktop app.'));
      render(AddProjectDialog, {
        props: {
          open: true,
          targets: [],
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode,
        },
      });

      await fireEvent.click(screen.getByTestId('add-project-provision-local-node'));
      await waitFor(() =>
        expect(
          screen.getByText('Setting up a node on this Mac requires the desktop app.'),
        ).toBeTruthy(),
      );
    });

    it('resets the provisioning state on close/reopen, same as every other field this dialog carries', async () => {
      const onProvisionLocalNode = vi.fn().mockResolvedValue(provisionOutcome({ ok: false }));
      const { rerender } = render(AddProjectDialog, {
        props: {
          open: true,
          targets: [],
          client: fakeClient({}),
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onProvisionLocalNode,
        },
      });

      await fireEvent.click(screen.getByTestId('add-project-provision-local-node'));
      await waitFor(() => expect(screen.getByText(/could not set up a node/i)).toBeTruthy());

      await rerender({
        open: false,
        targets: [],
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
        onProvisionLocalNode,
      });
      await rerender({
        open: true,
        targets: [],
        client: fakeClient({}),
        onClose: vi.fn(),
        onCreated: vi.fn(),
        onProvisionLocalNode,
      });

      expect(screen.queryByText(/could not set up a node/i)).toBeNull();
      expect(screen.getByTestId('add-project-provision-local-node')).toBeTruthy();
    });
  });
});
