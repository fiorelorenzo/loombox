<script lang="ts">
  /**
   * The GitHub connect dialog (SPEC §7.26, issues #230/#224) — two paths
   * onto the same registry: the device-flow (drives
   * `RelayClient.startGithubConnect`, issue #643's already-shipped client
   * method) through its own three states (starting, showing the
   * device/user code, terminal success/failure), and a fine-grained PAT
   * paste (`RelayClient.connectGithubPat`, issue #224) for an org whose
   * OAuth App access restrictions block the device flow outright. The
   * device code is the whole interaction for that first path (the
   * operator types it into a browser tab on another device), so it
   * renders large, monospace, and selectable — never a caption-sized
   * aside next to the real content. The PAT field mirrors
   * `JiraConnectForm.svelte`'s own `type="password"` precedent: masked on
   * screen, and — the same browser mechanism, not a separate one — never
   * exposed through the accessibility tree either (browsers deliberately
   * never report a password input's real value to assistive tech, which
   * is also why an ARIA snapshot never captures it; see AGENTS.md's own
   * Recovery Code hazard note for the input-shape half of that same
   * story).
   *
   * Opens the device flow itself the moment `open` turns true (no
   * separate "Start" click), and cancels/resets whatever was in flight —
   * device or PAT — the moment the dialog closes, whether that's the
   * operator's own Cancel/Close button or `Dialog`'s Esc/backdrop-close
   * path (both route through `onClose`, mirroring every other dialog in
   * this package). Switching mode (`mode`, below) cancels an in-flight
   * device flow the same way, without closing the dialog.
   */
  import type {
    ConnectedAccount,
    GithubConnectDeviceCode,
    GithubConnectOutcome,
    GithubPatConnectOutcome,
  } from '@loombox/protocol';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';

  export interface GithubConnectClient {
    startGithubConnect: (
      nodeId: string,
      onDeviceCode: (info: GithubConnectDeviceCode) => void,
      timeoutMs?: number,
    ) => { requestId: string; cancel: () => void; result: Promise<GithubConnectOutcome> };
    /** Issue #224's fine-grained PAT paste path — one round trip, no device-code step (mirrors `JiraConnectClient.connectJiraAccount`). Reuses the same numeric-id identity resolution as {@link startGithubConnect}; see `GithubPatConnectOutcome`'s own doc comment for what a success carries beyond the account (the reach report this dialog's success screen shows). */
    connectGithubPat: (
      nodeId: string,
      credentials: { token: string; host?: string },
      timeoutMs?: number,
    ) => Promise<GithubPatConnectOutcome>;
  }

  interface Props {
    open: boolean;
    /** The node this flow runs on — GitHub connect always executes on a specific node (SPEC §7.26's node-locality). */
    nodeId: string | undefined;
    client: GithubConnectClient;
    onClose: () => void;
    /** Fired once with the newly-connected account on success, before this dialog's own success state renders — the caller (SPEC §230's list) refreshes from it. */
    onConnected: (account: ConnectedAccount) => void;
  }

  const { open, nodeId, client, onClose, onConnected }: Props = $props();

  type Phase = 'idle' | 'starting' | 'waiting' | 'success' | 'failure';
  type Mode = 'device' | 'pat';

  let phase = $state<Phase>('idle');
  let deviceCode = $state<GithubConnectDeviceCode | undefined>(undefined);
  let connectedAccount = $state<ConnectedAccount | undefined>(undefined);
  let failureMessage = $state<string | undefined>(undefined);
  let cancelFlow: (() => void) | undefined;

  // Which connect mechanism is currently showing/active while `phase` is
  // still 'idle' — the device flow auto-starts by default (unchanged
  // behavior); switching to 'pat' is the operator's own choice (issue
  // #224: the fallback for an org whose OAuth App access restrictions
  // block the device flow outright). A successful connect through either
  // mode lands in the SAME terminal `phase === 'success'` below — `mode`
  // only decides what renders while nothing has settled yet.
  let mode = $state<Mode>('device');
  let patToken = $state('');
  let patHost = $state('github.com');
  let patSubmitting = $state(false);
  let patError = $state<string | undefined>(undefined);
  /** Set only on a PAT-mode success — `undefined` for a device-flow success, which is how the success screen below decides whether to render the reach report at all. */
  let patAccessibleRepositories = $state<string[] | undefined>(undefined);
  let patAccessibleRepositoriesTruncated = $state(false);

  const patCanSubmit = $derived(patToken.trim().length > 0);

  function reset(): void {
    phase = 'idle';
    deviceCode = undefined;
    connectedAccount = undefined;
    failureMessage = undefined;
    cancelFlow = undefined;
    mode = 'device';
    patToken = '';
    patError = undefined;
    patAccessibleRepositories = undefined;
    patAccessibleRepositoriesTruncated = false;
  }

  function start(): void {
    if (!nodeId) {
      phase = 'failure';
      failureMessage = 'Select a node above first — GitHub connect runs on a specific node.';
      return;
    }
    phase = 'starting';
    const flow = client.startGithubConnect(nodeId, (info) => {
      deviceCode = info;
      phase = 'waiting';
    });
    cancelFlow = flow.cancel;
    flow.result
      .then((outcome) => {
        if (outcome.outcome === 'success') {
          phase = 'success';
          connectedAccount = outcome.account;
          onConnected(outcome.account);
        } else {
          phase = 'failure';
          failureMessage = outcome.message;
        }
      })
      .catch((error: unknown) => {
        phase = 'failure';
        failureMessage = error instanceof Error ? error.message : String(error);
      });
  }

  // Starts the device flow the moment the dialog opens (only while still
  // in device mode — switching to PAT mode sets `phase` back to 'idle'
  // too, and this must not treat that as "reopen the dialog"), and
  // cancels/resets whatever was in flight the moment it closes — whether
  // that's Cancel, Esc, a backdrop click, or the caller flipping `open`
  // itself, all of which reach here as `open` turning false (see the file
  // doc comment).
  $effect(() => {
    if (open) {
      if (mode === 'device' && phase === 'idle') start();
    } else if (phase !== 'idle' || mode !== 'device') {
      if (phase === 'starting' || phase === 'waiting') cancelFlow?.();
      reset();
    }
  });

  function handleCancel(): void {
    cancelFlow?.();
    onClose();
  }

  function retry(): void {
    reset();
    start();
  }

  /** Abandons an in-flight/pending device flow (if any) and switches to the PAT-paste form — reachable from the idle/starting/waiting loader and from a device-flow failure alike, since an org's OAuth App restriction most commonly SURFACES as that failure (issue #224's own framing). */
  function switchToPat(): void {
    if (phase === 'starting' || phase === 'waiting') cancelFlow?.();
    reset();
    mode = 'pat';
  }

  /** Discards whatever was typed into the PAT form and restarts the device flow — symmetric with {@link switchToPat}. */
  function switchToDevice(): void {
    reset();
    start();
  }

  async function submitPat(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!nodeId) {
      patError = 'Select a node above first — GitHub connect runs on a specific node.';
      return;
    }
    if (!patCanSubmit || patSubmitting) return;
    patSubmitting = true;
    patError = undefined;
    try {
      const host = patHost.trim();
      const outcome = await client.connectGithubPat(nodeId, {
        token: patToken,
        host: host.length > 0 && host !== 'github.com' ? host : undefined,
      });
      if (outcome.outcome === 'success') {
        patToken = '';
        patAccessibleRepositories = outcome.accessibleRepositories;
        patAccessibleRepositoriesTruncated = outcome.accessibleRepositoriesTruncated;
        connectedAccount = outcome.account;
        phase = 'success';
        onConnected(outcome.account);
      } else {
        patError = outcome.message;
      }
    } catch (error) {
      patError = error instanceof Error ? error.message : String(error);
    } finally {
      patSubmitting = false;
    }
  }
