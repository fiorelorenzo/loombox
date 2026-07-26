<script lang="ts">
  /**
   * The shared chrome for the three full-page destinations: Inbox, Nodes,
   * Settings (design spec v4 §3.3, issue #507). Before this issue those
   * three were Drawer tabs sharing the Drawer's own title bar/Close button;
   * now each is a real page in the main area, so this is the one place
   * that anatomy (a real heading, an optional actions cluster beside it,
   * content capped at the transcript's own `--measure-wide` and centred)
   * lives, rather than being copy-pasted into `InboxPage`/`NodesPage`/
   * `SettingsPage` three times.
   *
   * Deliberately has NO close affordance: v4 §3.3 is explicit that "you
   * leave a page by going somewhere else, which is what the sidebar is
   * for". The old Drawer's `IconButton` "Close panel" has no equivalent
   * here on purpose, not an oversight.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** Rendered as the page's real `<h1>`, replacing the Drawer tab label these three destinations used to share a title bar for. */
    title: string;
    /** A stable per-page selector root, distinct from the wrapped panel's own `data-testid` (e.g. `TargetStatusView`'s `"target-status-view"`), so a page's own test can target its root without colliding with the panel's. */
    testid: string;
    /** Optional actions cluster beside the title (e.g. `NodesPage`'s Add target/Connect a node setup actions, design spec v4 §3.1). */
    actions?: Snippet;
    children: Snippet;
  }

  const { title, testid, actions, children }: Props = $props();
</script>

<div class="page" data-testid={testid}>
  <header class="page-header">
    <h1>{title}</h1>
    {#if actions}
      <div class="page-header-actions">{@render actions()}</div>
    {/if}
  </header>
  <div class="page-content">
    {@render children()}
  </div>
</div>

<style>
  /* Same measure rule the transcript itself opts into (design spec v4
     §3.3 "the same measure rule as the transcript"; see `DiffViewer.svelte`
     for the identical `--measure-wide` cap): a page-shaped surface reads
     no better stretched edge-to-edge than a paragraph would. */
  .page {
    width: 100%;
    max-width: var(--measure-wide);
    margin: 0 auto;
    padding: var(--space-2xl);
    display: flex;
    flex-direction: column;
    gap: var(--space-xl);
    min-width: 0;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-lg);
  }

  .page-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-shrink: 0;
  }

  .page-content {
    min-width: 0;
  }
</style>
