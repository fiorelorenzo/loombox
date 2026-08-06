import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpendLedgerError, SpendLedgerStore } from './spend-ledger-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-spend-ledger-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('SpendLedgerStore', () => {
  it('all() is empty against a fresh state dir', () => {
    const store = new SpendLedgerStore({ stateDir });
    expect(store.all()).toEqual([]);
  });

  it('recordDelta() creates a new row on the first delta for a (date, project, provider) combination', () => {
    const store = new SpendLedgerStore({ stateDir });
    store.recordDelta('2026-08-01', '/proj-a', 'claude', 1.5);
    expect(store.all()).toEqual([
      { date: '2026-08-01', projectPath: '/proj-a', provider: 'claude', costUsd: 1.5 },
    ]);
  });

  it('recordDelta() accumulates into the same row for a repeated (date, project, provider)', () => {
    const store = new SpendLedgerStore({ stateDir });
    store.recordDelta('2026-08-01', '/proj-a', 'claude', 1.5);
    store.recordDelta('2026-08-01', '/proj-a', 'claude', 0.25);
    expect(store.all()).toEqual([
      { date: '2026-08-01', projectPath: '/proj-a', provider: 'claude', costUsd: 1.75 },
    ]);
  });

  it('recordDelta() keeps distinct rows for different dates, projects, or providers', () => {
    const store = new SpendLedgerStore({ stateDir });
    store.recordDelta('2026-08-01', '/proj-a', 'claude', 1);
    store.recordDelta('2026-08-02', '/proj-a', 'claude', 1);
    store.recordDelta('2026-08-01', '/proj-b', 'claude', 1);
    store.recordDelta('2026-08-01', '/proj-a', 'codex', 1);
    expect(store.all()).toHaveLength(4);
  });

  it('rejects a zero, negative, or non-finite delta — there is nothing to persist for a day nothing increased', () => {
    const store = new SpendLedgerStore({ stateDir });
    expect(() => store.recordDelta('2026-08-01', '/proj-a', 'claude', 0)).toThrow(SpendLedgerError);
    expect(() => store.recordDelta('2026-08-01', '/proj-a', 'claude', -1)).toThrow(
      SpendLedgerError,
    );
    expect(() => store.recordDelta('2026-08-01', '/proj-a', 'claude', Infinity)).toThrow(
      SpendLedgerError,
    );
    expect(store.all()).toEqual([]); // the rejected writes never landed
  });

  it('rejects a malformed date', () => {
    const store = new SpendLedgerStore({ stateDir });
    expect(() => store.recordDelta('08/01/2026', '/proj-a', 'claude', 1)).toThrow(SpendLedgerError);
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    new SpendLedgerStore({ stateDir }).recordDelta('2026-08-01', '/proj-a', 'claude', 2);
    const reopened = new SpendLedgerStore({ stateDir });
    expect(reopened.all()).toEqual([
      { date: '2026-08-01', projectPath: '/proj-a', provider: 'claude', costUsd: 2 },
    ]);
  });

  it('all() returns a defensive copy — mutating the result never reaches the store', () => {
    const store = new SpendLedgerStore({ stateDir });
    store.recordDelta('2026-08-01', '/proj-a', 'claude', 1);
    const rows = store.all();
    rows[0]!.costUsd = 999;
    expect(store.all()[0]!.costUsd).toBe(1);
  });

  describe('on-disk validation', () => {
    it('throws SpendLedgerError for invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'spend-ledger.json'), '{not json');
      const store = new SpendLedgerStore({ stateDir });
      expect(() => store.all()).toThrow(SpendLedgerError);
    });

    it('throws SpendLedgerError when a persisted row has a non-positive costUsd', async () => {
      await writeFile(
        path.join(stateDir, 'spend-ledger.json'),
        JSON.stringify({
          v: 1,
          rows: [{ date: '2026-08-01', projectPath: '/proj-a', provider: 'claude', costUsd: 0 }],
        }),
      );
      const store = new SpendLedgerStore({ stateDir });
      expect(() => store.all()).toThrow(SpendLedgerError);
    });

    it('throws SpendLedgerError when a persisted row has a malformed date', async () => {
      await writeFile(
        path.join(stateDir, 'spend-ledger.json'),
        JSON.stringify({
          v: 1,
          rows: [{ date: 'not-a-date', projectPath: '/proj-a', provider: 'claude', costUsd: 1 }],
        }),
      );
      const store = new SpendLedgerStore({ stateDir });
      expect(() => store.all()).toThrow(SpendLedgerError);
    });
  });
});
