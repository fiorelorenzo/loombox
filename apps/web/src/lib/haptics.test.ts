import { describe, expect, it, vi } from 'vitest';

import { ImpactStyle } from '@capacitor/haptics';
import {
  CONFIRM_DENY_VIBRATION_PATTERN_MS,
  triggerHapticFeedback,
  type NativeHapticsEngine,
} from './haptics';

describe('triggerHapticFeedback (#133)', () => {
  it('calls navigator.vibrate with the confirm/deny pattern when the Vibration API is available', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    triggerHapticFeedback({ vibrate });
    expect(vibrate).toHaveBeenCalledWith(CONFIRM_DENY_VIBRATION_PATTERN_MS);
  });

  it('never throws when navigator.vibrate is missing (most desktop browsers)', () => {
    expect(() => triggerHapticFeedback({})).not.toThrow();
  });

  it('never throws when navigator itself is undefined', () => {
    expect(() => triggerHapticFeedback(undefined)).not.toThrow();
  });

  it('accepts a custom pattern', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    triggerHapticFeedback({ vibrate }, [10, 20, 10]);
    expect(vibrate).toHaveBeenCalledWith([10, 20, 10]);
  });
});

describe('triggerHapticFeedback: native branch (#284)', () => {
  it('fires ImpactStyle.Light via the native Haptics engine instead of navigator.vibrate when in the Capacitor shell', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    const impact = vi.fn().mockResolvedValue(undefined);
    const engine: NativeHapticsEngine = { impact };

    triggerHapticFeedback({ vibrate }, CONFIRM_DENY_VIBRATION_PATTERN_MS, {
      isNative: true,
      engine,
    });

    expect(impact).toHaveBeenCalledWith({ style: ImpactStyle.Light });
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('never throws when the native impact call rejects (unsupported hardware, missing permission)', async () => {
    const engine: NativeHapticsEngine = {
      impact: vi.fn().mockRejectedValue(new Error('unavailable')),
    };
    expect(() =>
      triggerHapticFeedback(undefined, undefined, { isNative: true, engine }),
    ).not.toThrow();
    // Let the rejected promise's .catch() settle before the test ends, so
    // an unhandled-rejection warning never leaks into an unrelated test.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('falls back to navigator.vibrate when isNative is false even with a native engine present', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    const impact = vi.fn().mockResolvedValue(undefined);
    triggerHapticFeedback({ vibrate }, CONFIRM_DENY_VIBRATION_PATTERN_MS, {
      isNative: false,
      engine: { impact },
    });
    expect(vibrate).toHaveBeenCalledWith(CONFIRM_DENY_VIBRATION_PATTERN_MS);
    expect(impact).not.toHaveBeenCalled();
  });
});
