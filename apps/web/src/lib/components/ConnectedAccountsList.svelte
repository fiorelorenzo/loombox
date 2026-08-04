<script lang="ts">
  /**
   * The connected-accounts list (SPEC §7.26, issue #230) — `Row`-based,
   * mirroring `TargetStatusView.svelte`'s row/expansion/confirm pattern
   * (per-row disclosure collapsed by default, a `confirmingDisconnect`
   * `SvelteSet` gating Disconnect's inline "are you sure" bar). Renders
   * only fields that are actually on `ConnectedAccount` — `label`,
   * `avatarUrl`, `host`, `capabilities`, `provider`, `connectedAt` — and
   * never `secretRef`: that field names a keyring entry, not anything a
   * person should read (`connected-accounts.ts`'s own doc comment, and
   * this issue's own acceptance).
   *
   * `nodeId` is the acting node every row's Disconnect routes through —
   * `ConnectedAccount` carries no node id of its own (`connected_account_
   * announce`/`connected_account_list` are both node-agnostic on the wire,
   * SPEC §7.26's own "only the metadata row syncs" — the relay never
   * records which node announced a given row), so this list cannot infer
   * one per account any more than a fresh connect can; the caller's own
   * node picker (`ConnectedAccountsSection`) is the single source for it,
   * exactly like SPEC §7.26's node-locality bullet describes every
   * account operation as inherently node-scoped. A disconnect issued
   * against the wrong node surfaces that node's own real failure message
   * rather than silently no-op'ing.
   *
   * Disconnect's confirm step carries a generic warning that a pinned
   * project may break — the full per-pin scan-and-warn is issue #229's
   * scope, deliberately not built here (SPEC §7.26: "Before letting a user
   * disconnect an account still pinned somewhere, scan all project
   * settings and warn" is the eventual behavior; this issue's own handoff
   * comment scopes #230 to the generic warning only).
   */
  import type { ConnectedAccount, ConnectedAccountDisconnectResponse } from '@loombox/protocol';
  import { SvelteSet } from 'svelte/reactivity';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Row from './ui/Row.svelte';

  export interface DisconnectAccountsClient {
    disconnectAccount: (
      nodeId: string,
      accountId: string,
      timeoutMs?: number,
    ) => Promise<ConnectedAccountDisconnectResponse>;
    refreshConnectedAccounts: () => void;
  }

  interface Props {
    accounts: ConnectedAccount[];
    client: DisconnectAccountsClient;
    /** The acting node every Disconnect call routes through — see the file doc comment. */
    nodeId: string | undefined;
  }

  const { accounts, client, nodeId }: Props = $props();

  const expandedKeys = new SvelteSet<string>();
  const confirmingDisconnect = new SvelteSet<string>();
  const busyKeys = new SvelteSet<string>();
  let actionMessages = $state<Record<string, string>>({});

  function toggleExpanded(id: string): void {
    if (expandedKeys.has(id)) expandedKeys.delete(id);
    else expandedKeys.add(id);
  }

  function providerLabel(provider: string): string {
    if (provider === 'github') return 'GitHub';
    if (provider === 'jira') return 'Jira';
    return provider;
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
  }

  function startDisconnect(id: string): void {
    confirmingDisconnect.add(id);
  }

  function cancelDisconnect(id: string): void {
    confirmingDisconnect.delete(id);
  }

  async function confirmDisconnect(account: ConnectedAccount): Promise<void> {
    if (!nodeId) {
      actionMessages = {
        ...actionMessages,
        [account.id]: 'Select a node above first — disconnect runs on a specific node.',
      };
      confirmingDisconnect.delete(account.id);
      return;
    }
    busyKeys.add(account.id);
    try {
      const response = await client.disconnectAccount(nodeId, account.id);
      actionMessages = {
        ...actionMessages,
        [account.id]: response.message ?? (response.outcome === 'ok' ? 'Disconnected.' : 'Failed.'),
      };
      if (response.outcome === 'ok') client.refreshConnectedAccounts();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [account.id]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(account.id);
      confirmingDisconnect.delete(account.id);
    }
  }
</script>

{#if accounts.length === 0}
  <EmptyState
    message="No connected accounts yet. Connect a GitHub or Jira account above to let projects use it for tracker sync and write-back."
  />
{:else}
  <ul class="account-rows" data-testid="connected-accounts-list">
    {#each accounts as account (account.id)}
      {@const expanded = expandedKeys.has(account.id)}
      <li class="account-row">
        <Row
          as="div"
          onclick={() => toggleExpanded(account.id)}
          ariaLabel={`${account.label}, ${providerLabel(account.provider)}, ${account.host}`}
          dataTestId={`connected-account-row-${account.id}`}
        >
          {#snippet leading()}
            {#if account.avatarUrl}
              <img class="account-avatar" src={account.avatarUrl} alt="" width="28" height="28" />
            {:else}
              <span class="account-avatar account-avatar-fallback" aria-hidden="true">
                {providerLabel(account.provider).charAt(0)}
              </span>
            {/if}
          {/snippet}
          <span class="account-label">{account.label}</span>
          <Badge size="sm">{providerLabel(account.provider)}</Badge>
          <span class="account-host font-mono">{account.host}</span>
          {#snippet trailing()}
            <span class="account-capabilities">
              {#each account.capabilities as capability (capability)}
                <Badge size="sm">{capability}</Badge>
              {/each}
            </span>
          {/snippet}
        </Row>

        {#if expanded}
          <div class="account-expansion" data-testid={`connected-account-expansion-${account.id}`}>
            <p class="account-meta">
              Connected {formatDate(account.connectedAt)} · last updated {formatDate(
                account.updatedAt,
              )}
            </p>
            {#if account.scopes}
              <p class="account-meta">Scopes: {account.scopes.join(', ') || 'none'}</p>
            {/if}

            {#if confirmingDisconnect.has(account.id)}
              <div class="disconnect-confirm" data-testid={`disconnect-confirmbar-${account.id}`}>
                <p class="disconnect-warning">
                  Disconnect {account.label}? Any project pinned to this account may stop working
                  until it's repinned.
                </p>
                <div class="disconnect-confirm-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyKeys.has(account.id)}
                    onclick={() => cancelDisconnect(account.id)}
                    dataTestId={`disconnect-cancel-${account.id}`}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busyKeys.has(account.id)}
                    onclick={() => confirmDisconnect(account)}
                    dataTestId={`disconnect-confirm-${account.id}`}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            {:else}
              <Button
                size="sm"
                variant="danger"
                onclick={() => startDisconnect(account.id)}
                dataTestId={`disconnect-start-${account.id}`}
              >
                Disconnect
              </Button>
            {/if}

            {#if actionMessages[account.id]}
              <p class="action-message" data-testid={`account-action-message-${account.id}`}>
                {actionMessages[account.id]}
              </p>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .account-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .account-row {
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .account-avatar {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-full);
    flex-shrink: 0;
  }

  .account-avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-fill);
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
    font-weight: 600;
    text-transform: uppercase;
  }

  .account-label {
    font-weight: 600;
  }

  .account-host {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .account-capabilities {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3xs);
  }

  .account-expansion {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: 0 var(--space-md) var(--space-sm);
    border-top: 1px solid var(--color-border-subtle);
    margin-top: var(--space-2xs);
    padding-top: var(--space-sm);
  }

  .account-meta {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .disconnect-confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .disconnect-warning {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .disconnect-confirm-actions {
    display: flex;
    gap: var(--space-xs);
  }

  .action-message {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }
</style>
