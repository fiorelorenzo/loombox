/**
 * The action registry (Zed-parity F1-3, issue #758). Before this, the
 * command palette's rows were a hand-built array pushed together inline in
 * `+page.svelte` — two entries plus a conditional third — while two more
 * real bindings (`Mod+B`, the dock resize handles' arrow keys) existed
 * outside that array and were invisible to it. Nothing else in the app
 * read it, so nothing caught a new capability that forgot to join the
 * list.
 *
 * This module is that one list now: every user-invokable capability the
 * cockpit has declared exactly once, as an {@link ActionDefinition} —
 * a stable `id`, a `label`, an optional keyboard `shortcut` in this app's
 * own `Mod+<key>` convention (`keyboard.ts`), and an `isAvailable`
 * predicate deciding whether it can run against a snapshot of live state
 * (an {@link ActionContext}). Two readers exist today and both are pure
 * views over this array, never a second list of their own:
 *
 * - `+page.svelte`'s `paletteActions` calls {@link getAvailableActions}
 *   and maps the result onto `CommandPalette`'s props — a row is shown
 *   only when its predicate accepts the live context, so the palette
 *   never lists something that would no-op if picked right now.
 * - `+page.svelte`'s `handleGlobalKeydown` calls {@link matchShortcut} on
 *   every keydown — a chord only fires when the action it names is both
 *   bound to that chord AND currently available, so a shortcut and its
 *   palette row can never disagree about whether they do anything.
 *
 * A future reader (B4-2's zero-state hint block, any later menu) reads
 * the same array rather than hardcoding the bindings a second time.
 *
 * Not everything real is here on purpose. The attention inbox's `j`/`k`
 * and its digit answers (`AttentionInbox.svelte:334-361`) and the three
 * dock resize handles' arrow keys (`dock-panel.svelte.ts`) stay local to
 * the component that owns them: both are per-element, focus-scoped,
 * continuous interactions (move a cursor, drag a size), not a discrete
 * "run once" command a palette row could meaningfully represent — Zed's
 * own command palette does not list its resize handles either. Migrating
 * them here was considered and rejected for that reason, not missed.
 *
 * PERMANENCE: once #760 ships a user-editable keymap, a remap is stored
 * against an action's `id`. Renaming an `id` after that point silently
 * detaches every account's existing remap from the action it used to
 * name — indistinguishable, from inside a keymap file, from the action
 * having been deleted. Treat every `id` below as permanent from the
 * moment #760 ships: retire an action by removing its entry, never by
 * renaming it out from under an existing remap.
 *
 * Adding a capability: add one entry to {@link actionRegistry} below.
 * There is deliberately no other code path that feeds `paletteActions` or
 * `handleGlobalKeydown` — see their own doc comments in `+page.svelte` —
 * so a capability that skips this file has no way to reach the palette or
 * the keyboard, rather than reaching one but not the other.
 * `action-registry.test.ts` asserts the registry's own shape (unique
 * ids, every entry has a real predicate and handler) and that
 * {@link matchShortcut} recognizes nothing this file doesn't declare, so
 * a hand-added `if (isModShortcut(...))` slipped in elsewhere would leave
 * that guarantee failing rather than silently working.
 */
import { isModShortcut, type KeyboardEventLike } from './keyboard';

/** The live state every registered action's `isAvailable` predicate reads. `+page.svelte` rebuilds this from its own state on every change (`$derived`); nothing here is Svelte-specific, which is what keeps this whole module testable without mounting anything. */
export interface ActionContext {
  /** True while the selected session has a turn in flight — `+page.svelte`'s own `turnIsActive` (`transcript?.turnActive ?? false`), passed straight through rather than re-derived here. */
  turnActive: boolean;
  /** How many sessions this account currently has, across every project and target — the same universe the palette's own "jump to a session" list already draws from. */
  sessionCount: number;
}

/** Where each action's `run` actually reaches into `+page.svelte`'s own state and the live `RelayClient` — one function per capability, named for what it does rather than how, so the registry entries below read as a table of intent, not a table of closures over page internals. */
export interface ActionHandlers {
  stopTurn: () => void;
  toggleSessionsSidebar: () => void;
  openInbox: () => void;
  openNodes: () => void;
  selectNextSession: () => void;
  selectPreviousSession: () => void;
}

export interface ActionDefinition {
  /** Permanent once #760 ships — see this module's own doc comment. */
  readonly id: string;
  readonly label: string;
  /** `Mod+<key>` (this app's existing convention, `keyboard.ts`), or omitted for an action reachable only by picking it in the palette. Which capabilities get a shortcut at all is #759's decision, not this module's — every entry below keeps exactly the binding (or lack of one) it had before this refactor. */
  readonly shortcut?: string;
  readonly isAvailable: (context: ActionContext) => boolean;
  readonly run: (handlers: ActionHandlers) => void;
}

