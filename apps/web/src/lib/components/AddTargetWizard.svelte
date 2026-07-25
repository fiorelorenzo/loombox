<script lang="ts">
  /**
   * The "Add target" wizard (SPEC §7.23; issue #408): the zero-touch
   * provision-and-pair flow assembled behind ONE explicit in-app
   * confirmation (Lorenzo's decision — no RFC 8628 `user_code` step). Four
   * states:
   *
   * 1. **pick-host** — pick or type an `ssh:` host. There is no live
   *    "list this node's `~/.ssh/config` candidates" wire request in v1
   *    (host autodetection, `packages/node/src/ssh/host-candidates.ts`, is a
   *    node-local concern with no RPC exposing it yet) — so this step is a
   *    plain host/user/port/alias form (SPEC §7.23's "falls back to manual
   *    entry when nothing is discoverable" already covers this shape; an
   *    `alias` field lets a caller who already knows their own `~/.ssh/config`
   *    entry name have the acting node resolve it, matching what
   *    `provisionTarget`'s wire `host.alias` is for).
   * 2. **review** — the human checkpoint that replaces the user_code: a
   *    single explicit "This will install a loombox node on <host> and pair
   *    it. Continue?" confirmation.
   * 3. **progress** — live `provision_progress` steps via
   *    `RelayClient.provisionTarget()`'s `onProgress`, using the
   *    woven-thread `WovenLoader` motif (SPEC §4).
   * 4. **done** — success (the new target is paired) or failure, with the
   *    step it stopped at.
   *
   * The "no nodes yet" empty state (SPEC §7.23's "at least one node must
   * already exist") is handled before step 1 even renders: this wizard needs
   * an already-connected node to drive the provisioning, exactly like
   * `NewSessionDialog`'s own "No nodes connected yet" state — pointing here
   * at the Mac app / a local node instead of a session's target picker.
   *
   * `client` is typed to the narrow `AddTargetClient` interface (not the
   * full `RelayClient`), mirroring `NewSessionDialog.svelte`'s own
   * narrowed-client pattern, so a hermetic component test injects a fake
   * without spinning up a real relay.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §4/§6,
   * issue #431): chrome moves onto the shared `Dialog` primitive; the
   * four steps get an explicit progress indicator across the top, its
   * fill driven by the shared `thread-draw` motion primitive
   * (`$lib/styles/motion.css`'s `.thread-draw-fill`) per the issue's
   * surface direction ("clear step progression using thread-draw for the
   * progress indicator"). The no-nodes empty state and terminal
   * success/failure lines read through `EmptyState`/`ErrorNotice`'s visual
   * language (wrapped, not imported bare, so this component's own
   * load-bearing `data-testid`s survive — see `NewSessionDialog.svelte`'s
   * identical note). Each progress-log entry gets a `StatusDot` for its
   * status instead of a plain capitalized word.
   */
  import type {
    ProvisionProgress,
    ProvisionTargetHostInputV1,
    ProvisionTargetResult,
    TargetListEntry,
  } from '$lib/relay-client';
  import WovenLoader from './WovenLoader.svelte';
  import Dialog from './ui/Dialog.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';

  export interface AddTargetClient {
    listTargets: (timeoutMs?: number) => Promise<TargetListEntry[]>;
    provisionTarget: (
      options: {
        nodeId: string;
        targetId: string;
        host: ProvisionTargetHostInputV1;
        onProgress?: (progress: ProvisionProgress) => void;
      },
      timeoutMs?: number,
    ) => Promise<ProvisionTargetResult>;
  }

  interface Props {
    open: boolean;
    client: AddTargetClient | undefined;
    onClose: () => void;
    /** Fired once a target is successfully provisioned and paired, with its new targetId. */
    onProvisioned?: (targetId: string) => void;
  }

  const { open, client, onClose, onProvisioned }: Props = $props();

  type WizardStep = 'pick-host' | 'review' | 'progress' | 'done';

  const STEPS: { id: WizardStep; label: string }[] = [
    { id: 'pick-host', label: 'Host' },
    { id: 'review', label: 'Review' },
    { id: 'progress', label: 'Provision' },
    { id: 'done', label: 'Done' },
  ];

  let nodesLoading = $state(false);
  let nodesError = $state<string | undefined>(undefined);
  let actingNodeId = $state<string | undefined>(undefined);

  let step = $state<WizardStep>('pick-host');
  let host = $state('');
  let user = $state('');
  let port = $state('');
  let alias = $state('');
  let label = $state('');

  let progressLog = $state<ProvisionProgress[]>([]);
  let result = $state<ProvisionTargetResult | undefined>(undefined);
  let provisionError = $state<string | undefined>(undefined);
  let generatedTargetId = $state('');

  const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));
  const stepProgressPercent = $derived(((stepIndex + 1) / STEPS.length) * 100);

  // Re-fetches (and resets the whole wizard) every time it actually opens,
  // or once `client` becomes available while already open — mirrors
  // `NewSessionDialog.svelte`'s own effect exactly.
  $effect(() => {
    if (!open) return;
    resetWizard();
    if (client) void loadNodes();
  });

  async function loadNodes(): Promise<void> {
    if (!client) return;
    nodesLoading = true;
    nodesError = undefined;
    try {
      const targets = await client.listTargets();
      const reachable = targets.find((t) => t.reachable);
      actingNodeId = (reachable ?? targets[0])?.nodeId;
    } catch (error) {
      nodesError = error instanceof Error ? error.message : String(error);
    } finally {
      nodesLoading = false;
    }
  }

  function resetWizard(): void {
    nodesError = undefined;
    actingNodeId = undefined;
    step = 'pick-host';
    host = '';
    user = '';
    port = '';
    alias = '';
    label = '';
    progressLog = [];
    result = undefined;
    provisionError = undefined;
    generatedTargetId = '';
  }

  const canReview = $derived(host.trim() !== '');

  function goToReview(event: Event): void {
    event.preventDefault();
    if (!canReview) return;
    step = 'review';
  }

  function goBackToPickHost(): void {
    step = 'pick-host';
  }

  function slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'host';
  }

  async function confirmAndProvision(): Promise<void> {
    if (!client || !actingNodeId) return;
    step = 'progress';
    progressLog = [];
    provisionError = undefined;
    generatedTargetId = `ssh:${slugify(host)}-${Date.now().toString(36)}`;

    const hostInput: ProvisionTargetHostInputV1 = {
      host: host.trim(),
      user: user.trim() || undefined,
      port: port.trim() ? Number(port.trim()) : undefined,
      alias: alias.trim() || undefined,
      label: label.trim() || undefined,
    };

    try {
      result = await client.provisionTarget({
        nodeId: actingNodeId,
        targetId: generatedTargetId,
        host: hostInput,
        onProgress: (progress) => {
          progressLog = [...progressLog, progress];
        },
      });
    } catch (error) {
      provisionError = error instanceof Error ? error.message : String(error);
    } finally {
      step = 'done';
      if (result?.ok && onProvisioned) onProvisioned(result.targetId);
    }
  }

  function handleClose(): void {
    onClose();
  }

  function progressEntryTone(status: ProvisionProgress['status']): StatusTone {
    if (status === 'ok') return 'success';
    if (status === 'failed') return 'danger';
    return 'info';
  }
