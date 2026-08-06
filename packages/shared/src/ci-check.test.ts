import { describe, expect, it } from 'vitest';

import { isFailingCiConclusion } from './ci-check';

describe('isFailingCiConclusion (SPEC §7.14; issues #239/#243)', () => {
  it('treats failure, timed_out, action_required, and cancelled as failing', () => {
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'cancelled']) {
      expect(isFailingCiConclusion(conclusion)).toBe(true);
    }
  });

  it('treats success, neutral, skipped, and stale as not failing', () => {
    for (const conclusion of ['success', 'neutral', 'skipped', 'stale']) {
      expect(isFailingCiConclusion(conclusion)).toBe(false);
    }
  });

  it('treats a still-running check (null conclusion) as not failing', () => {
    expect(isFailingCiConclusion(null)).toBe(false);
  });

  it('never treats an unrecognized future conclusion as a failure — conservative by design', () => {
    expect(isFailingCiConclusion('some_conclusion_github_invents_later')).toBe(false);
  });
});