export const actionRegistry: ActionDefinition[] = [
  /**
   * SPEC §7.3/§7.24, issue #129 — the turn-level Stop/interrupt. Migrated
   * unchanged from the old `paletteActions`' conditional third entry;
   * `isAvailable` is the exact condition that used to gate whether it was
   * pushed into the array at all (`selectedSessionId && transcript?.
   * turnActive`, folded into `turnIsActive` upstream in `+page.svelte`).
   * One real behaviour change ships with this migration: `Mod+.` used to
   * call `interruptTurn` unconditionally whenever a session was selected,
   * even with no turn running (a harmless no-op — see
   * `RelayClient.interruptTurn`'s own doc comment, it only settles
   * already-settled bookkeeping and cancels a request queue that's
   * already empty). The shortcut and the palette row now share this one
   * predicate, so the shortcut also declines to fire when the action
   * would no-op — the whole point of F1-3, applied to the binding as well
   * as the row.
   */
  {
    id: 'stop-turn',
    label: 'Stop current turn',
    shortcut: 'Mod+.',
    isAvailable: (context) => context.turnActive,
    run: (handlers) => handlers.stopTurn(),
  },
  /**
   * Issue #438 — was a real binding with no palette row at all (one of
   * the two the issue's own description calls out as "invisible to it").
   * Always available: identical to the old ad hoc `handleGlobalKeydown`
   * branch, which never gated it on anything beyond "not typing".
   */
  {
    id: 'toggle-sessions-sidebar',
    label: 'Toggle sessions sidebar',
    shortcut: 'Mod+B',
    isAvailable: () => true,
    run: (handlers) => handlers.toggleSessionsSidebar(),
  },
  /** Migrated unchanged from the old `paletteActions`' first unconditional entry. No shortcut today — #759 decides which capabilities gain one. */
  {
    id: 'open-inbox',
    label: 'Open attention inbox',
    isAvailable: () => true,
    run: (handlers) => handlers.openInbox(),
  },
  /** Migrated unchanged from the old `paletteActions`' second unconditional entry. */
  {
    id: 'open-nodes',
    label: 'Open nodes and targets',
    isAvailable: () => true,
    run: (handlers) => handlers.openNodes(),
  },
  /**
   * New rows, not a new binding: nothing before this issue could jump to
   * "the next session" at all, by mouse or key — only to a specific
   * session by id. F1-3's own worked example names this exact predicate
   * ("Next session"/"Previous session" only with more than one session
   * open), and the palette is the only way to reach it until #759 (which
   * owns picking a chord for it, per its own scope note: "do not invent
   * new bindings here").
   */
  {
    id: 'next-session',
    label: 'Next session',
    isAvailable: (context) => context.sessionCount > 1,
    run: (handlers) => handlers.selectNextSession(),
  },
  {
    id: 'previous-session',
    label: 'Previous session',
    isAvailable: (context) => context.sessionCount > 1,
    run: (handlers) => handlers.selectPreviousSession(),
  },
];

/** Every registered action whose `isAvailable` predicate accepts `context` — what `paletteActions` maps onto `CommandPalette`'s props, and what {@link matchShortcut} searches. */
export function getAvailableActions(context: ActionContext): ActionDefinition[] {
  return actionRegistry.filter((action) => action.isAvailable(context));
}

/**
 * The registry's own keydown dispatcher: the first currently-available
 * action whose `shortcut` matches `event`'s Mod-chord, or `undefined`.
 * Only `Mod+<key>` shortcuts are considered — bare keys, arrow keys and
 * `Escape` are Dialog/Overlay/component-local concerns (see this module's
 * top doc comment for why the inbox's `j`/`k`/digits and the dock resize
 * handles are never registered here), not registry actions, so they never
 * reach this function at all.
 */
export function matchShortcut(
  event: KeyboardEventLike,
  context: ActionContext,
): ActionDefinition | undefined {
  return getAvailableActions(context).find((action) => {
    if (action.shortcut === undefined) return false;
    // The key argument `isModShortcut` wants is the last `+` segment of
    // this app's `Mod+<key>` convention (`keyboard.ts`) — `Mod+.` -> `.`,
    // `Mod+B` -> `B` (it lowercases both sides itself).
    const key = action.shortcut.split('+').pop();
    return key !== undefined && isModShortcut(event, key);
  });
}