</script>

{#snippet stepProgress()}
  <ol class="wizard-steps" aria-label="Add target progress">
    <div class="wizard-steps-track">
      <div
        class="wizard-steps-fill thread-draw-fill"
        style={`--thread-draw-progress: ${stepProgressPercent}%`}
      ></div>
    </div>
    {#each STEPS as s, index (s.id)}
      <li
        class="wizard-step"
        class:done={index < stepIndex}
        class:current={index === stepIndex}
        aria-current={index === stepIndex ? 'step' : undefined}
      >
        {s.label}
      </li>
    {/each}
  </ol>
{/snippet}

{#snippet dialogBody()}
  {#if actingNodeId}
    {@render stepProgress()}
  {/if}

  {#if nodesLoading}
    <p class="status-line">
      <WovenLoader label="Looking for a node to provision with" />
      Looking for a node to provision with…
    </p>
  {:else if nodesError}
    <p class="error" role="alert">{nodesError}</p>
  {:else if !actingNodeId}
    <div class="empty-state-slot" data-testid="add-target-no-nodes">
      <EmptyState
        message="You need at least one node first — run the Mac app or a local node, then come back here to add an SSH target."
      >
        {#snippet cta()}
          <button type="button" class="btn btn-secondary" onclick={handleClose}>Close</button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if step === 'pick-host'}
    <form class="host-form" onsubmit={goToReview}>
      <label for="add-target-host">Host</label>
      <input
        id="add-target-host"
        type="text"
        placeholder="10.0.0.5 or devbox.example.com"
        bind:value={host}
        data-testid="add-target-host"
      />

      <label for="add-target-user">User (optional)</label>
      <input
        id="add-target-user"
        type="text"
        placeholder="defaults to root"
        bind:value={user}
        data-testid="add-target-user"
      />

      <label for="add-target-port">Port (optional)</label>
      <input
        id="add-target-port"
        type="number"
        placeholder="22"
        bind:value={port}
        data-testid="add-target-port"
      />

      <label for="add-target-alias">~/.ssh/config alias (optional)</label>
      <input
        id="add-target-alias"
        type="text"
        placeholder="matches an entry the node already knows"
        bind:value={alias}
        data-testid="add-target-alias"
      />

      <label for="add-target-label">Label (optional)</label>
      <input
        id="add-target-label"
        type="text"
        placeholder="Defaults to the host"
        bind:value={label}
        data-testid="add-target-label"
      />

      <div class="actions">
        <button type="button" class="btn btn-secondary" onclick={handleClose}>Cancel</button>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={!canReview}
          data-testid="add-target-next"
        >
          Next
        </button>
      </div>
    </form>
  {:else if step === 'review'}
    <div class="review" data-testid="add-target-review">
      <p class="confirm-text">
        This will install a loombox node on <strong>{host}</strong> and pair it. Continue?
      </p>
      <ul class="review-details">
        <li><span>Host</span><span>{host}</span></li>
        {#if user}<li><span>User</span><span>{user}</span></li>{/if}
        {#if port}<li><span>Port</span><span>{port}</span></li>{/if}
        {#if alias}<li><span>Alias</span><span>{alias}</span></li>{/if}
      </ul>
      <div class="actions">
        <button type="button" class="btn btn-secondary" onclick={goBackToPickHost}>Back</button>
        <button
          type="button"
          class="btn btn-primary"
          onclick={confirmAndProvision}
          data-testid="add-target-confirm"
        >
          Continue
        </button>
      </div>
    </div>
  {:else if step === 'progress'}
    <div class="progress" data-testid="add-target-progress">
      <p class="status-line">
        <WovenLoader label="Provisioning" variant="working" />
        Provisioning "{host}"…
      </p>
      <ul class="progress-log">
        {#each progressLog as entry, index (index)}
          <li class="progress-entry">
            <StatusDot
              tone={progressEntryTone(entry.status)}
              pulse={entry.status === 'started'}
              label={entry.status}
              size="sm"
            />
            <span class="step-name">{entry.step.replaceAll('_', ' ')}</span>
            <span class="step-status">{entry.status}</span>
          </li>
        {/each}
      </ul>
    </div>
  {:else if step === 'done'}
    <div class="done" data-testid="add-target-done">
      {#if provisionError}
        <p class="error" role="alert" data-testid="add-target-error">{provisionError}</p>
      {:else if result?.ok}
        <p class="success" data-testid="add-target-success">
          <StatusDot tone="success" label="Paired" size="sm" />
          "{host}" is provisioned and paired.
        </p>
      {:else if result}
        <p class="error" role="alert" data-testid="add-target-failure">
          {result.message}
          {#if result.failedStep}
            (stopped at {result.failedStep.replaceAll('_', ' ')})
          {/if}
        </p>
      {/if}
      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          onclick={handleClose}
          data-testid="add-target-done-close"
        >
          {result?.ok ? 'Done' : 'Close'}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

<Dialog {open} label="Add target" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>Add target</h2>
  {/snippet}
</Dialog>

<style>
  .status-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .empty-state-slot {
    border-radius: var(--radius-lg);
    background: var(--color-fill-subtle);
  }

  /* Step progress — a thread-draw fill sweep (redesign brief §2's
     "thread-draw" row: "anything that fills or reveals") across the top
     of the wizard, plus a labeled step list below it (issue #431's
     surface direction: "clear step progression using thread-draw for the
     progress indicator"). */
  .wizard-steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    margin: 0 0 var(--space-sm);
    padding: 0;
    list-style: none;
  }

  .wizard-steps-track {
    position: relative;
    height: 3px;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    overflow: hidden;
  }

  .wizard-steps-fill {
    position: absolute;
    inset: 0;
    background: var(--color-accent);
  }

  .wizard-step {
    display: inline-block;
    margin-right: var(--space-md);
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
    font-weight: 500;
    transition: color var(--duration-fast) var(--ease-beat);
  }

  .wizard-step.done {
    color: var(--color-text-secondary);
  }

  .wizard-step.current {
    color: var(--color-accent);
  }

  .host-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .host-form label {
    margin-top: var(--space-xs);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .host-form input {
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: inherit;
    font-family: inherit;
    font-size: 0.9rem;
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .host-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .review {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .confirm-text {
    margin: 0;
  }

  .review-details {
    list-style: none;
    margin: 0;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-subtle);
    background: var(--color-surface);
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    font-size: var(--text-small-size);
  }

  .review-details li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .review-details li span:first-child {
    color: var(--color-text-muted);
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .progress-log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    max-height: 16rem;
    overflow-y: auto;
  }

  .progress-entry {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
    font-size: var(--text-small-size);
  }

  .step-name {
    flex: 1;
    text-transform: capitalize;
  }

  .step-status {
    color: var(--color-text-muted);
    text-transform: capitalize;
  }

  .done {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .success {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin: 0;
    padding: var(--space-md);
    border-radius: var(--radius-lg);
    background: var(--color-success-subtle);
    border: 1px solid var(--color-success);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-sm);
  }

  /* Hand-styled to match the shared `Button` primitive (see
     `NewSessionDialog.svelte`'s identical note: this wizard's own
     `add-target-*` testids are load-bearing for its tests). */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-xs);
    border-radius: var(--radius-md);
    padding: var(--space-sm) var(--space-lg);
    font-family: inherit;
    font-weight: 600;
    font-size: var(--text-body-size);
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .btn:not(:disabled):active {
    transform: scale(0.98);
  }

  .btn:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .btn-primary {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .btn-primary:not(:disabled):hover {
    background: var(--color-accent-hover);
  }

  .btn-primary:not(:disabled):active {
    background: var(--color-accent-active);
  }

  .btn-secondary {
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  .btn-secondary:not(:disabled):hover {
    background: var(--color-fill-subtle);
  }

  .error {
    margin: 0;
    padding: var(--space-md) var(--space-lg);
    border-radius: var(--radius-lg);
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
    color: var(--color-danger);
    font-size: var(--text-small-size);
  }
</style>
