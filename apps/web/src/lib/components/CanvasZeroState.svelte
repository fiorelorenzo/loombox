<script lang="ts">
  /**
   * The canvas zero state (Zed-parity B4-2, issue #739;
   * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md#B4-2`).
   * Replaces the bare `EmptyState` `+page.svelte` used to render for "no
   * session selected" once a project and a target both exist (the
   * `emptyStateCta === 'new-session'` case) — measured at 1728px as a
   * dimmed mark, one sentence and a void covering ~70% of the window. This
   * fills that void with three things, matching the decision's own list:
   *
   * - **Recent sessions** — `recentSessions`, built by `+page.svelte` from
   *   its own `sessions` array (the exact same one the sidebar already
   *   derives from `RelayClient.sessions`) re-sorted by `createdAt` and
   *   capped, never a second subscription or data source.
   * - **The last transcript's tail** — `lastTranscript`, the most recent
   *   session's final few items (`$lib/transcript-tail.ts`'s
   *   `transcriptTail`, a pure function this component never re-derives).
   * - **The bindings that matter** — read directly from `$lib/action-
   *   registry.ts`'s `actionRegistry` below, exactly the array
   *   `paletteActions`/`handleGlobalKeydown` already read (issue #758):
   *   this is a THIRD reader, never a second hardcoded shortcut list, so a
   *   shortcut added/changed/removed in the registry shows up here for
   *   free and `CanvasZeroState.test.ts` fails the moment it doesn't.
   *
   * Both honest empty cases the decision calls out are real render
   * branches, never a blank region or a fabricated example: `recentSessions
   * = []` (a brand-new project with nothing recent yet) renders its own
   * "nothing yet" copy in the recent-sessions panel, and `lastTranscript ===
   * undefined` (no session exists to have a tail at all) vs.
   * `lastTranscript.items.length === 0` (a real session that genuinely has
   * zero turns yet) each render their own distinct honest copy in the
   * transcript panel — never the same "empty" sentence, since they are not
   * the same fact.
   */
  import type { Snippet } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import Card from './ui/Card.svelte';
  import {
    actionRegistry,
    effectiveShortcut,
    type ActionContext,
    type ActionDefinition,
  } from '$lib/action-registry';
  import type { TranscriptTailEntry, TranscriptTailSpeaker } from '$lib/transcript-tail';

  /** One row of the "recent sessions" panel — a plain view model `+page.svelte` builds from `ClientSessionMeta` plus the sidebar's own `projectDisplayName`/`sessionTargetLabel`/`formatSessionActivity` helpers, so this component never needs to know about `Project`, target lists, or how "3m ago" gets computed. */
  export interface CanvasZeroStateRecentSession {
    id: string;
    title: string;
    projectLabel: string;
    targetLabel: string;
    activityLabel: string;
  }

  /** The "last transcript" panel's data: which session it's from and its tail. `items: []` is the real, honest "this session has zero turns" case — distinct from the panel getting no session at all (`lastTranscript` prop itself `undefined`). */
  export interface CanvasZeroStateTranscriptPreview {
    sessionId: string;
    sessionTitle: string;
    items: TranscriptTailEntry[];
  }

  interface Props {
    recentSessions: CanvasZeroStateRecentSession[];
    /** `undefined` when there is no session anywhere to preview (an account/project with zero sessions) — distinct from a real session whose `items` is `[]`. */
    lastTranscript: CanvasZeroStateTranscriptPreview | undefined;
    onSelectSession: (id: string) => void;
    /** The primary-action slot `+page.svelte` already builds (Connect a node / Add project / New session) — passed through unchanged so this component owns none of that branching. */
    cta?: Snippet;
    /**
     * `+page.svelte`'s own live `actionContext` (issue #759) — needed here
     * because `next-session`/`previous-session`/`new-session` no longer
     * carry a plain `shortcut` string; their binding is resolved per
     * environment via `shortcutFor` (desktop shell vs. a Windows/Linux
     * browser tab can't safely claim the same chord). Reading only the
     * static `shortcut` field, the way this panel did before #759, would
     * have silently hidden all three from "the bindings that matter"
     * everywhere, including the desktop shell and a Mac browser tab where
     * they DO have a real, working chord.
     */
    context: ActionContext;
  }

  const { recentSessions, lastTranscript, onSelectSession, cta, context }: Props = $props();

  const TAIL_SPEAKER_LABEL: Record<TranscriptTailSpeaker, string> = {
    user: 'You',
    agent: 'Agent',
    thought: 'Agent (thinking)',
    tool: 'Tool',
  };

  /**
   * Issue #758's registry, read directly — B4-2's own decision text: "the
   * bindings shown must be read from F1's registry once that exists, not
   * hardcoded a second time." Every entry whose {@link effectiveShortcut}
   * resolves against the live `context` (issue #759's environment-
   * conditional rows included), in the registry's own declaration order.
   * Deliberately NOT filtered by live `isAvailable`: this panel orients
   * someone with no session open at all, where a turn-scoped predicate
   * like `stop-turn`'s is never true anyway (there is no turn to stop) —
   * it teaches the bindings that exist in this app, not just the ones
   * actionable this instant. `matchShortcut` (the dispatcher that
   * actually fires a chord) still gates on `isAvailable` itself, so this
   * panel can never claim a binding "works" when it wouldn't.
   */
  interface BoundAction {
    action: ActionDefinition;
    shortcut: string;
  }
  const boundActions = $derived(
    actionRegistry
      .map((action) => ({ action, shortcut: effectiveShortcut(action, context) }))
      .filter((entry): entry is BoundAction => entry.shortcut !== undefined),
  );

  const TAIL_TEXT_MAX = 160;

  /** Collapses a tail entry's text to one readable line — a message chunk can run to paragraphs, and this panel is a hint, not a transcript reader. */
  function previewText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '…';
    return trimmed.length > TAIL_TEXT_MAX ? `${trimmed.slice(0, TAIL_TEXT_MAX)}…` : trimmed;
  }
