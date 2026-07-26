// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetListEntry } from '$lib/relay-client';
import NodesPage from './NodesPage.svelte';

afterEach(() => cleanup());

const TARGETS: TargetListEntry[] = [
  {
    nodeId: 'node_1',
    targetId: 'local',
    label: 'This machine',
    kind: 'local',
    reachable: true,
  },
];

const noop = () => {};

describe('NodesPage (design spec v4 §3.1/§3.3, issue #507)', () => {
  it('renders a real page title and the TargetStatusView panel it wraps', () => {
    render(NodesPage, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        onAddTarget: noop,
        onConnectNode: noop,
      },
    });

    expect(screen.getByRole('heading', { name: 'Nodes', level: 1 })).toBeTruthy();
    expect(screen.getByTestId('target-status-view')).toBeTruthy();
    expect(screen.getByText('This machine')).toBeTruthy();
  });

  it('has no close button: a page is left by navigating elsewhere, not by dismissing it', () => {
    render(NodesPage, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        onAddTarget: noop,
        onConnectNode: noop,
      },
    });

    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(screen.queryByRole('button', { name: /^close/i })).toBeNull();
  });

  it("renders the split menu's two former setup actions as this page's primary actions", async () => {
    const onAddTarget = vi.fn();
    const onConnectNode = vi.fn();
    render(NodesPage, {
      props: {
        targets: TARGETS,
        loading: false,
        error: undefined,
        onRefresh: noop,
        onAddTarget,
        onConnectNode,
      },
    });

    await fireEvent.click(screen.getByTestId('nodes-page-add-target'));
    expect(onAddTarget).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByTestId('nodes-page-connect-node'));
    expect(onConnectNode).toHaveBeenCalledOnce();
  });

  it('reads no connected targets as a good outcome (the shared EmptyState), not a blank rectangle', () => {
    render(NodesPage, {
      props: {
        targets: [],
        loading: false,
        error: undefined,
        onRefresh: noop,
        onAddTarget: noop,
        onConnectNode: noop,
      },
    });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(
      screen.getByText(
        'No nodes or targets connected yet. Add a target or connect a node to get started.',
      ),
    ).toBeTruthy();
  });
});
