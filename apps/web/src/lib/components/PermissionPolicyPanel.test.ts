// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionPolicyV1, PermissionPolicyViolationPayloadV1 } from '@loombox/protocol';
import PermissionPolicyPanel, { type PermissionPolicyClient } from './PermissionPolicyPanel.svelte';

afterEach(() => cleanup());

function emptyPolicy(): PermissionPolicyV1 {
  return { command: { allow: [], deny: [] }, network: { allow: [], deny: [] } };
}

function fakeClient(overrides: Partial<PermissionPolicyClient> = {}): PermissionPolicyClient {
  return {
    getPermissionPolicy: vi.fn().mockResolvedValue(emptyPolicy()),
    setPermissionPolicy: vi.fn().mockResolvedValue(emptyPolicy()),
    onPermissionPolicyViolation: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe('PermissionPolicyPanel (SPEC §7.17; issue #751)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(PermissionPolicyPanel, { props: { projectPath: '/proj-a', client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.getPermissionPolicy).not.toHaveBeenCalled();
  });

  it('loads and displays the saved policy for the active session', async () => {
    const saved: PermissionPolicyV1 = {
      command: { allow: [], deny: ['rm -rf *'] },
      network: { allow: ['*.internal'], deny: [] },
    };
    const client = fakeClient({ getPermissionPolicy: vi.fn().mockResolvedValue(saved) });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => expect(client.getPermissionPolicy).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => {
      expect(screen.getByTestId('permission-policy-command-deny-list').textContent).toContain(
        'rm -rf *',
      );
      expect(screen.getByTestId('permission-policy-network-allow-list').textContent).toContain(
        '*.internal',
      );
    });
  });

  it('shows the default approval mode, derived from whether the allow list is empty, per dimension', async () => {
    const saved: PermissionPolicyV1 = {
      command: { allow: ['pnpm *'], deny: [] },
      network: { allow: [], deny: [] },
    };
    const client = fakeClient({ getPermissionPolicy: vi.fn().mockResolvedValue(saved) });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => {
      expect(screen.getByTestId('permission-policy-command-mode').textContent).toContain(
        'only listed commands run',
      );
      expect(screen.getByTestId('permission-policy-network-mode').textContent).toContain(
        'Default: allow',
      );
    });
  });

  it('adding a rule sends the full updated policy and shows the saved result back', async () => {
    const client = fakeClient({
      setPermissionPolicy: vi.fn().mockResolvedValue({
        command: { allow: [], deny: ['touch *'] },
        network: { allow: [], deny: [] },
      }),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    const input = (await screen.findByTestId(
      'permission-policy-command-deny-input',
    )) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'touch *' } });
    await fireEvent.click(screen.getByTestId('permission-policy-command-deny-add'));

    await waitFor(() =>
      expect(client.setPermissionPolicy).toHaveBeenCalledWith('sess-1', {
        command: { allow: [], deny: ['touch *'] },
        network: { allow: [], deny: [] },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('permission-policy-command-deny-list').textContent).toContain(
        'touch *',
      ),
    );
  });

  it('rejects a blank pattern at entry, with a message, without ever calling setPermissionPolicy (issue #751 acceptance)', async () => {
    const client = fakeClient();
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await screen.findByTestId('permission-policy-command-deny-input');
    await fireEvent.click(screen.getByTestId('permission-policy-command-deny-add'));

    await waitFor(() => expect(screen.getByText('Enter a pattern to add.')).toBeTruthy());
    expect(client.setPermissionPolicy).not.toHaveBeenCalled();

    // A whitespace-only pattern is rejected the same way.
    const input = screen.getByTestId('permission-policy-command-deny-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.click(screen.getByTestId('permission-policy-command-deny-add'));
    await waitFor(() => expect(screen.getByText('Enter a pattern to add.')).toBeTruthy());
    expect(client.setPermissionPolicy).not.toHaveBeenCalled();
  });

  it('removing a rule sends the policy with that rule filtered out', async () => {
    const saved: PermissionPolicyV1 = {
      command: { allow: [], deny: ['rm *', 'touch *'] },
      network: { allow: [], deny: [] },
    };
    const client = fakeClient({
      getPermissionPolicy: vi.fn().mockResolvedValue(saved),
      setPermissionPolicy: vi.fn().mockResolvedValue({
        command: { allow: [], deny: ['touch *'] },
        network: { allow: [], deny: [] },
      }),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await screen.findByTestId('permission-policy-command-deny-remove-0');
    await fireEvent.click(screen.getByTestId('permission-policy-command-deny-remove-0'));

    await waitFor(() =>
      expect(client.setPermissionPolicy).toHaveBeenCalledWith('sess-1', {
        command: { allow: [], deny: ['touch *'] },
        network: { allow: [], deny: [] },
      }),
    );
  });

  it('surfaces a load failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      getPermissionPolicy: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });

  it('a node that never answers reads as "The saved policy didn\'t answer in time...", never the raw wire message (issue #650)', async () => {
    const client = fakeClient({
      getPermissionPolicy: vi
        .fn()
        .mockRejectedValue(
          new Error('RelayClient: timed out waiting for permission_policy_get_response'),
        ),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    const notice = await waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('permission_policy_get_response');
    expect(notice.textContent).toContain("The saved policy didn't answer in time.");
  });

  it('subscribes to live violations on mount and unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    const client = fakeClient({
      onPermissionPolicyViolation: vi.fn().mockReturnValue(unsubscribe),
    });
    const { unmount } = render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() =>
      expect(client.onPermissionPolicyViolation).toHaveBeenCalledWith(
        'sess-1',
        expect.any(Function),
      ),
    );
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('a refusal caused by a deny rule names that rule in the UI (D3-4 attribution, issue #751)', async () => {
    let deliverViolation: (violation: PermissionPolicyViolationPayloadV1) => void = () => {};
    const client = fakeClient({
      onPermissionPolicyViolation: vi.fn((_sessionId, listener) => {
        deliverViolation = listener;
        return () => {};
      }),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => expect(client.onPermissionPolicyViolation).toHaveBeenCalled());

    deliverViolation({
      reason: {
        kind: 'permission_policy',
        dimension: 'command',
        rule: 'rm -rf *',
        matched: 'rm -rf /',
      },
      surface: 'terminal',
      command: 'rm -rf /',
      timestamp: '2026-08-06T00:00:00.000Z',
    });

    await waitFor(() => {
      const row = screen.getByTestId('permission-policy-violation-0');
      expect(row.textContent).toContain('Policy');
      expect(row.textContent).toContain('rm -rf *');
      expect(row.textContent).toContain('rm -rf /');
    });
  });

  it('a refusal caused by an agent profile names that profile in the UI, distinguishable from a policy refusal (D3-4 attribution, issue #752)', async () => {
    let deliverViolation: (violation: PermissionPolicyViolationPayloadV1) => void = () => {};
    const client = fakeClient({
      onPermissionPolicyViolation: vi.fn((_sessionId, listener) => {
        deliverViolation = listener;
        return () => {};
      }),
    });
    render(PermissionPolicyPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => expect(client.onPermissionPolicyViolation).toHaveBeenCalled());

    deliverViolation({
      reason: {
        kind: 'profile',
        profileId: 'prof_ask',
        profileName: 'Ask First',
        matchedBy: 'tool-kind',
        rule: 'execute',
      },
      surface: 'tool_call',
      command: 'Bash',
      timestamp: '2026-08-06T00:00:00.000Z',
    });

    await waitFor(() => {
      const row = screen.getByTestId('permission-policy-violation-0');
      expect(row.textContent).toContain('Profile');
      expect(row.textContent).not.toContain('Policy');
      expect(row.textContent).toContain('Ask First');
      expect(row.textContent).toContain('execute');
    });
  });
});
