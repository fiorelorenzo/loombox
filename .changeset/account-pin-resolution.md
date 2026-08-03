---
'@loombox/node': minor
---

Add per-project, per-capability connected-account pin resolution (SPEC §7.26, issue #227)

`@loombox/node` gets `account-pin.ts`: a pure resolver over the tri-state `AccountPinMap` from SPEC §7.26 (`{ github?: string | null; jira?: string | null; [capability]: string | null | undefined }`) — an absent key means unconfigured, an explicit `null` means opted out, a string is a pinned `ConnectedAccount.id`. `resolveAccountForRead` and `resolveAccountForWrite` are two distinct functions (not one function plus a flag) so a caller cannot forget the difference: a write-back action always throws `AccountPinRequiredError` without an explicit pin, while a read may default silently only when exactly one candidate account matches, throwing `AmbiguousAccountError` for two or more. Both hard-fail with `AccountHostMismatchError` when a pinned account's decoded host/site (via `@loombox/protocol`'s `parseConnectedAccountId`, never string-slicing) doesn't match the project's configured target, mirroring emdash's `githubApiAccountHostMismatch` guard — never a silent fallback to a different account. `AccountPinDanglingError`/`AccountPinMalformedError` cover a pin naming an unknown or unparsable id.

`account-pin-store.ts` persists the map node-side as one JSON file keyed by `projectPath`, mirroring `permission-policy-store.ts`/`mcp-config-store.ts`'s existing per-project storage shape. `setPin`/`unsetPin` are deliberately separate operations (an explicit `null` opt-out vs. deleting the key back to unconfigured) so the tri-state survives a save/reload round trip intact.

No tracker backend, no wiring into a write-back call site, no management UI (#230), no safe-disconnect scan (#229), and no node-presence computation (#228) ship here — this is the resolution primitive those build on.
