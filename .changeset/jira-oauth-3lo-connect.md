---
'@loombox/node': minor
---

Add `JiraOauthConnectService` (SPEC §7.26, issue #226): the Jira OAuth 2.0 (3LO) connect path, the upgrade over #225's API-token connect. Runs the documented redirect-code exchange and rotating-refresh-token flow against `https://auth.atlassian.com/oauth/token`, then calls `GET https://api.atlassian.com/oauth/token/accessible-resources` to discover every Jira site the grant covers — a 3LO token is not scoped to one site, and an Atlassian account commonly has more than one, so `discoverSites`/`connectSites` is a deliberate two-step split: discovery returns the full site list with nothing persisted, and the caller's chosen subset is what gets registered, one `ConnectedAccount` per site (`credentialSource: 'oauth_3lo'`, `scopes` populated from the token endpoint's own granted-scope list, never `null`).

Because every site an OAuth grant covers shares the exact same rotating token pair, the pair is stored once per Atlassian account rather than duplicated per site — duplicating it would mean refreshing under one site's copy silently invalidates the identical string stored under a sibling site. `getCredential` resolves through that shared secret and refreshes transparently near expiry; a refresh triggered while resolving one site is immediately visible to every sibling site's next call, with no second refresh (covered by its own test).

Deliberately out of scope for this PR: wiring `oauth_3lo` through `tracker-backend-composition.ts`'s live-mode gate (it still hard-rejects the credential source pending that follow-up) and the connect-flow UI (#230). Nothing here has been exercised against a real Atlassian OAuth app — see the PR description for exactly what that verification would need to confirm.
