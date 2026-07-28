// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingPermissionRequest } from '@loombox/providers-core';
import PermissionCard from './PermissionCard.svelte';

afterEach(() => cleanup());

const request: PendingPermissionRequest = {
  requestId: 'req-1',
  sessionId: 's1',
  toolCall: {
    kind: 'tool_call',
    id: 'tc1',
    title: 'Edit src/foo.ts',
    rawInput: { path: 'src/foo.ts' },
  },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow all edits', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
  parentToolCallId: undefined,
  enqueuedAt: 0,
};

describe('PermissionCard: rendering', () => {
  it('renders fields straight off toolCall (title) and every option by its own provider-given name', () => {
    render(PermissionCard, { props: { request, actionable: true, onResolve: vi.fn() } });
    expect(screen.getByText('Edit src/foo.ts')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow all edits/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
  });

  it('renders a lone path-shaped rawInput as a path, not raw JSON (redesign v3 spec §2 C7)', () => {
    render(PermissionCard, { props: { request, actionable: true, onResolve: vi.fn() } });
    expect(screen.getByTestId('permission-raw-input-path').textContent).toContain('src/foo.ts');
  });

  it('renders a command rawInput as a single mono command line', () => {
    const withCommand: PendingPermissionRequest = {
      ...request,
      toolCall: { ...request.toolCall, rawInput: { command: 'pnpm -r test' } },
    };
    render(PermissionCard, {
      props: { request: withCommand, actionable: true, onResolve: vi.fn() },
    });
    expect(screen.getByTestId('permission-raw-input-command').textContent).toContain(
      'pnpm -r test',
    );
  });

  it('renders an unrecognized rawInput object as a formatted key/value list, never as raw JSON (redesign v3 spec §2 C7)', () => {
    const withObject: PendingPermissionRequest = {
      ...request,
      toolCall: {
        ...request.toolCall,
        rawInput: { pattern: 'TODO', recursive: true },
      },
    };
    const { container } = render(PermissionCard, {
      props: { request: withObject, actionable: true, onResolve: vi.fn() },
    });
    const list = screen.getByTestId('permission-raw-input-entries');
    expect(within(list).getByText('pattern')).toBeTruthy();
    expect(within(list).getByText('TODO')).toBeTruthy();
    expect(within(list).getByText('recursive')).toBeTruthy();
    expect(within(list).getByText('true')).toBeTruthy();
    expect(container.textContent).not.toContain('{"');
  });

  it('renders a diff via DiffViewer when the toolCall carries one', () => {
    const withDiff: PendingPermissionRequest = {
      ...request,
      toolCall: { ...request.toolCall, diff: { path: 'src/foo.ts', oldText: 'a', newText: 'b' } },
    };
    render(PermissionCard, { props: { request: withDiff, actionable: true, onResolve: vi.fn() } });
    expect(screen.getByText('src/foo.ts')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('dims and disables its option buttons when not actionable (a queued, non-head request)', () => {
    render(PermissionCard, { props: { request, actionable: false, onResolve: vi.fn() } });
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('PermissionCard: the deliberate exception to the shared card language (design spec v5 §4)', () => {
  it('never carries the shared flat .tool-card class every other tool surface converges on — interrupting is its own, heavier job', () => {
    render(PermissionCard, { props: { request, actionable: true, onResolve: vi.fn() } });
    expect(screen.getByTestId('permission-card').className).not.toMatch(/\btool-card\b/);
  });
});

describe('PermissionCard: option buttons', () => {
  it('calls onResolve with the clicked option', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve } });
    await fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect(onResolve).toHaveBeenCalledWith(request.options[2]);
  });
});

describe('PermissionCard: haptic feedback (#133)', () => {
  it('triggers a haptic cue on every confirm/deny resolve, since those are irreversible', async () => {
    const onResolve = vi.fn();
    const hapticFn = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve, hapticFn } });
    await fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect(hapticFn).toHaveBeenCalledTimes(1);
  });

  it('never triggers haptic feedback when a button is disabled (not actionable)', async () => {
    const onResolve = vi.fn();
    const hapticFn = vi.fn();
    render(PermissionCard, { props: { request, actionable: false, onResolve, hapticFn } });
    await fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect(hapticFn).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe('PermissionCard: narrow-viewport footer (#134)', () => {
  it('shows every option on a wide viewport (narrow omitted) — no overflow control', () => {
    render(PermissionCard, { props: { request, actionable: true, onResolve: vi.fn() } });
    expect(screen.queryByTestId('permission-overflow-toggle')).toBeNull();
    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow all edits/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
  });

  it('collapses to two primary actions plus an overflow control when narrow', () => {
    render(PermissionCard, {
      props: { request, actionable: true, onResolve: vi.fn(), narrow: true },
    });
    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow all edits/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Deny/ })).toBeNull();
    expect(screen.getByTestId('permission-overflow-toggle')).toBeTruthy();
  });

  it('the overflow list is reachable, scrollable, and still resolves via onResolve', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve, narrow: true } });

    expect(screen.queryByTestId('permission-options-scroll')).toBeNull();
    await fireEvent.click(screen.getByTestId('permission-overflow-toggle'));

    const scrollArea = screen.getByTestId('permission-options-scroll');
    expect(scrollArea).toBeTruthy();
    const denyButton = screen.getByRole('button', { name: /Deny/ });
    expect(scrollArea.contains(denyButton)).toBe(true);

    await fireEvent.click(denyButton);
    expect(onResolve).toHaveBeenCalledWith(request.options[2]);
  });

  it('never collapses when there are two or fewer options, even on narrow', () => {
    const twoOptionRequest: PendingPermissionRequest = {
      ...request,
      options: request.options.slice(0, 2),
    };
    render(PermissionCard, {
      props: { request: twoOptionRequest, actionable: true, onResolve: vi.fn(), narrow: true },
    });
    expect(screen.queryByTestId('permission-overflow-toggle')).toBeNull();
  });
});

describe('PermissionCard: keyboard shortcuts (#148)', () => {
  it('digit keys resolve with the matching options[] entry in order, only while the card is focused', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve } });
    const card = screen.getByTestId('permission-card');

    await fireEvent.keyDown(card, { key: '2' });

    expect(onResolve).toHaveBeenCalledWith(request.options[1]);
  });

  it('a digit outside the options range does nothing', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve } });
    await fireEvent.keyDown(screen.getByTestId('permission-card'), { key: '9' });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('Esc defers (calls onDefer) without resolving, leaving the request queued', async () => {
    const onResolve = vi.fn();
    const onDefer = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve, onDefer } });
    await fireEvent.keyDown(screen.getByTestId('permission-card'), { key: 'Escape' });
    expect(onResolve).not.toHaveBeenCalled();
    expect(onDefer).toHaveBeenCalledOnce();
  });

  it('shortcuts do not fire when the card is not actionable (not the FIFO head)', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: false, onResolve } });
    await fireEvent.keyDown(screen.getByTestId('permission-card'), { key: '1' });
    expect(onResolve).not.toHaveBeenCalled();
  });
});
