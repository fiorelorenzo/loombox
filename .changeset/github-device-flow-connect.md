---
'@loombox/node': minor
---

Add the GitHub connect device flow (SPEC §7.26, issue #222)

`@loombox/node` gets the default GitHub connect path: `runGithubDeviceFlow` (`github-device-flow.ts`) runs RFC 8628's device authorization grant against `github.com` with a public OAuth App client id only (no client secret shipped or required — configurable per deployment via `LOOMBOX_GITHUB_CONNECT_CLIENT_ID`, `github-connect.ts`'s `resolveGithubConnectClientId`), requesting exactly `repo read:user read:org read:project`. It handles every real poll state — `authorization_pending` keeps polling at the server-given `interval`, `slow_down` increases it (honoring an explicit server `interval` or GitHub's documented +5s default), `expired_token`/`access_denied` end the flow with a named `GithubDeviceFlowError`, and an `AbortSignal` cancels it immediately rather than waiting out the current interval.

`resolveGithubIdentity` (`github-identity.ts`) resolves `GET /user` and rejects any response with no numeric `id` — never falls back to `login`. `GithubConnectService` (`github-connect.ts`) orchestrates both, writes the resulting token to this node's OS keyring (`keyring.ts`'s `NodeKeyring`, same abstraction and file-fallback as `mcp-secrets.ts`), and returns the metadata-only `ConnectedAccount` (issue #221) a caller announces through the existing `connected_account_announce` wire path — the token never appears in that returned value, in a log line, or in any error message.

No `gh` CLI import (#223), PAT paste (#224), Jira paths (#225, #226), per-project pinning (#227), node-presence computation (#228), or management UI (#230) ship here.
