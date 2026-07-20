// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPermissionQueueState,
  enqueuePermissionRequest,
  type PermissionQueueState,
} from '@loombox/providers-core';
import PermissionQueueBar from './PermissionQueueBar.svelte';

afterEach(() => cleanup());

const OPTIONS = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }];

function seedThree(): PermissionQueueState {
  let state = createPermissionQueueState();
  state = enqueuePermissionRequest(state, {
    requestId: 'r1',
    sessionId: 's1',
    toolCall: { kind: 'tool_call', id: 'tc1', title: 'first' },
    options: OPTIONS,
  }).state;
  state = enqueuePermissionRequest(state, {
    requestId: 'r2',
    sessionId: 's1',
    toolCall: { kind: 'tool_call', id: 'tc2', title: 'second' },
    options: OPTIONS,
  }).state;
  state = enqueuePermissionRequest(state, {
    requestId: 'r3',
    sessionId: 's1',
    toolCall: { kind: 'tool_call', id: 'tc3', title: 'third' },
    options: OPTIONS,
  }).state;
  return state;
}

describe('PermissionQueueBar', () => {
  it('renders nothing when the session has no pending requests', () => {
    render(PermissionQueueBar, {
      props: {
        sessionId: 's1',
        queue: createPermissionQueueState(),
        onResolve: vi.fn(),
        onStop: vi.fn(),
      },
    });
    expect(screen.queryByTestId('permission-queue-bar')).toBeNull();
  });

  it('shows only the FIFO head as the focused, actionable card — one at a time', () => {
    render(PermissionQueueBar, {
      props: { sessionId: 's1', queue: seedThree(), onResolve: vi.fn(), onStop: vi.fn() },
    });
    expect(screen.getAllByTestId('permission-card')).toHaveLength(1);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('3 pending')).toBeTruthy();
  });

  it('calls onResolve with the head request id and the chosen option', async () => {
    const onResolve = vi.fn();
    render(PermissionQueueBar, {
      props: { sessionId: 's1', queue: seedThree(), onResolve, onStop: vi.fn() },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onResolve).toHaveBeenCalledWith('r1', OPTIONS[0]);
  });

  it('calls onStop when the Stop button is pressed', async () => {
    const onStop = vi.fn();
    render(PermissionQueueBar, {
      props: { sessionId: 's1', queue: seedThree(), onResolve: vi.fn(), onStop },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('forwards narrow to PermissionCard and marks the bar itself reachable/sticky (issue #134)', () => {
    render(PermissionQueueBar, {
      props: {
        sessionId: 's1',
        queue: seedThree(),
        onResolve: vi.fn(),
        onStop: vi.fn(),
        narrow: true,
      },
    });
    expect(screen.getByTestId('permission-queue-bar').className).toContain('narrow');
  });

  it('never blocks a different session — an empty queue for another session renders nothing even if this one has pending requests', () => {
    render(PermissionQueueBar, {
      props: { sessionId: 's2', queue: seedThree(), onResolve: vi.fn(), onStop: vi.fn() },
    });
    expect(screen.queryByTestId('permission-queue-bar')).toBeNull();
  });
});
