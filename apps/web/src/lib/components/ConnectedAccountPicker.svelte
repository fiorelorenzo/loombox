<script lang="ts">
  /**
   * Picks one `ConnectedAccount` (SPEC §7.26) for a given provider — the
   * "reuse the picker from the connected-accounts epic" piece issue #220's
   * live-tracker config needs. `RelayClient.connectedAccounts`'s full,
   * account-scoped list is the caller's to fetch and pass down (mirrors
   * `TargetPicker`'s split: this component only renders whatever `accounts`
   * it's given and reports a pick, it owns no fetching of its own).
   *
   * Filters to `provider` itself rather than making every caller do it —
   * the same "hand the whole set, let the picker narrow it" shape
   * `AccountPinning`'s server-side `resolveAccountForRead`/
   * `resolveAccountForWrite` already use for the identical registry.
   *
   * No connected account for `provider` renders `EmptyState` instead of an
   * empty `Select` (issue #220's own acceptance: "not a dead dropdown") —
   * `emptyStateCta` is the caller's real next step (there is no in-app
   * "connect an account" flow yet; #230 owns building one), so this stays a
   * plain presentational slot rather than this component inventing one.
   */
  import type { ConnectedAccount } from '@loombox/protocol';
  import type { Snippet } from 'svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Select from './ui/Select.svelte';

  interface Props {
    provider: 'github' | 'jira';
    accounts: readonly ConnectedAccount[];
    value: string | undefined;
    onChange: (connectionId: string) => void;
    /** Accessible name for the underlying `Select` trigger. */
    label?: string;
    /** Rendered inside the `EmptyState` when this provider has no connected account yet — the caller's real next step (e.g. "use native mode instead"). */
    emptyStateCta?: Snippet;
    dataTestId?: string;
  }

  const {
    provider,
    accounts,
    value,
    onChange,
    label = 'Connected account',
    emptyStateCta,
    dataTestId = 'connected-account-picker',
  }: Props = $props();

  const providerAccounts = $derived(accounts.filter((account) => account.provider === provider));
  const options = $derived(
    providerAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      hint: account.host,
    })),
  );
  const providerLabel = $derived(provider === 'github' ? 'GitHub' : 'Jira');
</script>

<div data-testid={dataTestId}>
  {#if providerAccounts.length === 0}
    <EmptyState message={`No connected ${providerLabel} account yet.`} cta={emptyStateCta} />
  {:else}
    <Select value={value ?? ''} {options} {onChange} {label} dataTestId={`${dataTestId}-select`} />
  {/if}
</div>
