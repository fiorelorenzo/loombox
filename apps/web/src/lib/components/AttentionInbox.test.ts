// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionInboxItem } from '../relay-client';
import AttentionInbox from './AttentionInbox.svelte';

afterEach(() => cleanup());

const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
];

const permissionItem: AttentionInboxItem = {
  kind: 'permission',
  sessionId: 'sess-a',
  sessionTitle: 'Fix the bug',
  projectPath: '/proj-a',
  nodeId: 'node-a',
  waitingSince: 1,
  permission: {
    requestId: 'req-1',
    sessionId: 'sess-a',
    toolCall: { kind: 'tool_call', id: 'tc-1', title: 'Run tests' },
    options: PERMISSION_OPTIONS,
    parentToolCallId: undefined,
    enqueuedAt: 1,
  },
};

const awaitingInputItem: AttentionInboxItem = {
  kind: 'awaiting_input',
  sessionId: 'sess-b',
  sessionTitle: 'Add feature',
  projectPath: '/proj-b',
  nodeId: 'node-b',
  waitingSince: 0,
};

const finishedItem: AttentionInboxItem = {
  kind: 'session_outcome',
  sessionId: 'sess-c',
  sessionTitle: 'Refactor module',
  projectPath: '/proj-c',
  nodeId: 'node-c',
  waitingSince: 2,
  outcome: 'exited',
  stopReason: 'end_turn',
};

const erroredItem: AttentionInboxItem = {
  kind: 'session_outcome',
  sessionId: 'sess-d',
  sessionTitle: 'Migrate DB',
  projectPath: '/proj-d',
  nodeId: 'node-d',
  waitingSince: 3,
  outcome: 'error',
};

const ciFailureItem: AttentionInboxItem = {
  kind: 'ci_failure',
  sessionId: 'sess-e',
  sessionTitle: 'Add CI job',
  projectPath: '/proj-e',
  nodeId: 'node-e',
  waitingSince: 4,
};

const runFailureItem: AttentionInboxItem = {
  kind: 'run_failure',
  sessionId: 'sess-h',
  sessionTitle: 'Fix the failing test',
  projectPath: '/proj-h',
  nodeId: 'node-h',
  waitingSince: 4.5,
};

const trackerUnreachableItem: AttentionInboxItem = {
  kind: 'tracker_failure',
  sessionId: 'sess-h',
  sessionTitle: 'Ship the tracker fix',
  projectPath: '/proj-h',
  nodeId: 'node-h',
  waitingSince: 7,
  trackerProvider: 'github',
  trackerConnectivityState: 'unreachable',
};

const trackerAuthFailedItem: AttentionInboxItem = {
  kind: 'tracker_failure',
  sessionId: 'sess-i',
  sessionTitle: 'Rotate the credential',
  projectPath: '/proj-i',
  nodeId: 'node-i',
  waitingSince: 8,
  trackerProvider: 'jira',
  trackerConnectivityState: 'authFailed',
};

const reviewRequestItem: AttentionInboxItem = {
  kind: 'review_request',
  sessionId: 'sess-f',
  sessionTitle: 'Open PR',
  projectPath: '/proj-f',
  nodeId: 'node-f',
  waitingSince: 5,
};

const contextLimitItem: AttentionInboxItem = {
  kind: 'context_limit',
  sessionId: 'sess-j',
  sessionTitle: 'Long research turn',
  projectPath: '/proj-j',
  nodeId: 'node-j',
  waitingSince: 6,
  contextPercent: 85,
  tokensUsed: 170_000,
  contextWindow: 200_000,
};

describe('AttentionInbox: empty state', () => {
  it('shows an empty-state message and no items when there is nothing to surface', () => {
    render(AttentionInbox, {
      props: { items: [], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy();
    expect(screen.queryAllByTestId('attention-inbox-item')).toHaveLength(0);
  });
});

describe('AttentionInbox: rendering (issue #167)', () => {
  it('renders one row per item, in the given order, each showing the session title, project, and what it needs', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByText('Add feature')).toBeTruthy();
    expect(within(rows[0]).getByText('/proj-b · node-b')).toBeTruthy();
    expect(within(rows[0]).getByText('Waiting for your reply')).toBeTruthy();

    expect(within(rows[1]).getByText('Fix the bug')).toBeTruthy();
    expect(within(rows[1]).getByText('/proj-a · node-a')).toBeTruthy();
    expect(within(rows[1]).getByText('Needs approval: Run tests')).toBeTruthy();
  });

  it('renders the project path and node id in the shared mono identifier face (#735)', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(within(rows[0]).getByText('/proj-b · node-b').className).toContain('font-mono');
  });

  it('renders a permission item with its actionable PermissionCard (issue #168), but no card for an awaiting_input item', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getAllByTestId('permission-card')).toHaveLength(1);
  });
});

