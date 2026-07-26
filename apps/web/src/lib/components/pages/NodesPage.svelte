<script lang="ts">
  /**
   * Nodes & targets as a full page (design spec v4 §3.1/§3.3, issue #507):
   * same reasoning as `InboxPage`'s own doc comment: one destination
   * instead of a sidebar row that opened a Drawer tab of the same name.
   * `TargetStatusView` already collapsed its own header down to just the
   * Refresh action (redesign v3 §3.6 `D2`'s "this view no longer repeats
   * its own... title or a Close action"), so it needed no further changes
   * here. `PageLayout` supplies the title the old Drawer used to.
   *
   * `onAddTarget`/`onConnectNode` are new (v4 §3.1): the sidebar's "New
   * session" split menu, which used to carry these two one-time setup
   * actions alongside session creation, is removed entirely (every
   * creation path is now project-scoped, §3.4): "Add target"/"Connect a
   * node" move here instead, rendered as this page's primary actions,
   * "among their own kind" rather than bolted onto an unrelated menu.
   */
  import TargetStatusView, { type FocusTarget } from '../TargetStatusView.svelte';
  import type { TargetListEntry } from '$lib/relay-client';
  import Button from '../ui/Button.svelte';
  import PageLayout from './PageLayout.svelte';

  interface Props {
    targets: TargetListEntry[];
    loading: boolean;
    error: string | undefined;
    focusTarget?: FocusTarget;
    onRefresh: () => void;
    /** Opens the zero-touch provision-and-pair wizard (`AddTargetWizard`), moved here from the sidebar's deleted "New session" split menu (v4 §3.1). */
    onAddTarget: () => void;
    /** The split menu's other setup action, moved here alongside `onAddTarget` for the same reason. */
    onConnectNode: () => void;
  }

  const { targets, loading, error, focusTarget, onRefresh, onAddTarget, onConnectNode }: Props =
    $props();
</script>

{#snippet pageActions()}
  <Button
    variant="secondary"
    size="sm"
    onclick={onConnectNode}
    dataTestId="nodes-page-connect-node"
  >
    Connect a node
  </Button>
  <Button variant="primary" size="sm" onclick={onAddTarget} dataTestId="nodes-page-add-target">
    Add target
  </Button>
{/snippet}

<PageLayout title="Nodes" testid="nodes-page" actions={pageActions}>
  <TargetStatusView {targets} {loading} {error} {focusTarget} {onRefresh} />
</PageLayout>
