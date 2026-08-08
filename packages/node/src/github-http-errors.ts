/* ---------------------------------------------------------------------
 * GitHub HTTP primitives shared by both of this backend's transports —
 * REST (`./github-tracker-backend.ts`) and GraphQL
 * (`./github-projects-v2.ts`, issue #218). Split out on its own so
 * neither transport module has to import the other just to reuse the
 * same rate-limit error/retry-after math: `github-tracker-backend.ts`
 * re-exports the three error classes below for its own existing
 * consumers (`./index.ts`, tests), so this split is invisible to
 * anything outside these two files.
 * --------------------------------------------------------------------- */

export const GITHUB_API_BASE = 'https://api.github.com';

/** Raised when GitHub answers `403` with `x-ratelimit-remaining: 0` — retryable, never a permission error. Reused verbatim by GraphQL requests (`./github-projects-v2.ts`): GitHub's GraphQL endpoint sends the identical `x-ratelimit-*` headers as REST. */
export class GithubTrackerRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`github tracker: rate limited (x-ratelimit-remaining: 0) — retry in ${retryAfterMs}ms`);
    this.name = 'GithubTrackerRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Raised for a `404` (no access, not "gone"), a payload that turns out to be a pull request, a binding whose target isn't a GitHub repo, a `resolveCredential` result with no usable token, or (issue #218) a Projects v2 board this token cannot see. */
export class GithubTrackerAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubTrackerAccessError';
  }
}

/** Raised for any other non-2xx GitHub response, REST or GraphQL. */
export class GithubTrackerRequestError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`github tracker: HTTP ${status} from ${url}`);
    this.name = 'GithubTrackerRequestError';
    this.status = status;
  }
}

/** `Retry-After` (seconds) wins when present; otherwise `X-RateLimit-Reset` (unix seconds) minus `nowMs`. Never negative. */
export function computeRetryAfterMs(headers: Headers, nowMs: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, Math.round(resetMs - nowMs));
  }
  return 0;
}