describe('AttentionInbox: inline actions (issue #168)', () => {
  it('calls onResolve with the session id, request id, and chosen option once the answer window elapses (E2-1, issue #671)', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: { items: [permissionItem], onResolve, onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onResolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResolve).toHaveBeenCalledWith('sess-a', 'req-1', PERMISSION_OPTIONS[0]);
    vi.useRealTimers();
  });

  it('calls onOpenSession with the item session id when its Open control is pressed', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession, onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-b');
  });

  it('shows an inline reply composer only for an awaiting_input item, not a permission item', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getAllByTestId('attention-inbox-reply')).toHaveLength(1);
  });

  it('calls onReply with the session id and typed text once the answer window elapses, and the draft stays cleared if undone', async () => {
    vi.useFakeTimers();
    const onReply = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply },
    });
    const input = screen.getByTestId('attention-inbox-reply-input');
    await fireEvent.input(input, { target: { value: 'go ahead and merge it' } });
    await fireEvent.click(screen.getByTestId('attention-inbox-reply-send'));

    // The form (and its input) is swapped for the dimmed outcome while pending.
    expect(screen.queryByTestId('attention-inbox-reply-input')).toBeNull();
    expect(onReply).not.toHaveBeenCalled();

    // Undo brings the form back with the draft cleared, not restored.
    await fireEvent.click(screen.getByTestId('attention-inbox-answer-undo'));
    expect((screen.getByTestId('attention-inbox-reply-input') as HTMLInputElement).value).toBe('');

    await fireEvent.input(screen.getByTestId('attention-inbox-reply-input'), {
      target: { value: 'go ahead and merge it' },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-reply-send'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(onReply).toHaveBeenCalledWith('sess-b', 'go ahead and merge it');
    vi.useRealTimers();
  });

  it('does not call onReply when the composer is submitted empty', async () => {
    const onReply = vi.fn();
    render(AttentionInbox, {
      props: { items: [awaitingInputItem], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-reply-send'));
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe('AttentionInbox: session-outcome class (issue #167, SPEC §7.13)', () => {
  it('renders a finished session distinctly from an errored one, neither with a permission card or reply composer', () => {
    render(AttentionInbox, {
      props: {
        items: [finishedItem, erroredItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(rows[0].dataset.kind).toBe('session_outcome');
    expect(within(rows[0]).getByText('Finished: end_turn')).toBeTruthy();
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Exited');

    expect(rows[1].dataset.kind).toBe('session_outcome');
    expect(within(rows[1]).getByTestId('attention-inbox-need').textContent).toBe('Errored');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Error');

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);
  });

  it('lets Open jump to the originating session from a session-outcome row', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: { items: [erroredItem], onResolve: vi.fn(), onOpenSession, onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-d');
  });
});

describe('AttentionInbox: target-health context on a stalled/errored row (issue #204)', () => {
  it('shows the target-health note for an awaiting_input row when the caller found relevant context', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem],
        targetHealthBySessionId: new Map([
          ['sess-b', { state: 'overloaded' as const, message: 'target overloaded — load 96%' }],
        ]),
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const note = screen.getByTestId('attention-inbox-target-health');
    expect(note.textContent?.trim()).toBe('target overloaded — load 96%');
    expect(note.dataset.tone).toBe('overloaded');
  });

  it('shows it for an errored session_outcome row too, but never for a finished (exited) one', () => {
    render(AttentionInbox, {
      props: {
        items: [finishedItem, erroredItem],
        targetHealthBySessionId: new Map([
          ['sess-c', { state: 'unreachable' as const, message: 'should never render' }],
          [
            'sess-d',
            { state: 'unreachable' as const, message: 'target unreachable — last checked 2m ago' },
          ],
        ]),
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const notes = screen.getAllByTestId('attention-inbox-target-health');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent?.trim()).toBe('target unreachable — last checked 2m ago');
  });

  it("never shows it for a permission row, even if the caller's map happens to carry an entry for that session", () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem],
        targetHealthBySessionId: new Map([
          ['sess-a', { state: 'no-data' as const, message: 'should never render' }],
        ]),
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.queryByTestId('attention-inbox-target-health')).toBeNull();
  });

  it('renders no note at all when no target-health map is supplied (existing callers keep the plain v1 row)', () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, erroredItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.queryByTestId('attention-inbox-target-health')).toBeNull();
  });
});

describe('AttentionInbox: ci_failure (issue #243) and review_request (issue #240) are both live', () => {
  it('renders both classes with their own badge and needs-attention label, and an Open action, with no permission card or reply composer', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [ciFailureItem, reviewRequestItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(rows[0].dataset.kind).toBe('ci_failure');
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('CI');
    expect(within(rows[0]).getByText('CI check failed')).toBeTruthy();

    expect(rows[1].dataset.kind).toBe('review_request');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Review');
    expect(within(rows[1]).getByText('Review requested')).toBeTruthy();

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);

    await fireEvent.click(within(rows[0]).getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-e');
  });
});

describe('AttentionInbox: tracker_failure is live (SPEC §7.10/§7.13; issue #219)', () => {
  it('renders unreachable and authFailed with distinct wording and their own badge, and an Open action, with no permission card or reply composer', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [trackerUnreachableItem, trackerAuthFailedItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(2);

    expect(rows[0].dataset.kind).toBe('tracker_failure');
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Tracker');
    expect(within(rows[0]).getByText(/GitHub tracker unreachable — retrying/)).toBeTruthy();

    expect(rows[1].dataset.kind).toBe('tracker_failure');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe(
      'Tracker auth',
    );
    expect(
      within(rows[1]).getByText(/Jira tracker credential expired or was revoked/),
    ).toBeTruthy();

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);

    await fireEvent.click(within(rows[0]).getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-h');
  });
});

describe('AttentionInbox: ci_failure carries actionable detail (issue #243)', () => {
  const wiredCiFailureItem: AttentionInboxItem = {
    kind: 'ci_failure',
    sessionId: 'sess-g',
    sessionTitle: 'Add CI job',
    projectPath: '/proj-g',
    nodeId: 'node-g',
    waitingSince: 6,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/12',
    prNumber: 12,
    failingChecks: ['test (unit)', 'lint'],
  };

  it('names the failing check(s) in the row body instead of a bare "CI check failed"', () => {
    render(AttentionInbox, {
      props: {
        items: [wiredCiFailureItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getByText('CI check failed: test (unit), lint')).toBeTruthy();
  });

  it('links straight to the PR the check is failing on', () => {
    render(AttentionInbox, {
      props: {
        items: [wiredCiFailureItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const link = screen.getByTestId('attention-inbox-ci-pr-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/fiorelorenzo/loombox/pull/12');
    expect(link.textContent).toBe('View PR #12');
    expect(link.target).toBe('_blank');
  });

  it('renders no PR link when the item has no prUrl yet', () => {
    render(AttentionInbox, {
      props: {
        items: [ciFailureItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.queryByTestId('attention-inbox-ci-pr-link')).toBeNull();
  });
});

describe('AttentionInbox: all four classes are visually distinguishable (issue #167 acceptance)', () => {
  it('gives every class its own data-kind and its own badge text, not shared across classes', () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem, awaitingInputItem, finishedItem, ciFailureItem, reviewRequestItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    const kinds = rows.map((row) => row.dataset.kind);
    expect(new Set(kinds).size).toBe(kinds.length);

    const badges = screen
      .getAllByTestId('attention-inbox-kind-badge')
      .map((badge) => badge.textContent);
    expect(new Set(badges).size).toBe(badges.length);
  });
});

describe('AttentionInbox: agent message in full, no digit badge (E1-3 amended, issue #671)', () => {
  it("renders the agent's real last message in full for a permission item, not the derived need label", () => {
    const withMessage: AttentionInboxItem = {
      ...permissionItem,
      agentMessage: 'I need to run the test suite before touching anything else.',
    };
    render(AttentionInbox, {
      props: { items: [withMessage], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    const message = screen.getByTestId('attention-inbox-need');
    expect(message.textContent).toContain(
      'I need to run the test suite before touching anything else.',
    );
    expect(message.textContent).not.toContain('Needs approval');
  });

  it("renders the agent's real last message in full for an awaiting_input item", () => {
    const withMessage: AttentionInboxItem = {
      ...awaitingInputItem,
      agentMessage: 'Done with the migration — want me to run it against staging next?',
    };
    render(AttentionInbox, {
      props: { items: [withMessage], onResolve: vi.fn(), onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    expect(screen.getByTestId('attention-inbox-need').textContent).toContain(
      'Done with the migration — want me to run it against staging next?',
    );
  });

  it('falls back to the derived label when the item has no agent message yet', () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getByTestId('attention-inbox-need').textContent).toBe(
      'Needs approval: Run tests',
    );
  });

  it('renders permission options with no leading digit badge', () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const allow = screen.getByRole('button', { name: /Allow/ });
    const deny = screen.getByRole('button', { name: /Deny/ });
    expect(allow.textContent?.trim()).toBe('Allow');
    expect(deny.textContent?.trim()).toBe('Deny');
  });
});

describe('AttentionInbox: answering dims and offers undo, queue-wide (E2-1, issue #671)', () => {
  afterEach(() => vi.useRealTimers());

  it('dims the row and shows the outcome immediately, without removing it, then commits and clears after the window', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: { items: [permissionItem], onResolve, onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Allow/ }));

    expect(screen.getAllByTestId('attention-inbox-item')).toHaveLength(1);
    expect(screen.queryByTestId('permission-card')).toBeNull();
    expect(screen.getByTestId('attention-inbox-answer-outcome').textContent).toContain('Allow');
    expect(onResolve).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(onResolve).toHaveBeenCalledWith('sess-a', 'req-1', PERMISSION_OPTIONS[0]);
  });

  it('undo restores the row before the real callback ever fires, not merely cancelling the timer', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: { items: [permissionItem], onResolve, onOpenSession: vi.fn(), onReply: vi.fn() },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    await fireEvent.click(screen.getByTestId('attention-inbox-answer-undo'));

    // Restored: the live, actionable PermissionCard is back, not a frozen outcome.
    expect(screen.getByTestId('permission-card')).toBeTruthy();
    expect(screen.queryByTestId('attention-inbox-answer-outcome')).toBeNull();

    await vi.advanceTimersByTimeAsync(10000);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('the queue path: answering two items and undoing one only ever commits the one left standing, and a third untouched item never fires at all', async () => {
    vi.useFakeTimers();
    const secondPermission: AttentionInboxItem = {
      ...permissionItem,
      sessionId: 'sess-b2',
      sessionTitle: 'Ship the release',
      permission: {
        ...permissionItem.permission!,
        requestId: 'req-2',
        sessionId: 'sess-b2',
      },
    };
    const thirdPermission: AttentionInboxItem = {
      ...permissionItem,
      sessionId: 'sess-c3',
      sessionTitle: 'Untouched session',
      permission: {
        ...permissionItem.permission!,
        requestId: 'req-3',
        sessionId: 'sess-c3',
      },
    };
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [permissionItem, secondPermission, thirdPermission],
        onResolve,
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });

    const rows = screen.getAllByTestId('attention-inbox-item');
    await fireEvent.click(within(rows[0]).getByRole('button', { name: /Allow/ }));
    await fireEvent.click(within(rows[1]).getByRole('button', { name: /Allow/ }));
    // Undo the second answer only — the first stays scheduled, the third was never touched.
    await fireEvent.click(within(rows[1]).getByTestId('attention-inbox-answer-undo'));

    await vi.advanceTimersByTimeAsync(3000);

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('sess-a', 'req-1', PERMISSION_OPTIONS[0]);
    expect(onResolve).not.toHaveBeenCalledWith('sess-b2', 'req-2', expect.anything());
    expect(onResolve).not.toHaveBeenCalledWith('sess-c3', 'req-3', expect.anything());
    // The untouched third row is still fully interactive.
    expect(within(rows[2]).getByTestId('permission-card')).toBeTruthy();
  });
});

describe('AttentionInbox: keyboard-first triage (E3-1, issue #671)', () => {
  afterEach(() => vi.useRealTimers());

  it('states the digit shortcut in the hint bar, its only advertisement now the badge is gone (spec §0 conflict resolution)', () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const hints = screen.getByTestId('attention-inbox-hints').textContent ?? '';
    expect(hints).toMatch(/1.*9|digit/i);
    expect(hints.toLowerCase()).toContain('j');
    expect(hints.toLowerCase()).toContain('k');
  });

  it('j/k move the list-wide focus cursor between rows', async () => {
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows[0].className).toMatch(/ui-row-active/);
    expect(rows[1].className).not.toMatch(/ui-row-active/);

    await fireEvent.keyDown(window, { key: 'j' });
    expect(rows[0].className).not.toMatch(/ui-row-active/);
    expect(rows[1].className).toMatch(/ui-row-active/);

    await fireEvent.keyDown(window, { key: 'k' });
    expect(rows[0].className).toMatch(/ui-row-active/);
    expect(rows[1].className).not.toMatch(/ui-row-active/);
  });

  it('a digit key answers the focused row, not necessarily the first one', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve,
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    await fireEvent.keyDown(window, { key: 'j' }); // move onto the permission row
    await fireEvent.keyDown(window, { key: '2' }); // Deny is PERMISSION_OPTIONS[1]

    await vi.advanceTimersByTimeAsync(3000);
    expect(onResolve).toHaveBeenCalledWith('sess-a', 'req-1', PERMISSION_OPTIONS[1]);
  });

  it("Enter moves real focus into the focused row's reply box", async () => {
    render(AttentionInbox, {
      props: {
        items: [permissionItem, awaitingInputItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    await fireEvent.keyDown(window, { key: 'j' }); // move onto the awaiting_input row
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByTestId('attention-inbox-reply-input'));
  });

  it('does not hijack j/k/digits while the user is typing in the reply box', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [permissionItem, awaitingInputItem],
        onResolve,
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const input = screen.getByTestId('attention-inbox-reply-input');
    input.focus();
    await fireEvent.keyDown(input, { key: '1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attention-inbox-answer-outcome')).toBeNull();
  });

  it('mouse interaction still works exactly as before alongside keyboard nav', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [awaitingInputItem, permissionItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    await fireEvent.click(screen.getAllByTestId('attention-inbox-open')[1]);
    expect(onOpenSession).toHaveBeenCalledWith('sess-a');
  });
});

describe("AttentionInbox: run_failure is live (issue #247), sharing ci_failure's own shape", () => {
  it('renders its own badge and needs-attention label, and an Open action, with no permission card or reply composer', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [runFailureItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(1);

    expect(rows[0].dataset.kind).toBe('run_failure');
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Run');
    expect(within(rows[0]).getByText('Local run failed')).toBeTruthy();

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);

    await fireEvent.click(within(rows[0]).getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-h');
  });

  it('names the failing run kind(s) in the row body instead of a bare "Local run failed"', () => {
    render(AttentionInbox, {
      props: {
        items: [{ ...runFailureItem, failingRuns: ['test', 'lint'] }],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    expect(screen.getByText('Local run failed: test, lint')).toBeTruthy();
  });

  it('renders alongside a ci_failure item as two distinct rows, in the given order, each with its own badge — neither one hides the other', () => {
    render(AttentionInbox, {
      props: {
        items: [runFailureItem, ciFailureItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows.map((row) => row.dataset.kind)).toEqual(['run_failure', 'ci_failure']);
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Run');
    expect(within(rows[1]).getByTestId('attention-inbox-kind-badge').textContent).toBe('CI');
  });
});

describe('AttentionInbox: context_limit is live (SPEC §7.9; issue #250)', () => {
  it('renders its own warning badge and percentage in the row body, and an Open action, with no permission card or reply composer', async () => {
    const onOpenSession = vi.fn();
    render(AttentionInbox, {
      props: {
        items: [contextLimitItem],
        onResolve: vi.fn(),
        onOpenSession,
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows).toHaveLength(1);

    expect(rows[0].dataset.kind).toBe('context_limit');
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Context');
    expect(within(rows[0]).getByText('Context window nearly full — 85% used')).toBeTruthy();

    expect(screen.queryAllByTestId('permission-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('attention-inbox-reply')).toHaveLength(0);

    await fireEvent.click(within(rows[0]).getByTestId('attention-inbox-open'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-j');
  });

  it('renders alongside a ci_failure item as two distinct rows — a session can be both near its context limit and have a failing check at once', () => {
    render(AttentionInbox, {
      props: {
        items: [contextLimitItem, ciFailureItem],
        onResolve: vi.fn(),
        onOpenSession: vi.fn(),
        onReply: vi.fn(),
      },
    });
    const rows = screen.getAllByTestId('attention-inbox-item');
    expect(rows.map((row) => row.dataset.kind)).toEqual(['context_limit', 'ci_failure']);
    expect(within(rows[0]).getByTestId('attention-inbox-kind-badge').textContent).toBe('Context');
  });
});
