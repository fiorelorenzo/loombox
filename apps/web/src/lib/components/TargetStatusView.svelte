<script lang="ts">
  /**
   * The node/target status view (SPEC §7.21; issue #269): every known node
   * and target with reachability, agent-process health, and CPU/RAM/disk,
   * reusing #253's per-target sampling (`TargetListEntry.health`) fanned
   * out over `RelayClient.listTargets()`. Purely presentational, mirroring
   * `TargetPicker.svelte`'s split — `+page.svelte` owns polling
   * `listTargets()` on an interval (issue #269's "refreshed on a regular
   * interval") and passes the latest snapshot plus loading/error state in.
   *
   * Distinguishes the three causes a stalled session's target can have
   * (issue #269's acceptance, "overload vs. unreachable vs. process
   * crash"):
   * - `reachable: false` — this target's owning **node** has no live relay
   *   connection at all ("Node offline").
   * - `reachable: true` but `health.healthy === false` — the node is up,
   *   but the sampler's own probe against *this* target failed (an `ssh:`
   *   exec error) — the target itself is unreachable/crashed even though
   *   its node is fine ("Unreachable").
   * - `reachable: true`, `health.healthy === true`, but CPU/RAM/disk is
   *   pinned near capacity — the target is up and sampling fine, just
   *   under load ("Overloaded"), the §7.16 concern this same sampling data
   *   also feeds.
   * - Anything else with a health reading is "Healthy"; no reading yet at
   *   all (a node that hasn't completed its first sample tick) is
   *   "No data yet" rather than any of the above.
   *
   * Warp Deck restyle (redesign brief `docs/design/redesign.md` §3/§4/§6,
   * issue #436): each row keeps its `raised` elevation tier but gains a
   * quiet left-edge stripe keyed by `healthState`, mirroring
   * `AttentionInbox`'s treatment so both attention surfaces read as one
   * family; the health badge grows a `StatusDot` alongside its (now
   * larger) text, and the CPU/RAM/disk meters switch from a plain `width`
   * transition to the shared `thread-draw-fill` primitive
   * (`$lib/styles/motion.css`). Empty and error states adopt the shared
   * `EmptyState`/`ErrorNotice` primitives. All `data-testid`s, DOM
   * structure the tests query, `focusTarget` highlighting, and every
   * callback contract are unchanged.
   *
   * Deck migration (redesign v2 §2 "one button language" / issue #466):
   * the Refresh header action rendered through the real `ui/Button`
   * rather than hand-styled `.header-btn` markup, using `Button`'s
   * `dataTestId` override (issue #460) to keep its existing
   * `target-status-refresh` selector — since replaced by an `IconButton`
   * below (redesign v3). The health
   * badge also gains a shape-coded glyph from the bespoke icon set
   * (`health-ok`/`health-warn`/`health-danger`) next to its `StatusDot`, so
   * the state reads by shape as well as color (no icon is drawn for the
   * neutral `no-data` state, which has none in the set — the dot alone
   * still carries it). Every remaining literal color/spacing/radius value
   * in this file's own styles is now a token.
   *
   * Connection management (redesign v2 §3.3; issue #476): each row gains
   * Reconnect/Update/Remove/Edit actions through `ui/Button` — entirely
   * additive behind the new optional `client` prop, so a caller that never
   * passes one (every existing call site, until a follow-up wires it) keeps
   * today's exact read-only view. Reconnect has no wire message of its own
   * (an `ssh:` target's transport already auto-reconnects on next use); it
   * just re-runs `onRefresh` for a fresh reachable/health read. Update and
   * Remove call `client.updateTarget`/`decommissionTarget`; Remove requires
   * an explicit confirm step first. Edit reuses `AddTargetWizard` itself
   * (100% of the same tested add-target machinery) rather than a second
   * form, opened in its `editing` mode — see that component's own doc
   * comment for what "prefilled from the target being edited" honestly
   * means given `TargetListEntry` never carries a target's connection
   * recipe (SPEC §8's crypto boundary).
   *
   * Panel chrome (redesign v3 design spec §3.6 `D2`): this view no longer
   * repeats its own "Nodes & targets" title or a Close action — the
   * Drawer that hosts it already renders both — so its own header
   * collapses to just the Refresh action, now a compact `IconButton`
   * rather than a labeled `Button`. `onClose` is gone from its props;
   * the caller (`+page.svelte`'s Drawer) owns closing the panel.
   *
   * Coherence v5 (`docs/superpowers/specs/2026-07-28-coherence-v5-design.md`
   * §3): each card becomes one dense row. The header line now answers
   * "which machine" directly — the target's label, then the sample's own
   * `hostname`/`platform`/`arch` (a target labeled "Local" on two different
   * boxes used to be indistinguishable) — plus tabular-nums load/mem/disk
   * readings and a terse relative age. The meters, the absolute sample
   * time, and the Reconnect/Update/Edit/Remove actions all move behind a
   * per-row disclosure (`expandedKeys`, collapsed by default, same
   * `SvelteSet` posture as `busyKeys` below) instead of always rendering.
   * `cpuPercent` is a load-average proxy that has always been mislabelled
   * as CPU (`@loombox/protocol`'s own doc comment on `targetHealth`); this
   * view reads the honestly-named `loadPercent` instead and labels it
   * "Load" — `cpuPercent` stays on the wire only for a peer that predates
   * `loadPercent` and is deliberately never read here.
   */
  import {
    buildIdentityMismatch,
    type BuildIdentityV1,
    type DecommissionTargetResponse,
    type NodeSelfUpdateApplyResponse,
    type TargetHealth,
    type TargetListEntry,
    type TargetUpdateResponse,
  } from '$lib/relay-client';
  import type { TargetConcurrencySnapshot } from '$lib/target-concurrency';
  import WovenLoader from './WovenLoader.svelte';
  import Badge from './ui/Badge.svelte';
  import { type StatusTone } from './ui/StatusDot.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { Icon, type IconName } from './icons';
  import AddTargetWizard, {
    type AddTargetClient,
    type EditingTarget,
  } from './AddTargetWizard.svelte';
  import { SvelteSet } from 'svelte/reactivity';

  /** `TargetStatusView`'s own action surface on top of `AddTargetWizard`'s add/edit contract (issue #476) — `decommissionTarget`/`updateTarget` are required here (unlike `AddTargetClient`'s optional `decommissionTarget`), since every action this view offers besides Edit needs them the moment a `client` is passed at all. `applyNodeSelfUpdate` (issue #656) is the node's OWN update, distinct from `updateTarget`'s per-`ssh:`-target supervisor update — see that method's own doc comment on `RelayClient`. */
  export interface TargetActionsClient extends AddTargetClient {
    decommissionTarget: (
      options: { nodeId: string; targetId: string; removeFiles?: boolean },
      timeoutMs?: number,
    ) => Promise<DecommissionTargetResponse>;
    updateTarget: (
      options: { nodeId: string; targetId: string },
      timeoutMs?: number,
    ) => Promise<TargetUpdateResponse>;
    applyNodeSelfUpdate: (
      options: { nodeId: string },
      timeoutMs?: number,
    ) => Promise<NodeSelfUpdateApplyResponse>;
  }

  export interface FocusTarget {
    nodeId: string;
    targetId: string;
  }

  interface Props {
    targets: TargetListEntry[];
    /** True only for the first, still-in-flight fetch — a background refresh reusing an existing list never re-shows this. */
    loading: boolean;
    error: string | undefined;
    onRefresh: () => void;
    /** A specific node/target to highlight (issue #269's "a stalled session's view links back to this status view for its target") — e.g. `+page.svelte` sets this from the session row the user clicked through from. */
    focusTarget?: FocusTarget;
    /** Enables the per-target Reconnect/Update/Remove/Edit actions (redesign v2 §3.3; issue #476) — omit to keep this view exactly as read-only as before. */
    client?: TargetActionsClient;
    /**
     * This account's relay's own build identity (issue #655), from
     * `RelayClient.relayBuildIdentity` — "what is actually being served",
     * the baseline every row's own `target.build` is compared against.
     * `undefined` before the first handshake, or against a relay that
     * predates #655 — either way no row is ever flagged off an unknown
     * baseline (`buildIdentityMismatch`'s own contract).
     */
    relayBuildIdentity?: BuildIdentityV1;
    /**
     * Per-target best-effort running/queued session counts (issue #255),
     * keyed by {@link rowKey} — `+page.svelte`'s own
     * `target-concurrency.ts#summarizeTargetConcurrency`, read alongside
     * `TargetListEntry.maxConcurrentSessions`/`maxConcurrentSessionsSource`
     * (wire-sent, always current) to render "N/cap, source" next to a
     * queued badge. Defaults to an empty map — a caller with no session
     * data yet just shows every target at `0/cap`, never a hole in the
     * row.
     */
    concurrency?: Map<string, TargetConcurrencySnapshot>;
    /**
     * Uninstalls the local resident node behind a `target.kind === 'local'`
     * row (issue #814, decision E1-3) — a desktop-only IPC action, never a
     * relay-wire one (`$lib/local-node-uninstall.ts`'s own doc comment
     * explains why this can't go through `client`: it authenticates as the
     * node being torn down, using its own on-disk identity, not this
     * account session). `undefined` outside the desktop shell — that row's
     * Uninstall action simply doesn't render, mirroring `AddProjectDialog`'s
     * own `onProvisionLocalNode` gate.
     */
    onUninstallLocalNode?: (request: {
      nodeId: string;
      keepData?: boolean;
    }) => Promise<{ ok: boolean; deviceRevoked: boolean; message: string }>;
  }

  const {
    targets,
    loading,
    error,
    onRefresh,
    focusTarget,
    client,
    relayBuildIdentity,
    concurrency = new Map<string, TargetConcurrencySnapshot>(),
    onUninstallLocalNode,
  }: Props = $props();

  /** In-flight Update/Remove calls, keyed by {@link rowKey} — disables that row's own buttons and drives `Button`'s `loading` state without a page-wide spinner. `SvelteSet` (not a plain `Set` wrapped in `$state`, mirrors `FileTreePanel.svelte`'s own `expandedPaths`) so `.add`/`.delete` are reactive in place, no reassignment needed. */
  const busyKeys = new SvelteSet<string>();
  /** Rows currently showing Remove's "are you sure" confirm bar instead of its plain button, keyed by {@link rowKey}. */
  const confirmingRemove = new SvelteSet<string>();
  /** Rows currently showing Uninstall's "are you sure" confirm bar (issue #814) instead of its plain button, keyed by {@link rowKey} — same pattern as {@link confirmingRemove}, separate set since a local row's Uninstall and an ssh row's Remove never coexist on the same key but keeping them distinct avoids any future ambiguity. */
  const confirmingUninstall = new SvelteSet<string>();
  /** Per-row keep-data checkbox state for the Uninstall confirm bar (decision E1-3's explicit opt-out) — unchecked (remove everything) by default, keyed by {@link rowKey}. */
  let keepDataChoices = $state<Record<string, boolean>>({});
  /** The last Update/Remove outcome message per row, keyed by {@link rowKey} — cleared implicitly the next time either action runs on that row. */
  let actionMessages = $state<Record<string, string>>({});
  let editWizardOpen = $state(false);
  let editingTarget = $state<EditingTarget | undefined>(undefined);

  /** Rows currently showing their expansion — the meters, the absolute sample time, and (when `client` is passed) the Reconnect/Update/Edit/Remove actions (v5 design spec §3). Collapsed by default: the whole point of the dense row is that none of that has to render until asked for. */
  const expandedKeys = new SvelteSet<string>();

  function toggleExpanded(target: TargetListEntry): void {
    const key = rowKey(target);
    if (expandedKeys.has(key)) {
      expandedKeys.delete(key);
    } else {
      expandedKeys.add(key);
    }
  }

  /** The overload threshold this view flags — deliberately not configurable at v1 (a fixed, documented figure is more legible than a per-target setting nobody has looked at yet); §7.16's own configurable per-target limits are the future consumer of this same sampling data. */
  const OVERLOAD_PERCENT = 90;

  function rowKey(target: TargetListEntry): string {
    return `${target.nodeId}:${target.targetId}`;
  }

  function isFocused(target: TargetListEntry): boolean {
    return (
      focusTarget !== undefined &&
      focusTarget.nodeId === target.nodeId &&
      focusTarget.targetId === target.targetId
    );
  }

  type HealthState = 'no-data' | 'node-offline' | 'unreachable' | 'overloaded' | 'healthy';

  function healthState(target: TargetListEntry): HealthState {
    if (!target.reachable) return 'node-offline';
    if (!target.health) return 'no-data';
    if (!target.health.healthy) return 'unreachable';
    // Reads `loadPercent`, never the deprecated `cpuPercent` (v5 design spec §3) — see
    // this file's own doc comment. `loadPercent` is optional only for a peer that
    // predates it; a genuinely missing reading just can't push this into "overloaded"
    // on its own, mem/disk still can.
    const { loadPercent, memPercent, diskPercent } = target.health;
    if (
      (loadPercent !== undefined && loadPercent >= OVERLOAD_PERCENT) ||
      memPercent >= OVERLOAD_PERCENT ||
      diskPercent >= OVERLOAD_PERCENT
    ) {
      return 'overloaded';
    }
    return 'healthy';
  }

  const HEALTH_LABELS: Record<HealthState, string> = {
    'no-data': 'No data yet',
    'node-offline': 'Node offline',
    unreachable: 'Unreachable',
    overloaded: 'Overloaded',
    healthy: 'Healthy',
  };

  /** Maps `HealthState` onto the shared `StatusDot` tone vocabulary — the same four semantic colors this view's own badge already carries, just also driving the dot. */
  const HEALTH_TONES: Record<HealthState, StatusTone> = {
    'no-data': 'neutral',
    'node-offline': 'danger',
    unreachable: 'danger',
    overloaded: 'warning',
    healthy: 'success',
  };

  /** Pairs the badge's `StatusDot` with a shape-distinct glyph from the bespoke icon set, so the state doesn't rely on color alone — `no-data` has no dedicated icon in the set and falls back to the dot only. */
  const HEALTH_ICONS: Partial<Record<HealthState, IconName>> = {
    'node-offline': 'health-danger',
    unreachable: 'health-danger',
    overloaded: 'health-warn',
    healthy: 'health-ok',
  };

  function meterLevel(percent: number | undefined): 'ok' | 'elevated' | 'high' {
    if (percent === undefined) return 'ok';
    if (percent >= OVERLOAD_PERCENT) return 'high';
    if (percent >= 75) return 'elevated';
    return 'ok';
  }

  /** A percent reading, or an em dash when the sample never carried one. Only `loadPercent` can be missing here (an older peer that predates it) — `memPercent`/`diskPercent` are mandatory on the wire. */
  function formatPercent(percent: number | undefined): string {
    return percent === undefined ? '—' : `${Math.round(percent)}%`;
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
    const value = bytes / 2 ** (10 * exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
  }

  function isNonEmpty(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  /**
   * "Which machine" (v5 design spec §3) — joins the sample's real `hostname` with its
   * `platform`/`arch`, e.g. `devbox-node-1 · linux/x64`. This is the fix for Lorenzo's
   * actual complaint: a target labeled "Local" reads identically whether it is the
   * devbox or the Mac. Every piece is independently optional (an older node predates
   * all three), so a missing one is simply left out rather than rendering a stray
   * "undefined" or a bare " · " — an older node's row degrades to just the target
   * label, not a hole.
   */
  function targetIdentity(health: TargetHealth | undefined): string | undefined {
    if (!health) return undefined;
    const platformArch = [health.platform, health.arch].filter(isNonEmpty).join('/');
    const parts = [health.hostname, platformArch].filter(isNonEmpty);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  /**
   * Whether `target.build` is a KNOWN-different build than this account's
   * relay (issue #655's middle outcome: same protocol, different build —
   * allowed, and surfaced right here on the node's own row, never a
   * modal/log). Pure equality via `buildIdentityMismatch` — never version
   * ordering — so `undefined` on either side (an older node, or before
   * this client's own handshake has landed) never renders as "behind".
   */
  function isBehind(target: TargetListEntry): boolean {
    return buildIdentityMismatch(relayBuildIdentity, target.build);
  }

  /**
   * Whether the OWNING NODE has an unapplied self-update ready (issue
   * #656) — `target.nodeSelfUpdate` is mirrored onto every target row
   * that node owns (`packages/relay/src/relay.ts`'s own doc comment on
   * that field), so this reads the same for every row sharing a
   * `nodeId`, exactly like `isBehind` reads the same `build` value for
   * them. `undefined` (an older node, or before its first check
   * completes) and `'current'`/`'unknown'` all render as "nothing to
   * offer" — only a definite `'update_available'` shows anything, never
   * a guess.
   */
  function isNodeUpdateAvailable(target: TargetListEntry): boolean {
    return target.nodeSelfUpdate?.status === 'update_available';
  }

  /** Terse relative age for the row header (e.g. "28s", "5m") — the dense row's own compact echo of {@link formatAbsoluteSampledAt}, which the expansion carries in full (v5 design spec §3 moves the absolute time behind the disclosure). */
  function formatRelativeAge(health: TargetHealth): string {
    const ageMs = Date.now() - health.sampledAt;
    if (ageMs < 1_000) return 'now';
    if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
    if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
    return `${Math.round(ageMs / 3_600_000)}h`;
  }

  /** Absolute sample time for the expansion, pinned to UTC/en-US rather than the viewer's own locale/timezone — the same sample reads identically everywhere (including in tests) instead of silently shifting with whoever is looking at it. */
  function formatAbsoluteSampledAt(health: TargetHealth): string {
    return new Date(health.sampledAt).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'UTC',
    });
  }

  /**
   * "Reconnect" (redesign v2 §3.3; issue #476): there is no reconnect wire
   * message at all (`@loombox/protocol`'s `target-lifecycle.ts` doc comment)
   * — an `ssh:` target's pooled transport already auto-reconnects on next
   * use, so the one useful thing a client can do is ask for a fresh
   * reachable/health read, exactly what the header's own Refresh button
   * already does.
   */
  function reconnect(): void {
    onRefresh();
  }

  async function runUpdate(target: TargetListEntry): Promise<void> {
    if (!client) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await client.updateTarget({
        nodeId: target.nodeId,
        targetId: target.targetId,
      });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
    }
  }

  /**
   * The "Update" one-tap action for the NODE's own self-update (issue
   * #656) — distinct from `runUpdate` above, which re-provisions the
   * supervisor on one `ssh:` target. Applies to the whole node that owns
   * `target`, never just this one row, exactly like `isNodeUpdateAvailable`
   * reads the same shared `nodeSelfUpdate` value across every row that
   * node owns. No separate confirm step: this click IS the explicit
   * consent the epic requires (#653's "out of scope: auto-updating
   * without consent") — the mechanism itself (stage, verify, activate,
   * roll back on failure) is what makes it safe to apply directly, the
   * same posture `runUpdate` already takes for a target update.
   */
  async function runNodeSelfUpdate(target: TargetListEntry): Promise<void> {
    if (!client) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await client.applyNodeSelfUpdate({ nodeId: target.nodeId });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
    }
  }

  function startRemove(target: TargetListEntry): void {
    confirmingRemove.add(rowKey(target));
  }

  function cancelRemove(target: TargetListEntry): void {
    confirmingRemove.delete(rowKey(target));
  }

  async function confirmRemove(target: TargetListEntry): Promise<void> {
    if (!client) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await client.decommissionTarget({
        nodeId: target.nodeId,
        targetId: target.targetId,
      });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
      confirmingRemove.delete(key);
    }
  }

  function startUninstall(target: TargetListEntry): void {
    keepDataChoices = { ...keepDataChoices, [rowKey(target)]: false };
    confirmingUninstall.add(rowKey(target));
  }

  function cancelUninstall(target: TargetListEntry): void {
    confirmingUninstall.delete(rowKey(target));
  }

  function toggleKeepData(target: TargetListEntry, checked: boolean): void {
    keepDataChoices = { ...keepDataChoices, [rowKey(target)]: checked };
  }

  /** Issue #814, decision E1-3: revokes this node's device on the relay and tears down its local install (see `onUninstallLocalNode`'s own doc comment for exactly what). `keepDataChoices[key]` defaults to `false` (nothing unset yet means the confirm bar was never opened, which never reaches here) — the explicit opt-out `startUninstall` initializes on open. */
  async function confirmUninstall(target: TargetListEntry): Promise<void> {
    if (!onUninstallLocalNode) return;
    const key = rowKey(target);
    busyKeys.add(key);
    try {
      const response = await onUninstallLocalNode({
        nodeId: target.nodeId,
        keepData: keepDataChoices[key] ?? false,
      });
      actionMessages = { ...actionMessages, [key]: response.message };
      if (response.ok) onRefresh();
    } catch (error) {
      actionMessages = {
        ...actionMessages,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      busyKeys.delete(key);
      confirmingUninstall.delete(key);
    }
  }

  /** Opens the embedded `AddTargetWizard` in Edit mode (issue #476) — see that component's own doc comment for what "prefilled" means here. */
  function openEdit(target: TargetListEntry): void {
    editingTarget = { nodeId: target.nodeId, targetId: target.targetId, label: target.label };
    editWizardOpen = true;
  }

  function closeEditWizard(): void {
    editWizardOpen = false;
    editingTarget = undefined;
  }

  /** The edit's replacement target is now paired — refresh so the list reflects the swap (the old target is already gone from a prior `decommissionTarget` call inside the wizard itself). */
  function handleEditProvisioned(): void {
    onRefresh();
  }
</script>

<section class="target-status-view" data-testid="target-status-view">
  <div class="header">
    <IconButton
      label="Refresh nodes and targets"
      onclick={onRefresh}
      dataTestId="target-status-refresh"
    >
      <Icon name="refresh" />
    </IconButton>
  </div>

  {#if error}
    <ErrorNotice message={error} retryable onRetry={onRefresh} />
  {/if}

  {#if loading}
    <p class="loading-state">
      <WovenLoader label="Checking node/target status" />
      Checking node/target status…
    </p>
  {:else if targets.length === 0}
    <!-- Points at nothing in particular on purpose: the two setup actions
         moved onto this surface's own header when it became the Nodes page
         (IA v4 §3.1), so the old "from the sidebar" told you to look in the
         one place they are no longer. -->
    <EmptyState
      message="No nodes or targets connected yet. Add a target or connect a node to get started."
    />
  {:else}
    <ul class="target-rows">
      {#each targets as target (rowKey(target))}
        {@const state = healthState(target)}
        {@const icon = HEALTH_ICONS[state]}
        {@const key = rowKey(target)}
        {@const expanded = expandedKeys.has(key)}
        {@const identity = targetIdentity(target.health)}
        {@const behind = isBehind(target)}
        {@const nodeUpdateAvailable = isNodeUpdateAvailable(target)}
        <li class="target-row" data-testid="target-status-row">
          <div
            data-testid={`target-status-row-${key}`}
            class="target-row-inner"
            data-health={state}
            class:focused={isFocused(target)}
          >
            <button
              type="button"
              class="row-header"
              onclick={() => toggleExpanded(target)}
              aria-expanded={expanded}
              data-testid={`target-row-toggle-${key}`}
            >
              <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
              <Badge
                tone={HEALTH_TONES[state]}
                size="md"
                dot
                dotLabel={HEALTH_LABELS[state]}
                class="agent-health-badge"
                dataTestId="agent-health-badge"
              >
                {#if icon}<Icon name={icon} />{/if}{HEALTH_LABELS[state]}
              </Badge>
              <span class="target-label">{target.label}</span>
              <Badge size="sm" class="kind-badge">{target.kind}</Badge>
              {#if identity}
                <span class="target-identity font-mono" data-testid={`target-identity-${key}`}
                  >{identity}</span
                >
              {/if}
              {#if target.build}
                <span class="target-build font-mono" data-testid={`target-build-${key}`}
                  >v{target.build.version}</span
                >
              {/if}
              {#if behind}
                <Badge
                  tone="warning"
                  size="sm"
                  class="behind-badge"
                  dataTestId={`target-behind-${key}`}>Behind</Badge
                >
              {/if}
              {#if nodeUpdateAvailable}
                <Badge
                  tone="warning"
                  size="sm"
                  class="node-update-available-badge"
                  dataTestId={`target-node-update-available-${key}`}>Update available</Badge
                >
              {/if}
              <span class="target-metrics">
                {#if target.maxConcurrentSessions !== undefined}
                  {@const snapshot = concurrency.get(key) ?? { running: 0, queued: 0 }}
                  <span class="metric" data-testid={`target-concurrency-${key}`}>
                    <span class="metric-label">Slots</span>
                    <span
                      class="metric-value font-mono"
                      data-testid={`target-concurrency-cap-${key}`}
                      >{snapshot.running}/{target.maxConcurrentSessions}</span
                    >
                    <span
                      class="concurrency-source"
                      data-testid={`target-concurrency-source-${key}`}
                      >{target.maxConcurrentSessionsSource === 'configured'
                        ? 'configured'
                        : 'default'}</span
                    >
                  </span>
                  {#if snapshot.queued > 0}
                    <Badge
                      tone="warning"
                      size="sm"
                      class="concurrency-queued-badge"
                      dataTestId={`target-concurrency-queued-${key}`}
                    >
                      {snapshot.queued} queued
                    </Badge>
                  {/if}
                {/if}
                {#if target.health}
                  {@const health = target.health}
                  <span class="metric" data-testid="metric-load">
                    <span class="metric-label">Load</span><span class="metric-value font-mono"
                      >{formatPercent(health.loadPercent)}</span
                    >
                  </span>
                  <span class="metric" data-testid="metric-mem">
                    <span class="metric-label">RAM</span><span class="metric-value font-mono"
                      >{formatPercent(health.memPercent)}</span
                    >
                  </span>
                  <span class="metric" data-testid="metric-disk">
                    <span class="metric-label">Disk</span><span class="metric-value font-mono"
                      >{formatPercent(health.diskPercent)}</span
                    >
                  </span>
                  <span class="target-age font-mono">{formatRelativeAge(health)}</span>
                {:else}
                  <span class="no-data">No data yet</span>
                {/if}
              </span>
            </button>

            {#if expanded}
              <div class="target-expansion" data-testid="target-expansion">
                <p class="node-id font-mono">Node {target.nodeId}</p>
                {#if target.health}
                  {@const health = target.health}
                  <div class="meters">
                    <div class="meter-row">
                      <span class="meter-label">Load</span>
                      <div class="meter" data-testid="load-meter">
                        <div
                          class="meter-fill thread-draw-fill"
                          data-level={meterLevel(health.loadPercent)}
                          style={`--thread-draw-progress: ${Math.min(100, health.loadPercent ?? 0)}%`}
                        ></div>
                      </div>
                      <span class="meter-value font-mono">{formatPercent(health.loadPercent)}</span>
                    </div>
                    <div class="meter-row">
                      <span class="meter-label">RAM</span>
                      <div class="meter" data-testid="mem-meter">
                        <div
                          class="meter-fill thread-draw-fill"
                          data-level={meterLevel(health.memPercent)}
                          style={`--thread-draw-progress: ${Math.min(100, health.memPercent)}%`}
                        ></div>
                      </div>
                      <span class="meter-value font-mono"
                        >{formatPercent(health.memPercent)} ({formatBytes(health.memUsedBytes)} / {formatBytes(
                          health.memTotalBytes,
                        )})</span
                      >
                    </div>
                    <div class="meter-row">
                      <span class="meter-label">Disk</span>
                      <div class="meter" data-testid="disk-meter">
                        <div
                          class="meter-fill thread-draw-fill"
                          data-level={meterLevel(health.diskPercent)}
                          style={`--thread-draw-progress: ${Math.min(100, health.diskPercent)}%`}
                        ></div>
                      </div>
                      <span class="meter-value font-mono"
                        >{formatPercent(health.diskPercent)} ({formatBytes(health.diskUsedBytes)} / {formatBytes(
                          health.diskTotalBytes,
                        )})</span
                      >
                    </div>
                  </div>
                  <p class="sampled-at" data-testid="target-sampled-at">
                    Sampled <span class="font-mono">{formatAbsoluteSampledAt(health)}</span>
                  </p>
                  <p class="overload-note">
                    Flags overloaded at <span class="font-mono">{OVERLOAD_PERCENT}%</span> load, memory,
                    or disk.
                  </p>
                {:else}
                  <p class="no-data">No data yet.</p>
                {/if}

                {#if client}
                  <div class="target-actions" data-testid="target-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      onclick={reconnect}
                      dataTestId={`target-action-reconnect-${key}`}
                    >
                      Reconnect
                    </Button>
                    {#if nodeUpdateAvailable}
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyKeys.has(key)}
                        disabled={busyKeys.has(key)}
                        onclick={() => runNodeSelfUpdate(target)}
                        dataTestId={`target-action-node-self-update-${key}`}
                      >
                        Update node
                      </Button>
                    {/if}
                    {#if target.kind === 'ssh'}
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyKeys.has(key)}
                        disabled={busyKeys.has(key)}
                        onclick={() => runUpdate(target)}
                        dataTestId={`target-action-update-${key}`}
                      >
                        Update
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyKeys.has(key)}
                        onclick={() => openEdit(target)}
                        dataTestId={`target-action-edit-${key}`}
                      >
                        Edit
                      </Button>
                      {#if confirmingRemove.has(key)}
                        <span
                          class="remove-confirm"
                          data-testid={`target-action-remove-confirmbar-${key}`}
                        >
                          Remove this target?
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyKeys.has(key)}
                            onclick={() => cancelRemove(target)}
                            dataTestId={`target-action-remove-cancel-${key}`}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busyKeys.has(key)}
                            onclick={() => confirmRemove(target)}
                            dataTestId={`target-action-remove-confirm-${key}`}
                          >
                            Remove
                          </Button>
                        </span>
                      {:else}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyKeys.has(key)}
                          onclick={() => startRemove(target)}
                          dataTestId={`target-action-remove-${key}`}
                        >
                          Remove
                        </Button>
                      {/if}
                    {/if}
                    {#if target.kind === 'local' && onUninstallLocalNode}
                      {#if confirmingUninstall.has(key)}
                        <span
                          class="uninstall-confirm"
                          data-testid={`target-action-uninstall-confirmbar-${key}`}
                        >
                          <p
                            class="uninstall-warning"
                            data-testid={`target-action-uninstall-warning-${key}`}
                          >
                            Uninstalling removes this node completely. Unless you keep your data,
                            this also permanently deletes every session transcript and project
                            secret stored on this machine — they exist in clear only here; the relay
                            only ever holds ciphertext it cannot read, so once removed they cannot
                            be recovered. Either way, this device is revoked on your account and
                            will not be able to reconnect.
                          </p>
                          <label class="uninstall-keep-data">
                            <input
                              type="checkbox"
                              checked={keepDataChoices[key] ?? false}
                              onchange={(event) =>
                                toggleKeepData(target, event.currentTarget.checked)}
                              data-testid={`target-action-uninstall-keepdata-${key}`}
                            />
                            Keep session history and project secrets on this machine
                          </label>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyKeys.has(key)}
                            onclick={() => cancelUninstall(target)}
                            dataTestId={`target-action-uninstall-cancel-${key}`}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busyKeys.has(key)}
                            onclick={() => confirmUninstall(target)}
                            dataTestId={`target-action-uninstall-confirm-${key}`}
                          >
                            Uninstall
                          </Button>
                        </span>
                      {:else}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyKeys.has(key)}
                          onclick={() => startUninstall(target)}
                          dataTestId={`target-action-uninstall-${key}`}
                        >
                          Uninstall
                        </Button>
                      {/if}
                    {/if}
                  </div>
                  {#if actionMessages[key]}
                    <p class="action-message" data-testid={`target-action-message-${key}`}>
                      {actionMessages[key]}
                    </p>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if client}
  <AddTargetWizard
    open={editWizardOpen}
    {client}
    editing={editingTarget}
    onClose={closeEditWizard}
    onProvisioned={handleEditProvisioned}
  />
{/if}

<style>
  .target-status-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .header {
    display: flex;
    justify-content: flex-end;
  }

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-secondary);
  }

  .no-data {
    opacity: 0.6;
    font-size: var(--text-small-size);
    margin: 0;
  }

  .target-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .target-row {
    display: contents;
  }

  /* Raised elevation tier (redesign brief §3), plus a quiet left-edge
     stripe keyed by `healthState` — the same "stripe, not a tinted card"
     language `AttentionInbox` uses, so both attention surfaces read as
     one family. */
  .target-row-inner {
    display: flex;
    flex-direction: column;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    border-left-width: var(--space-2xs);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    transition:
      border-color var(--duration-fast) var(--ease-beat),
      box-shadow var(--duration-fast) var(--ease-beat);
  }

  .target-row-inner[data-health='healthy'] {
    border-left-color: var(--color-success);
  }

  .target-row-inner[data-health='overloaded'] {
    border-left-color: var(--color-warning);
  }

  .target-row-inner[data-health='unreachable'],
  .target-row-inner[data-health='node-offline'] {
    border-left-color: var(--color-danger);
  }

  .target-row-inner[data-health='no-data'] {
    border-left-color: var(--color-border-strong);
  }

  .target-row-inner.focused {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }

  /* The dense row itself (v5 design spec §3): a plain full-width button so
     the whole line — not just a small chevron — toggles the expansion,
     matching `BashWidget`/`GenericToolRow`'s own disclosure convention. */
  .row-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-sm);
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  :global(.disclosure-icon) {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  /* `Badge` owns the pill's chrome (radius, padding, tone colors) now —
     this is only the uppercase/tracking treatment `kind-badge` still wants
     on top of it. `:global()` because `Badge` renders its own root in its
     own component scope (same pattern as `TargetPicker`'s own copy of this
     rule — the two `kind-badge`s are the literal duplicate issue #579
     names, unified onto one primitive but still each carrying this one
     content-transform locally). */
  :global(.kind-badge) {
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .target-label {
    font-weight: 600;
  }

  /* "Which machine" (v5 design spec §3) — the sample's real hostname/
     platform/arch, right next to the target's own label. */
  .target-identity {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .node-id {
    font-size: var(--text-small-size);
    opacity: 0.7;
    margin: 0;
  }

  /* Health/status badge (redesign brief §6, issue #436; composes `Badge`
     as of issue #579): `Badge`'s own tone ladder now supplies the
     success/warning/danger coloring `HEALTH_TONES` already drove — no
     separate `[data-state]` color table needed on top of it. */

  /* Load/mem/disk plus the relative age, pushed to the row's trailing edge
     (v5 design spec §3's "column of targets stays scannable") — tabular
     figures so the digits themselves don't jitter the column width as a
     row's numbers change on refresh. */
  .target-metrics {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-sm);
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-size: var(--text-small-size);
  }

  .metric {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3xs);
  }

  .metric-label {
    color: var(--color-text-muted);
  }

  .metric-value {
    color: var(--color-text-secondary);
  }

  /* The cap's honesty marker (issue #255) — parenthetical-weight text, not
     a badge: it modifies the "Slots" reading right next to it rather than
     standing as its own state the way the queued count's `Badge` does. */
  .concurrency-source {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .target-age {
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* The disclosure body: meters, absolute sample time, overload threshold,
     and (when a `client` is passed) the connection-management actions —
     all moved here from the always-visible row (v5 design spec §3). */
  .target-expansion {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    margin-top: var(--space-sm);
    padding-top: var(--space-sm);
    border-top: 1px solid var(--color-border-subtle);
  }

  .meters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
  }

  .meter-row {
    display: grid;
    grid-template-columns: var(--space-3xl) 1fr auto;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
  }

  .meter-label {
    opacity: 0.7;
  }

  .meter {
    height: var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    overflow: hidden;
  }

  /* thread-draw-fill (redesign brief §2, `$lib/styles/motion.css`): the
     fill spans the full track and reveals only its `--thread-draw-progress`
     share via `clip-path`, replacing the previous plain `width` transition
     — with `motion.css`'s own reduced-motion fallback applying for free. */
  .meter-fill {
    width: 100%;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .meter-fill[data-level='elevated'] {
    background: var(--color-warning);
  }

  .meter-fill[data-level='high'] {
    background: var(--color-danger);
  }

  .meter-value {
    white-space: nowrap;
    opacity: 0.8;
  }

  .sampled-at {
    margin: 0;
    font-size: var(--text-small-size);
    opacity: 0.6;
  }

  /* The overload threshold, named rather than left as folklore (v5 design
     spec §3's own phrasing). */
  .overload-note {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  /* Connection management actions (redesign v2 §3.3; issue #476). */
  .target-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
  }

  .remove-confirm {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .uninstall-confirm {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-xs);
    width: 100%;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .uninstall-warning {
    margin: 0;
    color: var(--color-danger);
  }

  .uninstall-keep-data {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
  }

  .action-message {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }
</style>
