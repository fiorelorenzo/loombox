import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIndexedDbOutboxStorage,
  createInMemoryOutboxStorage,
  type QueuedPrompt,
} from './outbox';

function prompt(overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id: 'prompt_1',
    sessionId: 'sess_1',
    text: 'hello',
    attachments: [],
    queuedAt: 1,
    ...overrides,
  };
}

// `fake-indexeddb/auto` installs one process-wide `indexedDB` global backed
// by in-memory databases keyed by name — resetting it between tests keeps
// each test's database namespace isolated, exactly like a real browser
// profile wipe would (jsdom offers no such thing itself).
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('createIndexedDbOutboxStorage', () => {
  it('put then list round-trips a queued prompt verbatim', async () => {
    const storage = createIndexedDbOutboxStorage('acct-1');
    await storage.put(prompt());
    expect(await storage.list()).toEqual([prompt()]);
  });

  it('put with the same id overwrites rather than duplicating', async () => {
    const storage = createIndexedDbOutboxStorage('acct-1');
    await storage.put(prompt({ text: 'first draft' }));
    await storage.put(prompt({ text: 'edited draft' }));
    const all = await storage.list();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('edited draft');
  });

  it('delete removes exactly the given id, leaving the rest', async () => {
    const storage = createIndexedDbOutboxStorage('acct-1');
    await storage.put(prompt({ id: 'a' }));
    await storage.put(prompt({ id: 'b' }));
    await storage.delete('a');
    const all = await storage.list();
    expect(all.map((p) => p.id)).toEqual(['b']);
  });

  it('a queued prompt written by one storage handle is read back by a fresh handle for the SAME account — simulating a full page reload', async () => {
    const before = createIndexedDbOutboxStorage('acct-reload');
    await before.put(prompt({ id: 'p-reload', text: 'survive me' }));

    // A brand-new `OutboxStorage` instance, exactly what a fresh page load
    // constructs — nothing here shares in-memory state with `before`, only
    // the same underlying IndexedDB database name.
    const after = createIndexedDbOutboxStorage('acct-reload');
    expect(await after.list()).toEqual([prompt({ id: 'p-reload', text: 'survive me' })]);
  });

  it('scopes storage per accountId — one account never sees another account’s queued prompts', async () => {
    const alice = createIndexedDbOutboxStorage('acct-alice');
    const bob = createIndexedDbOutboxStorage('acct-bob');
    await alice.put(prompt({ id: 'alice-1' }));
    await bob.put(prompt({ id: 'bob-1' }));

    expect((await alice.list()).map((p) => p.id)).toEqual(['alice-1']);
    expect((await bob.list()).map((p) => p.id)).toEqual(['bob-1']);
  });
});

describe('createInMemoryOutboxStorage', () => {
  it('put/list/delete behave the same as the IndexedDB-backed storage, minus persistence', async () => {
    const storage = createInMemoryOutboxStorage();
    await storage.put(prompt({ id: 'a' }));
    await storage.put(prompt({ id: 'b' }));
    expect((await storage.list()).map((p) => p.id).sort()).toEqual(['a', 'b']);
    await storage.delete('a');
    expect((await storage.list()).map((p) => p.id)).toEqual(['b']);
  });
});
