<script lang="ts">
  /**
   * The GitHub device-flow connect dialog (SPEC §7.26, issue #230) —
   * drives `RelayClient.startGithubConnect` (issue #643's already-shipped
   * client method) through its own three states: starting the flow,
   * showing the operator the device/user code once GitHub issues it, and
   * the terminal success/failure outcome. The device code is the whole
   * interaction (the operator types it into a browser tab on another
   * device), so it renders large, monospace, and selectable — never a
   * caption-sized aside next to the real content.
   *
   * Opens the flow itself the moment `open` turns true (no separate
   * "Start" click — there's nothing else this dialog is for), and cancels
   * an in-flight flow whenever it closes, whether that's the operator's
   * own Cancel button or `Dialog`'s Esc/backdrop-close path (both route
   * through `onClose`, mirroring every other dialog in this package).
   */
  import type {
    ConnectedAccount,
    GithubConnectDeviceCode,
    GithubConnectOutcome,
  } from '@loombox/protocol';
  import CopyButton from './CopyButton.svelte';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import FormActions from './ui/FormActions.svelte';

  export interface GithubConnectClient {
    startGithubConnect: (
      nodeId: string,
      onDeviceCode: (info: GithubConnectDeviceCode) => void,
      timeoutMs?: number,
    ) => { requestId: string; cancel: () => void; result: Promise<GithubConnectOutcome> };
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

  let phase = $state<Phase>('idle');
  let deviceCode = $state<GithubConnectDeviceCode | undefined>(undefined);
  let connectedAccount = $state<ConnectedAccount | undefined>(undefined);
  let failureMessage = $state<string | undefined>(undefined);
  let cancelFlow: (() => void) | undefined;

  function reset(): void {
    phase = 'idle';
    deviceCode = undefined;
    connectedAccount = undefined;
    failureMessage = undefined;
    cancelFlow = undefined;
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

  // Starts the flow the moment the dialog opens, and cancels/resets it the
  // moment it closes — whether that's Cancel, Esc, a backdrop click, or the
  // caller flipping `open` itself, all of which reach here as `open`
  // turning false (see the file doc comment).
  $effect(() => {
    if (open) {
      if (phase === 'idle') start();
    } else if (phase !== 'idle') {
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
</script>

{#snippet body()}
  {#if phase === 'idle' || phase === 'starting'}
    <p class="connect-status">
      <WovenLoader label="Starting GitHub device flow" />
      Starting…
    </p>
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
    </FormActions>
  {:else if phase === 'success' && connectedAccount}
    <p data-testid="github-connect-success">
      Connected <strong>{connectedAccount.label}</strong> ({connectedAccount.host}).
    </p>
    <FormActions>
      <Button onclick={onClose} dataTestId="github-connect-done">Done</Button>
    </FormActions>
  {:else if phase === 'failure'}
    <ErrorNotice message={failureMessage ?? 'GitHub connect failed.'} />
    <FormActions>
      <Button variant="secondary" onclick={onClose} dataTestId="github-connect-close">Close</Button>
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
</style>
