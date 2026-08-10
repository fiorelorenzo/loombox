/**
 * Haptic feedback for irreversible confirm/deny taps (SPEC.md §7.3 "Touch
 * affordances for transcript widgets", issue #133; native parity issue
 * #284): the Vibration API on web, guarded so it is a silent no-op
 * wherever unsupported (most desktop browsers, and jsdom in tests unless a
 * test stubs it) rather than throwing. Same injectable-browser-API pattern
 * as `copy.ts`'s `copyToClipboard`: the real `navigator` is the default, a
 * fake is passed in tests.
 *
 * `triggerHapticFeedback` is also the one call site the native branch
 * lives behind: `PermissionCard.svelte`/`AttentionInbox.svelte` call it
 * exactly as before (`hapticFn()`, no args) and never branch on platform
 * themselves. The `native` param picks the implementation once, inside
 * this function, the same shape as `native-attachments.ts`'s
 * `pickAttachmentImages` — its default reads the real
 * `Capacitor.isNativePlatform()` and the real `@capacitor/haptics` plugin,
 * so every existing caller (and every existing test, unchanged) keeps
 * getting today's web-only behavior: `Capacitor.isNativePlatform()` is
 * `false` in jsdom (no `window.androidBridge`/`webkit.messageHandlers`),
 * so `nav.vibrate` is exactly the code path that runs.
 *
 * NOT RUNNABLE HERE: no Android emulator, no iOS toolchain on this box
 * (docs/superpowers/specs/2026-08-08-capacitor-mobile-spike.md). The
 * native branch is unit-tested by injecting a fake `native` engine below;
 * the real `@capacitor/haptics` call is exercised only by TypeScript's
 * structural check against its `.d.ts`, never by a live run.
 */
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/** The minimal `Navigator` surface this module needs. */
export interface VibratingNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
}

/** Minimal `@capacitor/haptics` surface this module needs — satisfied by the real plugin singleton and by a test fake. */
export interface NativeHapticsEngine {
  impact(options: { style: ImpactStyle }): Promise<void>;
}

/** A short, single-pulse pattern (ms) — a light tap acknowledgement, not a buzz. Also the impact style's rough web-side equivalent: `ImpactStyle.Light`. */
export const CONFIRM_DENY_VIBRATION_PATTERN_MS = 15;

/**
 * Fires a short haptic cue for a confirm/deny tap: `ImpactStyle.Light` via
 * Capacitor's Haptics plugin inside the native shell, the Vibration API
 * everywhere else. Never throws: a browser without the Vibration API
 * (desktop Chrome/Safari, jsdom by default) simply lacks `navigator.vibrate`
 * and this checks for it rather than calling it unconditionally; a device
 * whose native haptics call rejects (unsupported hardware, permission)
 * has that rejection swallowed the same way.
 */
export function triggerHapticFeedback(
  nav: VibratingNavigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
  pattern: number | number[] = CONFIRM_DENY_VIBRATION_PATTERN_MS,
  native: { isNative: boolean; engine: NativeHapticsEngine } = {
    isNative: Capacitor.isNativePlatform(),
    engine: Haptics,
  },
): void {
  if (native.isNative) {
    native.engine.impact({ style: ImpactStyle.Light }).catch(() => {
      // Swallowed on purpose — same "never throws into a click handler"
      // contract as the Vibration-API branch below.
    });
    return;
  }
  if (nav && typeof nav.vibrate === 'function') {
    nav.vibrate(pattern);
  }
}
