---
'@loombox/node': minor
---

Add the lazy per-node connected-account presence check (SPEC §7.26 "Node-locality", issue #228)

`NodeAccountPresence` (`account-presence.ts`) answers "does this node's OS keyring currently hold a connected account's credential" — the local half of SPEC §7.26's node-locality gap: a `ConnectedAccount`'s metadata row syncs through the relay, but its secret lives in one node's keyring, so a second node can see the account and still not be able to use it. The check is computed lazily (never eagerly probed at startup) and cached per `secretRef` in memory; a connect or disconnect on this node invalidates the cached answer via a new `onCredentialChanged` hook both `GithubConnectService` and `JiraConnectService` now call. `isPresent` returns only a boolean — the credential value never leaves the keyring read that produces it.

`GithubConnectService` and `JiraConnectService` previously each built their own private `NodeKeyring` (same service name, different file-fallback filename). Extracted into `connected-account-keyring.ts`'s `createConnectedAccountKeyring`, which both connect services and `NodeAccountPresence` now share — necessary for correctness, not just DRY: on this devbox's file-fallback path (no OS keyring session), a presence check built from its own independent file would silently report every real account absent.

`account-pin.ts` (#227) gains `resolveAccountForWriteOnThisNode`, layered on top of the existing `resolveAccountForWrite` (unchanged, same hard-fail cases, same tests green) — throws the new `AccountNotPresentOnNodeError` when the resolved account is not present on this node, a distinct outcome from "no pin" (`AccountPinRequiredError`) and "dangling pin" (`AccountPinDanglingError`).

Not shipped here: the multi-node wire/UI flow that asks a _different_ node whether it holds a pin's secret (SPEC §7.26 frames that as reusing §7.21's node-health reachability channel) — this issue is scoped to the local, per-node computation only.
