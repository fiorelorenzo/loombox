// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
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
  it('renders fields straight off toolCall (title, rawInput) and every option by its own provider-given name', () => {
    render(PermissionCard, { props: { request, actionable: true, onResolve: vi.fn() } });
    expect(screen.getByText('Edit src/foo.ts')).toBeTruthy();
    expect(screen.getByText(/"path": "src\/foo.ts"/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow all edits/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
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

describe('PermissionCard: option buttons', () => {
  it('calls onResolve with the clicked option', async () => {
    const onResolve = vi.fn();
    render(PermissionCard, { props: { request, actionable: true, onResolve } });
    await fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect(onResolve).toHaveBeenCalledWith(request.options[2]);
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
