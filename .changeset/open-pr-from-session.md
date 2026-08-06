---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/web': minor
---

Open a pull request from a session's own branch (SPEC §7.14, issue #238). `@loombox/protocol` gains `pr.ts`'s `pr_open_preview_request`/`_result` and `pr_open_request`/`_result` wire pair, routed session-scoped through the relay exactly like `permission_policy_get`/`_set` (the relay only ever forwards `sessionId`/`requestId` plus opaque `EncryptedEnvelope`s — never a branch name, commit count, PR title/body, or the created PR's URL).

`@loombox/node`'s new `pr-open.ts` runs `git`/`gh` on the session's own `ExecutionTarget` (`local` or `ssh:`), authenticated by that target's own already-signed-in `gh` CLI — deliberately not SPEC §7.26's connected-account registry (`GithubConnectService`), whose token lives in one node's OS keyring and cannot reach an `ssh:` target's `gh` invocation at all (`ExecOptions.env` is local-only) or add anything a target's own git-push credentials don't already provide for a `local` one. `previewPrOpen` is read-only (resolves the session's branch via `resolveSessionBranch`, issue #738; the repo's default branch via `gh repo view`; and the commit count ahead of it) and reports one of seven named failure categories (`no_branch` | `no_commits` | `gh_missing` | `gh_unauthenticated` | `repo_lookup_failed` | `push_failed` | `create_failed`) rather than one generic error, mirroring issue #750's `AcpMcpServerFailureCategory` precedent. `openPr` re-verifies that same preview immediately before it pushes the branch and runs `gh pr create` — the one point in the whole feature with a real side effect on the operator's own repository.

`apps/web`'s `RelayClient` gains `previewPrOpen`/`openPr`, and a new `PrOpenDialog.svelte` — reached from any session row's "⋯" menu ("Open pull request…"), alongside "Archive session…"/"Export transcript": an occasional, per-session action, not a permanent workbench sub-tab beside Files/Config/Runner (those stay relevant for a session's whole lifetime; opening a PR happens once, near the end). The dialog shows the preview (branch, base, commit count) the moment it opens, then only pushes and opens the PR once the operator has typed a title and clicked "Push & open pull request", surfacing the resulting URL or a distinct failure reason inline. No AI-drafted PR body here (issue #233's scope, not this one's).
