---
'@loombox/node': minor
---

Add the tracker backend composition layer (SPEC §7.10, §7.26, issue #631)

`@loombox/node` gets `resolveTrackerBackend` (`tracker-backend-composition.ts`), the one entry point that turns a project's `TrackerMode` into a working `GithubTrackerBackend`/`JiraTrackerBackend` or a typed `TrackerBackendResolutionError`, closing the gap that left #213/#214/#220 unreachable from the UI: it looks `mode.connectionId` up in the connected-account registry, applies issue #227's per-capability account pin (`resolveAccountForRead`/`resolveAccountForWrite`, every hard-fail case mapped to its own error kind), requires the pin's answer to agree with `mode.connectionId` exactly (`connectionPinMismatch` — the mechanism that keeps one project's mode from ever resolving against a different project's pinned account), and only then resolves the credential through this node's keyring (`GithubConnectService.getAccessToken`/`JiraConnectService.getCredential`) — never any other source, and re-asked on every backend call so a revoked/rotated credential takes effect on the next request. A `{kind:'native'}` mode always resolves to `{ok:false, error:{kind:'nativeMode'}}`; composing a native-mode backend is not this module's job.

`jira-connect.ts`'s and `jira-tracker-backend.ts`'s independently-declared, structurally-identical `JiraCredential` interfaces are deliberately left unconverged — TypeScript already accepts one everywhere the other is expected, and introducing a shared third declaration would force both files to import it, reopening the "a tracker backend never imports a connect module" boundary their own tests guard, to save two five-line interfaces that already cost nothing at the call site.

Server-side only: this lives in `@loombox/node`, not in `apps/web`'s dependency graph. The bridge dispatch (`readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge`) and the Tracker page's error-state rendering are follow-up work against this module's exported `resolveTrackerBackend`/`TrackerBackendResolutionError`.
