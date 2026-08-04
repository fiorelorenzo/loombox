---
'@loombox/node': minor
---

Add the Jira `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #214)

`@loombox/node` gets `JiraTrackerBackend` (`jira-tracker-backend.ts`), the second concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209), after GitHub (#213). `list`/`get`/`create`/`update`/`addComment`/`listBindings` go against Jira Cloud REST v3 for a bound project: `list` searches via `POST /rest/api/3/search/jql` (the modern token-paginated replacement for the deprecated `search` endpoint), comment bodies and any `description` field are converted from plain text into a minimal `{type:'doc', version:1, content:[...]}` Atlassian Document Format document (and flattened back to plain text on read), and every request is composed purely from an injected `credential.baseUrl`, so the same backend works unmodified against both an OAuth-3LO-routed base (`https://api.atlassian.com/ex/jira/{cloudId}`) and a direct API-token site host. `create`/`update` each follow up with a `get` since Jira's own create/update responses don't carry the full issue (`{id, key, self}` only, and `204 No Content`, respectively).

Credentials come only from an injected `resolveCredential(connectionId): Promise<{baseUrl, authHeader}>`; this backend never runs a connect flow and never touches this package's own `keyring.ts`/`jira-connect.ts` directly.

`capabilities` reports `comments`/`labels: true`, `transitions`/`boards`/`sprints`/`milestones`/`customFields: false` for this slice. No transitions (#216), no boards/sprints (#217) ship here.
