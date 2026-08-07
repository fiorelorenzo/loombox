---
'@loombox/web': patch
---

Fix: `SettingsPage.svelte` never forwarded its `client` prop into `TargetStatusView`, the Nodes section it mounts (issue #862). `TargetStatusView`'s Reconnect/Update/Remove/Edit actions (issue #476) and Update node action (issue #656) are all gated on that prop being present, so all four were unreachable in production despite being fully implemented and covered by `TargetStatusView`'s own component tests, which always pass a client directly and so never exercised the mount site.

`SettingsPage`'s own `client` prop is now widened to `ConnectedAccountsClient & KeymapClient & TargetActionsClient` (same pattern its own doc comment already used for the first two) and forwarded straight through to `TargetStatusView`. Added a mount-site test in `SettingsPage.test.ts` that renders the Nodes section with a client, expands a row, and asserts the actions are present, so a future refactor that drops the prop again fails a test instead of silently disabling four actions.

Verified by driving Reconnect/Update/Remove/Edit and Update node in a real headless browser tab against the dev loop, not only in jsdom.
