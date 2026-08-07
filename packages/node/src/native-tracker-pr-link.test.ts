import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NativeTrackerStore } from './native-tracker-store';
import {
  findNativeTrackerRecordForSession,
  formatPullRequestRef,
  linkOpenedPullRequestToNativeTracker,
} from './native-tracker-pr-link';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-native-tracker-pr-link-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const PROJECT = '/home/dev/projects/loombox-demo';

describe('formatPullRequestRef()', () => {
  it('formats owner/repo#number, matching the on-disk convention', () => {
    expect(formatPullRequestRef({ owner: 'fiorelorenzo', repo: 'loombox', number: 241 })).toBe(
      'fiorelorenzo/loombox#241',
    );
  });
});

describe('findNativeTrackerRecordForSession()', () => {
  it('finds the record whose linkedSessionIds names the session', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');

    const found = findNativeTrackerRecordForSession(store, PROJECT, 'session-1');
    expect(found?.id).toBe(record.id);
  });

  it('returns undefined for a session linked to nothing', () => {
    const store = new NativeTrackerStore({ stateDir });
    store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });

    expect(findNativeTrackerRecordForSession(store, PROJECT, 'session-untracked')).toBeUndefined();
  });

  it('still finds an archived record — a PR landing after archival is not silently dropped', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');
    store.update(PROJECT, record.id, { archived: true });

    expect(findNativeTrackerRecordForSession(store, PROJECT, 'session-1')?.id).toBe(record.id);
  });
});

describe('linkOpenedPullRequestToNativeTracker()', () => {
  it('writes the link to the tracker record a tracked session is linked to', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');

    const updated = linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-1', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });

    expect(updated?.system.linkedPullRequests).toEqual(['fiorelorenzo/loombox#241']);
    // and it's really on disk, not just the returned value
    expect(store.get(PROJECT, record.id)?.system.linkedPullRequests).toEqual([
      'fiorelorenzo/loombox#241',
    ]);
  });

  it('skips honestly for a session with no tracker item — no record touched, no store write', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    // deliberately never linked to any session

    const result = linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-untracked', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });

    expect(result).toBeUndefined();
    expect(store.get(PROJECT, record.id)?.system.linkedPullRequests).toEqual([]);
  });

  it('re-opening the same PR for the same session updates rather than duplicates the link', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');

    linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-1', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });
    const updated = linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-1', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });

    expect(updated?.system.linkedPullRequests).toEqual(['fiorelorenzo/loombox#241']);
  });

  it('an item that already carries a different PR gets it replaced, not appended, by the new one', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');
    // simulates an item that already carries a PR link from earlier
    store.linkPullRequest(PROJECT, record.id, 'fiorelorenzo/loombox#100');

    const updated = linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-1', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });

    expect(updated?.system.linkedPullRequests).toEqual(['fiorelorenzo/loombox#241']);
  });

  it('a PR that later closes without merging leaves the recorded link exactly as it was written — no separate close hook mutates it', () => {
    const store = new NativeTrackerStore({ stateDir });
    const record = store.create(PROJECT, { primaryType: 'task', fields: {}, authorId: 'a' });
    store.linkSession(PROJECT, record.id, 'session-1');

    linkOpenedPullRequestToNativeTracker(store, PROJECT, 'session-1', {
      owner: 'fiorelorenzo',
      repo: 'loombox',
      number: 241,
    });

    // the PR closing without merging is an event this module never
    // observes at all (it only ever runs off a successful pr_open_request)
    // — the link this issue is responsible for stays exactly as opened.
    expect(store.get(PROJECT, record.id)?.system.linkedPullRequests).toEqual([
      'fiorelorenzo/loombox#241',
    ]);
  });
});
