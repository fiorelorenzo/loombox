<script lang="ts">
  /**
   * The permanent status bar (Zed-parity decision B1-1, issue #736):
   * loombox had no status bar at all, so every machine/session signal Zed
   * would put in one was scattered across the shell instead — a
   * connection chip that only rendered while unhealthy (`+page.svelte`'s
   * old `connectionNotice`/`.connection-chip`), target health as a boolean
   * dot glued onto the account avatar (`hasUnhealthyTarget`), build
   * identity's Behind badge only inside `TargetStatusView` on the Settings
   * page, session state as a dot in the sidebar list only, and the
   * context/cost meter living inside `ConfigBar`, visible only while a
   * session was selected and its composer was on screen.
   *
   * This bar is the one place all of that reads now, always mounted (see
   * `+page.svelte`'s `main.cockpit`) regardless of `mainView` — inbox,
   * settings, tracker or a session — so it is chrome for the WHOLE window,
   * not session-view furniture. Left is about the machine underneath
   * (relay connection, target health, the Behind badge); right is about
   * THIS session (its own status, the context/cost meter, how many other
   * sessions are queued behind it). B1-1 over the passive B1-2: every
   * segment that has somewhere useful to send a user is a real `<button>`
   * (connection retry, target health / Behind -> Settings > Nodes), not
   * inert text — this is the thing that makes B1-1 a "real" status bar
   * rather than a caption strip.
   *
   * The context/cost meter's markup/logic below is a straight port of
   * what used to live in `ConfigBar.svelte` (issue #248's usage-meter
   * correctness fixes, the near-limit warning, the `title` spelling both
   * figures out) — moved, not duplicated, per this issue's own explicit
   * instruction. It drops the old `compact` variant entirely: `compact`
   * existed only because the meter used to share a cramped composer row
   * with Send/attach/pickers on a 390px phone; this bar spans the full
   * window width on its own row, so there is nothing left to fit it
   * against and the denominator never has to go.
   *
   * No session selected reads as its own distinct state ("No session
   * selected"), never as `SESSION_STATUS_UNKNOWN_LABEL` ("No status yet")
   * — the latter is a real session whose first `session_status` hasn't
   * arrived yet, which is not the same fact and must not be presented as
   * one just because both cases happen to carry `undefined` upstream (see
   * `hasSelectedSession`'s own doc comment below).
   */
  import {
    CONTEXT_NEAR_LIMIT_THRESHOLD,
    contextFillPercent,
    type UsageRecord,
  } from '@loombox/providers-core/browser';
  import type { SessionStatusV1 } from '@loombox/protocol';
  import type { ConnectionStatus } from '$lib/relay-client';
  import { SESSION_STATUS_TONES, sessionStatusLabelWithReason } from '$lib/session-status';
  import Badge from './ui/Badge.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';

  /** Mirrors `TargetStatusView.svelte`'s own local `healthState()` classification (see `+page.svelte`'s `classifyTargetHealth`, the one place a `TargetListEntry` becomes this) — kept here as the shared vocabulary both that computation and this bar's summary read, rather than each guessing the other's shape. */
  export type TargetHealthDotState = 'healthy' | 'overloaded' | 'unreachable' | 'no-data';

  interface TargetHealthDot {
    key: string;
    label: string;
    state: TargetHealthDotState;
  }

  interface Props {
    // Left zone — the machine underneath.
    connectionStatus: ConnectionStatus;
    /** Only ever called while the connection segment's own Retry control is showing (`connectionSummary.retry`). */
    onRetryConnection: () => void;
    /**
     * The specific target the SELECTED session runs on (e.g. "MacBook-Pro-
     * Lorenzo"), `undefined` when nothing is selected — the piece B3-3
     * (issue #738) moves down from the topbar breadcrumb's old `project ·
     * target` trail, so it renders exactly once rather than duplicating
     * `targetHealthDots`' aggregate health summary just below it. Already
     * resolved to a human label by the caller (`+page.svelte`'s
     * `sessionTargetLabel`, the same helper the sidebar row and the canvas
     * zero state already use), not a bare `targetId` this component would
     * have to look up on its own.
     */
    selectedSessionTargetLabel: string | undefined;
    targetHealthDots: TargetHealthDot[];
    /** How many currently-listed targets' build identity mismatches this relay's own (`buildIdentityMismatch`) — `TargetStatusView`'s per-row Behind badge, aggregated. */
    targetsBehindCount: number;
    /** Both the target-health segment and the Behind badge open the same place: Settings > Nodes (`+page.svelte`'s `openTargetStatus`). */
    onOpenNodes: () => void;

    // Right zone — this session.
    /**
     * Whether a session is actually selected right now — deliberately
     * separate from `selectedSessionStatus` itself: that derived is
     * `undefined` BOTH when nothing is selected AND when a real selected
     * session simply hasn't reported a status yet, and this bar must
     * read differently for those two (acceptance: "with no session
     * selected the bar still reads correctly rather than showing stale
     * session state").
     */
    hasSelectedSession: boolean;
    selectedSessionStatus: SessionStatusV1 | undefined;
    /** The selected session's own `RelayClient.statusReasonFor` value — folded into the label by `sessionStatusLabelWithReason` exactly like the sidebar row's badge. */
    selectedSessionStatusReason: string | undefined;
    /** How many OTHER sessions across the account are currently `'queued'` (issue #730's "waiting for a concurrency slot") — not scoped to the selected session, since the point is surfacing contention the selected session's own status can't show. */
    queuedSessionCount: number;
    usage: UsageRecord | undefined;
    cumulativeCostUsd: number;
  }

  const {
    connectionStatus,
    onRetryConnection,
    selectedSessionTargetLabel,
    targetHealthDots,
    targetsBehindCount,
    onOpenNodes,
    hasSelectedSession,
    selectedSessionStatus,
    selectedSessionStatusReason,
    queuedSessionCount,
    usage,
    cumulativeCostUsd,
  }: Props = $props();

  /**
   * Unlike the retired `connectionNotice` this replaces, EVERY status gets
   * a reading, including the healthy one — that derived returned
   * `undefined` for `'open'` specifically so the old topbar chip could
   * render nothing at all (v2's "permanently green dot said nothing"
   * critique). A permanent bar has no such "render nothing" option: a
   * blank left zone the moment the connection recovers would itself read
   * as a stale/broken bar, so `'open'` gets `success`/"Connected" like
   * every other state gets its own tone/label.
   */
  const connection = $derived.by((): { tone: StatusTone; label: string; retry: boolean } => {
    switch (connectionStatus) {
      case 'open':
        return { tone: 'success', label: 'Connected', retry: false };
      case 'connecting':
        return { tone: 'warning', label: 'Connecting…', retry: false };
      case 'closed':
        return { tone: 'warning', label: 'Reconnecting…', retry: true };
      case 'error':
        return { tone: 'danger', label: 'Offline', retry: true };
      default:
        return { tone: 'neutral', label: 'Not connected', retry: false };
    }
  });

  /** One line for every target this account has, not a dot per target (that stays `TargetStatusView`'s job) — worst state wins the tone, same severity order `hasUnhealthyTarget` already used (`unreachable` outranks `overloaded`, both outrank an unclassified `no-data`). */
  function summarizeTargetHealth(dots: TargetHealthDot[]): { tone: StatusTone; label: string } {
    if (dots.length === 0) return { tone: 'neutral', label: 'No targets' };
    const unreachable = dots.filter((dot) => dot.state === 'unreachable').length;
    if (unreachable > 0) {
      return {
        tone: 'danger',
        label:
          unreachable === dots.length
            ? `${unreachable} unreachable`
            : `${unreachable} of ${dots.length} unreachable`,
      };
    }
    const overloaded = dots.filter((dot) => dot.state === 'overloaded').length;
    if (overloaded > 0) {
      return {
        tone: 'warning',
        label:
          overloaded === dots.length
            ? `${overloaded} overloaded`
            : `${overloaded} of ${dots.length} overloaded`,
      };
    }
    const noData = dots.filter((dot) => dot.state === 'no-data').length;
    if (noData === dots.length) {
      return { tone: 'neutral', label: `${dots.length} target${dots.length === 1 ? '' : 's'}` };
    }
    return {
      tone: 'success',
      label: `${dots.length} target${dots.length === 1 ? '' : 's'} healthy`,
    };
  }
  const targetSummary = $derived(summarizeTargetHealth(targetHealthDots));

  const sessionLabel = $derived(
    hasSelectedSession
      ? sessionStatusLabelWithReason(selectedSessionStatus, selectedSessionStatusReason)
      : 'No session selected',
  );
  const sessionTone = $derived(
    hasSelectedSession && selectedSessionStatus
      ? SESSION_STATUS_TONES[selectedSessionStatus]
      : 'neutral',
  );
  const sessionPulse = $derived(hasSelectedSession && selectedSessionStatus === 'working');

  // ------------------------------------------------------------------
  // Context/cost meter — ported verbatim from `ConfigBar.svelte` (issue
  // #736 moves it, not duplicates it). See that file's own git history
  // for the fixes this logic already carries (issue #248): `usage.
  // tokensUsed`/`contextWindow` arrive here already parent-only
  // (`transcript.ts`'s `reduceUsage` freezes them during a
  // subagent-attributed update), and `cumulativeCostUsd` is the session's
  // running total, never summed here.
  // ------------------------------------------------------------------
  const contextPercent = $derived(contextFillPercent(usage));

  const contextTokens = $derived(
    contextPercent !== undefined && usage?.tokensUsed !== undefined && usage.contextWindow
      ? { used: usage.tokensUsed, max: usage.contextWindow }
      : undefined,
  );

  const isNearLimit = $derived(
    contextPercent !== undefined && contextPercent >= CONTEXT_NEAR_LIMIT_THRESHOLD,
  );

  const meterTitle = $derived(
    contextTokens
      ? `${contextPercent}% of the context window used this turn${isNearLimit ? ' — nearly full' : ''} (${contextTokens.used.toLocaleString('en-US')} of ${contextTokens.max.toLocaleString('en-US')} tokens) · $${cumulativeCostUsd.toFixed(2)} spent this session`
      : `$${cumulativeCostUsd.toFixed(2)} spent this session`,
  );

  function formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
    return `${count}`;
  }
