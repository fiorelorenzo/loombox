<script lang="ts">
  /**
   * The Settings "Accounts" section (SPEC §7.26, issue #230) — the one
   * piece the wire-layer handoff (issue #643) left for this issue to
   * build: connect (GitHub device flow, Jira API token), list, disconnect,
   * and per-project pin. Composes `GithubConnectFlow`/`JiraConnectForm`
   * (each its own `Dialog`), `ConnectedAccountsList` (the row list plus
   * disconnect confirm), and `AccountPinPicker` (the per-project tri-state
   * pin map) — this component owns the connect-dialog open state and the
   * one piece of context every one of those needs but `ConnectedAccount`
   * itself can't supply: which node is acting (see `ConnectedAccountsList`
   * and `AccountPinPicker`'s own doc comments on why every operation here
   * is node-scoped).
   *
   * A second Jira site visibly ADDS a row rather than replacing one — SPEC
   * §7.26: "loombox's registry fixes both: key on `(siteUrl, accountId)`,
   * and support two connect paths" — because `connectedAccounts` is the
   * caller's own synced store (`RelayClient.connectedAccounts`), and
   * `JiraConnectForm` calls `onConnected` (which triggers
   * `refreshConnectedAccounts`) per successful submit without ever closing
   * itself, so a second connect while the dialog is still open reaches the
   * same store update path as the first.
   */
  import type {
    AccountPinMapV1,
    AccountPinResolveOutcome,
    AccountPinScanHitV1,
    ConnectedAccount,
    ConnectedAccountDisconnectResponse,
    GithubConnectDeviceCode,
    GithubConnectOutcome,
    GithubPatConnectOutcome,
    JiraConnectOutcome,
  } from '@loombox/protocol';
  import type { TargetListEntry } from '$lib/relay-client';
  import AccountPinPicker from './AccountPinPicker.svelte';
  import ConnectedAccountsList from './ConnectedAccountsList.svelte';
  import GithubConnectFlow from './GithubConnectFlow.svelte';
  import JiraConnectForm from './JiraConnectForm.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Select from './ui/Select.svelte';

  /** The full method surface every child below needs — a plain structural interface (not `RelayClient` itself) so a test can pass a minimal stub, mirroring `TargetStatusView`'s own `TargetActionsClient` split. */
  export interface ConnectedAccountsClient {
    startGithubConnect: (
      nodeId: string,
      onDeviceCode: (info: GithubConnectDeviceCode) => void,
      timeoutMs?: number,
    ) => { requestId: string; cancel: () => void; result: Promise<GithubConnectOutcome> };
    /** Issue #224's fine-grained PAT paste path — see `GithubConnectFlow`'s own `GithubConnectClient.connectGithubPat` doc comment. */
    connectGithubPat: (
      nodeId: string,
      credentials: { token: string; host?: string },
      timeoutMs?: number,
    ) => Promise<GithubPatConnectOutcome>;
    connectJiraAccount: (
      nodeId: string,
      credentials: { siteUrl: string; email: string; apiToken: string },
      timeoutMs?: number,
    ) => Promise<JiraConnectOutcome>;
    scanAccountPins: (
      nodeId: string,
      accountId: string,
      timeoutMs?: number,
    ) => Promise<AccountPinScanHitV1[]>;
    disconnectAccount: (
      nodeId: string,
      accountId: string,
      timeoutMs?: number,
    ) => Promise<ConnectedAccountDisconnectResponse>;
    getAccountPins: (
      nodeId: string,
      projectPath: string,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    setAccountPin: (
      nodeId: string,
      projectPath: string,
      capability: string,
      accountId: string | null,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    unsetAccountPin: (
      nodeId: string,
      projectPath: string,
      capability: string,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    resolveAccountPin: (
      nodeId: string,
      params: {
        projectPath: string;
        capability: string;
        mode: 'read' | 'write';
        target: { provider: string; host: string };
        accounts: ConnectedAccount[];
      },
      timeoutMs?: number,
    ) => Promise<AccountPinResolveOutcome>;
    refreshConnectedAccounts: () => void;
  }

  interface Props {
    client: ConnectedAccountsClient;
    connectedAccounts: ConnectedAccount[];
    targets: TargetListEntry[];
    projectPaths: string[];
  }

  const { client, connectedAccounts, targets, projectPaths }: Props = $props();

  /** Every operation here is node-scoped (connect, disconnect, and pin storage all run on a specific node — see the child components' own doc comments), so this is the one node picker the whole section shares. Derived from `targets` since that is the only synced source of known node ids; each option's label pairs the id with a real target label already announced on it, never an invented node name. */
  const nodeOptions = $derived(
    [...new Set(targets.map((target) => target.nodeId))].map((id) => {
      const sample = targets.find((target) => target.nodeId === id);
      return { id, label: sample ? `${id} (${sample.label})` : id };
    }),
  );

  let selectedNodeId = $state<string | undefined>(undefined);
  const activeNodeId = $derived(
    selectedNodeId && nodeOptions.some((option) => option.id === selectedNodeId)
      ? selectedNodeId
      : nodeOptions[0]?.id,
  );

  let githubDialogOpen = $state(false);
  let jiraDialogOpen = $state(false);

  function handleConnected(_account: ConnectedAccount): void {
    client.refreshConnectedAccounts();
  }
</script>

{#snippet connectActions()}
  <Button
    variant="secondary"
    size="sm"
    disabled={!activeNodeId}
    onclick={() => (githubDialogOpen = true)}
    dataTestId="accounts-connect-github"
  >
    Connect GitHub
  </Button>
  <Button
    variant="secondary"
    size="sm"
    disabled={!activeNodeId}
    onclick={() => (jiraDialogOpen = true)}
    dataTestId="accounts-connect-jira"
  >
    Connect Jira
  </Button>
{/snippet}

<div class="connected-accounts-section" data-testid="connected-accounts-section">
  {#if nodeOptions.length === 0}
    <p class="no-nodes-message" data-testid="accounts-no-nodes">
      Connect a node first — GitHub/Jira accounts connect through a specific node.
    </p>
  {:else}
    <div class="accounts-toolbar">
      {#if nodeOptions.length > 1}
        <Field label="Acting node" grouped class="node-select-field">
          <Select
            value={activeNodeId ?? ''}
            options={nodeOptions}
            onChange={(id) => (selectedNodeId = id)}
            label="Acting node"
            size="sm"
            dataTestId="accounts-node-select"
          />
        </Field>
      {/if}
      <div class="accounts-toolbar-actions">
        {@render connectActions()}
      </div>
    </div>

    <ConnectedAccountsList accounts={connectedAccounts} {client} nodeId={activeNodeId} />

    <section class="pin-picker-section">
      <h3>Per-project pins</h3>
      <AccountPinPicker
        {client}
        accounts={connectedAccounts}
        {projectPaths}
        nodeId={activeNodeId}
      />
    </section>
  {/if}
</div>

<GithubConnectFlow
  open={githubDialogOpen}
  nodeId={activeNodeId}
  {client}
  onClose={() => (githubDialogOpen = false)}
  onConnected={handleConnected}
/>
<JiraConnectForm
  open={jiraDialogOpen}
  nodeId={activeNodeId}
  {client}
  onClose={() => (jiraDialogOpen = false)}
  onConnected={handleConnected}
/>

<style>
  .connected-accounts-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  .no-nodes-message {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .accounts-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  :global(.node-select-field) {
    min-width: 14rem;
  }

  .accounts-toolbar-actions {
    display: flex;
    gap: var(--space-sm);
    margin-left: auto;
  }

  .pin-picker-section h3 {
    margin: 0 0 var(--space-sm);
    font-size: var(--text-body-size);
  }
</style>
