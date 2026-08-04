---
'@loombox/web': minor
---

Build the SPEC §7.26 connected-accounts Settings UI (issue #230), the Svelte-only remainder after #643 shipped the wire protocol/relay/node/client-API layer.

Settings gains an "Accounts" section (`ConnectedAccountsSection`), reachable in both the desktop sub-nav and the narrow segmented control:

- `ConnectedAccountsList` — a `Row`-based list mirroring `TargetStatusView`'s row/expansion/confirm pattern, rendering `label`/`avatarUrl`/`host`/`capabilities` from the real synced `ConnectedAccount` fields. `secretRef` is never rendered.
- `GithubConnectFlow` — a `Dialog` driving `RelayClient.startGithubConnect`'s device flow: the user code renders large, monospace, and selectable (with a copy button) as soon as it arrives, then a waiting state, then success/failure. Cancel calls the flow's own `cancel()`.
- `JiraConnectForm` — a three-field `Dialog` form (`siteUrl`/`email`/`apiToken`) over `connectJiraAccount`; a successful connect clears the form and stays open rather than closing, so a second/third Jira site adds a row instead of replacing one.
- Disconnect mirrors `TargetStatusView`'s `confirmingRemove` inline-bar pattern, with a generic warning that a pinned project may break (the full per-pin scan is issue #229).
- `AccountPinPicker` — the per-project, per-capability tri-state pin map (`getAccountPins`/`setAccountPin`/`unsetAccountPin`) as a real three-way `RadioGroup` (Unconfigured / Opted out / a specific account), plus a `resolveAccountPin` preview that renders `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as five distinct states with a concrete next step, never a raw error string.

Every account operation is node-scoped (connect/disconnect/pin storage all run on a specific node); the section carries one shared node picker, hidden when only one node is known.

`+page.svelte` passes `client`/`connectedAccounts` into `SettingsPage`, which gates the new "Accounts" nav entry on `client` being present, the same pattern `deviceId` already gates "Push" on.
