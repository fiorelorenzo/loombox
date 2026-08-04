<script lang="ts">
  /**
   * The Jira API-token connect dialog (SPEC §7.26, issue #230) — a plain
   * three-field form (`siteUrl`/`email`/`apiToken`) over
   * `RelayClient.connectJiraAccount` (issue #643's already-shipped client
   * method), using `Field`+`Input` like every other form in this package.
   *
   * Multiple Jira sites coexist by design (SPEC §7.26: "loombox's registry
   * fixes both: key on `(siteUrl, accountId)`... support two connect
   * paths"), so a successful connect never closes this dialog into "done" —
   * it clears the form and returns to the empty fields, staying open so a
   * second/third site is a repeat submit, not a re-open. `onConnected`
   * fires per success so the caller's list picks up the new row
   * immediately (see `ConnectedAccountsSection`'s own doc comment on why a
   * second site must visibly add a row rather than replace one).
   */
  import type { ConnectedAccount, JiraConnectOutcome } from '@loombox/protocol';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';

  export interface JiraConnectClient {
    connectJiraAccount: (
      nodeId: string,
      credentials: { siteUrl: string; email: string; apiToken: string },
      timeoutMs?: number,
    ) => Promise<JiraConnectOutcome>;
  }

  interface Props {
    open: boolean;
    /** The node this connect call runs on — Jira API-token connect always executes on a specific node (SPEC §7.26's node-locality). */
    nodeId: string | undefined;
    client: JiraConnectClient;
    onClose: () => void;
    /** Fired once per successful connect, including a second/third site in the same dialog session (see the file doc comment). */
    onConnected: (account: ConnectedAccount) => void;
  }

  const { open, nodeId, client, onClose, onConnected }: Props = $props();

  let siteUrl = $state('');
  let email = $state('');
  let apiToken = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | undefined>(undefined);
  let lastConnected = $state<ConnectedAccount | undefined>(undefined);

  function resetForm(): void {
    siteUrl = '';
    email = '';
    apiToken = '';
    errorMessage = undefined;
    lastConnected = undefined;
  }

  // A fresh open always starts from a clean form — closing mid-edit and
  // reopening should never resurface a half-typed previous attempt.
  $effect(() => {
    if (open) resetForm();
  });

  const canSubmit = $derived(
    siteUrl.trim().length > 0 && email.trim().length > 0 && apiToken.trim().length > 0,
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!nodeId) {
      errorMessage = 'Select a node above first — Jira connect runs on a specific node.';
      return;
    }
    if (!canSubmit || submitting) return;
    submitting = true;
    errorMessage = undefined;
    lastConnected = undefined;
    try {
      const outcome = await client.connectJiraAccount(nodeId, {
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken,
      });
      if (outcome.outcome === 'success') {
        lastConnected = outcome.account;
        onConnected(outcome.account);
        siteUrl = '';
        email = '';
        apiToken = '';
      } else {
        errorMessage = outcome.message;
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet body()}
  <form class="jira-connect-form" onsubmit={submit} data-testid="jira-connect-form">
    <Field label="Site URL" required>
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          monospace
          bind:value={siteUrl}
          placeholder="https://myteam.atlassian.net"
          dataTestId="jira-connect-site-url"
        />
      {/snippet}
    </Field>

    <Field label="Email" required>
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          type="email"
          bind:value={email}
          placeholder="you@example.com"
          dataTestId="jira-connect-email"
        />
      {/snippet}
    </Field>

    <Field
      label="API token"
      required
      help="Created at id.atlassian.com/manage-profile/security/api-tokens"
    >
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          type="password"
          monospace
          bind:value={apiToken}
          dataTestId="jira-connect-api-token"
        />
      {/snippet}
    </Field>

    {#if lastConnected}
      <p data-testid="jira-connect-success">
        Connected <strong>{lastConnected.label}</strong> ({lastConnected.host}). Add another site
        below, or close when done.
      </p>
    {/if}

    {#if errorMessage}
      <ErrorNotice message={errorMessage} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={onClose} dataTestId="jira-connect-close">Close</Button>
      <Button
        type="submit"
        loading={submitting}
        disabled={!canSubmit}
        dataTestId="jira-connect-submit"
      >
        Connect
      </Button>
    </FormActions>
  </form>
{/snippet}

<Dialog {open} label="Connect a Jira account" {onClose} size="sm" children={body}>
  {#snippet header()}
    <h2>Connect a Jira account</h2>
  {/snippet}
</Dialog>

<style>
  .jira-connect-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
</style>
