import { describe, expect, it } from 'vitest';

import { AutoIterateDriveGate } from './auto-iterate-drive-gate';

describe('AutoIterateDriveGate (SPEC §7.15; issue #247)', () => {
  it('drives the first time a session sees a given head sha, and refuses a later call for that exact same sha', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(false);
    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(false);
  });

  it('is exactly what prevents a CI failure and a local runner failure for the same commit from both driving', () => {
    const gate = new AutoIterateDriveGate();

    // CI observes the failure first.
    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    // The runner independently observes the very same commit failing —
    // must NOT drive a second attempt for what is really one change.
    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(false);
  });

  it('drives again for a genuinely new commit', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-1', 'sha-b')).toBe(true);
  });

  it('never suppresses on a missing or placeholder sha', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', undefined)).toBe(true);
    expect(gate.shouldDrive('sess-1', undefined)).toBe(true);
    expect(gate.shouldDrive('sess-1', 'unknown')).toBe(true);
    expect(gate.shouldDrive('sess-1', 'unknown')).toBe(true);
  });

  it('tracks sessions independently', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-2', 'sha-a')).toBe(true);
  });

  it('clear() lets a later call for the same sha drive again (mirrors a fresh watch, a green check, or session archival)', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(false);

    gate.clear('sess-1');

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
  });

  it('clear() only affects the named session', () => {
    const gate = new AutoIterateDriveGate();

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-2', 'sha-b')).toBe(true);

    gate.clear('sess-1');

    expect(gate.shouldDrive('sess-1', 'sha-a')).toBe(true);
    expect(gate.shouldDrive('sess-2', 'sha-b')).toBe(false);
  });
});
