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
 * and its digit answers (`AttentionInbox.svelte:334-361`), the composer's
 * own `Enter`/`Shift+Enter` (`+page.svelte`'s `handleComposerKeydown`) and
 * `Escape` (`Dialog`/`Overlay`'s own window handler), and the three dock
 * resize handles' arrow keys (`dock-panel.svelte.ts`) all stay local to the
 * component that owns them: every one of them is either per-element,
 * focus-scoped, continuous interaction (move a cursor, drag a size) or a
 * component-local dismiss/submit convention, not a discrete "run once"
 * command a palette row could meaningfully represent — Zed's own command
 * palette does not list its resize handles or its Escape key either.
 * Migrating them here was considered and rejected for that reason, not
 * missed (issue #759 re-confirmed this while adopting the rest of F2-3's
 * eighteen-row default set).
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
 * a hand-added `if (matchesShortcut(...))` slipped in elsewhere would
 * leave that guarantee failing rather than silently working.
 */
import type { KeymapV1 } from '@loombox/protocol';
import { isDesktopShell, isMacPlatform, matchesShortcut, type KeyboardEventLike } from './keyboard';

/** The live state every registered action's `isAvailable` predicate reads. `+page.svelte` rebuilds this from its own state on every change (`$derived`); nothing here is Svelte-specific, which is what keeps this whole module testable without mounting anything. */
export interface ActionContext {
  /** True while the selected session has a turn in flight — `+page.svelte`'s own `turnIsActive` (`transcript?.turnActive ?? false`), passed straight through rather than re-derived here. */
  turnActive: boolean;
  /** How many sessions this account currently has, across every project and target — the same universe the palette's own "jump to a session" list already draws from. */
  sessionCount: number;
  /** True while a session is selected (issue #759) — gates the actions that reach into the session-scoped part of the shell (the composer, the workbench panel, the terminal dock, the model/effort picker), none of which exist in the DOM at all with no session selected. */
  sessionSelected: boolean;
  /** True when this account has at least one project to create a session into (issue #759) — "New session" has nowhere to aim `NewSessionDialog` at (it inherits its target/folder from a `Project`, `+page.svelte`'s `openNewSessionDialogFor` doc comment) when this is false. */
  hasProjects: boolean;
  /** True while the selected session's negotiated `configOptions` carries at least one entry (issue #759) — `ConfigBar` renders no trigger at all when this is false (`hasOptions`, `ConfigBar.svelte`), so "Cycle model / effort" would silently do nothing if offered anyway. */
  hasConfigOptions: boolean;
  /** True inside the desktop app's Electron `BrowserWindow` (`keyboard.ts`'s `isDesktopShell`) — issue #759's F2-3: the only environment that can safely claim `Mod+Alt+Right`/`Mod+Alt+Left`/`Mod+N` on every platform, since a real browser reserves all three for its own tab history / new-window chrome. */
  desktopShell: boolean;
  /** True when the browser reports a macOS platform (`keyboard.ts`'s `isMacPlatform`) — issue #759's F2-3: `Mod+Alt+Right`/`Mod+Alt+Left` only collide with the browser's own tab-history navigation on Windows and Linux, so a Mac browser tab is exactly as safe as the desktop shell for those two rows. Not consulted for `Mod+N`, which a browser reserves on every platform. */
  macPlatform: boolean;
}

/** Where each action's `run` actually reaches into `+page.svelte`'s own state and the live `RelayClient` — one function per capability, named for what it does rather than how, so the registry entries below read as a table of intent, not a table of closures over page internals. */
export interface ActionHandlers {
  stopTurn: () => void;
  toggleSessionsSidebar: () => void;
  openInbox: () => void;
  openNodes: () => void;
  selectNextSession: () => void;
  selectPreviousSession: () => void;
  /** Opens `NewSessionDialog` against this account's first project (issue #759) — the same `projects[0]` fallback the empty-state "New session" CTA already uses. */
  createSession: () => void;
  /** Toggles the right sidebar (the "workbench panel": Files/Config/Runner tabs) — `+page.svelte`'s existing `toggleRightSidebar` (issue #571), reached from the keyboard for the first time by issue #759. */
  toggleWorkbenchPanel: () => void;
  /** Toggles the bottom terminal dock — `+page.svelte`'s existing `toggleTerminalDock` (issue #572), reached from the keyboard for the first time by issue #759. */
  toggleTerminalDock: () => void;
  /** Moves focus into the composer's `<textarea>` (issue #759) — a no-op if it isn't mounted (`sessionSelected` gates `isAvailable` first, this is just the last line of defense against a stale ref). */
  focusComposer: () => void;
  /** Switches the main area to Settings (issue #759) — the same one-line effect the sidebar's own "Settings" menu item already has (`+page.svelte:3360-3367`). */
  openSettings: () => void;
  /** Opens `ConfigBar`'s "model, thinking and mode" popover (issue #759, reaching the one consolidated control E1-2 already settled in v8 rather than proposing a new one) — expands the composer's collapsed picker row first on a narrow viewport, where the trigger is otherwise not in the DOM at all (`configControlsExpanded`). */
  openConfigPopover: () => void;
}

export interface ActionDefinition {
  /** Permanent once #760 ships — see this module's own doc comment. */
  readonly id: string;
  readonly label: string;
  /** `Mod+[Shift+][Alt+]<key>` (this app's convention, `keyboard.ts`), or omitted for an action reachable only by picking it in the palette. Ignored when {@link shortcutFor} is present. */
  readonly shortcut?: string;
  /**
   * Issue #759 (F2-3's next/previous session rows, and the "New session"
   * row's own inherited risk from F2-2): resolves the effective shortcut
   * against the live {@link ActionContext} instead of a fixed string, for
   * the handful of rows whose chord a browser tab can't safely claim on
   * every platform. Returns `undefined` where the chord would be unsafe to
   * claim there — the action itself stays available (still reachable by
   * clicking its palette row), only the keyboard binding and the palette's
   * displayed hint disappear, so the palette never advertises a shortcut
   * that would silently do nothing if pressed. See {@link effectiveShortcut}.
   */
  readonly shortcutFor?: (context: ActionContext) => string | undefined;
  readonly isAvailable: (context: ActionContext) => boolean;
  readonly run: (handlers: ActionHandlers) => void;
}

/**
 * `overrides?.[action.id]` (issue #760's user keymap — a saved remap wins
 * unconditionally, in every environment, replacing {@link ActionDefinition.shortcutFor}'s
 * environment-conditional resolution entirely rather than layering on top
 * of it: a remap only ever changes WHICH chord triggers an action, it
 * never needs its own copy of the environment gating `shortcutFor` already
 * encodes) when present, else `action.shortcutFor(context)` when present,
 * else the plain `action.shortcut` — the one place all three are resolved
 * to a single value, read by {@link matchShortcut}, `+page.svelte`'s
 * `paletteActions` mapping, and `CanvasZeroState.svelte`, so the keyboard
 * dispatcher and every displayed hint can never disagree about which
 * chord (if any) is live right now.
 */
export function effectiveShortcut(
  action: ActionDefinition,
  context: ActionContext,
  overrides?: KeymapV1,
): string | undefined {
  const override = overrides?.[action.id];
  if (override !== undefined) return override;
  return action.shortcutFor ? action.shortcutFor(context) : action.shortcut;
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
  /**
   * Migrated from the old `paletteActions`' first unconditional entry.
   * Issue #759 (F2-2/F2-3 row 15) gives it its first real shortcut —
   * `Mod+Shift+A`, VS Code's own default for a "focus X view" command,
   * flagged in the artifact as "verify: Firefox add-ons" (Firefox binds
   * the same chord to its Add-ons Manager at browser-chrome level). Bound
   * anyway, same treatment F2-2 already gave the two "verify" rows
   * (`Mod+P`/`Mod+Alt+B`): a chord that MIGHT lose to a specific browser's
   * own reserved binding is not the same risk as one confirmed to always
   * lose (`Mod+N`, `Mod+Alt+Right`/`Left` on Windows/Linux — see
   * `next-session`/`previous-session`/`new-session` below for those).
   */
  {
    id: 'open-inbox',
    label: 'Open attention inbox',
    shortcut: 'Mod+Shift+A',
    isAvailable: () => true,
    run: (handlers) => handlers.openInbox(),
  },
  /** Migrated unchanged from the old `paletteActions`' second unconditional entry. Not one of F2-3's eighteen rows — issue #759 leaves it exactly as issue #758 shipped it. */
  {
    id: 'open-nodes',
    label: 'Open nodes and targets',
    isAvailable: () => true,
    run: (handlers) => handlers.openNodes(),
  },
  /**
   * F1-3's own worked example named this exact predicate ("Next
   * session"/"Previous session" only with more than one session open").
   * Issue #759 (F2-3) gives it its shortcut: VS Code's Mac default,
   * `Mod+Alt+Right`, picked over Zed's own `Mod+Shift+]` per the settled
   * decision (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md`
   * §6 F2-3). That same decision names the cost explicitly: on Windows and
   * Linux, `Mod+Alt+Right` is the browser tab's own forward-history
   * navigation, a chord no page's `preventDefault()` reaches — confirmed,
   * not merely "worth checking", unlike `Mod+Alt+B`'s "verify: Windows Alt
   * menu" a few rows up. `shortcutFor` is the fix: the chord is offered
   * only where it is safe to claim (the desktop shell, or a Mac browser
   * tab — `keyboard.ts`'s `isDesktopShell`/`isMacPlatform`), `undefined`
   * everywhere else. The ACTION stays available regardless of platform —
   * `isAvailable` is unrelated to where the chord is safe — so a Windows
   * or Linux browser tab still reaches "Next session" by clicking its
   * palette row; only the keyboard binding (and the hint the palette
   * would otherwise show next to it) disappears where it would silently
   * do nothing.
   */
  {
    id: 'next-session',
    label: 'Next session',
    shortcutFor: (context) =>
      context.desktopShell || context.macPlatform ? 'Mod+Alt+Right' : undefined,
    isAvailable: (context) => context.sessionCount > 1,
    run: (handlers) => handlers.selectNextSession(),
  },
  {
    id: 'previous-session',
    label: 'Previous session',
    shortcutFor: (context) =>
      context.desktopShell || context.macPlatform ? 'Mod+Alt+Left' : undefined,
    isAvailable: (context) => context.sessionCount > 1,
    run: (handlers) => handlers.selectPreviousSession(),
  },
  /**
   * Issue #759 (F2-3 row 3) — "New session" had no keyboard path at all
   * before this. `Mod+N` inherits F2-2's own named cost unchanged (F2-3
   * only touches next/previous session): "sits on top of 'new window',
   * which no `preventDefault()` reaches in a plain browser tab" — a
   * browser reserves it at chrome level on every platform, not just
   * Windows/Linux the way the Alt-arrow rows do, so `shortcutFor` gates it
   * on `desktopShell` alone. Targets `projects[0]`, the same fallback the
   * empty-state "New session" `Button` already uses (`+page.svelte`'s
   * `defaultProject`) — this action has no session/turn context to infer
   * a project from the way `stop-turn` or `next-session` do.
   */
  {
    id: 'new-session',
    label: 'New session',
    shortcutFor: (context) => (context.desktopShell ? 'Mod+N' : undefined),
    isAvailable: (context) => context.hasProjects,
    run: (handlers) => handlers.createSession(),
  },
  /**
   * Issue #759 (F2-3 row 5) — "verify: Windows Alt menu" in the artifact:
   * a bare Alt press/release can move focus into a Windows app's menu
   * bar, but that is a lone-Alt gesture, not an Alt-held chord like this
   * one, so it is bound unconditionally like the rest of the "verify"
   * tier rather than platform-gated like `Mod+N`/next/previous session's
   * confirmed collisions.
   */
  {
    id: 'toggle-workbench-panel',
    label: 'Toggle workbench panel',
    shortcut: 'Mod+Alt+B',
    isAvailable: (context) => context.sessionSelected,
    run: (handlers) => handlers.toggleWorkbenchPanel(),
  },
  /** Issue #759 (F2-3 row 6) — agrees with Zed on macOS already (the artifact's own note: "Toggle terminal... already agree between the two editors on macOS"), so no VS Code substitution applies here. */
  {
    id: 'toggle-terminal-dock',
    label: 'Toggle terminal dock',
    shortcut: 'Mod+J',
    isAvailable: (context) => context.sessionSelected,
    run: (handlers) => handlers.toggleTerminalDock(),
  },
  /** Issue #759 (F2-3 row 9). */
  {
    id: 'focus-composer',
    label: 'Focus composer',
    shortcut: 'Mod+I',
    isAvailable: (context) => context.sessionSelected,
    run: (handlers) => handlers.focusComposer(),
  },
  /**
   * Issue #759 (F2-3 row 14) — reaches cockpit v8's own consolidated
   * model/mode/effort control (E1-2, issue #711, `ConfigBar.svelte`)
   * rather than proposing a new one, per the artifact's own note under F2.
   * Gated on `hasConfigOptions` too, not just `sessionSelected`: `ConfigBar`
   * renders no trigger at all with an empty `options` list (a session whose
   * agent hasn't reported its config catalog yet), so offering the row
   * before that would be a real no-op, not just an unlikely one.
   */
  {
    id: 'cycle-model-effort',
    label: 'Cycle model / effort',
    shortcut: 'Mod+Shift+M',
    isAvailable: (context) => context.sessionSelected && context.hasConfigOptions,
    run: (handlers) => handlers.openConfigPopover(),
  },
  /** Issue #759 (F2-3 row 16) — agrees with Zed on macOS already, no VS Code substitution. */
  {
    id: 'open-settings',
    label: 'Open settings',
    shortcut: 'Mod+,',
    isAvailable: () => true,
    run: (handlers) => handlers.openSettings(),
  },
];

/** Every registered action whose `isAvailable` predicate accepts `context` — what `paletteActions` maps onto `CommandPalette`'s props, and what {@link matchShortcut} searches. */
export function getAvailableActions(context: ActionContext): ActionDefinition[] {
  return actionRegistry.filter((action) => action.isAvailable(context));
}

/**
 * The registry's own keydown dispatcher: the first currently-available
 * action whose {@link effectiveShortcut} (issue #760's `overrides` folded
 * in) matches `event`'s chord, or `undefined`. Only `Mod+…` shortcuts are
 * considered — bare keys, arrow keys and `Escape` are Dialog/Overlay/
 * component-local concerns (see this module's top doc comment for why the
 * inbox's `j`/`k`/digits and the dock resize handles are never registered
 * here), not registry actions, so they never reach this function at all.
 */
export function matchShortcut(
  event: KeyboardEventLike,
  context: ActionContext,
  overrides?: KeymapV1,
): ActionDefinition | undefined {
  return getAvailableActions(context).find((action) => {
    const shortcut = effectiveShortcut(action, context, overrides);
    return shortcut !== undefined && matchesShortcut(event, shortcut);
  });
}

/**
 * `+page.svelte`'s own `desktopShell`/`macPlatform` — computed once per
 * component instance (`keyboard.ts`'s `isDesktopShell`/`isMacPlatform`
 * doc comments explain why each is a plain function call, never a
 * module-level constant) and threaded into every `ActionContext` it
 * builds. Re-exported here purely so `action-registry.test.ts` can build a
 * context without importing `keyboard.ts` a second time under a different
 * name.
 */
export { isDesktopShell, isMacPlatform };
