import type { KeymapV1 } from '@loombox/protocol';
import {
  actionRegistry,
  effectiveShortcut,
  type ActionContext,
  type ActionDefinition,
} from './action-registry';

/**
 * User-editable keymap validation and per-environment availability
 * (Zed-parity F3-3, issue #760, building on the action registry (#758) and
 * the default binding set (#759)). Everything here is client-side and
 * framework-free — the wire schema (`@loombox/protocol`'s `keymapV1`)
 * validates shape only (every key/value a non-empty string); this module
 * is where a candidate keymap is checked against the LIVE registry before
 * it is ever sent to the relay, mirroring `PermissionPolicyPanel.svelte`'s
 * own pre-send validation (its blank-glob check happens in the component,
 * never in `RelayClient`).
 *
 * Two decisions this module's own doc comments record, per issue #760's
 * "these two questions must be answered, not glossed over":
 *
 * 1. **The phone.** Nothing here changes for mobile — {@link isChordUnavailableHere}
 *    and {@link validateKeymapCandidate} both keep working identically on a
 *    narrow viewport, since a synced keymap still has real effect if a
 *    physical/Bluetooth keyboard is attached. What's phone-specific is the
 *    EDITOR, not the runtime binding: `SettingsPage.svelte` hides its
 *    "Keyboard" section entirely on a narrow viewport (`viewport.ts`'s
 *    `isNarrowViewport`), because recording a new chord has nothing to
 *    attach to with no physical keyboard to press — the design mockup's own
 *    words. It does not show a read-only view; there is nothing there to
 *    show that the rest of the app doesn't already show (the palette
 *    already lists every live binding).
 * 2. **Per-device availability.** The keymap stays a single per-account
 *    record — no per-device override field (`packages/protocol/src/v1/
 *    keymap.ts`'s own doc comment: the wire schema is bare
 *    `Record<actionId, chord>`). Instead, {@link isChordUnavailableHere}
 *    computes a RUNTIME "unavailable here" state per chord/environment
 *    pair, generalizing issue #759's own hand-coded `Mod+N`/`Mod+Alt+Right`/
 *    `Mod+Alt+Left` browser-reservation rule (`action-registry.ts`'s
 *    `new-session`/`next-session`/`previous-session` `shortcutFor`) to ANY
 *    user-remapped chord that happens to land on one of those same
 *    reservations, not just the three rows #759 hand-coded for its own
 *    defaults. A remap that is unavailable here is never rejected at save
 *    time (it may be perfectly live on the desktop shell or a Mac browser
 *    tab, which is exactly the "free on desktop Chrome, reserved on mobile
 *    Safari" scenario issue #760 names) — it is simply reported as
 *    inactive in THIS environment, the same non-fatal way #759's own
 *    `shortcutFor` already withholds a hint rather than erroring.
 */

/** This app's own `Mod+[Shift+][Alt+]<Key>` grammar (`keyboard.ts`'s `matchesShortcut`), in that exact segment order — every existing registry entry is already written this way, so a remap that doesn't match it could never actually fire. Key names are exactly the set `keyboard.ts` knows how to compare: a bare letter/digit, `.`/`,`/`[`/`]`, or `Right`/`Left`/`Up`/`Down`. */
const CHORD_PATTERN = /^Mod(\+Shift)?(\+Alt)?\+(Right|Left|Up|Down|[A-Z0-9]|[.,[\]])$/;

/** True when `chord` matches this app's shortcut-string grammar — the one thing `keymapV1`'s wire schema (any non-empty string) deliberately does not itself check, since the relay has no reason to know this app's own convention. */
export function isWellFormedChord(chord: string): boolean {
  return CHORD_PATTERN.test(chord);
}

/** `ActionContext` fields {@link effectiveShortcut} actually reads for shortcut resolution are only `desktopShell`/`macPlatform` (`shortcutFor`'s environment gate) — every other field only feeds `isAvailable`, which conflict-checking below deliberately never calls (see {@link validateKeymapCandidate}'s doc comment for why). These three fixed base contexts are the same three `action-registry.test.ts` already exercises (`DESKTOP_SHELL`/`MAC_WEB`/`WINDOWS_LINUX_WEB`), reused here so a conflict check covers every real environment a chord could actually resolve in. */
const VALIDATION_CONTEXTS: readonly ActionContext[] = [
  {
    turnActive: false,
    sessionCount: 1,
    sessionSelected: true,
    hasProjects: true,
    hasConfigOptions: true,
    desktopShell: true,
    macPlatform: false,
  },
  {
    turnActive: false,
    sessionCount: 1,
    sessionSelected: true,
    hasProjects: true,
    hasConfigOptions: true,
    desktopShell: false,
    macPlatform: true,
  },
  {
    turnActive: false,
    sessionCount: 1,
    sessionSelected: true,
    hasProjects: true,
    hasConfigOptions: true,
    desktopShell: false,
    macPlatform: false,
  },
];

