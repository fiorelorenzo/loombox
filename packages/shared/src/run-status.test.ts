import { describe, expect, it } from 'vitest';

import { isFailingRunOutcome } from './run-status';

describe('isFailingRunOutcome (SPEC §7.14/§7.15; issue #247)', () => {
  it('treats fail and could_not_start as failing', () => {
    expect(isFailingRunOutcome('fail')).toBe(true);
    expect(isFailingRunOutcome('could_not_start')).toBe(true);
  });

  it('treats pass as not failing', () => {
    expect(isFailingRunOutcome('pass')).toBe(false);
  });
});