</script>

<div class="status-bar" data-testid="status-bar" aria-label="Status">
  <div class="status-bar-zone status-bar-left">
    <span
      class="status-bar-segment"
      data-tone={connection.tone}
      data-testid="status-bar-connection"
      role="status"
    >
      <StatusDot
        tone={connection.tone}
        pulse={connectionStatus === 'connecting' || connectionStatus === 'closed'}
        label={connection.label}
        size="sm"
      />
      <span class="status-bar-label">{connection.label}</span>
      {#if connection.retry}
        <button
          type="button"
          class="status-bar-retry"
          onclick={onRetryConnection}
          data-testid="status-bar-connection-retry"
        >
          Retry
        </button>
      {/if}
    </span>

    {#if selectedSessionTargetLabel}
      <span class="status-bar-segment" data-testid="status-bar-session-target">
        <span class="status-bar-label font-mono">{selectedSessionTargetLabel}</span>
      </span>
    {/if}

    <button
      type="button"
      class="status-bar-segment status-bar-button"
      data-tone={targetSummary.tone}
      onclick={onOpenNodes}
      aria-label={`Target health: ${targetSummary.label}. Open Nodes settings.`}
      data-testid="status-bar-targets"
    >
      <StatusDot tone={targetSummary.tone} label={targetSummary.label} size="sm" />
      <span class="status-bar-label">{targetSummary.label}</span>
    </button>

    {#if targetsBehindCount > 0}
      <button
        type="button"
        class="status-bar-segment status-bar-button"
        onclick={onOpenNodes}
        aria-label={`${targetsBehindCount} target${targetsBehindCount === 1 ? '' : 's'} behind this relay's build. Open Nodes settings.`}
        data-testid="status-bar-behind"
      >
        <Badge tone="warning" size="sm" dataTestId="status-bar-behind-badge">
          {targetsBehindCount > 1 ? `${targetsBehindCount} behind` : 'Behind'}
        </Badge>
      </button>
    {/if}
  </div>

  <div class="status-bar-zone status-bar-right">
    {#if queuedSessionCount > 0}
      <span class="status-bar-segment" data-testid="status-bar-queued">
        <span class="status-bar-label"
          ><span class="font-mono">{queuedSessionCount}</span> session{queuedSessionCount === 1
            ? ''
            : 's'} queued</span
        >
      </span>
    {/if}

    <span
      class="status-bar-segment"
      data-tone={sessionTone}
      data-testid="status-bar-session"
      role="status"
    >
      <StatusDot tone={sessionTone} pulse={sessionPulse} label={sessionLabel} size="sm" />
      <span class="status-bar-label">{sessionLabel}</span>
    </span>

    <span class="meter" data-testid="context-meter" title={meterTitle}>
      {#if contextTokens}
        <!-- The track is the percentage; the numbers are the absolutes. Hidden
             from the accessibility tree because it re-states, in pixels, what
             the figures beside it and the `title` already say in words. The
             near-limit warning itself still reaches assistive tech — see the
             `.sr-only` span below, which doesn't depend on hover. -->
        <span
          class="track"
          class:high={isNearLimit}
          class:full={contextPercent !== undefined && contextPercent >= 95}
          data-testid="context-track"
          data-fill={contextPercent}
          aria-hidden="true"
        >
          <span class="track-fill" style:width={`${contextPercent}%`}></span>
        </span>
        <span class="meter-primary font-mono">{formatTokens(contextTokens.used)}</span>
        <span class="meter-sep" aria-hidden="true">/</span>
        <span class="meter-max font-mono">{formatTokens(contextTokens.max)}</span>
        <span class="meter-sep" aria-hidden="true">·</span>
        {#if isNearLimit}
          <span class="sr-only" data-testid="context-warning"
            >Context window nearly full, {contextPercent}% used</span
          >
        {/if}
      {/if}
      <span class="meter-cost font-mono">${cumulativeCostUsd.toFixed(2)}</span>
    </span>
  </div>
</div>

<style>
  /* ~24px band (Zed-parity decision B1-1's own trade sentence), a real
     token because the mobile tab bar's own fixed-position math
     (`+page.svelte`'s `.shell`/`.tabbar` under `--bp-desktop`) has to
     reserve exactly this much room for it, not a repeated literal. */
  .status-bar {
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: var(--space-md);
    height: var(--statusbar-height);
    padding-inline: var(--space-md);
    background: var(--color-rail);
    border-top: 1px solid var(--color-border);
    font-size: var(--text-caption-size);
    overflow: hidden;
  }

  .status-bar-zone {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    min-width: 0;
  }

  .status-bar-segment {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .status-bar-button {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .status-bar-button:hover {
    color: var(--color-text-primary);
  }

  .status-bar-button:focus-visible,
  .status-bar-retry:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .status-bar-segment[data-tone='danger'] .status-bar-label {
    color: var(--color-danger);
  }

  .status-bar-segment[data-tone='warning'] .status-bar-label {
    color: var(--color-warning);
  }

  .status-bar-retry {
    background: transparent;
    border: none;
    padding: 0;
    margin-inline-start: var(--space-2xs);
    color: inherit;
    text-decoration: underline;
    font: inherit;
    cursor: pointer;
  }

  /* Right-aligned figures, same mono/tabular treatment `ConfigBar`'s
     meter used before the move — this IS that meter, unchanged. */
  .meter {
    display: flex;
    align-items: baseline;
    gap: var(--space-2xs);
    white-space: nowrap;
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
  }

  .meter-primary {
    color: var(--color-text-primary);
    font-weight: 600;
  }

  .meter-sep,
  .meter-max,
  .meter-cost {
    color: var(--color-text-muted);
  }

  .track {
    align-self: center;
    width: var(--status-meter-track-width);
    height: var(--status-meter-track-height);
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--color-border);
    overflow: hidden;
  }

  .track-fill {
    display: block;
    height: 100%;
    background: var(--color-text-secondary);
    transition: width var(--duration-base) var(--ease-beat);
  }

  .track.high .track-fill {
    background: var(--color-warning);
  }

  .track.full .track-fill {
    background: var(--color-danger);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Below the desktop breakpoint the fixed tabbar already claims the
     window's true bottom edge (`+page.svelte`'s `.tabbar`); this bar sits
     directly above it, matching how the terminal dock and both sidebars
     already dock against `--tabbar-height` in that same media query.
     `--z-raised` (10), deliberately BELOW every sheet/overlay this shell
     opens on mobile — the sessions sidebar sheet and its backdrop sit at
     `--z-sticky`/`--z-sticky - 1` (20/19), `Overlay`-backed dialogs at
     `--z-overlay`/`--z-modal` (30/40), same as `.tabbar` itself
     (`--z-overlay`, "deliberately ABOVE the sheet and its backdrop").
     This bar is passive chrome, never a control any of those need to
     reach through: at the SAME `--z-sticky` tier as the sidebar sheet it
     used to sit above it by DOM order alone (this component mounts after
     `.shell`), covering the sheet's own account-menu trigger and hanging
     every test that opens it at 390px (`accounts-mobile.spec.ts`). */
  @media (max-width: 1023px) {
    .status-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: var(--tabbar-height);
      z-index: var(--z-raised);
    }
  }

  @media (max-width: 767px) {
    .status-bar {
      padding-inline: var(--space-sm);
    }

    /* The queued-session count is the one segment this bar can lose
       without losing meaning at phone width — the session's own status
       dot/label and the meter stay, same "the figures a user watches
       must not go" rule `ConfigBar`'s old `compact` used. */
    .status-bar-right :global([data-testid='status-bar-queued']) {
      display: none;
    }

    /* The selected session's own target chip (issue #738) is the least
       useful LEFT-zone segment at phone width: a phone user is rarely
       picking between targets mid-session, unlike the connection/target-
       health segments this bar exists to surface at a glance. Dropping it
       here (issue #736's own composer-strip e2e spec pins this bar's
       phone budget — `composer-strip.spec.ts`'s "fits one row on a
       phone") still leaves it discoverable at this width: the sessions
       sheet's own row for the open session already carries the identical
       label (`+page.svelte`'s `session-activity`, reachable from the
       bottom tab bar), so nothing here becomes undiscoverable, only
       un-glanceable while composing. */
    .status-bar-left :global([data-testid='status-bar-session-target']) {
      display: none;
    }
  }
</style>
