import { describe, expect, it } from 'vitest';

import { listSshHostCandidates } from './ssh-candidates';

describe('listSshHostCandidates (TODO stub)', () => {
  it('reports no candidates and requiresManualEntry, until @loombox/node exports discoverSshTargets', async () => {
    await expect(listSshHostCandidates()).resolves.toEqual({
      candidates: [],
      requiresManualEntry: true,
    });
  });
});