</script>

<div class="canvas-zero-state" data-testid="canvas-zero-state">
  <div class="canvas-zero-state-intro">
    <BrandMark class="canvas-zero-state-mark" />
    <p class="canvas-zero-state-message">
      Pick a session on the left to follow its live transcript, or start a new one.
    </p>
    {#if cta}
      <div class="canvas-zero-state-cta">{@render cta()}</div>
    {/if}
  </div>

  <div class="canvas-zero-state-grid">
    <Card elevation="flat" padding="md" class="canvas-zero-state-panel">
      <h2>Recent sessions</h2>
      {#if recentSessions.length === 0}
        <p class="canvas-zero-state-empty" data-testid="canvas-zero-state-recent-empty">
          Nothing recent yet — start a session in this project to see it here.
        </p>
      {:else}
        <ul class="canvas-zero-state-recent-list">
          {#each recentSessions as session (session.id)}
            <li>
              <button
                type="button"
                class="canvas-zero-state-recent-item"
                onclick={() => onSelectSession(session.id)}
                data-testid="canvas-zero-state-recent-item"
              >
                <strong>{session.title}</strong>
                <span class="canvas-zero-state-recent-meta font-mono">
                  {session.projectLabel}
                  <span aria-hidden="true">·</span>
                  {session.targetLabel}
                  <span aria-hidden="true">·</span>
                  {session.activityLabel}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Card elevation="flat" padding="md" class="canvas-zero-state-panel">
      <h2>Last transcript</h2>
      {#if !lastTranscript}
        <p class="canvas-zero-state-empty" data-testid="canvas-zero-state-tail-empty">
          No sessions yet — there is nothing to show here.
        </p>
      {:else if lastTranscript.items.length === 0}
        <p class="canvas-zero-state-empty" data-testid="canvas-zero-state-tail-empty">
          “{lastTranscript.sessionTitle}” has no turns yet.
        </p>
      {:else}
        <p class="canvas-zero-state-tail-session" data-testid="canvas-zero-state-tail-session">
          {lastTranscript.sessionTitle}
        </p>
        <ul class="canvas-zero-state-tail-list">
          {#each lastTranscript.items as item (item.id)}
            <li class="canvas-zero-state-tail-row" data-testid="canvas-zero-state-tail-item">
              <span class="canvas-zero-state-tail-speaker">{TAIL_SPEAKER_LABEL[item.speaker]}</span>
              <span class="canvas-zero-state-tail-text">{previewText(item.text)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Card elevation="flat" padding="md" class="canvas-zero-state-panel">
      <h2>Bindings that matter</h2>
      <ul class="canvas-zero-state-bindings-list">
        {#each boundActions as entry (entry.action.id)}
          <li class="canvas-zero-state-binding-row" data-testid="canvas-zero-state-binding">
            <kbd class="canvas-zero-state-binding-key font-mono">{entry.shortcut}</kbd>
            <span>{entry.action.label}</span>
          </li>
        {/each}
      </ul>
    </Card>
  </div>
</div>

<style>
  .canvas-zero-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2xl);
    width: 100%;
    max-width: var(--measure-wide);
    margin: 0 auto;
    padding: var(--space-2xl);
  }

  .canvas-zero-state-intro {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-md);
  }

  /* Same narrowly-scoped `:global()` pattern `EmptyState.svelte`'s own
     `.ui-empty-state-mark` uses to reach `BrandMark`'s internal class —
     `BrandMark`'s own scoped `flex-shrink` rule stays untouched either
     way (`primitive-override-scope.test.ts`), this only ever sets
     size/opacity/color. */
  .canvas-zero-state-intro :global(.canvas-zero-state-mark) {
    width: 4rem;
    height: 4rem;
    opacity: 0.14;
    color: var(--color-text-primary);
  }

  .canvas-zero-state-message {
    max-width: 28rem;
    margin: 0;
    color: var(--color-text-secondary);
  }

  .canvas-zero-state-cta {
    margin-top: var(--space-2xs);
  }

  .canvas-zero-state-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-lg);
    width: 100%;
    text-align: left;
  }

  @media (max-width: 960px) {
    .canvas-zero-state-grid {
      grid-template-columns: 1fr;
    }
  }

  .canvas-zero-state-grid :global(.canvas-zero-state-panel) {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-width: 0;
  }

  .canvas-zero-state-grid h2 {
    margin: 0;
    font-size: var(--text-small-size);
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .canvas-zero-state-empty {
    margin: 0;
    color: var(--color-text-muted);
  }

  .canvas-zero-state-recent-list,
  .canvas-zero-state-tail-list,
  .canvas-zero-state-bindings-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .canvas-zero-state-recent-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3xs);
    width: 100%;
    padding: var(--space-xs) var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-beat);
  }

  .canvas-zero-state-recent-item:hover,
  .canvas-zero-state-recent-item:focus-visible {
    background: var(--color-fill-subtle);
  }

  .canvas-zero-state-recent-meta {
    color: var(--color-text-muted);
    font-size: var(--text-caption-size);
  }

  .canvas-zero-state-tail-session {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-caption-size);
  }

  .canvas-zero-state-tail-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    padding: var(--space-2xs) 0;
    border-top: 1px solid var(--color-border-subtle);
  }

  .canvas-zero-state-tail-row:first-child {
    border-top: none;
  }

  .canvas-zero-state-tail-speaker {
    color: var(--color-text-muted);
    font-size: var(--text-caption-size);
  }

  .canvas-zero-state-tail-text {
    color: var(--color-text-secondary);
  }

  .canvas-zero-state-binding-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
  }

  .canvas-zero-state-binding-key {
    padding: var(--space-3xs) var(--space-2xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-caption-size);
  }
</style>
