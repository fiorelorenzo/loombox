// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerTypeDefinitionV1 } from '@loombox/protocol';
import TrackerManageTypesDialog, {
  type TrackerTypeClient,
} from './TrackerManageTypesDialog.svelte';

afterEach(() => cleanup());

/**
 * v7 decision F3-1 (issue #673): "New type" moves off the Tracker page
 * header and behind this dialog, and the type-definition form stops being
 * write-only — a type defined here has to still be visible here, and
 * survive a reload. This suite proves both: a plain rendering test for the
 * list, the internal list/define view swap, and a round trip through a
 * real (if minimal) backend that persists independently of the Svelte
 * component tree — not the component's own `$state`, which the last test
 * proves by literally unmounting and remounting a fresh instance.
 */

const TASK_TYPE: TrackerTypeDefinitionV1 = {
  id: 'task',
  label: 'Task',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

const BUG_TYPE: TrackerTypeDefinitionV1 = {
  id: 'bug',
  label: 'Bug',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

const EPIC_TYPE: TrackerTypeDefinitionV1 = {
  id: 'epic',
  label: 'Epic',
  builtin: true,
  roles: { title: 'title', workflowStatus: 'status', priority: 'priority', assignee: 'assignee' },
};

const BUILTINS = [TASK_TYPE, BUG_TYPE, EPIC_TYPE];

/**
 * Mirrors `NativeTrackerStore.defineType()`/`listTypes()`'s own contract
 * (replace-by-id, built-ins always included) but lives entirely in this
 * test file — the node-side store itself is already covered end to end by
 * `native-tracker-store.test.ts`'s "persists across a simulated restart"
 * test, and the wire round trip by `relay-client.test.ts`'s
 * `defineTrackerType` suite. What's untested before this file is whether
 * the DIALOG actually shows back what it was told, which is the whole
 * point of the "write-only form" complaint — so this fake stands in for
 * "the real backend, however many hops away", deliberately outside the
 * component under test, so a passing round-trip test can't be an artifact
 * of Svelte state surviving a re-render.
 */
class FakeTrackerTypeBackend {
  private custom: TrackerTypeDefinitionV1[] = [];

  listTypes(): TrackerTypeDefinitionV1[] {
    return [...BUILTINS, ...this.custom];
  }

  defineTrackerType: TrackerTypeClient['defineTrackerType'] = async (type) => {
    const defined: TrackerTypeDefinitionV1 = { ...type, builtin: false };
    this.custom = [...this.custom.filter((existing) => existing.id !== defined.id), defined];
    return defined;
  };
}

describe('TrackerManageTypesDialog (v7 decision F3-1; issue #673)', () => {
  it('lists every known type, marking the built-ins', () => {
    render(TrackerManageTypesDialog, {
      props: {
        open: true,
        client: { defineTrackerType: vi.fn() },
        types: BUILTINS,
        onClose: vi.fn(),
        onDefined: vi.fn(),
      },
    });

    expect(screen.getByTestId('tracker-type-row-task').textContent).toMatch(/Task/);
    expect(screen.getByTestId('tracker-type-row-bug').textContent).toMatch(/Bug/);
    expect(screen.getByTestId('tracker-type-row-epic').textContent).toMatch(/Epic/);
    expect(screen.getAllByText('Built in')).toHaveLength(3);
  });

  it('"New type" swaps the SAME dialog to the define-type view (never a second stacked overlay), and Cancel swaps back to the list', async () => {
    render(TrackerManageTypesDialog, {
      props: {
        open: true,
        client: { defineTrackerType: vi.fn() },
        types: BUILTINS,
        onClose: vi.fn(),
        onDefined: vi.fn(),
      },
    });

    expect(screen.getByText('Manage types')).toBeTruthy();
    expect(screen.getAllByTestId('dialog-backdrop')).toHaveLength(1);

    await fireEvent.click(screen.getByRole('button', { name: 'New type' }));

    // Still exactly one dialog on screen — the SAME panel now shows the
    // define form instead of the list, not a second one stacked on top.
    expect(screen.getAllByTestId('dialog-backdrop')).toHaveLength(1);
    expect(screen.queryByText('Manage types')).toBeNull();
    expect(screen.getByText('New tracker type')).toBeTruthy();
    expect(screen.queryByTestId('tracker-manage-types-list')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getAllByTestId('dialog-backdrop')).toHaveLength(1);
    expect(screen.getByText('Manage types')).toBeTruthy();
    expect(screen.queryByText('New tracker type')).toBeNull();
  });

  it('passes the current type ids down as the define form\u2019s own collision guard', async () => {
    render(TrackerManageTypesDialog, {
      props: {
        open: true,
        client: { defineTrackerType: vi.fn() },
        types: BUILTINS,
        onClose: vi.fn(),
        onDefined: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'New type' }));
    await fireEvent.input(screen.getByTestId('tracker-define-type-id'), {
      target: { value: 'bug' },
    });
    await fireEvent.input(screen.getByTestId('tracker-define-type-label'), {
      target: { value: 'Bug again' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create type' }));

    expect(screen.getByText('"bug" is already a tracker type in this project.')).toBeTruthy();
  });

  it('a type defined through "New type" is visible in the list again on a fresh mount — a real round trip through a backend outside the component, not local component state surviving a re-render', async () => {
    const backend = new FakeTrackerTypeBackend();
    const client: TrackerTypeClient = { defineTrackerType: backend.defineTrackerType };
    const onDefined = vi.fn();

    const { unmount, rerender } = render(TrackerManageTypesDialog, {
      props: {
        open: true,
        client,
        types: backend.listTypes(),
        onClose: vi.fn(),
        onDefined,
      },
    });

    expect(screen.queryByText('Feature Request')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'New type' }));
    await fireEvent.input(screen.getByTestId('tracker-define-type-id'), {
      target: { value: 'feature-request' },
    });
    await fireEvent.input(screen.getByTestId('tracker-define-type-label'), {
      target: { value: 'Feature Request' },
    });
    await fireEvent.input(screen.getByTestId('tracker-define-type-role-title'), {
      target: { value: 'summary' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create type' }));

    await waitFor(() => expect(onDefined).toHaveBeenCalledTimes(1));
    // The backend — standing in for NativeTrackerStore/RelayClient, both
    // already tested elsewhere — actually persisted it, independent of
    // this component instance.
    expect(backend.listTypes().map((type) => type.id)).toContain('feature-request');
    expect(screen.getByText('Manage types')).toBeTruthy();

    // A real caller (`TrackerPage`) re-supplies `types` reactively the
    // moment its own snapshot store merges the newly defined type — this
    // dialog keeps no local copy of its own, so it only shows the new type
    // once told, exactly like `rerender` here simulates.
    await rerender({ open: true, client, types: backend.listTypes(), onClose: vi.fn(), onDefined });
    expect(screen.getByTestId('tracker-type-row-feature-request').textContent).toMatch(
      /Feature Request/,
    );

    // Simulate a reload: tear the whole tree down (no Svelte state
    // survives this) and mount a FRESH instance, re-deriving `types` from
    // the backend exactly like a real page reload's fresh
    // `tracker_snapshot_request` would.
    unmount();

    render(TrackerManageTypesDialog, {
      props: {
        open: true,
        client,
        types: backend.listTypes(),
        onClose: vi.fn(),
        onDefined: vi.fn(),
      },
    });

    expect(screen.getByTestId('tracker-type-row-feature-request').textContent).toMatch(
      /Feature Request/,
    );
  });
});