</script>

{#snippet body()}
  {#if mode === 'pat' && phase === 'idle'}
    <form class="pat-connect-form" onsubmit={submitPat} data-testid="github-pat-connect-form">
      <Field label="Personal access token" required>
        {#snippet children({ id, describedBy, errorId, invalid, required })}
          <Input
            {id}
            {describedBy}
            {errorId}
            {invalid}
            {required}
            type="password"
            monospace
            bind:value={patToken}
            placeholder="github_pat_…"
            dataTestId="github-pat-connect-token"
          />
        {/snippet}
      </Field>

      <Field label="Host" help="Only for GitHub Enterprise Server — leave as github.com otherwise.">
        {#snippet children({ id, describedBy, errorId, invalid, required })}
          <Input
            {id}
            {describedBy}
            {errorId}
            {invalid}
            {required}
            monospace
            bind:value={patHost}
            dataTestId="github-pat-connect-host"
          />
        {/snippet}
      </Field>

      {#if patError}
        <ErrorNotice message={patError} />
      {/if}

      <FormActions>
        <Button
          variant="secondary"
          onclick={switchToDevice}
          dataTestId="github-pat-connect-use-device-flow"
        >
          Use the device flow instead
        </Button>
        <Button
          type="submit"
          loading={patSubmitting}
          disabled={!patCanSubmit}
          dataTestId="github-pat-connect-submit"
        >
          Connect
        </Button>
      </FormActions>
    </form>
  {:else if phase === 'idle' || phase === 'starting'}
    <p class="connect-status">
      <WovenLoader label="Starting GitHub device flow" />
      Starting…
    </p>
    <FormActions align="start">
      <Button variant="secondary" onclick={switchToPat} dataTestId="github-connect-use-pat">
        Paste a personal access token instead
      </Button>
    </FormActions>
  {:else if phase === 'waiting' && deviceCode}
    {@const code = deviceCode}
    <div class="device-code-block" data-testid="github-device-code-block">
      <p class="device-code-instructions">
        On another device, open
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- `verificationUri` is GitHub's own external URL (github.com/login/device), never an internal SvelteKit route; the rule can't statically prove that from a dynamic href. -->
        <a href={code.verificationUri} target="_blank" rel="noreferrer">{code.verificationUri}</a>
        and enter this code:
      </p>
      <div class="device-code-row">
        <code class="device-code font-mono" data-testid="github-device-user-code">
          {code.userCode}
        </code>
        <CopyButton text={code.userCode} label="Copy code" prominent />
      </div>
      <p class="device-code-expiry">
        Expires in {Math.max(1, Math.round(code.expiresInSeconds / 60))} minutes.
      </p>
      <p class="connect-status">
        <WovenLoader label="Waiting for approval" variant="working" />
        Waiting for approval…
      </p>
    </div>
    <FormActions align="start">
      <Button variant="secondary" onclick={handleCancel} dataTestId="github-connect-cancel">
        Cancel
      </Button>
      <Button variant="secondary" onclick={switchToPat} dataTestId="github-connect-use-pat">
        Paste a token instead
      </Button>
    </FormActions>
  {:else if phase === 'success' && connectedAccount}
    <p data-testid="github-connect-success">
      Connected <strong>{connectedAccount.label}</strong> ({connectedAccount.host}).
    </p>
    {#if patAccessibleRepositories}
      <p class="pat-reach" data-testid="github-pat-connect-reach">
        This token can reach {patAccessibleRepositories.length}{patAccessibleRepositoriesTruncated
          ? '+'
          : ''} repositor{patAccessibleRepositories.length === 1 ? 'y' : 'ies'}:
        {patAccessibleRepositories.slice(0, 5).join(', ')}{patAccessibleRepositories.length > 5
          ? ', …'
          : ''}
      </p>
    {/if}
    <FormActions>
      <Button onclick={onClose} dataTestId="github-connect-done">Done</Button>
    </FormActions>
  {:else if phase === 'failure'}
    <ErrorNotice message={failureMessage ?? 'GitHub connect failed.'} />
    <FormActions>
      <Button variant="secondary" onclick={onClose} dataTestId="github-connect-close">Close</Button>
      <Button variant="secondary" onclick={switchToPat} dataTestId="github-connect-use-pat">
        Paste a token instead
      </Button>
      <Button onclick={retry} dataTestId="github-connect-retry">Try again</Button>
    </FormActions>
  {/if}
{/snippet}

<Dialog {open} label="Connect a GitHub account" onClose={handleCancel} size="sm" children={body}>
  {#snippet header()}
    <h2>Connect a GitHub account</h2>
  {/snippet}
</Dialog>

<style>
  .connect-status {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .device-code-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .device-code-instructions {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .device-code-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  /* The whole interaction: big, selectable, copyable — the operator is
     typing this into a browser tab on another device (file doc comment). */
  .device-code {
    font-size: var(--text-display-size);
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    user-select: all;
  }

  .device-code-expiry {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  .pat-connect-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .pat-reach {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }
</style>
