import { describe, expect, it } from 'vitest';
import { classifyTrackerConnectivityError } from './tracker-connectivity';
import { GithubTrackerAccessError, GithubTrackerRateLimitError, GithubTrackerRequestError } from './github-tracker-backend';
import { JiraTrackerAccessError, JiraTrackerRequestError } from './jira-tracker-backend';

describe('classifyTrackerConnectivityError (issue #219) — no real network, every case constructed directly', () => {
  it('classifies a GitHub rate limit as unreachable, never authFailed', () => {
    expect(classifyTrackerConnectivityError(new GithubTrackerRateLimitError(30_000))).toBe(
      'unreachable',
    );
  });

  it('classifies a GitHub 404/no-access as authFailed', () => {
    expect(
      classifyTrackerConnectivityError(new GithubTrackerAccessError('github tracker: 404')),
    ).toBe('authFailed');
  });

  it('classifies a GitHub 401 as authFailed', () => {
    expect(
      classifyTrackerConnectivityError(new GithubTrackerRequestError(401, 'https://api.github.com/x')),
    ).toBe('authFailed');
  });

  it('classifies a GitHub 403 (not the rate-limit shape) as authFailed', () => {
    expect(
      classifyTrackerConnectivityError(new GithubTrackerRequestError(403, 'https://api.github.com/x')),
    ).toBe('authFailed');
  });

  it('classifies a GitHub 500 as unreachable, not authFailed', () => {
    expect(
      classifyTrackerConnectivityError(new GithubTrackerRequestError(500, 'https://api.github.com/x')),
    ).toBe('unreachable');
  });

  it('classifies a GitHub 429 as unreachable', () => {
    expect(
      classifyTrackerConnectivityError(new GithubTrackerRequestError(429, 'https://api.github.com/x')),
    ).toBe('unreachable');
  });

  it('classifies a Jira 404/no-access as authFailed', () => {
    expect(classifyTrackerConnectivityError(new JiraTrackerAccessError('jira tracker: 404'))).toBe(
      'authFailed',
    );
  });

  it('classifies a Jira 401 as authFailed', () => {
    expect(
      classifyTrackerConnectivityError(new JiraTrackerRequestError(401, 'https://api.atlassian.com/x')),
    ).toBe('authFailed');
  });

  it('classifies a Jira 429 (Jira has no dedicated rate-limit error class) as unreachable', () => {
    expect(
      classifyTrackerConnectivityError(new JiraTrackerRequestError(429, 'https://api.atlassian.com/x')),
    ).toBe('unreachable');
  });

  it('classifies a Jira 503 as unreachable', () => {
    expect(
      classifyTrackerConnectivityError(new JiraTrackerRequestError(503, 'https://api.atlassian.com/x')),
    ).toBe('unreachable');
  });

  it('classifies an unrecognized raw fetch failure (DNS/timeout/connection refused) as unreachable, never guessed as authFailed', () => {
    expect(classifyTrackerConnectivityError(new TypeError('fetch failed'))).toBe('unreachable');
    expect(classifyTrackerConnectivityError('not even an Error')).toBe('unreachable');
    expect(classifyTrackerConnectivityError(undefined)).toBe('unreachable');
  });
});
