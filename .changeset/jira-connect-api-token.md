---
'@loombox/node': minor
---

Add the Jira API-token connect path (SPEC §7.26, issue #225)

`@loombox/node` gets the zero-infrastructure Jira connect path: `JiraConnectService` (`jira-connect.ts`) takes `{siteUrl, email, apiToken}`, resolves identity via `GET /rest/api/3/myself` over Basic auth (`base64(email:apiToken)`, `jira-identity.ts`'s `resolveJiraIdentity`), and returns the metadata-only `ConnectedAccount` (issue #221) keyed on `(siteUrl-host, accountId)` — the stable Atlassian `accountId`, never the mutable `email`. This is the specific fix for emdash's `jira-connection-service.ts` single-row limitation (keyed on `email`, one row total): connecting a second Jira site, or a second account on the same site, gets its own `ConnectedAccount.id` and never overwrites an existing one.

`credentialSource` is `'api_token'`. The email/apiToken pair lives only in the node's OS keyring (`keyring.ts`'s `NodeKeyring`, the same abstraction and file-fallback #222's `GithubConnectService` uses) — Basic auth needs both on every request, and `email` is deliberately not a `ConnectedAccount` field, so it travels with the token as one keyring secret rather than living on the synced row. `getCredential` resolves a `ConnectedAccount` into the request base URL and a ready-to-set `Authorization` header — the seam #214's `JiraTrackerBackend` consumes, agreed over IRC while both issues were in flight.

No Jira OAuth 2.0 (3LO, #226), per-project pinning (#227, already shipped and reusable as-is), node-presence computation (#228), or connect-flow UI (#230) ship here.
