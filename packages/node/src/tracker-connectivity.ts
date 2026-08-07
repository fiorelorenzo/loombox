/* ---------------------------------------------------------------------
 * Classifies a live `TrackerBackend` call failure into the two connectivity
 * failure states `@loombox/protocol`'s `TrackerConnectivityStateV1` knows
 * (SPEC §7.10's "explicit connectivity-error state"; issue #219):
 * 'unreachable' (transient — network failure, timeout, a 5xx, GitHub/Jira
 * rate limiting; the corrective action is "try again later") or
 * 'authFailed' (the credential was rejected; the corrective action is
 * "reconnect the account in Settings"). `TrackerConnectivityWatcher` is
 * this module's only caller — see that file's own doc comment for how a
 * `resolveTrackerBackend` resolution failure (no account/credential to
 * even attempt a call with) is classified separately, upstream of this
 * function ever running.
 * --------------------------------------------------------------------- */

import {
  GithubTrackerAccessError,
  GithubTrackerRateLimitError,
  GithubTrackerRequestError,
} from './github-tracker-backend';
import { JiraTrackerAccessError, JiraTrackerRequestError } from './jira-tracker-backend';

export type TrackerConnectivityFailure = 'unreachable' | 'authFailed';

/** HTTP statuses that mean "this credential was rejected", not "something is briefly wrong" — 401 unauthorized (no/expired token) and 403 forbidden (revoked/insufficient scope), as long as the 403 isn't GitHub's own rate-limit signal (that one throws `GithubTrackerRateLimitError` instead, never a plain `GithubTrackerRequestError`, so it never reaches this check). */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Classifies why `TrackerBackend.list` (or any other backend call
 * `TrackerConnectivityWatcher` might one day probe with) threw.
 *
 * - A GitHub/Jira `AccessError` (404, or `resolveCredential` returning no
 *   usable token/baseUrl) is treated as `'authFailed'`: GitHub/Jira never
 *   distinguish "does not exist" from "you cannot see it" on a 404 (see
 *   each backend's own doc comment), and the only actionable response
 *   available to a user either way is the same one 401/403 gets —
 *   reconnect the account.
 * - A GitHub rate-limit (403 + `x-ratelimit-remaining: 0`) is
 *   `'unreachable'`: purely transient, nothing to reconnect.
 * - A generic `RequestError` (any other non-2xx) is `'authFailed'` only
 *   for 401/403, `'unreachable'` for everything else (429, 5xx, ...).
 * - Anything else (a raw `fetch` rejection — DNS failure, connection
 *   refused, timeout, an aborted request) is `'unreachable'`: this
 *   function only ever recognizes credential-flavored failures by their
 *   specific shape, so an unrecognized error defaults to the transient
 *   bucket rather than guessing it is a credential problem.
 */
export function classifyTrackerConnectivityError(error: unknown): TrackerConnectivityFailure {
  if (error instanceof GithubTrackerRateLimitError) return 'unreachable';
  if (error instanceof GithubTrackerAccessError) return 'authFailed';
  if (error instanceof GithubTrackerRequestError) {
    return isAuthStatus(error.status) ? 'authFailed' : 'unreachable';
  }
  if (error instanceof JiraTrackerAccessError) return 'authFailed';
  if (error instanceof JiraTrackerRequestError) {
    return isAuthStatus(error.status) ? 'authFailed' : 'unreachable';
  }
  return 'unreachable';
}
