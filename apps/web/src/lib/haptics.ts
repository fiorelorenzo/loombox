/**
 * Haptic feedback for irreversible confirm/deny taps (SPEC.md §7.3 "Touch
 * affordances for transcript widgets", issue #133): the Vibration API,
 * guarded so it is a silent no-op wherever unsupported (most desktop
 * browsers, and jsdom in tests unless a test stubs it) rather than throwing.
 * Same injectable-browser-API pattern as `copy.ts`'s `copyToClipboard`: the
 * real `navigator` is the default, a fake is passed in tests.
 */

/** The minimal `Navigator` surface this module needs. */
export interface VibratingNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
}

/** A short, single-pulse pattern (ms) — a light tap acknowledgement, not a buzz. */
export const CONFIRM_DENY_VIBRATION_PATTERN_MS = 15;

/**
 * Fires a short vibration for a confirm/deny tap. Never throws: browsers
 * without the Vibration API (desktop Chrome/Safari, jsdom by default) simply
 * lack `navigator.vibrate`, and this checks for it rather than calling it
 * unconditionally.
 */
export function triggerHapticFeedback(
  nav: VibratingNavigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
  pattern: number | number[] = CONFIRM_DENY_VIBRATION_PATTERN_MS,
): void {
  if (nav && typeof nav.vibrate === 'function') {
    nav.vibrate(pattern);
  }
}
