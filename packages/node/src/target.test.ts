import { cpus } from 'node:os';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SSH_MAX_CONCURRENT_SESSIONS, defaultLocalMaxConcurrentSessions } from './target';

describe('defaultLocalMaxConcurrentSessions (SPEC §7.16, issue #252)', () => {
  it("reflects this host's own CPU core count", () => {
    expect(defaultLocalMaxConcurrentSessions()).toBe(cpus().length || 4);
  });

  it("is at least 1, never 0, even on a host os.cpus() can't read", () => {
    expect(defaultLocalMaxConcurrentSessions()).toBeGreaterThanOrEqual(1);
  });
});

describe('DEFAULT_SSH_MAX_CONCURRENT_SESSIONS (SPEC §7.16, issue #252)', () => {
  it('is a fixed, conservative constant independent of this host', () => {
    expect(DEFAULT_SSH_MAX_CONCURRENT_SESSIONS).toBe(2);
  });

  it("differs from the local default on any real multi-core box (local scales with hardware, ssh: doesn't)", () => {
    if (cpus().length <= DEFAULT_SSH_MAX_CONCURRENT_SESSIONS) return; // not meaningful on a 1-2 core box
    expect(defaultLocalMaxConcurrentSessions()).not.toBe(DEFAULT_SSH_MAX_CONCURRENT_SESSIONS);
  });
});
