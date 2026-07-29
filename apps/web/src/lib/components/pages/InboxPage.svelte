<script lang="ts">
  /**
   * Inbox as a full page (design spec v4 §3.3, issue #507): the
   * cross-project attention queue used to be a Drawer tab pointed at from
   * the sidebar's own "Inbox" row: two navigations to the same
   * destination (v4 §1.1). This is now the ONE destination; the sidebar
   * row sets `mainView = 'inbox'` and mounts this instead of opening the
   * Drawer.
   *
   * `AttentionInbox` itself is untouched and not this issue's to change:
   * it already carries no title or Close of its own (the old Drawer
   * supplied both, this page's `PageLayout` now does) and already reuses
   * the shared `EmptyState` for "nothing needs your attention" (its own
   * doc comment, redesign brief §6). Props below are copied verbatim from
   * `AttentionInbox`'s old Drawer mount site in `+page.svelte`, so the
   * shell swaps the component name there and leaves every prop expression
   * untouched.
   */
  import type { AcpPermissionOption } from '@loombox/providers-core/browser';
  import type { AttentionInboxItem } from '$lib/relay-client';
  import AttentionInbox from '../AttentionInbox.svelte';
  import PageLayout from './PageLayout.svelte';

  interface Props {
    items: AttentionInboxItem[];
    onResolve: (sessionId: string, requestId: string, option: AcpPermissionOption) => void;
    onOpenSession: (sessionId: string) => void;
    onReply: (sessionId: string, text: string) => void;
  }

  const { items, onResolve, onOpenSession, onReply }: Props = $props();
</script>

<PageLayout title="Inbox" testid="inbox-page">
  <AttentionInbox {items} {onResolve} {onOpenSession} {onReply} />
</PageLayout>
