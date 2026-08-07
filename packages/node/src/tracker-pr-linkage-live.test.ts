import { describe, expect, it, vi } from 'vitest';
import type { JiraTarget } from '@loombox/protocol';
import type { TrackerBackend, TrackerBinding } from '@loombox/shared';

import {
  extractJiraIssueKey,
  LiveTrackerPrLinkageWriter,
  type LiveTrackerPrLinkageInput,
} from './tracker-pr-linkage-live';
import { JiraTrackerAccessError, JiraTrackerRequestError } from './jira-tracker-backend';

/**
 * `./tracker-pr-linkage-live.ts` (SPEC §7.14 lines 526-530; issue #242)
 * against stub `TrackerBackend`s only — no real GitHub/Jira API, same
 * convention as `./tracker-connectivity-watcher.test.ts` (issue #219).
 */

const jiraTarget: JiraTarget = { cloudId: 'cloud-1', projectKey: 'PROJ' };

const jiraBinding: TrackerBinding = {
  connectionId: 'jira:site:1',
  target: jiraTarget,
};

const githubBinding: TrackerBinding = {
  connectionId: 'github:github.com:1',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

const CAPABILITIES = {
  comments: true,
  transitions: true,
  boards: false,
  sprints: false,
  labels: true,
  milestones: true,
  customFields: false,
};

function fakeGithubBackend(addComment?: TrackerBackend['addComment']): TrackerBackend {
  return {
    id: 'github',
    capabilities: CAPABILITIES,
    listBindings: () => Promise.resolve([]),
    list: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    create: () => Promise.reject(new Error('not used')),
    update: () => Promise.reject(new Error('not used')),
    addComment,
  };
}

function fakeJiraBackend(addComment: TrackerBackend['addComment']): TrackerBackend {
  return {
    id: 'jira',
    capabilities: CAPABILITIES,
    listBindings: () => Promise.resolve([]),
    list: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    create: () => Promise.reject(new Error('not used')),
    update: () => Promise.reject(new Error('not used')),
    addComment,
  };
}

function input(overrides: Partial<LiveTrackerPrLinkageInput> = {}): LiveTrackerPrLinkageInput {
  return {
    backend: fakeJiraBackend(vi.fn().mockResolvedValue(undefined)),
    binding: jiraBinding,
    prUrl: 'https://github.com/fiorelorenzo/loombox/pull/42',
    prTitle: 'PROJ-7: fix the thing',
    prBody: 'Fixes the bug described in PROJ-7.',
    ...overrides,
  };
}

describe('extractJiraIssueKey (issue #242) — scoped to the bound project\u2019s own key', () => {
  it('finds the key in the title', () => {
    expect(extractJiraIssueKey(jiraTarget, 'PROJ-7: fix the thing\n')).toBe('PROJ-7');
  });

  it('finds the key in the body when the title has none', () => {
    expect(extractJiraIssueKey(jiraTarget, 'no key here\nRelates to PROJ-123.')).toBe('PROJ-123');
  });

  it('never matches a DIFFERENT project\u2019s key, even one shaped identically', () => {
    expect(
      extractJiraIssueKey(jiraTarget, 'Closes OTHER-7, unrelated to this project'),
    ).toBeUndefined();
  });

  it('never matches an unrelated all-caps-word-then-number', () => {
    expect(extractJiraIssueKey(jiraTarget, 'See RFC-2119 for the vocabulary')).toBeUndefined();
  });

  it('returns undefined when the key never appears', () => {
    expect(extractJiraIssueKey(jiraTarget, 'nothing to see here')).toBeUndefined();
  });

  it('escapes a projectKey containing regex-special characters rather than letting them change what matches', () => {
    const weirdTarget: JiraTarget = { cloudId: 'cloud-1', projectKey: 'A.B' };
    // A naive, unescaped `A.B-\d+` would also match "AxB-7" (the "." acting
    // as a wildcard) - this proves it does not.
    expect(extractJiraIssueKey(weirdTarget, 'AxB-7 should not match')).toBeUndefined();
    expect(extractJiraIssueKey(weirdTarget, 'A.B-7 should match')).toBe('A.B-7');
  });
});

describe('LiveTrackerPrLinkageWriter.writePrLinkage — GitHub (issue #242)', () => {
  it('relies on GitHub\u2019s own issue-closing keywords: makes zero backend calls, ever', async () => {
    const addComment = vi.fn();
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(
      input({
        backend: fakeGithubBackend(addComment),
        binding: githubBinding,
        prTitle: 'Closes #123',
        prBody: 'Fixes the reported bug.',
      }),
    );
    expect(result).toEqual({ outcome: 'reliesOnKeywords' });
    expect(addComment).not.toHaveBeenCalled();
  });
});

describe('LiveTrackerPrLinkageWriter.writePrLinkage — Jira (issue #242)', () => {
  it('posts an addComment linking the PR when the title/body names an issue in the bound project', async () => {
    const addComment = vi.fn().mockResolvedValue(undefined);
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(
      input({ backend: fakeJiraBackend(addComment), prTitle: 'PROJ-7: fix the thing' }),
    );
    expect(result).toEqual({ outcome: 'linked', externalId: 'PROJ-7' });
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledWith(
      jiraBinding,
      'PROJ-7',
      expect.stringContaining('https://github.com/fiorelorenzo/loombox/pull/42'),
    );
  });

  it('reports noIssueReference, never a guess, when neither title nor body names an issue in the bound project', async () => {
    const addComment = vi.fn();
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(
      input({
        backend: fakeJiraBackend(addComment),
        prTitle: 'fix the thing',
        prBody: 'no issue mentioned',
      }),
    );
    expect(result).toEqual({ outcome: 'noIssueReference' });
    expect(addComment).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call for the identical (issue, PR) pair short-circuits without a second addComment', async () => {
    const addComment = vi.fn().mockResolvedValue(undefined);
    const writer = new LiveTrackerPrLinkageWriter();
    const backend = fakeJiraBackend(addComment);
    const first = await writer.writePrLinkage(input({ backend }));
    const second = await writer.writePrLinkage(input({ backend }));
    expect(first).toEqual({ outcome: 'linked', externalId: 'PROJ-7' });
    expect(second).toEqual({ outcome: 'alreadyLinked', externalId: 'PROJ-7' });
    expect(addComment).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT PR referencing the same issue is not treated as a duplicate', async () => {
    const addComment = vi.fn().mockResolvedValue(undefined);
    const writer = new LiveTrackerPrLinkageWriter();
    const backend = fakeJiraBackend(addComment);
    await writer.writePrLinkage(
      input({ backend, prUrl: 'https://github.com/fiorelorenzo/loombox/pull/1' }),
    );
    const second = await writer.writePrLinkage(
      input({ backend, prUrl: 'https://github.com/fiorelorenzo/loombox/pull/2' }),
    );
    expect(second).toEqual({ outcome: 'linked', externalId: 'PROJ-7' });
    expect(addComment).toHaveBeenCalledTimes(2);
  });

  it('classifies a rejected credential (401) as authFailed, distinct from a transient failure', async () => {
    const addComment = vi
      .fn()
      .mockRejectedValue(new JiraTrackerRequestError(401, 'https://api.atlassian.com/x'));
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(input({ backend: fakeJiraBackend(addComment) }));
    expect(result).toEqual({ outcome: 'authFailed', externalId: 'PROJ-7' });
  });

  it('classifies a 404 access error as authFailed (Jira never distinguishes "gone" from "no access")', async () => {
    const addComment = vi.fn().mockRejectedValue(new JiraTrackerAccessError('jira tracker: 404'));
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(input({ backend: fakeJiraBackend(addComment) }));
    expect(result).toEqual({ outcome: 'authFailed', externalId: 'PROJ-7' });
  });

  it('classifies a 5xx as unreachable, distinct from authFailed', async () => {
    const addComment = vi
      .fn()
      .mockRejectedValue(new JiraTrackerRequestError(503, 'https://api.atlassian.com/x'));
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(input({ backend: fakeJiraBackend(addComment) }));
    expect(result).toEqual({ outcome: 'unreachable', externalId: 'PROJ-7' });
  });

  it('classifies an unrecognized raw fetch failure (DNS/timeout) as unreachable, never guessed as authFailed', async () => {
    const addComment = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const writer = new LiveTrackerPrLinkageWriter();
    const result = await writer.writePrLinkage(input({ backend: fakeJiraBackend(addComment) }));
    expect(result).toEqual({ outcome: 'unreachable', externalId: 'PROJ-7' });
  });

  it('a failed attempt is never marked linked: the very next call retries addComment rather than silently skipping', async () => {
    const addComment = vi
      .fn()
      .mockRejectedValueOnce(new JiraTrackerRequestError(503, 'https://api.atlassian.com/x'))
      .mockResolvedValueOnce(undefined);
    const writer = new LiveTrackerPrLinkageWriter();
    const backend = fakeJiraBackend(addComment);
    const first = await writer.writePrLinkage(input({ backend }));
    const second = await writer.writePrLinkage(input({ backend }));
    expect(first).toEqual({ outcome: 'unreachable', externalId: 'PROJ-7' });
    expect(second).toEqual({ outcome: 'linked', externalId: 'PROJ-7' });
    expect(addComment).toHaveBeenCalledTimes(2);
  });

  it('throws for a should-never-happen jira backend composed with a non-Jira binding.target, rather than silently miscomposing a comment target', async () => {
    const addComment = vi.fn();
    const writer = new LiveTrackerPrLinkageWriter();
    await expect(
      writer.writePrLinkage(
        input({ backend: fakeJiraBackend(addComment), binding: githubBinding }),
      ),
    ).rejects.toThrow(/non-Jira binding\.target/);
    expect(addComment).not.toHaveBeenCalled();
  });
});
