// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetFsListResponsePayloadV1 } from '@loombox/protocol';
import { loadRecentPaths } from '$lib/recent-paths';
import DirectoryPicker, { type DirectoryPickerClient } from './DirectoryPicker.svelte';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

describe('DirectoryPicker (SPEC §7.25 directory picker; issue #474)', () => {
  it('keeps the same labelled input shape (disabled), rather than swapping to prose, when no target is selected yet (design spec §0.7)', () => {
    const { container } = render(DirectoryPicker, {
      props: {
        client: undefined,
        nodeId: undefined,
        targetId: undefined,
        value: '',
        onChange: vi.fn(),
      },
    });
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.queryByTestId('directory-picker-no-target')).toBeNull();
    expect(container.querySelector('p')).toBeNull();
  });

  it('browses the target on mount (empty path == "let the node pick") and lists dirs then files', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [
          { name: 'projects', kind: 'dir', size: 0 },
          { name: '.bashrc', kind: 'file', size: 220 },
        ],
      },
    });
    const onChange = vi.fn();
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange },
    });

    await waitFor(() => expect(screen.getByTestId('directory-picker-entry')).toBeTruthy());
    expect(client.browseDirectory).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'local',
      path: '',
    });
    expect(screen.getByText('projects')).toBeTruthy();
    expect(screen.getByText('.bashrc')).toBeTruthy();
    expect(screen.getByTestId('directory-picker-file')).toBeTruthy();
    // The initial landing-on-home-dir browse is just a starting point, not
    // itself a pick — it must never call onChange (that would race a
    // caller/user setting `value` in the meantime; see `navigate`'s
    // `reportSelection` doc comment). Only an explicit navigation
    // (typing+Enter, or clicking a breadcrumb/entry/recent-path) does.
    expect(onChange).not.toHaveBeenCalled();
    // It's still shown as an editable breadcrumb, ready to browse further.
    expect((screen.getByTestId('directory-picker-input') as HTMLInputElement).value).toBe(
      '/home/lorenzo',
    );
    expect(screen.getAllByTestId('directory-picker-breadcrumb-segment').length).toBeGreaterThan(1);
  });

  it('clicking a directory entry navigates into it, fetching lazily (not eagerly walking the tree)', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'projects', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/projects': {
        outcome: 'ok',
        path: '/home/lorenzo/projects',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });

    await waitFor(() => expect(screen.getByText('projects')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('directory-picker-entry'));

    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());
    expect(client.browseDirectory).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'local',
      path: '/home/lorenzo/projects',
    });
    // Only the two directories actually visited were fetched — never a
    // third, unvisited one.
    expect(client.browseDirectory).toHaveBeenCalledTimes(2);
  });

  it('typing a path and pressing Enter navigates there directly', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      '/etc': { outcome: 'ok', path: '/etc', entries: [{ name: 'hosts', kind: 'file', size: 12 }] },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });
    // Wait for the initial browse to fully settle (not just for the call to
    // have started) before typing over it, so this isn't racing the async
    // chain that seeds the input with the resolved home directory.
    await waitFor(() =>
      expect((screen.getByTestId('directory-picker-input') as HTMLInputElement).value).toBe(
        '/home/lorenzo',
      ),
    );

    await fireEvent.input(screen.getByTestId('directory-picker-input'), {
      target: { value: '/etc' },
    });
    await fireEvent.keyDown(screen.getByTestId('directory-picker-input'), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('hosts')).toBeTruthy());
    expect(client.browseDirectory).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'local',
      path: '/etc',
    });
  });

  it('reports every keystroke via onChange immediately, without browsing on every one (mirrors the plain-input contract it replaces)', async () => {
    const client = fakeClient({ '': { outcome: 'ok', path: '/home/lorenzo', entries: [] } });
    const onChange = vi.fn();
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange },
    });
    await waitFor(() =>
      expect((screen.getByTestId('directory-picker-input') as HTMLInputElement).value).toBe(
        '/home/lorenzo',
      ),
    );
    onChange.mockClear();
    const callsBeforeTyping = (client.browseDirectory as ReturnType<typeof vi.fn>).mock.calls
      .length;

    await fireEvent.input(screen.getByTestId('directory-picker-input'), {
      target: { value: '/home/dev/project' },
    });

    expect(onChange).toHaveBeenCalledWith('/home/dev/project');
    // Typing alone never triggers a browseDirectory round trip — only
    // Enter/a breadcrumb/entry/recent-path click does.
    expect((client.browseDirectory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBeforeTyping,
    );
  });

  it('clicking a breadcrumb segment navigates back up to it', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo/projects',
        entries: [{ name: 'loombox', kind: 'dir', size: 0 }],
      },
      '/home': {
        outcome: 'ok',
        path: '/home',
        entries: [{ name: 'lorenzo', kind: 'dir', size: 0 }],
      },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });
    await waitFor(() => expect(screen.getByText('loombox')).toBeTruthy());

    const segments = screen.getAllByTestId('directory-picker-breadcrumb-segment');
    // segments: ['/', 'home', 'lorenzo', 'projects'] — click "home".
    const homeSegment = segments.find((el) => el.textContent?.trim() === 'home')!;
    await fireEvent.click(homeSegment);

    await waitFor(() => expect(screen.getByText('lorenzo')).toBeTruthy());
    expect(client.browseDirectory).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'local',
      path: '/home',
    });
  });

  it('records an explicitly-picked directory (not the passive initial landing) to the recent-paths list, scoped by nodeId:targetId', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'projects', kind: 'dir', size: 0 }],
      },
      '/home/lorenzo/projects': {
        outcome: 'ok',
        path: '/home/lorenzo/projects',
        entries: [],
      },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });
    await waitFor(() => expect(screen.getByText('projects')).toBeTruthy());
    // The passive initial landing never records anything.
    expect(loadRecentPaths('node_1:local')).toEqual([]);

    await fireEvent.click(screen.getByTestId('directory-picker-entry'));

    await waitFor(() =>
      expect(loadRecentPaths('node_1:local')).toEqual(['/home/lorenzo/projects']),
    );
  });

  it('shows a previously recorded recent path and navigates to it on click', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      '/home/lorenzo/old-project': {
        outcome: 'ok',
        path: '/home/lorenzo/old-project',
        entries: [{ name: 'README.md', kind: 'file', size: 4 }],
      },
    });
    localStorage.setItem(
      'loombox:recent-paths:node_1:local',
      JSON.stringify(['/home/lorenzo/old-project']),
    );

    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });

    await waitFor(() => expect(screen.getByTestId('directory-picker-recent-path')).toBeTruthy());
    expect(screen.getByText('/home/lorenzo/old-project')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('directory-picker-recent-path'));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
  });

  it('surfaces an error outcome as an ErrorNotice instead of hanging', async () => {
    const client = fakeClient({
      '': { outcome: 'error', path: '', message: 'permission denied' },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });

    await waitFor(() => expect(screen.getByText('permission denied')).toBeTruthy());
  });

  it('re-browses from scratch when the selected target changes', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
    });
    const { rerender } = render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });
    await waitFor(() => expect(client.browseDirectory).toHaveBeenCalledTimes(1));

    const sshClient = fakeClient({
      '': { outcome: 'ok', path: '/root', entries: [] },
    });
    await rerender({
      client: sshClient,
      nodeId: 'node_1',
      targetId: 'ssh_devbox',
      value: '',
      onChange: vi.fn(),
    });

    await waitFor(() => expect(sshClient.browseDirectory).toHaveBeenCalledTimes(1));
    expect(sshClient.browseDirectory).toHaveBeenCalledWith({
      nodeId: 'node_1',
      targetId: 'ssh_devbox',
      path: '',
    });
  });

  it('shows a quiet "Git repository" marker on the current path when the listing reports gitRepo: true, and reports it as onChange\'s second argument', async () => {
    const client = fakeClient({
      '': {
        outcome: 'ok',
        path: '/home/lorenzo',
        entries: [{ name: 'projects', kind: 'dir', size: 0 }],
        gitRepo: false,
      },
      '/home/lorenzo/projects': {
        outcome: 'ok',
        path: '/home/lorenzo/projects',
        entries: [],
        gitRepo: true,
      },
    });
    const onChange = vi.fn();
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange },
    });

    await waitFor(() => expect(screen.getByText('projects')).toBeTruthy());
    expect(screen.queryByTestId('directory-picker-git-badge')).toBeNull();

    await fireEvent.click(screen.getByTestId('directory-picker-entry'));

    await waitFor(() => expect(screen.getByTestId('directory-picker-git-badge')).toBeTruthy());
    expect(onChange).toHaveBeenCalledWith('/home/lorenzo/projects', true);
  });

  it("treats an omitted gitRepo (an older node) as unknown rather than false: no marker, and onChange's second argument is undefined", async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
      '/etc': { outcome: 'ok', path: '/etc', entries: [] },
    });
    const onChange = vi.fn();
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange },
    });
    await waitFor(() =>
      expect((screen.getByTestId('directory-picker-input') as HTMLInputElement).value).toBe(
        '/home/lorenzo',
      ),
    );

    await fireEvent.input(screen.getByTestId('directory-picker-input'), {
      target: { value: '/etc' },
    });
    await fireEvent.keyDown(screen.getByTestId('directory-picker-input'), { key: 'Enter' });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/etc', undefined));
    expect(screen.queryByTestId('directory-picker-git-badge')).toBeNull();
  });

  it("replaces a rejected browseDirectory's raw wire message with human copy and a working Retry action (issue #505)", async () => {
    let attempts = 0;
    const client: DirectoryPickerClient = {
      browseDirectory: vi.fn(async (): Promise<TargetFsListResponsePayloadV1> => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('RelayClient: timed out waiting for target_fs_list_response');
        }
        return { outcome: 'ok', path: '/home/lorenzo', entries: [] };
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });

    await waitFor(() => expect(screen.getByTestId('ui-error-notice')).toBeTruthy());
    const notice = screen.getByTestId('ui-error-notice');
    expect(notice.textContent).not.toMatch(/target_fs_list_response/);
    expect(notice.textContent).toMatch(/didn't respond/i);
    expect(warnSpy).toHaveBeenCalledWith(
      'DirectoryPicker: browseDirectory failed',
      expect.any(Error),
    );

    await fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getByTestId('directory-picker-input')).toBeTruthy());
    expect(client.browseDirectory).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('does not re-browse when only `value` changes without the target changing (e.g. a parent reactively echoing typed input back down): only a real target change re-triggers the initial browse (issue #507 regression, AddProjectDialog binds `value` back to its own state on every keystroke)', async () => {
    const client = fakeClient({
      '': { outcome: 'ok', path: '/home/lorenzo', entries: [] },
    });
    render(DirectoryPicker, {
      props: { client, nodeId: 'node_1', targetId: 'local', value: '', onChange: vi.fn() },
    });
    await waitFor(() => expect(client.browseDirectory).toHaveBeenCalledTimes(1));

    await fireEvent.input(screen.getByTestId('directory-picker-input'), {
      target: { value: '/tmp/typed' },
    });

    expect(client.browseDirectory).toHaveBeenCalledTimes(1);
  });

  it('`.recent-path:hover` reads `--color-fill-subtle`, a real defined token, not silently doing nothing (issue #508 token-hygiene finding: the property it referenced before this fix was never declared anywhere in styles/*.css). `styles/tokens.test.ts` guards the general no-undefined-custom-property contract repo-wide; this pins the specific rule that regression lived in.', () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'DirectoryPicker.svelte');
    const source = readFileSync(sourcePath, 'utf8');
    const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)?.[1];
    const hoverRule = styleBlock?.match(/\.recent-path:hover\s*\{([^}]*)\}/);
    expect(hoverRule).not.toBeNull();
    expect(hoverRule?.[1]).toContain('var(--color-fill-subtle)');
  });
});
