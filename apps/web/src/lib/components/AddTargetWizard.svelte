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
   *
   * Deck migration (redesign v2 §2 "One button language", issue #465):
   * every hand-rolled `.btn`/`.btn-primary`/`.btn-secondary` here is gone in
   * favor of the shared `ui/Button` primitive, using its `dataTestId`
   * override (issue #460) to keep every `add-target-*` testid this
   * component's own tests rely on — unlike `NewSessionDialog.svelte`'s
   * still-hand-styled buttons (written before that override existed),
   * this file is a real call site now that the primitive supports it.
   * There is no glyph anywhere in this wizard (the step indicator is
   * label-only, `StatusDot` already covers per-status color), so
   * `ui/IconButton`/the `Icon` component have nothing to attach to here.
   */
  import type {
    ProvisionProgress,
    ProvisionTargetHostInputV1,
    ProvisionTargetResult,
    SshAgentInfoV1,
    SshDiscoveryResultV1,
    SshHostCandidateV1,
    TargetListEntry,
  } from '$lib/relay-client';
  import WovenLoader from './WovenLoader.svelte';
  import Button from './ui/Button.svelte';
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
    /**
     * Asks `nodeId` to run its own SSH host autodetection over the relay
     * (redesign v2 §3.2; issue #475) — this wizard's fallback source when
     * there is no {@link getDesktopBridge desktop IPC bridge} in scope (the
     * PWA case, no local filesystem access of its own).
     */
    discoverSshHosts: (nodeId: string, timeoutMs?: number) => Promise<SshDiscoveryResultV1>;
  }

  /**
   * The desktop app's own IPC bridge (`apps/desktop/src/shared/bridge.ts`'s
   * `listSshHostCandidates`), present only inside its Electron
   * `BrowserWindow` — this is the SAME `apps/web` PWA build the desktop
   * shell loads (see `AGENTS.md`'s "Testing the desktop app on the Mac"),
   * so `window.loombox` is how this component tells the two apart. A
   * minimal duck-typed shape declared locally rather than importing
   * `apps/desktop`'s own bridge types, to keep this app's dependency graph
   * one-directional (the desktop app depends on this app's build output,
   * never the other way around).
   */
  interface DesktopSshBridge {
    listSshHostCandidates: () => Promise<{
      candidates: SshHostCandidateV1[];
      requiresManualEntry: boolean;
    }>;
  }

  /** `undefined` in a plain browser tab (the PWA case) or in this component's own SSR/test environment; the real bridge only inside the desktop shell's `BrowserWindow`. */
  function getDesktopBridge(): DesktopSshBridge | undefined {
    if (typeof window === 'undefined') return undefined;
    const bridge = (window as unknown as { loombox?: Partial<DesktopSshBridge> }).loombox;
    return typeof bridge?.listSshHostCandidates === 'function'
      ? (bridge as DesktopSshBridge)
      : undefined;
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

  // The candidate-card picker (redesign v2 §3.2; issue #475) — populated
  // from whichever source responds (the desktop IPC bridge if present,
  // else the relay round trip to the acting node); `manualOverride` is the
  // wizard's "Enter manually" fallback, which always works regardless of
  // what (if anything) was discovered.
  let candidates = $state<SshHostCandidateV1[]>([]);
  let candidatesLoading = $state(false);
  let manualOverride = $state(false);
  let agentInfo = $state<SshAgentInfoV1 | undefined>(undefined);

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
    if (actingNodeId) void loadCandidates();
  }

  /**
   * Prefers the desktop IPC bridge (this machine's own `~/.ssh/config`,
   * issue #403/#475) when this component runs inside the desktop shell;
   * otherwise falls back to asking the acting node over the relay
   * ({@link AddTargetClient.discoverSshHosts}, the PWA's own path with no
   * local filesystem access). Never blocks/breaks the wizard on failure —
   * an empty `candidates` list just means step 1 renders the manual form
   * directly, exactly SPEC §7.23's "falls back to manual entry" contract.
   */
  async function loadCandidates(): Promise<void> {
    candidatesLoading = true;
    try {
      const bridge = getDesktopBridge();
      if (bridge) {
        const discovered = await bridge.listSshHostCandidates();
        candidates = discovered.candidates;
        agentInfo = undefined;
        return;
      }
      if (client && actingNodeId) {
        const discovered = await client.discoverSshHosts(actingNodeId);
        if (discovered.outcome === 'ok') {
          candidates = discovered.candidates;
          agentInfo = discovered.agent;
        } else {
          candidates = [];
          agentInfo = undefined;
        }
      }
    } catch {
      candidates = [];
      agentInfo = undefined;
    } finally {
      candidatesLoading = false;
    }
  }

  function selectCandidate(candidate: SshHostCandidateV1): void {
    host = candidate.hostName;
    user = candidate.user ?? '';
    port = candidate.port ? String(candidate.port) : '';
    alias = candidate.alias;
    label = candidate.alias;
    step = 'review';
  }

  function candidateHasKnownAuth(candidate: SshHostCandidateV1): boolean {
    return candidate.identityFiles.length > 0;
  }

  function candidateTone(candidate: SshHostCandidateV1): StatusTone {
    if (candidateHasKnownAuth(candidate)) return 'success';
    if (agentInfo?.available && agentInfo.identities.length > 0) return 'info';
    return 'neutral';
  }

  function candidateStatusLabel(candidate: SshHostCandidateV1): string {
    if (candidateHasKnownAuth(candidate)) return 'key on file';
    if (agentInfo?.available && agentInfo.identities.length > 0) return 'ssh-agent available';
    return 'no known key';
  }

  function resetWizard(): void {
    nodesError = undefined;
    actingNodeId = undefined;
    candidates = [];
    candidatesLoading = false;
    manualOverride = false;
    agentInfo = undefined;
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
          <Button variant="secondary" dataTestId="add-target-no-nodes-close" onclick={handleClose}>
            Close
          </Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if step === 'pick-host'}
    {#if candidatesLoading}
      <p class="status-line">
        <WovenLoader label="Looking for known hosts" />
        Looking for known hosts…
      </p>
    {:else if candidates.length > 0 && !manualOverride}
      <div class="candidate-picker" data-testid="add-target-candidates">
        <ul class="candidate-list">
          {#each candidates as candidate (candidate.alias)}
            <li>
              <button
                type="button"
                class="candidate-card"
                data-testid={`add-target-candidate-${candidate.alias}`}
                onclick={() => selectCandidate(candidate)}
              >
                <StatusDot
                  tone={candidateTone(candidate)}
                  label={candidateStatusLabel(candidate)}
                  size="sm"
                />
                <span class="candidate-info">
                  <span class="candidate-host"
                    >{candidate.user ? `${candidate.user}@` : ''}{candidate.hostName}</span
                  >
                  <span class="candidate-alias">{candidate.alias}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <div class="actions">
          <Button variant="secondary" dataTestId="add-target-cancel" onclick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            dataTestId="add-target-enter-manually"
            onclick={() => (manualOverride = true)}
          >
            Enter manually
          </Button>
        </div>
      </div>
    {:else}
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

        {#if candidates.length > 0}
          <button
            type="button"
            class="link-button"
            data-testid="add-target-back-to-candidates"
            onclick={() => (manualOverride = false)}
          >
            ← Back to detected hosts
          </button>
        {/if}

        <div class="actions">
          <Button variant="secondary" dataTestId="add-target-cancel" onclick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canReview} dataTestId="add-target-next">Next</Button>
        </div>
      </form>
    {/if}
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
        <Button variant="secondary" dataTestId="add-target-back" onclick={goBackToPickHost}>
          Back
        </Button>
        <Button dataTestId="add-target-confirm" onclick={confirmAndProvision}>Continue</Button>
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
        <Button dataTestId="add-target-done-close" onclick={handleClose}>
          {result?.ok ? 'Done' : 'Close'}
        </Button>
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
    font-size: var(--text-body-size);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .host-form input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .link-button {
    align-self: flex-start;
    margin-top: var(--space-2xs);
    padding: 0;
    border: none;
    background: none;
    color: var(--color-accent);
    font: inherit;
    font-size: var(--text-small-size);
    cursor: pointer;
    text-decoration: underline;
  }

  .link-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .candidate-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .candidate-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    max-height: 18rem;
    overflow-y: auto;
  }

  .candidate-card {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-subtle);
    background: var(--color-surface);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      background var(--duration-fast) var(--ease-beat);
  }

  .candidate-card:hover {
    border-color: var(--color-accent);
  }

  .candidate-card:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .candidate-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    min-width: 0;
  }

  .candidate-host {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .candidate-alias {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
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
