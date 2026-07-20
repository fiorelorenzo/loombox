import { describe, expect, it, vi } from 'vitest';

import { CONFIRM_DENY_VIBRATION_PATTERN_MS, triggerHapticFeedback } from './haptics';

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
