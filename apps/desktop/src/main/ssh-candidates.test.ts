import { describe, expect, it, vi } from 'vitest';

const discoverSshTargets = vi.fn();
vi.mock('@loombox/node', () => ({ discoverSshTargets }));

const { listSshHostCandidates } = await import('./ssh-candidates');

describe('listSshHostCandidates (issue #475 — replaces the #403 TODO stub)', () => {
  it("calls the now-exported @loombox/node discoverSshTargets and forwards a real discovery (mocked ~/.ssh/config), instead of the stub's hardcoded empty result", async () => {
    discoverSshTargets.mockResolvedValueOnce({
      candidates: [
        {
          alias: 'devbox',
          hostName: '100.87.202.117',
          user: 'lorenzo',
          port: 22,
          identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
        },
      ],
      agent: { available: true, socketPath: '/tmp/ssh-agent.sock', identities: [] },
      requiresManualEntry: false,
    });

    const result = await listSshHostCandidates();

    expect(discoverSshTargets).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      candidates: [
        {
          alias: 'devbox',
          hostName: '100.87.202.117',
          user: 'lorenzo',
          port: 22,
          identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
        },
      ],
      requiresManualEntry: false,
    });
  });

  it("still resolves { candidates: [], requiresManualEntry: true } when there is nothing to discover — the wizard's fallback-to-manual-entry contract, now driven by a real (empty) discovery instead of a hardcoded stub", async () => {
    discoverSshTargets.mockResolvedValueOnce({
      candidates: [],
      agent: { available: false, identities: [] },
      requiresManualEntry: true,
    });

    await expect(listSshHostCandidates()).resolves.toEqual({
      candidates: [],
      requiresManualEntry: true,
    });
  });
});