export interface KeymapValidationSuccess {
  readonly ok: true;
}
export interface KeymapValidationError {
  readonly ok: false;
  /** Names the offending entry (an unknown action id, a malformed chord, or the two action ids sharing a chord) — issue #760's own acceptance criterion: "rejected with a message naming the offending entry". */
  readonly error: string;
}
export type KeymapValidationResult = KeymapValidationSuccess | KeymapValidationError;

/**
 * Checks `candidate` against the live registry before it is ever sent to
 * the relay: every key must name a real, currently-registered action id
 * (never a typo or a retired one — `action-registry.ts`'s own PERMANENCE
 * doc comment is what makes "currently-registered" a stable check at all),
 * every value must be a well-formed chord, and no two DIFFERENT actions may
 * resolve to the same chord in any real environment. Conflict-checking
 * deliberately calls {@link effectiveShortcut} over the FULL registry, not
 * `getAvailableActions`'s `isAvailable`-filtered subset — two actions
 * sharing a chord is a real authoring mistake even if they happen to never
 * be simultaneously available, mirroring `action-registry.test.ts`'s own
 * "has no duplicate static shortcuts among bound actions" assertion, which
 * makes the same unconditional-over-the-whole-registry choice.
 *
 * Returns the FIRST problem found, by registry declaration order then by
 * validation-context order — deterministic, not "whichever the object's
 * key iteration order happens to surface first", so the same invalid
 * candidate always names the same offending entry.
 */
export function validateKeymapCandidate(
  candidate: KeymapV1,
  registry: readonly ActionDefinition[] = actionRegistry,
): KeymapValidationResult {
  const knownIds = new Set(registry.map((action) => action.id));
  for (const [actionId, chord] of Object.entries(candidate)) {
    if (!knownIds.has(actionId)) {
      return { ok: false, error: `Unknown action "${actionId}" in keymap` };
    }
    if (!isWellFormedChord(chord)) {
      return { ok: false, error: `Invalid shortcut "${chord}" for "${actionId}"` };
    }
  }

  for (const context of VALIDATION_CONTEXTS) {
    const boundBy = new Map<string, string>();
    for (const action of registry) {
      const shortcut = effectiveShortcut(action, context, candidate);
      if (shortcut === undefined) continue;
      const holder = boundBy.get(shortcut);
      if (holder !== undefined && holder !== action.id) {
        return {
          ok: false,
          error: `"${holder}" and "${action.id}" are both bound to ${shortcut}`,
        };
      }
      boundBy.set(shortcut, action.id);
    }
  }

  return { ok: true };
}

/** Chords a real browser tab reserves at chrome level on every platform — `Mod+N`/`Mod+T`/`Mod+W` open/close a tab or window, `Mod+Shift+N`/`Mod+Shift+T` their obvious siblings, none of them reaching a `keydown` listener no matter how a page tries to `preventDefault()`. Mirrors `action-registry.ts`'s own `new-session` row (`Mod+N`, `shortcutFor: (context) => context.desktopShell ? 'Mod+N' : undefined`), generalized to any user-remapped chord that happens to land on the same reservation. */
const BROWSER_RESERVED_EVERYWHERE = new Set([
  'Mod+N',
  'Mod+T',
  'Mod+W',
  'Mod+Shift+N',
  'Mod+Shift+T',
]);

/** `Mod+Alt+Right`/`Mod+Alt+Left` collide with a Windows/Linux browser tab's own back/forward history navigation only — a Mac browser tab is exactly as safe as the desktop shell for these two, per `action-registry.ts`'s `next-session`/`previous-session` rows (issue #759, F2-3). */
const BROWSER_RESERVED_WINDOWS_LINUX_ONLY = new Set(['Mod+Alt+Right', 'Mod+Alt+Left']);

/**
 * True when `chord` cannot actually fire in the CURRENT environment even
 * though it is a perfectly valid saved binding — issue #760's answer to "a
 * chord free on desktop Chrome can be reserved on mobile Safari": a
 * runtime, per-environment state rather than a per-device field on the
 * keymap itself (see this module's own top doc comment, decision 2). The
 * desktop shell (Electron) can claim anything, exactly like `keyboard.ts`'s
 * `isDesktopShell` already lets #759's own default rows claim `Mod+N`/
 * `Mod+Alt+Right`/`Mod+Alt+Left` there and nowhere else in a browser tab.
 */
export function isChordUnavailableHere(
  chord: string,
  context: Pick<ActionContext, 'desktopShell' | 'macPlatform'>,
): boolean {
  if (context.desktopShell) return false;
  if (BROWSER_RESERVED_EVERYWHERE.has(chord)) return true;
  if (!context.macPlatform && BROWSER_RESERVED_WINDOWS_LINUX_ONLY.has(chord)) return true;
  return false;
}
