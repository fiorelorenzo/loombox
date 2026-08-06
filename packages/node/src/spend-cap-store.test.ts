import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpendCapError, SpendCapStore } from './spend-cap-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-spend-cap-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('SpendCapStore', () => {
  it('get() returns undefined (no cap) for an unconfigured project, against a fresh state dir', () => {
    const store = new SpendCapStore({ stateDir });
    expect(store.get('/proj-a')).toBeUndefined();
  });

  it('save() then get() round-trips a cap for exactly the saved project', () => {
    const store = new SpendCapStore({ stateDir });
    store.save('/proj-a', 25);
    expect(store.get('/proj-a')).toBe(25);
    // A different, never-saved project is unaffected — still no cap.
    expect(store.get('/proj-b')).toBeUndefined();
  });

  it('save() replaces an existing cap', () => {
    const store = new SpendCapStore({ stateDir });
    store.save('/proj-a', 25);
    store.save('/proj-a', 40);
    expect(store.get('/proj-a')).toBe(40);
  });

  it('save(projectPath, undefined) clears a saved cap, reverting to "no cap"', () => {
    const store = new SpendCapStore({ stateDir });
    store.save('/proj-a', 25);
    store.save('/proj-a', undefined);
    expect(store.get('/proj-a')).toBeUndefined();
  });

  it('rejects a zero, negative, or non-finite cap — a spend cap of $0 is not a real limit', () => {
    const store = new SpendCapStore({ stateDir });
    expect(() => store.save('/proj-a', 0)).toThrow(SpendCapError);
    expect(() => store.save('/proj-a', -5)).toThrow(SpendCapError);
    expect(() => store.save('/proj-a', Infinity)).toThrow(SpendCapError);
    expect(store.get('/proj-a')).toBeUndefined(); // the rejected write never landed
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    new SpendCapStore({ stateDir }).save('/proj-a', 25);
    const reopened = new SpendCapStore({ stateDir });
    expect(reopened.get('/proj-a')).toBe(25);
  });

  describe('on-disk validation', () => {
    it('throws SpendCapError for invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'spend-caps.json'), '{not json');
      const store = new SpendCapStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(SpendCapError);
    });

    it('throws SpendCapError when a saved cap is not a positive finite number', async () => {
      await writeFile(
        path.join(stateDir, 'spend-caps.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': 'not-a-number' } }),
      );
      const store = new SpendCapStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(SpendCapError);
    });

    it('throws SpendCapError for an on-disk cap of 0 — never silently treated as "no cap"', async () => {
      await writeFile(
        path.join(stateDir, 'spend-caps.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': 0 } }),
      );
      const store = new SpendCapStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(SpendCapError);
    });
  });
});
