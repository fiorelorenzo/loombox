---
'@loombox/node': minor
---

Add the GitHub `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #213)

`@loombox/node` gets `GithubTrackerBackend` (`github-tracker-backend.ts`), the first concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209). `list`/`get`/`create`/`update`/`addComment`/`listBindings` all go straight to GitHub REST (`docs.github.com/en/rest/issues/*`) for a bound `owner/repo`: `list` paginates via the `Link` header's `rel="next"` (carried opaquely through `TrackerListFilter.cursor`/`TrackerListPage.nextCursor`), a `403` with `x-ratelimit-remaining: 0` raises a distinct `GithubTrackerRateLimitError` with a computed `retryAfterMs` instead of being reported as a permission problem, a `404` raises `GithubTrackerAccessError` (GitHub returns 404, not 403, for a token with no access to a private repo/issue), and pull requests — which GitHub's issues endpoints return alongside real issues — are filtered out of `list` and rejected explicitly from `get`.

Credentials come only from an injected `resolveCredential(connectionId): Promise<{token}>`; this backend never runs OAuth and never touches this package's own `keyring.ts`/`github-connect.ts` directly, since the real connected-accounts credential registry SPEC §7.10 describes doesn't exist in a directly callable shape yet.

`capabilities` reports `comments`/`labels`/`milestones: true`, `transitions`/`boards`/`sprints`/`customFields: false` for this slice. No transitions (#215), no boards/Projects v2 (#218), no Jira backend (#214) ship here. Server-side only: this lives in `@loombox/node`, which is not in `apps/web`'s dependency graph, direct or transitive.
