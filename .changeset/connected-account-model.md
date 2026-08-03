---
'@loombox/protocol': minor
'@loombox/relay': minor
---

Add the `ConnectedAccount` data model and its relay metadata sync (SPEC §7.26)

`@loombox/protocol` gets `v1/connected-accounts.ts`: the provider-agnostic `ConnectedAccount` type, Zod-validated and registered in `schemasV1` field-for-field per spec (`id`, `provider`, `host`, `providerAccountId`, `label`, `avatarUrl`, `credentialSource`, `scopes`, `capabilities`, `connectedAt`, `updatedAt`, `secretRef`). `id` is derived, never free-form: `composeConnectedAccountId`/`parseConnectedAccountId` round-trip `provider:host:providerAccountId`, tolerant of a colon-bearing `host` (a GitHub Enterprise Server or Jira Data Center instance on a non-default port). `providerAccountId` rejects anything shaped like an email address for every provider, and additionally requires a numeric value for `github` (GitHub's own `GET /user` id). There is deliberately no `nodePresence` field: which node holds a given account's secret locally is computed lazily at the point of use (issue #228), never synced.

`@loombox/relay` wires the metadata row through its existing account-scoped sync path: a `ConnectedAccountStore` (in-memory and Postgres, new `connected_accounts` table), a node-only `connected_account_announce` message, and a client-only `connected_account_list_request`/`connected_account_list` pair, mirroring `target_announce`/`target_list_request` exactly. The synced row never carries a secret: `secretRef` only names a node-local OS-keyring entry (the same class of secret as SSH keys and MCP secrets), and the row is relay-readable plaintext by design, the same "account-scoped metadata" exception SPEC §8 already grants session existence and the device registry.

No connect flow ships here (GitHub device grant, `gh` CLI import, PAT paste, Jira token, Jira 3LO are issues #222-#226), no management UI (#230), no per-project pinning (#227), no node-presence computation (#228, referenced above).
