// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetListEntry } from '$lib/relay-client';
import TargetPicker from './TargetPicker.svelte';

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  { nodeId: 'node_1', targetId: 'local', label: 'This machine', kind: 'local', reachable: true },
  { nodeId: 'node_1', targetId: 'ssh_devbox', label: 'devbox', kind: 'ssh', reachable: false },
];

describe('TargetPicker (issue #385)', () => {
  it('lists every target from listTargets with its label/kind/node id', () => {
    render(TargetPicker, { props: { targets: TARGETS, value: undefined, onChange: vi.fn() } });

    const options = screen.getAllByTestId('target-option');
    expect(options).toHaveLength(2);
    expect(screen.getByText('This machine')).toBeTruthy();
    expect(screen.getByText('devbox')).toBeTruthy();
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('ssh')).toBeTruthy();
  });

  it('marks an unreachable target and disables selecting it', () => {
    render(TargetPicker, { props: { targets: TARGETS, value: undefined, onChange: vi.fn() } });

    const unreachable = screen.getByText('devbox').closest('button') as HTMLButtonElement;
    expect(unreachable.disabled).toBe(true);
    expect(screen.getByText('offline')).toBeTruthy();
  });

  it('clicking a reachable target calls onChange with its targetId', async () => {
    const onChange = vi.fn();
    render(TargetPicker, { props: { targets: TARGETS, value: undefined, onChange } });

    const local = screen.getByText('This machine').closest('button') as HTMLButtonElement;
    await fireEvent.click(local);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('marks the currently selected target', () => {
    render(TargetPicker, { props: { targets: TARGETS, value: 'local', onChange: vi.fn() } });

    const local = screen.getByText('This machine').closest('button') as HTMLButtonElement;
    expect(local.getAttribute('aria-checked')).toBe('true');
  });

  it('shows a fallback message when there are no targets', () => {
    render(TargetPicker, { props: { targets: [], value: undefined, onChange: vi.fn() } });
    expect(screen.queryAllByTestId('target-option')).toHaveLength(0);
  });
});
