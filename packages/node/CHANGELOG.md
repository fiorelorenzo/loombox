# @loombox/node

## 0.8.0

### Minor Changes

- 7b8e591: Per-project agent instructions surface (SPEC §7.18; issue #260)

  Surfaces and edits a project's own `AGENTS.md`/`CLAUDE.md` directly from the cockpit, read from and written back to the session's real worktree — not a new store, a read/write surface over a real file.

  - `@loombox/protocol`'s new `agent-instructions.ts` adds `agent_instructions_get_request`/`_response` (envelope-less request, mirrors `git_diff_request`) and `agent_instructions_set_request`/`_response` (enveloped on both sides, mirrors `git_hunk_action_request`). `agent_instructions_get_response`'s `files` array reports every one of `AGENTS.md`/`CLAUDE.md` that actually exists right now (0, 1, or both) — the client decides "offer to create" vs "let the user pick" from that list's length. The write side is optimistic-concurrency, not last-write-wins: every file state carries a `hash` (sha256 of its content), sent back as `baseHash` on save; a stale or missing `baseHash` comes back `outcome: 'conflict'` with what is actually on disk right now, never silently overwritten.
  - `@loombox/relay` routes the new pair exactly like the `fs_read_*`/`git_hunk_action_*` families — always blind to the envelope's contents.
  - `@loombox/node`'s new `agent-instructions.ts` reads and writes the files through the session's `ExecutionTarget` (works identically against a `local` or an `ssh:` target, the same seam `git-diff.ts` uses), with a `readdir` reachability canary distinguishing "worktree unreachable" from "file simply doesn't exist yet". `NodeDaemon` wires the two new handlers in exactly the same "decrypt, apply, always reply" / "no live bridge needed" shape as its `fs_read`/`git_hunk_action` siblings.
  - `@loombox/web`: `RelayClient` gains `getAgentInstructions`/`setAgentInstructions` (same "resolves either way, rejects only when unusable" contract as `readFile`/`applyGitHunkAction`). New `AgentInstructionsPanel.svelte` mounts in `ProjectConfigPanel`'s Config tab: both files are always offered as tabs, whether or not they exist yet (a missing file opens as an empty, clearly-labeled create draft, defaulting to `AGENTS.md`); a `'conflict'` save outcome shows what changed on disk and requires an explicit "Reload latest version" click before anything can be saved again.

  Verified: `pnpm --filter @loombox/protocol exec vitest run src/v1/agent-instructions.test.ts src/v1/message.test.ts` (30 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts src/message-routing.test.ts` (300 tests), `pnpm --filter @loombox/node exec vitest run src/agent-instructions.test.ts src/node-daemon-agent-instructions.test.ts src/node-daemon.test.ts` (98 tests — the first two new: a real temp-dir pure-module suite and a real relay/node/worktree wire round trip proving the conflict-safe write end to end), `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/AgentInstructionsPanel.test.ts src/lib/components/ProjectConfigPanel.test.ts` (190 tests), `pnpm --filter @loombox/{protocol,relay,node,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5086 passed, 1 pre-existing unrelated failure — `packages/providers/codex/src/codex-acp-capabilities.test.ts`, the known #158/#182 cross-branch mismatch already fixed on `main` via #834, which landed after this branch's base commit `e087fb9`; this branch never touches any `providers-codex`/`providers-core` file).

- edb3752: Agent auto-iterate-until-green loop (SPEC §7.14/§7.15; issue #246)

  Builds the loop that #239's CI check watcher hook feeds — `NodeDaemon.handleCiCheckFailure` calls `promptSession` once per new failure, but never decided whether it should, or when to stop:

  - `@loombox/node`'s new `CiAutoIterateController` (`ci-auto-iterate.ts`) is fully decoupled from `NodeDaemon`, mirroring `CiCheckWatcher`'s own style: `onFailure(sessionId, headSha, eligible)` decides whether a new CI failure actually drives a new agent turn, `onGreen(sessionId)` ends the loop and resets it the moment a poll reports `'passing'`, and `stopByUser(sessionId)` ends it immediately on request. A bounded `maxAttempts` (default 5) and a sticky user stop both refuse every further failure until a green check or a fresh PR watch (`reset()`); an ineligible session (paused, or over its SPEC §7.16 effective spend cap) is refused for THAT failure only, rechecked fresh on the next one.
  - `NodeDaemon.handleCiCheckFailure` now consults `isAutoIterateEligible` (session `'running'` and under its effective `SpendCapStore` cap) and the controller's decision before ever calling `promptSession` — never resuming a paused session, never spending past a spend cap. `onUpdate`'s `'passing'` branch feeds `onGreen`; `registerCiCheckWatch` resets the loop for every freshly-watched PR; session archival forgets it.
  - New wire pair: `ci_auto_iterate_status` (node-pushed, session-scoped, envelope-sealed — active/attempts/maxAttempts/stoppedReason plus a per-attempt history) pushed on every real decision, and `ci_auto_iterate_stop` (client, envelope-less, mirrors `run_cancel`) routed to the owning node exactly like `run_cancel`.

  Verified: `pnpm --filter @loombox/node exec vitest run src/ci-auto-iterate.test.ts src/node-daemon-ci-auto-iterate.test.ts src/node-daemon-ci-check.test.ts src/ci-check-watcher.test.ts src/ci-watch-store.test.ts` (45 tests, stubbed `fetch`/keyring only, no real network), `pnpm --filter @loombox/relay exec vitest run src/message-routing.test.ts` (151 tests), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5035 passed, 1 pre-existing unrelated `codex-acp-capabilities.test.ts` failure from the #158/#182 contract mismatch fixed on main by #834 after this branch was cut, 2 skipped).

- d2741e2: CI check status watcher (SPEC §7.14; issue #239)

  For a session whose branch has an open pull request (issue #238's `openPr`), the owning node now polls GitHub's check-runs API and surfaces the result back to the client, plus fires an auto-iterate hook into the agent on a new failure:

  - `@loombox/node`'s new `CiCheckWatcher` (`ci-check-watcher.ts`) is `TargetHealthSampler`'s sibling: same fixed-interval (60s), per-session registry, one-pass-at-a-time shape, but polling GitHub's REST API through an injected `resolveToken`/`fetchImpl` instead of an `ExecutionTarget` probe. Its own `FAILING_CONCLUSIONS` judges which of GitHub's check-run conclusions count as a real failure (`failure`/`timed_out`/`action_required`/`cancelled`) — an unrecognized future value is never treated as one. `ci-watch-store.ts` persists which sessions are being watched (one JSON file, mirroring `spend-cap-store.ts`), so a node restart re-registers every still-open PR's watch rather than silently dropping it.
  - Exactly-once-per-failure dedup, keyed on the failing state's own `headSha`: the first poll that observes `'failing'` for a commit fires the hook and remembers that sha; every later poll still red on the SAME sha stays silent, and the remembered sha clears the moment a poll stops observing `'failing'` (recovered, or the ref moved to a commit with no check runs yet) — so a later failure, even a re-run landing back on a previously-seen sha, fires again rather than staying suppressed forever.
  - `NodeDaemon.registerCiCheckWatch` starts a session's watch right after a successful `pr_open_request` (best-effort — a watch-registration failure never turns an otherwise-successful PR open into a reported failure). `NodeDaemon.resolveCiCheckGithubToken` is the watcher's only source of a bearer token, reusing SPEC §7.26's connected-account pin resolution (`resolveAccountForRead`) exactly like `resolveTrackerBackend`'s own GitHub branch — `github.com` only, and an ambiguous/absent/opted-out pin degrades the watched session to `'unknown'`, never an error.
  - New wire message `ci_check_status`: session-scoped and envelope-sealed exactly like `run_output`/`pr_open_result` (the relay only ever sees `sessionId` and ciphertext, never a check's name, conclusion, or failure output), pushed after every completed poll pass, whatever the resulting state.
  - The auto-iterate hook (`NodeDaemon.handleCiCheckFailure`) feeds a new failure straight back into the session via `promptSession`, listing every failing check run's name/conclusion/output summary. This is only the hook: driving the resulting turn to a genuinely green re-run (deciding when to stop, re-watching the next poll) is issue #246's job, not this one's.

  Verified: `pnpm --filter @loombox/node exec vitest run src/ci-check-watcher.test.ts src/ci-watch-store.test.ts src/node-daemon-ci-check.test.ts` (29 tests, stubbed `fetch`/keyring only, no real network call), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (4838 tests; one pre-existing, unrelated `apps/web` async-highlighter flake, confirmed passing in isolation).

- 4e090fc: Codex inline base64 image hand-off (SPEC §7.25 "Hand off to the agent"; issue #158)

  An image attached in the composer now reaches a live agent turn as a real ACP `ContentBlock::Image`, not just as `blob_ref` metadata:

  - `@loombox/providers-core` gains `buildInlineImageContentBlock`, the one capability-gated inline base64 builder both `@loombox/providers-claude`'s `buildClaudeImageContentBlock` and `@loombox/providers-codex`'s `buildCodexImageContentBlock` now re-export under their own adapter-named symbol — SPEC.md §7.25 confirms both adapters' real ACP bridges build the identical `data:`-style block, so unifying the two previously-duplicated implementations follows the spec's own "unified, not special-cased" language rather than inventing a new shape. The builder checks capability, then a 10 MB size cap (`MAX_INLINE_IMAGE_BYTES`, overridable per call), then re-sniffs the bytes against the four supported formats, returning a typed `{ ok: true, block }` / `{ ok: false, reason }` result instead of `undefined` — a caller can now tell "capability not negotiated" apart from "oversize" apart from "unsupported format."
  - `AcpClient.prompt()` and `AgentSession.prompt()` both grew an `extraContent: AcpPromptContentBlock[]` parameter (default `[]`, every existing plain-text caller unaffected) appended after the required text block. `AgentSession.getFeatureFlags()` exposes the session's negotiated `AcpFeatureFlags` (including `supportsImages`) the same way `configOptions`/`availableCommands` already do.
  - `@loombox/node`'s `NodeDaemon.deliverPrompt` runs each resolved attachment through `buildInlineImageContentBlock`, gated on `agentSession.getFeatureFlags().supportsImages`, and appends a successful build to the turn's content blocks. A declined hand-off (capability not negotiated, oversize, or unsupported format) never blocks the turn — it emits a new `'attachment_handoff_declined'` event for observability and the prompt still reaches the agent as text, exactly as before this issue.

  Verified: `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor test -- --run` (all green; one unrelated pre-existing timing-sensitive test in `attachments-e2e.test.ts`'s bounded-queue describe block flaked once under full-suite parallel load with its default 5s timeout and passed cleanly on every isolated/solo run), `pnpm --filter @loombox/providers-core --filter @loombox/providers-claude --filter @loombox/providers-codex --filter @loombox/node --filter @loombox/supervisor typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

  No real `codex` binary is installed on this box (`which codex` fails), so the exact payload shape Codex expects is proven against `codex-like-acp-agent.mjs`, a hermetic fixture agent driven over a real JSON-RPC/stdio child process (`packages/providers/codex/src/conformance.test.ts` and the two new `packages/node/src/attachments-e2e.test.ts` cases) — not against a real Codex install. The real `codex-acp` bridge's `promptCapabilities.image` advertisement itself is still unconfirmed against a live binary (tracked separately, issue #54).

- e42b8d1: Commit graph / branch tree view (SPEC §7.6; issue #231): a read-only view of one ref's commit history for a session's repo, working identically on `local` and `ssh:` targets.

  - `@loombox/protocol`'s new `git-graph.ts` (`git_graph_request`/`git_graph_response`) is enveloped like `git_branch_create_request` (a real caller-chosen filter — `ref`/`limit`/`offset`), unlike `git_diff_request`'s own no-content "asking" shape. Documents the paging decision this issue's own size constraint forces: measured `--skip`/`--max-count` against a 120,000-commit synthetic history and rejected the alternative (a sha-keyed O(1) resume cursor) because it is provably incorrect for a ref whose history contains a merge commit — exactly this issue's own acceptance shape.
  - `@loombox/node`'s `git-diff.ts` gains `computeCommitGraph`, parsing `git log --pretty=format:` explicit fields (never `--graph`'s ASCII art) with `\x1f`/`\x1e` control-character separators, resolving `ref` via `git rev-parse --verify` first (a bad ref reports cleanly, and `git log` itself never receives a caller-controlled string). An unborn `HEAD` resolves to an empty graph, never an error, mirroring `listBranches`'s identical contract.
  - `@loombox/relay` routes `git_graph_request`/`_response` exactly like `git_diff_request`/`_response` — the relay never learns a ref, commit message, author, or sha.
  - `@loombox/web`: `RelayClient.requestCommitGraph`, `CanvasTabsState`'s new singleton `graph` tab (paging via `appendGraphPage`, mirroring `openDiff`'s own tab lifecycle), and `CommitGraphViewer.svelte` — a dumb, read-only view (`+page.svelte` owns the fetch) rendering short sha, subject, author, relative date, a merge badge for any 2+-parent commit, a HEAD badge, and every branch/tag decorating a commit, with a "Load more" affordance. New `git-graph` icon. Reachable from the Files panel's sidebar (`Commit graph` button, beside `Working tree diff`).

  Verified: `pnpm --filter @loombox/protocol exec vitest run src/v1/git-graph.test.ts` (20 tests), `pnpm --filter @loombox/node exec vitest run src/git-diff.test.ts src/node-daemon-git-graph.test.ts` (67 + 5 tests, including a real temp repo with a merge commit, two diverged branches, and a detached HEAD, and a paging-across-the-boundary test proving concatenated pages equal the real full `git log` output exactly), `pnpm --filter @loombox/relay exec vitest run src/message-routing.test.ts` (179 tests) plus the full relay suite (528 tests), `pnpm --filter @loombox/web exec vitest run src/lib/tabs.test.ts src/lib/components/CanvasTabStrip.test.ts src/lib/components/CommitGraphViewer.test.ts src/lib/components/icons src/lib/relay-client.test.ts` (301 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

  Not yet done: a real-browser Playwright spec proving the view at the 390px mobile floor (the CSS itself follows this codebase's own established narrow-viewport conventions — `min-width: 0` down the flex chain, `flex-wrap` on the badge row, `overflow-wrap: break-word` on the subject line — and is unit-tested for correct rendering, but not yet measured against a real rendered box the way `spend-report-mobile.spec.ts`/`tracker-mobile.spec.ts` prove their own surfaces).

- 8948531: Commit workflow with AI-generated commit messages (SPEC §7.6; issue #233)

  Builds on #232's hunk-level staging: the index is now something a user can actually curate, so this is the next step — commit what's staged, with a message drafted from the staged diff.

  - `@loombox/protocol`'s new `git-commit.ts` adds `git_commit_draft_request`/`git_commit_draft_response` (read-only, envelope-less request mirroring `git_hunk_diff_request`, enveloped reply) and `git_commit_request`/`git_commit_response` (enveloped, mutating, mirrors `git_hunk_action_request`). `@loombox/relay` routes both exactly like their `git_hunk_*` siblings — the relay never sees the staged diff, the drafted message, or the final commit message in the clear.
  - `@loombox/node`'s new `git-commit.ts` adds `computeStagedDiffText`/`commitStaged` (real `git diff --cached`/`git commit -F -` through `ExecutionTarget.exec`, works identically against a `local` or an `ssh:` target) and `buildCommitDraftPrompt`. Message generation happens in `NodeDaemon.draftGitCommitMessageForBridge`/`draftCommitMessageViaAgent`, which prompts the session's OWN live `AgentSession` (never a new, separately-configured provider call — the issue's own constraint) and captures the resulting turn's text as the draft; a session with no live agent, or nothing staged, reports a clear `outcome: 'error'` instead. `commitStaged` refuses an empty index or an empty message with a clear `GitCommitError`, never a silent no-op.
  - `@loombox/web`: `WorktreeDiffViewer`'s staging surface gains a "Commit staged changes" button (disabled until at least one hunk is staged), opening the new `CommitDialog` — mirrors `PrOpenDialog`'s own "auto-load on open, only an explicit click acts" two-phase split, except the auto-loaded step is the AI draft itself. The draft is purely advisory: nothing is committed until the "Commit" click, and an unedited textarea sends the draft verbatim while an edited one sends whatever text is currently there.

  Verified: `pnpm --filter @loombox/node exec vitest run src/git-commit.test.ts src/node-daemon.test.ts` (10+97 tests, including a real temp-git-repo suite for `commitStaged`/`computeStagedDiffText` and a node-daemon suite proving the draft-then-explicit-confirm flow over the real wire with a live agent, an empty index refused with a clear reason, and no commit until the operator confirms), `pnpm --filter @loombox/protocol exec vitest run` (719 tests), `pnpm --filter @loombox/relay exec vitest run` (490 tests, plus `message-routing.test.ts`'s exhaustiveness check), `pnpm --filter @loombox/web exec vitest run src/lib/components/CommitDialog.test.ts src/lib/components/WorktreeDiffViewer.test.ts` (11+25 tests) and the full web suite (1879 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5076 tests; 1 pre-existing failure in `packages/providers/codex/src/codex-acp-capabilities.test.ts` unrelated to this change, already fixed on `main` in #834 after this branch was cut).

- 3dcb133: Branch create/switch/merge and stash save/pop (SPEC §7.6; issue #234)

  Extends the git-management surface (issues #206/#232) with branch and stash primitives: create/switch/merge a branch, and stash save/list/pop/drop.

  - `@loombox/protocol`'s new `git-branch.ts` (`git_branch_list_request`/`_response`, `git_branch_create_request`/`_response`, `git_branch_switch_request`/`_response`, `git_branch_merge_request`/`_response`, `git_branch_merge_abort_request`/`_response`) and `git-stash.ts` (`git_stash_save_request`/`_response`, `git_stash_list_request`/`_response`, `git_stash_pop_request`/`_response`, `git_stash_drop_request`/`_response`) add nine message pairs, mirroring `git_diff_request`/`git_hunk_action_request`'s existing envelope conventions (no envelope on a pure "ask"/"abort", enveloped for anything carrying a branch name, start point, or stash message). `@loombox/relay` routes every one exactly like its `git_diff_*`/`git_hunk_*` siblings — the relay never learns a branch name, a stash message, or which files conflicted.
  - `@loombox/node`'s `packages/node/src/git-diff.ts` gains `listBranches`/`createBranch`/`switchBranch`/`mergeBranch`/`abortMerge`/`listStashes`/`stashSave`/`stashPop`/`stashDrop`, driving real `git` subcommands through the same `ExecutionTarget.exec` seam this file already established (works identically for a `local` or an `ssh:` target). Three failure modes get honest, actionable outcomes instead of a swallowed error: `GitDirtyWorktreeError` (switching would overwrite real local changes, with the actual conflicting paths parsed from git's own stderr), `GitMergeConflictError`/`GitStashPopConflictError` (a real merge or stash-pop conflict, with the actual unmerged paths from `git diff --name-only --diff-filter=U` — a failed pop keeps the stash entry, nothing is lost). `NodeDaemon`'s bridge layer additionally refuses `switchBranch`/`createBranch`'s checkout path with a `session_branch_fixed` outcome for a worktree-isolated session, before touching git at all — that session's branch never moves for its whole life, and switching it would silently break `resolveSessionBranch`'s cached report and `SessionManager.removeSession`'s own teardown.
  - `@loombox/web`: `RelayClient` gains nine matching methods (`requestBranches`, `createBranch`, `switchBranch`, `mergeBranch`, `abortBranchMerge`, `saveStash`, `requestStashes`, `popStash`, `dropStash`), each resolving the node's own outcome — including `dirty_worktree`, `session_branch_fixed`, `conflict`, and a kept stash — rather than throwing. New `GitBranchPanel.svelte` component renders branch list/create/switch, merge with a conflict banner and Abort action, and stash save/list/pop (with a "stash kept" conflict banner) /drop; self-contained (owns its own relay calls and loading/error state, `DiscardHunkDialog`'s own DI pattern), not yet wired into the canvas tab strip.

  Verified: `pnpm --filter @loombox/node exec vitest run src/git-diff.test.ts src/node-daemon-git-branch.test.ts` (62 tests against real temp git repos, covering every operation and every named failure mode — dirty worktree, merge conflict + abort, a stash that cannot pop — asserting real resulting git state), `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/GitBranchPanel.test.ts` (173+16 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5148 tests, 2 pre-existing skips, all green after rebasing onto the #834 fix already on `main`).

- 93c1ffd: Hunk-level git stage/unstage/discard (SPEC §7.6; issue #232)

  The working-tree diff tab (issue #206) gains a staging surface: per-file staged/unstaged hunk breakdown, with per-hunk stage, unstage, and discard.

  - `@loombox/protocol`'s new `git-hunks.ts` adds the `git_hunk_diff_request`/`git_hunk_diff_response` (read-only, envelope-less, mirrors `git_diff_request`) and `git_hunk_action_request`/`git_hunk_action_response` (enveloped, mutating) message pairs. `@loombox/relay` routes both exactly like their `git_diff_*` siblings — the relay never sees a path, a hunk's content, or which action was taken.
  - `@loombox/node`'s `packages/node/src/git-diff.ts` adds `computeHunkDiff` (parses per-file `git diff --cached`/`git diff` output into `GitHunkV1[]`, with a synthetic single hunk for an untracked file) and `applyGitHunkAction` (extracts exactly the addressed hunk into a standalone one-hunk patch and drives it through `git apply --cached`/`--reverse` — the same mechanism `git add -p` itself uses; an untracked file's hunk is special-cased to `git add`/`git clean` since it has no `git diff`-derived patch to extract). Both work identically against a `local` or an `ssh:` target.
  - `@loombox/web`: `WorktreeDiffViewer` gets a Diff/Stage changes surface toggle. The staging surface lists each changed file's staged and unstaged hunks (reusing `DiffViewer`'s own `.diff-lines` line rendering), with Stage/Unstage applying immediately and Discard routed through the already-designed `DiscardHunkDialog` confirmation (destructive, unrecoverable — the dialog names exactly what is about to be lost, matching `ArchiveSessionDialog`/`CheckpointRestoreDialog`'s own confirmation pattern). `tabs.svelte.ts`'s `CanvasTabsState` gained a `hunkViewer` field alongside the existing `diffViewer` on the same diff tab (issue #737's tab strip) — not a second tab.

  Verified: `pnpm --filter @loombox/node exec vitest run src/git-diff.test.ts src/node-daemon.test.ts` (26 tests against a real temp git repo covering stage/unstage/discard, a multi-hunk file, a partially staged file, deletion hunks, untracked files, and every error path, plus the 4 pre-existing daemon wiring tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/WorktreeDiffViewer.test.ts src/lib/components/DiscardHunkDialog.test.ts src/lib/relay-client.test.ts src/lib/tabs.test.ts` (225+23+10 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (4898 tests, 2 pre-existing skips, all green).

- c8a9381: Push workflow (SPEC §7.6/§7.14; issue #235)

  Closes the create/switch/merge/stash/commit chain (#234/#232/#233): pushing a session's own branch to its remote, the first operation in the whole git-management surface that talks to a remote at all.

  - `@loombox/protocol`'s new `git-push.ts` adds one message pair, `git_push_request`/`_response`, enveloped (carries `force: boolean`) exactly like `git_branch_switch_request`. Six outcomes instead of one generic failure: `ok` (with `setUpstream`/`forced`), `no_branch` (detached HEAD/non-git, mirrors `pr-open.ts`'s `previewPrOpen`), `rejected_non_fast_forward`, `rejected_stale_lease`, `auth_failed`, `error`. `@loombox/relay` routes it exactly like its `git_branch_*`/`git_stash_*` siblings — the relay never learns the branch name or the push outcome, only ciphertext.
  - `@loombox/node`'s `packages/node/src/git-diff.ts` gains `pushBranch`, driving real `git push` through the same `ExecutionTarget.exec` seam this file already established (works identically for a `local` or an `ssh:` target). Always passes `--set-upstream origin <branch>` (idempotent — satisfies "sets upstream tracking on first push" unconditionally, no separate step). `force: true` uses `--force-with-lease`, never plain `--force`: it still refuses when this worktree's own knowledge of the remote ref is stale (`GitPushStaleLeaseError`, distinct from an ordinary `GitPushNonFastForwardError`), so a force push here can never silently discard a commit this worktree never observed. `GitPushAuthenticationError` for a remote that refuses the connection or the credentials themselves. Credentials reuse `pr-open.ts`'s (#238) own seam exactly — every push runs through the session's `ExecutionTarget`, authenticated by whatever that target's operator already has configured there (SSH agent, git credential helper), never a second relay-mediated path, per SPEC §8's SSH-credential rule.
  - `@loombox/web`: `RelayClient` gains `pushBranch`, resolving every named outcome rather than throwing. New Push section in `GitBranchPanel.svelte` — a Push button, a success note (upstream/forced), and a rejection banner with a "Push (force)" action, distinguishing a stale-lease refusal ("fetch, then retry") from an ordinary non-fast-forward rejection ("fetch and merge/rebase, or force").

  Verified: `pnpm --filter @loombox/node exec vitest run src/git-diff.test.ts src/node-daemon-git-push.test.ts` (61 tests, including 7 against a real temp git repo with a real local bare remote covering clean push + upstream tracking, a real rejected non-fast-forward from an actual second clone's diverging push, a stale-lease force refusal that only succeeds after fetching, and a hermetic `GIT_SSH_COMMAND`-intercepted auth failure — no network), `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/GitBranchPanel.test.ts` (207+21 tests), `pnpm --filter @loombox/relay exec vitest run` (528 tests, including `message-routing.test.ts`'s exhaustiveness check), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5364 passed, 2 skipped, 1 pre-existing unrelated flake in `node-daemon-spend-cap.test.ts` — a `/tmp` worktree-cleanup race under parallel load, confirmed passing in isolation and untouched by this change).

- 12cc8ec: Load and concurrency-limits UI (SPEC §7.16; issue #255)

  Surfaces what the node already knows about its own load and per-target concurrency, and makes a queued session's wait explicable rather than indistinguishable from "slow".

  - `@loombox/protocol`'s `targetDescriptor`/`targetListEntry` gain optional `maxConcurrentSessions`/`maxConcurrentSessionsSource` (`'configured' | 'default'`) — additive, exactly like `loadPercent`/`hostname` before them: an older node/relay simply omits them.
  - `@loombox/node` computes and forwards both fields in `target_announce`, straight off `SessionConcurrencyGate.maxFor` and whether the operator actually set `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS`/`localMaxConcurrentSessions` (or, for an `ssh:` target, its own `SshTargetConfig.maxConcurrentSessions`) versus the node's own computed default.
  - `@loombox/relay` forwards the same two fields verbatim from a node's announce into `target_list`'s `TargetListEntry`, exactly like `providers`.
  - `@loombox/web`: a queued session's row badge now reads its own wait context ("Queued: waiting for a slot", or "Queued: position N of M waiting for a slot" when more than one session is queued on the same target) instead of a bare "Queued" indistinguishable from "starting slowly" — computed client-side (`target-concurrency.ts`) from data already on the wire (each session's `nodeId`/`targetId`/live status/its transition timestamp, via the new `RelayClient.statusUpdatedAtFor`), no new wire message needed for the position itself. Settings > Nodes (`TargetStatusView.svelte`) now shows each target's `running/cap` slot count, the cap's honest source, and a queued-count badge when nonzero, right next to the existing load/RAM/disk readings.

  Verified: `pnpm --filter @loombox/protocol build` (typecheck), `pnpm --filter @loombox/node exec vitest run src/node-daemon-target-concurrency-announce.test.ts src/session-concurrency-gate.test.ts src/node-daemon-target-providers.test.ts` (18 tests), `pnpm --filter @loombox/web exec vitest run src/lib/target-concurrency.test.ts src/lib/components/TargetStatusView.test.ts src/lib/components/pages/SettingsPage.test.ts src/routes/page.test.ts` (163 tests), `pnpm --filter @loombox/web exec playwright test tests-e2e/target-concurrency-mobile.spec.ts` (2 tests, real relay/node/browser, 390px viewport), full `pnpm test` (5365 passed, 2 skipped, 442 files), `pnpm --filter @loombox/{node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, full `pnpm format:check`.

- 9a47212: Versioned JS bundle for the node runtime, and its install layout (SPEC §16; issue #817, decision A1-2)

  `pnpm bundle:node`/`pnpm bundle:supervisor` produce a self-contained esbuild bundle for each package (`node-pty`/`@napi-rs/keyring` external, their prebuilt binaries copied beside the bundle), and `pnpm package:node-release` packages both into the versioned release shape:

  - `scripts/lib/bundle-package.mjs` bundles `format: 'esm'`, `platform: 'node'`, with a `createRequire`/`__dirname`/`__filename` banner — without it, esbuild's own CJS-interop shim for a bundled CJS dependency's `require()` (`ssh2` calls `require('net')` and reads `__dirname` internally) throws `Dynamic require of "net" is not supported` the moment the bundle runs with no ambient `require`, which every copied-out standalone bundle has. `bakeBuildCommit: true` now actually works: `build-identity.ts`'s `readNodeBuildIdentity()` read `LOOMBOX_BUILD_COMMIT` through an aliased `env` variable, invisible to esbuild's `define`, so a baked bundle was silently falling through to a real (always-failing, no checkout present) `git rev-parse` at runtime; it now reads the literal `process.env.LOOMBOX_BUILD_COMMIT` expression `define` can actually replace. `readOwnVersion()` also now checks its own bundle directory for `package.json` before the dev-checkout's "one directory up", matching the bundle's flat layout.
  - New `packages/node/src/install-layout.ts`: resolve/stage/activate/rollback for `~/.loombox/versions/<version>/` + a `current` symlink, mirroring `scripts/deploy-prod.sh`'s proven `releases/<sha>` + `releases/current` shape (`ln -sfn`, no invented mechanism). Two drivers behind one interface — `createLocalInstallLayoutDriver()` (real `node:fs`, for a machine installing its own node) and `createRemoteInstallLayoutDriver()` (a `RemoteTransport`, ready for the ssh path), both exercised in `install-layout.test.ts` including a real second-version-beside-the-first flip-and-rollback.
  - New `packages/node/src/ssh/local-fs-artifact-source.ts`: a real, working `SupervisorArtifactSource` backed by a local directory tree — a GitHub Releases fetch is a follow-up (out of reach from this pass), so this is what actually satisfies the interface today, not a stub. `apps/desktop`'s `provision-target-bridge.ts` now wires a real `resolveSupervisorArtifactDeps()` (pinned Ed25519 public key + this source + `@loombox/supervisor`'s own version); `resolveProvisionTargetDeps()` still returns `undefined` — honestly, not the artifact half's fault — because the resident-node relay/identity config it also needs has no source until #398/#399 land.
  - `scripts/package-node-release.mjs` + `.github/workflows/release-node.yml`: packages both artifacts on every `vX.Y.Z` tag (linux-x64 + darwin-arm64, the two `RemoteOsArch` values this codebase recognizes), signing the supervisor artifact with `SUPERVISOR_SIGNING_KEY` when set (`scripts/generate-supervisor-signing-key.mjs` generates the keypair).

  Verified: copied `packages/node/dist/` to a directory with no monorepo and no other `node_modules`, ran it with a stripped `PATH`-only env — `node node.mjs --version` prints `{"version":"0.7.0","commit":"<real HEAD sha>"}` with no `.git` anywhere reachable and no `LOOMBOX_BUILD_COMMIT` set at runtime; a plain `node node.mjs` loads the entire module graph (ssh2, node-pty, keyring) and fails only on missing `LOOMBOX_RELAY_URL`/etc, never a module-resolution error. `pnpm --filter @loombox/node exec vitest run` (115 files, 1260 passed), `pnpm --filter @loombox/desktop exec vitest run` (9 files, 36 passed), the new `scripts` vitest project (`pnpm exec vitest run --config scripts/vitest.config.ts`, real end-to-end bundle build + standalone run), `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/desktop typecheck`, `pnpm exec eslint` on every touched file, full `pnpm format:check`.

- 9400cb4: Local test runner joins the PR/CI loop and the attention inbox (SPEC §7.14/§7.15; issue #247)

  The runner (#245), the CI check watcher (#239), the auto-iterate loop (#246), and the inbox's `ci_failure` class (#243) existed as four separate pieces. This wires a local run into the exact same loop and the exact same inbox a remote CI result already uses, so a failing change tells one story regardless of which side observed it first.

  - New wire message `run_status` (`@loombox/protocol`'s `run-status.ts`): the node's own durable per-kind (`test`/`lint`/`build`) run outcome for a session, the runner's sibling of `ci_check_status` — node-pushed, session-scoped, envelope-sealed, aggregating to `'unknown'`/`'passing'`/`'failing'`. `@loombox/shared`'s new `isFailingRunOutcome` (a run's outcome is `'fail'`/`'could_not_start'`) is the runner's own `isFailingCiConclusion` sibling, shared between the node and the browser so both name the same runs as failing.
  - `@loombox/node`'s new `RunStatusTracker` (`run-status-tracker.ts`) is `NodeDaemon.executeRun`'s own latest-outcome memory, updated from every exit path (a policy denial, an unsafe run id, and a real `run_exit` alike) right alongside the existing `sendRunExit`, and pushed as `run_status`.
  - A failing run also drives `CiAutoIterateController` — the SAME controller/session record a CI failure already drives, sharing one attempt count/bound per session rather than two separate loops. The real risk this issue calls out: a CI failure and a local runner failure for the SAME underlying commit must not drive two agent turns. `@loombox/node`'s new `AutoIterateDriveGate` (`auto-iterate-drive-gate.ts`) is the shared cross-source dedup both `NodeDaemon.handleCiCheckFailure` and the new `driveAutoIterateFromRunFailure` consult before ever calling `ciAutoIterateController.onFailure`, keyed on the failing commit's own head sha (`@loombox/node`'s new `workspace-head.ts`'s `resolveWorkspaceHeadSha`, the runner's own `resolveSessionBranch` sibling) — whichever source observes a given sha first drives; the other's own failure for that identical sha still updates its own status/inbox item, it just never fires a second `promptSession` turn. The gate's lifetime is tied to the controller's own active-loop lifetime (cleared alongside `reset()`/`onGreen()`/`forget()`), never CI's own shorter-lived per-poll dedup.
  - `@loombox/web`'s `RelayClient.attentionInbox()` gets a new `'run_failure'` class — the exact sibling of `'ci_failure'` (same base `AttentionInboxItem` shape: `sessionId`/`sessionTitle`/`projectPath`/`nodeId`/`waitingSince`, plus its own `failingRuns` alongside `ci_failure`'s `failingChecks`/`prUrl`/`prNumber`), built from `run_status` the same "durable until it clears, never a second guess" way `ci_failure` is built from `ci_check_status`. Independent of `ci_failure`, `awaiting_input`, and `session_outcome`: a session can carry any combination at once. `AttentionInbox.svelte` renders it with its own `'Run'` badge.

  Verified:

  - `pnpm --filter @loombox/node exec vitest run src/workspace-head.test.ts src/auto-iterate-drive-gate.test.ts src/run-status-tracker.test.ts src/node-daemon-run-ci-loop.test.ts src/node-daemon-ci-auto-iterate.test.ts src/node-daemon-ci-check.test.ts src/node-daemon-test-runner.test.ts src/test-runner-process.test.ts src/test-runner-config-store.test.ts` (250 tests, real local `sh -c`/git subprocesses only, no real network)
  - `pnpm --filter @loombox/shared exec vitest run src/run-status.test.ts` (2 tests)
  - `pnpm exec vitest run apps/web/src/lib/relay-client.test.ts apps/web/src/lib/components/AttentionInbox.test.ts` (218 + 32 tests, real in-process relay only)
  - `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm --filter @loombox/web typecheck` — all clean
  - `pnpm exec eslint` on every changed/new file — no errors
  - the full `pnpm format:check` — clean
  - the full `pnpm test` (touched `@loombox/protocol`) — 445 files passed, 1 pre-existing unrelated skip, 5379 tests passed, 2 skipped, 0 failures

- 05f8339: Linux namespace/bind-mount sandboxing for a `local` session's agent process (SPEC §7.17; issue #257)

  A `local` session's agent process can now be confined to the session's own worktree on Linux, without root, via `bwrap` (bubblewrap):

  - `@loombox/node`'s new `linux-sandbox.ts` is the bare primitive: `detectSandboxCapability()` runs a real, functional self-test (unshares a user+mount namespace, bind-mounts `/usr` read-only, execs `/usr/bin/true` inside it) rather than trusting `bwrap --version`, which would still report success on a kernel that refuses unprivileged user namespaces entirely. `buildBubblewrapArgv()`/`sandboxCommand()` build the sandboxed root up from nothing (only `/usr`, `/etc`, `/proc`, a fresh `/dev`/`/tmp`, and the caller's explicit mounts exist inside it) — a path never bind-mounted gets `ENOENT`, not a permission error. `sandboxCommand()` throws `SandboxUnavailableError` rather than ever returning a "wrapped"-looking command that is actually unsandboxed (fail-closed).
  - The self-test itself is built from the exact same `buildBubblewrapArgv()` production uses (rather than a narrower hand-rolled argv), which fixed a real false negative found while testing this on the project's own dev box: a merged-`/usr` distro's `/usr/bin/true` needs its ELF interpreter at a top-level path like `/lib64/ld-linux-x86-64.so.2`, which the old narrower self-test never created inside the sandbox, so it reported `available: false` on the majority of real Linux desktops/servers even though sandboxing works perfectly there.
  - New `session-sandbox.ts`'s `resolveSessionSandbox()` is the integration layer: on Linux (where SPEC requires sandboxing) it either returns a working `wrapSpawnConfig` hook or throws `SandboxUnavailableError` — refusing the session rather than running it unconfined; on any other platform (macOS today) it returns `required: false` and no hook, since SPEC's documented weaker macOS fallback isn't built yet. It also auto-discovers and read-only-mounts a version-manager-installed agent CLI's toolchain root (mise/nvm/volta/homebrew all live outside `/usr`) so a real `npx`/`omp`-launched provider can actually exec inside the sandbox, not just a `/usr`-rooted one — verified against the real `claude`/`omp` binaries installed on the project's own dev box, each completing a real ACP `initialize`/`session/new`/prompt turn inside `bwrap`. Getting there took two real, verified fixes along the way: (1) mounting only a resolved symlink's final target missed that `bwrap`'s own `execvpe` re-does its `PATH` search fresh inside the sandbox and needs the ORIGINAL `PATH`-resolved location visible too — real `npx` is exactly this shape (`<node-root>/bin/npx` is a _relative_ symlink to `../lib/node_modules/npm/bin/npx-cli.js`); (2) a command resolving through `/bin`/`/sbin` could make the "walk up through a `bin/` parent" heuristic compute `/` itself as a mount root, which would have `--ro-bind`ed the entire host filesystem — caught by a real spawned-child containment test failing, not by inspection.
  - `@loombox/providers-core`'s new `SandboxedSpawnConfig`/`markSandboxed()` are a type-level proof a spawn config really was wrapped: `@loombox/supervisor`'s new `AgentSupervisorStartOptions.wrapSpawnConfig` hook is typed to return `SandboxedSpawnConfig`, not a plain `AcpSpawnConfig`, so a caller cannot pass a no-op `(config) => config` and have it typecheck as "sandboxed".
  - `NodeDaemonOptions.sessionSandbox` wires it into `launchLocalSession` — off by default for `NodeDaemon`/`createNode` built directly (same shape as `resourceSampling`, and for the same reason: turning it on unconditionally would wrap every existing test's fixture-agent spawn in `bwrap` too, and most fixtures point outside the session worktree by design). `main.ts`'s real `createNode()` call turns it on for every real node, gated by a new operator kill switch: `NodeCliConfig.sandboxEnabled` (`LOOMBOX_SANDBOX=off`/the config file's `sandboxEnabled: false`, defaulting to `true`) lets a resident node's operator disable sandboxing without a code change if `bwrap`/userns ever becomes unexpectedly unavailable on that host — `main.ts`'s `start()` logs a loud, unmissable warning at startup whenever the override actually turns it off, so this can never be a silent reason sessions run unconfined. `ssh:` sessions are never sandboxed by this (the agent runs on the remote target machine, whose mount namespace this process can't touch) — `launchReservedSshSession` keeps working exactly as before.
  - Known, verified cost (not a failure): an `npx`-launched provider's package cache doesn't persist across sandboxed sessions (`npm`'s cache dir isn't mounted; `npx` re-downloads over the network — allowed via `--share-net` — into a fresh, ephemeral cache every session). Filed as its own follow-up: fiorelorenzo/loombox#831.

  Verified: `pnpm --filter @loombox/node exec vitest run src/linux-sandbox.test.ts src/session-sandbox.test.ts src/node-daemon-sandbox.test.ts src/config.test.ts src/main.test.ts` (104 tests total — including real `bwrap`-spawned child processes proving containment, a real ACP handshake completing through a sandboxed child, both real bugs above reproduced with fakes as regression tests, and the new kill-switch env-var/config-file/startup-warning coverage), a standalone real-agent probe against the actually-installed `claude`/`omp` binaries (not part of the automated suite, described in the PR), `pnpm --filter @loombox/supervisor exec vitest run src/agent-supervisor.test.ts` (24 tests, including the `wrapSpawnConfig` fail-closed path), the full `pnpm --filter @loombox/node exec vitest run` (116 files, 1281 passed / 1 pre-existing unrelated flake confirmed passing in isolation / 1 pre-existing unrelated skip — no regressions from this change), `pnpm --filter @loombox/providers-core typecheck`, `pnpm --filter @loombox/supervisor typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- eb16820: Session templates: a one-click way to repeat a "new session" workflow (issue #259, epic #29)

  `NewSessionDialog` and #752's agent-profile catalog were read first, on purpose: a template is deliberately NOT a bigger thing than the dialog itself asks for. It captures exactly the dialog's own per-session choices — the agent (a registered provider or a full `customAgent` record), the Workspace radio (`worktree`), and a default title — and nothing past that. No MCP server set (the dialog never lets a session choose one; it always inherits the project's Config panel state) and no starting prompt (issue #761 removed that field from the dialog entirely). No agent-profile deny rules either: the dialog has no profile picker yet, so there is nothing to compose with #752's catalog today; if one is added later, the right shape is a `profileId` reference, never a duplicated copy of `AgentProfileV1`'s fields.

  - `@loombox/protocol`'s new `session-template.ts`: `SessionTemplateV1` plus the `session_template_list_get`/`_set`/`_result` wire trio. Routed by `nodeId`+`targetId` directly, NOT by an existing session's `sessionId` the way `agent_profile_list_get`/`_set` are — `NewSessionDialog` is exactly where a template gets loaded/saved BEFORE any session (often the project's very first) exists, so there is nothing to route an `agent_profile`-style request through. Mirrors `target_fs_list_request`/`custom_agent_probe_request`'s identical "no session yet" convention: sealed under the same per-target key, `_get` carries no envelope, `_set`/`_result` do.
  - `@loombox/node`'s new `SessionTemplateStore` (`session-template-store.ts`): a single JSON catalog file, account-scoped (one node, one account), mirroring `agent-profile-store.ts`'s shape exactly — survives a node restart. `NodeDaemon` wires the wire pair the same way it wires `target_fs_list_request`/`custom_agent_probe_request`: ignored for a target this node doesn't own, replies always sealed under that target's key.
  - `@loombox/relay`'s `message-routing.ts`/`relay.ts`: the new trio routed exactly like `custom_agent_probe_request`/`_response` — a small in-memory per-requestId routing table (`pendingSessionTemplateListRequests`), TTL-bounded (`sessionTemplateListRequestTtlMs`, default 15s), cleaned up on response, disconnect, or expiry.
  - `@loombox/web`'s `RelayClient` gains `listSessionTemplates`/`saveSessionTemplates`, mirroring `browseDirectory`/`probeCustomAgent`'s `nodeId`+`targetId` calling convention. `NewSessionDialog` gains a "Template" picker (only for templates matching the open project's own target) and a "Save as template" action, both optional on the narrow `NewSessionClient` interface so existing fakes keep working unchanged. Applying a template sets the exact same reactive state a hand-filled form would (including adding a referenced custom agent to the project's own list if it isn't there yet), so `handleSubmit` builds an identical `CreateSessionOptions` either way — proven by a test comparing the two resulting `createSession` calls directly.

  Verified: `pnpm --filter @loombox/protocol exec vitest run src/v1/session-template.test.ts` (10 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts -t session_template_list` (6 tests) and `src/message-routing.test.ts` (180 tests), `pnpm --filter @loombox/node exec vitest run src/session-template-store.test.ts src/node-daemon-session-template.test.ts` (12 tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/NewSessionDialog.test.ts` (43 tests, 7 new), `pnpm --filter @loombox/protocol typecheck`, `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/relay typecheck`, `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, the full `@loombox/protocol`/`@loombox/relay`/`@loombox/node` package test suites (752/535/1464 tests), and the full monorepo `pnpm test` (5383 passed, 2 pre-existing skips, 0 failures).

- e087fb9: Aggregate spend-over-time view, per project and per provider (SPEC §7.9; issue #249)

  `@loombox/node` persists a per-day/project/provider spend ledger (`SpendLedgerStore`), fed by the exact same `usage_update.costUsd` increase that already drives §7.16's spend-cap enforcement — one source, never two divergent cost computations. `@loombox/protocol` adds `spend_report_request`/`spend_report_response` (node-addressed by `nodeId`+`projectPath`, mirroring `tracker_snapshot_request`; the request itself carries no envelope since a date range is a query parameter, not project content), routed through `@loombox/relay`'s exhaustive message-routing table.

  The per-project/per-provider grouping logic (`aggregateSpendLedgerRows`/`filterSpendLedgerRows`) now lives in `@loombox/shared` rather than `@loombox/node`, so `@loombox/web`'s new `SpendReportPanel` (mounted in the Config workbench tab) reuses the identical function the node runs server-side, rather than recomputing the rollup a second time in the browser. The panel offers a 7d/30d/90d/all-time period selector and shows a total plus per-provider breakdown; a period with nothing recorded reads as an honest "No spend recorded for this period." message, never a fabricated $0.00, matching the live session cost meter's own established convention.

- ed2392d: Live tracker connectivity-error state and attention-inbox failure surface (SPEC §7.10/§7.13; issue #219)

  A live tracker backend (GitHub/Jira) that cannot be reached now has an honest, three-way state instead of silently looking like an empty tracker: `reachable` (whether or not it returned any items), `unreachable` (network failure, timeout, a 5xx, or rate limiting — purely transient, nothing to reconfigure), and `authFailed` (no credential to attempt a call with, or the remote API rejected one — an expired/revoked token, requiring the user to reconnect the account in Settings).

  `@loombox/node` adds `TrackerConnectivityWatcher`, a per-project polling engine mirroring `CiCheckWatcher` exactly (fixed interval, one poll per project regardless of how many sessions share it), and `classifyTrackerConnectivityError`, which classifies a `GithubTrackerBackend`/`JiraTrackerBackend` call failure into the two failure states. `NodeDaemon` re-watches every saved live-mode project on restart (`TrackerModeStore.list()`), watches/unwatches on `tracker_mode_set_request`, and fans each project's latest reading out to every session open on it.

  `@loombox/protocol` adds `tracker_connectivity_status`, a session-scoped node-pushed message mirroring `ci_check_status`'s wire shape, routed through `@loombox/relay`'s existing per-session fan-out (`fanOutDirect`) — no new relay-side subscription registry needed.

  `@loombox/web`'s `RelayClient.attentionInbox()` gains a `'tracker_failure'` class: it raises exactly one item per session for a failing tracker, clears it once the tracker recovers, and never duplicates across repeated polls, the same recompute-from-latest-state property `'ci_failure'` (issue #243) already has. `AttentionInbox.svelte` renders `unreachable`/`authFailed` with distinct wording and badges, since the corrective action differs.

### Patch Changes

- ac5b075: The node's identity keypair is now anchored to its 0600 `identity.json`, with the
  OS keyring demoted to a best-effort cache in front of it, and a volatile backend
  (a Linux kernel keyring with no Secret Service session) is refused outright. An
  empty keyring next to a populated file is treated as a cold cache and the file's
  keypair is adopted, so a reboot no longer makes the node come back as a different
  device (#815).
- Updated dependencies [fc4f4e3]
- Updated dependencies [7b8e591]
- Updated dependencies [edb3752]
- Updated dependencies [d2741e2]
- Updated dependencies [4e090fc]
- Updated dependencies [5f500de]
- Updated dependencies [e42b8d1]
- Updated dependencies [8948531]
- Updated dependencies [3dcb133]
- Updated dependencies [93c1ffd]
- Updated dependencies [c8a9381]
- Updated dependencies [9c20ae1]
- Updated dependencies [12cc8ec]
- Updated dependencies [9a47212]
- Updated dependencies [9400cb4]
- Updated dependencies [05f8339]
- Updated dependencies [eb16820]
- Updated dependencies [e087fb9]
- Updated dependencies [ed2392d]
  - @loombox/providers-core@0.5.0
  - @loombox/protocol@0.8.0
  - @loombox/supervisor@0.3.0
  - @loombox/shared@0.3.0
  - @loombox/crypto@0.1.1

## 0.7.0

### Minor Changes

- 97598db: Custom ACP agents defined per project, gated by a node-side allowlist (D1-3, issue #748)

  `@loombox/protocol`: `customAgentRecordV1` (name/command/args/env/defaultMode/defaultConfigOptions) rides `sessionPrivateMetaV1.customAgent`, encrypted exactly like `title`/`projectPath`. A new `custom_agent_probe_request`/`custom_agent_probe_response` pair (mirrors `target-fs.ts`) lets a client check installed-vs-allowed on a target before ever creating a session. `sessionStatusEventV1` grew an optional `reason` so an `'error'` status can carry a verbatim message.

  `@loombox/node`: `custom-agent.ts` — `assertCustomAgentAllowed`/`isCustomAgentCommandAllowed` (the actual security boundary), `CustomAgentNotAllowedError`, `createCustomAgentProvider`. The allowlist itself (`NodeCliConfig.customAgentAllowlist`) is file/env-only (`LOOMBOX_CUSTOM_AGENT_ALLOWLIST` or the config file's `customAgentAllowlist`), defaults to `[]` on a fresh node, and has no wire message that reads or writes it — never reachable from a client. `NodeDaemon` gates every custom-agent launch (`local` and `ssh:`) through it before ever registering a spawn recipe; a refusal reports `session_status: 'error'` with `reason` naming the allowlist. `applyCustomAgentDefaults` best-effort-applies a custom agent's `defaultMode`/`defaultConfigOptions` via the existing `session/set_config_option` mechanism.

  `@loombox/relay`: routes `custom_agent_probe_request`/`response` by `nodeId`, same pending-request-table pattern as `target_fs_list_request`.

  `@loombox/web`: `RelayClient.createSession` now takes an optional `customAgent`, sealed into the same private envelope as `title`/`projectPath`; `RelayClient.probeCustomAgent` is the client half of the probe pair. A new per-project `custom-agent-store.ts` (`localStorage`-keyed, mirrors `mcp-server-store.ts`'s CRUD pattern) backs `NewSessionDialog`'s "+ Define a custom agent" form, which folds a project's custom agents into the same Agent picker as its registered providers (`custom-agent:<name>` ids, never colliding with a real provider id) and sends `provider: 'custom'` alongside the record on submit.

  **The allowlist's edit path**, in full: an operator sets `LOOMBOX_CUSTOM_AGENT_ALLOWLIST` (comma-separated) or the node config file's `customAgentAllowlist` (JSON array) and restarts the node (`packages/node/src/config.ts`'s `NodeCliConfig.customAgentAllowlist` doc comment, threaded through by `main.ts`'s `start()`). No wire message reads or writes it, so it is architecturally unreachable from any client, no matter which device or account.

- ff1fb1e: Fork a session from any turn into a new one (issue #746, Zed-parity decision C6-2). The transcript up to that turn is copied into a brand-new session with its own worktree, seeded from the source's branch tip plus an overlay of the source's uncommitted and untracked files, so the fork's files match the transcript it starts from. The original session and its worktree are untouched: nothing here reverts anything, which stays C6-3's job and depends on #603.
- 7ad7274: Wire `@loombox/supervisor`'s `GitCheckpointStore` (issue #266) into a running session and the wire protocol (issue #603). `NodeDaemon` now takes an automatic checkpoint right before every turn's prompt reaches the agent — before the whole turn, not just its first tool call, since ACP `session/update` notifications are fire-and-forget and there is no request/response boundary this node could synchronously interpose on between "the agent decided to write" and "the write already happened"; before the turn is the earliest point this node can actually guarantee, and it strictly subsumes "before the first write". Best-effort: a checkpoint failure is logged and never blocks the turn itself.

  Four new v1 wire messages (`checkpoint_create`/`_list`/`_restore_preview`/`_restore`, each with its own reply carrying an `outcome: 'ok' | 'error'` — `_restore` also `'confirmation_required'`), routed/fanned out by the relay exactly like `test_runner_config_get`/`_set`/`_detect`, sealed under the session key so a checkpoint's label, commit graph, and restore outcome never reach the relay in the clear. `checkpoint_restore` requires an explicit `confirm: boolean`: an unconfirmed restore that would discard anything uncommitted answers `confirmation_required` with the same `RestorePreview` `checkpoint_restore_preview` surfaces, and never touches the worktree — the structural half of "a rollback that would discard uncommitted human edits must say so before it runs". It also refuses while the session's own agent is actively mid-turn, so a restore can never race a live write.

  Every checkpoint/preview carries `isWorkInPlace` (`Session.branch === ''`): the engine treats an isolated worktree and an in-place session identically, but only an in-place session's worktree is the user's actual project folder, so this is the signal a client needs to warn accordingly rather than guessing. An `ssh:`-target session gets a clear `errorType: 'unsupported_target'` instead of a confusing failure: the engine spawns `git` as a local child process, so a remote session's `worktreePath` is not reachable from this node at all. A session's checkpoint refs are deleted (`GitCheckpointStore.deleteAllCheckpoints()`) whenever `SessionManager.removeSession` forgets it, so hidden refs never accumulate in the user's repo.

  This is the blocker both #268 (the rollback confirmation UI) and #747 (rewind) were waiting on. Neither is built yet: #268 still needs the client list/create/confirm UI over this wire surface, and #747 still needs to map a turn to the checkpoint taken before it (this wiring already takes one checkpoint per turn boundary, labeled `auto: before turn <n>`, for exactly that) and its own transcript-truncation half.

  `GitCheckpointStore.checkpoint()` itself now issues its independent `git` reads in parallel and one call fewer, plus a single retry on a transient subprocess-spawn failure: measured at 45-90ms serial per checkpoint against a real repo with zero contention. The automatic per-turn checkpoint stays serial — `await`ed before `agentSession.prompt()`, and in `deliverPrompt` ahead of attachment resolution too — after running it concurrently via `Promise.all` was found to let a caller (a test's teardown, in practice) delete a session's worktree while `checkpoint()` was still writing into it, surfacing as `ENOTEMPTY` on otherwise-unrelated tests on a clean CI runner; a per-bridge queue still orders two turns' checkpoint attempts against each other so they never race the same worktree either way.

- 79f55e0: Wires the browser's own MCP config/status surface into the one resolution path #750 (D2-2) built on the node (issue #794).

  - `apps/web`'s Config panel (`McpServerConfigPanel.svelte`) now forwards its per-project `mcp-server-store.ts` list — only the currently-enabled records — into `RelayClient.createSession`'s new `mcpServerConfigs` option, which seals it into `session_create`'s private envelope exactly like `title`/`projectPath`. A server added there is launched for the very next session on that project.
  - The node's `mcp_server_status` event gains a `disabled` flag (`@loombox/protocol`'s `mcpServerStatusEntryV1`, mirrored in `@loombox/providers-core`'s `AcpMcpServerStatusEntry`): `true` only on the exact failure that just auto-disabled the node's own `McpConfigStore` record after three consecutive failures (`NodeDaemon.recordMcpServerOutcome`/`autoDisableMcpServer`, now reporting instead of only logging).
  - The Config panel renders a new "Server status" section off `RelayClient.mcpServerStatusesFor(sessionId)` (threaded through `ProjectConfigPanel`): every failed server by name and reason, with an auto-disabled one visibly distinct from one that will simply be retried next session — including a server only the node itself is configured with, not just this device's own list.
  - New copy on the "Configured servers" section makes the two-store merge legible: this device's own declarations are one input the owning node merges with its own store, not the whole truth.
  - No secret value crosses either surface: `mcp-server-store.ts` never held one, and `mcp_server_status.reason` is always the human-readable failure detail, never a secret (`mcp-secret-grants.ts`'s node-local boundary unweakened).

- 6d3ad95: Consume MCP prompts and surface them as slash commands (Zed-parity D5-2, issue #754). The node now speaks MCP directly (`@loombox/providers-core`'s new `mcp-prompt-client.ts`, hand-rolled JSON-RPC over stdio/HTTP, mirroring `AcpClient`'s own conventions) — a second, independent connection per launched server, separate from whatever the ACP agent itself does with `mcpServers` at `session/new`, since a real `omp acp` binary never forwards an MCP server's prompt catalogue onto its own `available_commands_update`.

  Right alongside `mcp_server_status`, a new `mcp_server_prompts` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, same "ride the existing `session_update` envelope, no-op on an empty list" shape) carries every launched server's own `prompts/list` catalogue, attributed by server name. A server with no prompts contributes nothing; an unreachable server is silently excluded rather than breaking the push for the others.

  Selecting one in the composer's `/` picker (merged with the agent's own `commandsFor` catalogue, each MCP-sourced row tagged `mcpServer`/`mcpArguments`) sends the server's own rendered definition, not the raw typed text: a new `mcp_prompt_get_request`/`mcp_prompt_get_response` wire pair (`@loombox/relay` routes/fans it out exactly like `fs_list_request`/`fs_list_response`) asks the node to call that prompt's real `prompts/get`, with the user's typed argument text folded in. A failed render falls back to sending the user's raw typed text rather than blocking the send.

  Resources (D5-3) stay out of scope.

- 6325366: Launch a session's MCP servers on its execution target, local or `ssh:` (Zed-parity D2-2, issue #750). `NodeDaemon.resolveMcpServers` is now the one resolution path: this node's own `McpConfigStore` (global + project) merged with a client's per-project `mcpServerConfigs` declarations, forwarded inside `session_create`'s encrypted `SessionPrivateMetaV1` (`@loombox/protocol`'s new `mcp-servers.ts` schema, mirrored client-side, never a secret value). Secrets keep resolving node-side and are injected at launch, never sent to the relay.

  A server that fails to start — a missing binary or a failed MCP handshake — is excluded from that one attempt and retried without it (`startAgentWithMcpFallback`), so the session still opens with its remaining servers instead of quietly losing tools; the exclusion, its category (`missing_binary` | `handshake_failed` | `secret_missing`), and the underlying reason are pushed as a new `mcp_server_status` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, mirrored in `@loombox/providers-core`'s `AcpSessionWireEvent`/`TranscriptState.mcpServerStatuses`). A revoked/ungranted secret grant fails before any worktree/lease/agent is touched, and is now visible on the wire too (a minimal `session_announce` plus `session_status: 'error'` and `mcp_server_status`, both naming the server), not just a `console.warn`. Three consecutive failures for the same node-store-owned server auto-disable it (`McpConfigStore.setProjectEnabled`/`setGlobalEnabled`); a client-declared server has nothing here to disable, so it keeps being reported until the client acts. A server that already started is unaffected by a sibling's failure.

- d03fc5d: Open a pull request from a session's own branch (SPEC §7.14, issue #238). `@loombox/protocol` gains `pr.ts`'s `pr_open_preview_request`/`_result` and `pr_open_request`/`_result` wire pair, routed session-scoped through the relay exactly like `permission_policy_get`/`_set` (the relay only ever forwards `sessionId`/`requestId` plus opaque `EncryptedEnvelope`s — never a branch name, commit count, PR title/body, or the created PR's URL).

  `@loombox/node`'s new `pr-open.ts` runs `git`/`gh` on the session's own `ExecutionTarget` (`local` or `ssh:`), authenticated by that target's own already-signed-in `gh` CLI — deliberately not SPEC §7.26's connected-account registry (`GithubConnectService`), whose token lives in one node's OS keyring and cannot reach an `ssh:` target's `gh` invocation at all (`ExecOptions.env` is local-only) or add anything a target's own git-push credentials don't already provide for a `local` one. `previewPrOpen` is read-only (resolves the session's branch via `resolveSessionBranch`, issue #738; the repo's default branch via `gh repo view`; and the commit count ahead of it) and reports one of seven named failure categories (`no_branch` | `no_commits` | `gh_missing` | `gh_unauthenticated` | `repo_lookup_failed` | `push_failed` | `create_failed`) rather than one generic error, mirroring issue #750's `AcpMcpServerFailureCategory` precedent. `openPr` re-verifies that same preview immediately before it pushes the branch and runs `gh pr create` — the one point in the whole feature with a real side effect on the operator's own repository.

  `apps/web`'s `RelayClient` gains `previewPrOpen`/`openPr`, and a new `PrOpenDialog.svelte` — reached from any session row's "⋯" menu ("Open pull request…"), alongside "Archive session…"/"Export transcript": an occasional, per-session action, not a permanent workbench sub-tab beside Files/Config/Runner (those stay relevant for a session's whole lifetime; opening a PR happens once, near the end). The dialog shows the preview (branch, base, commit count) the moment it opens, then only pushes and opens the PR once the operator has typed a title and clicked "Push & open pull request", surfacing the resulting URL or a distinct failure reason inline. No AI-drafted PR body here (issue #233's scope, not this one's).

- 757fa0e: Per-project scoped secret/env injection for agent execution (issue #258): a project can declare env vars its spawned agent process gets at start, each either a literal value or a reference to a node-local secret by name — resolved and injected only on the executing node, never sent to the relay or a client.

  - `@loombox/providers-core`'s `project-env.ts` mirrors `mcp-secret-grants.ts` (issue #189): `ProjectEnvVarDecl`, a per-secret `ProjectEnvGrantStore` (deliberately separate from `McpSecretGrantStore` — direct agent-env injection is a distinct trust boundary from an MCP server grant), and `resolveProjectEnv`, which fails fast on an ungranted/missing secret before returning anything.
  - `@loombox/protocol`'s `sessionPrivateMetaV1.projectEnvDecls` carries a client's declared list inside the same encrypted envelope as `title`/`projectPath`/`mcpServerConfigs`.
  - `@loombox/node`'s `NodeProjectEnvManager` persists only the grant ACL and reuses `NodeMcpSecretManager`'s existing keyring-backed secret-value storage rather than a second store, so a secret set once is usable by both an MCP server grant and direct env injection. `NodeDaemon` resolves it alongside `mcpServers` at session start, in the same before-any-worktree preflight path that already fails clearly on a bad MCP grant — a missing/ungranted secret now gets the identical treatment (a minimal `session_announce` plus `session_status: 'error'` naming the env var and secret). `ssh:` targets refuse a declared env var outright for now (the sandboxing dependency, issue #257, is still open) rather than silently starting an agent missing it.
  - `@loombox/supervisor`'s `AgentSupervisor.start()` gains an `env` option, merged into the provider's own `spawnConfig.env` before spawning — never sent anywhere but the local `child_process.spawn()` call.
  - `@loombox/web` gets `project-env-store.ts` (client-side declaration CRUD, mirrors `mcp-server-store.ts`) and `ProjectSecretsPanel.svelte`, mounted in the Config panel next to MCP servers; `RelayClient.createSession()` and `NewSessionDialog` forward the declared list on every session creation, the same way `mcpServerConfigs` does.

- dace883: Turn-indexed session rewind (design spec `2026-08-05-zed-parity-decisions.md`'s C6-3; issue #747), built on top of #603/#805's `GitCheckpointStore` wiring: the same session, its transcript and its worktree, roll back together — destructive, and confirmed before it runs.

  Two new v1 wire messages, `session_rewind_preview`/`session_rewind`, distinct from `checkpoint_*`: `turn` is a plain, node-resolved integer (the same counter #805 already stamps into its `auto: before turn <n>` checkpoint labels), not the ACP-level `turnId` string. `@loombox/node`'s `session-rewind.ts` builds the turn→checkpoint index #805 deliberately left unbuilt, by reading that label back — no separate persisted structure to keep in sync, since the checkpoints' own hidden refs already are the persistence. Rewinding to `turn: N` restores the checkpoint taken before turn `N + 1` (keeping turn `N`'s own effects, discarding everything after) and truncates the session's transcript to match, in the same operation, so the thread and the worktree can never disagree.

  `session_rewind`'s confirmation gate reuses #805's own `confirmation_required` mechanism rather than inventing a second one — every valid rewind target discards at least one turn, so an unconfirmed rewind always answers `confirmation_required` with a preview naming exactly what's at risk: `filesAtRisk` (new `@loombox/supervisor` method `GitCheckpointStore.filesAffectedByRestore()`, a file-level diff between the worktree's current state and the target checkpoint) and `turnsAtRisk`. `isWorkInPlace` (#805's own flag) is carried through unchanged, so a client can render the sharper warning an in-place session's uncommitted state deserves. An `ssh:` session gets `errorType: 'unsupported_target'`, same as `checkpoint_*`; a session with no live agent (disconnected since a node restart) gets a new `errorType: 'no_live_agent'`, since truncating a transcript needs the live `AgentSession` object holding it — reviving one on demand is issue #706's own scope, not this one.

  `@loombox/supervisor`'s `TranscriptStore` gains `truncateTranscriptUpdates()` (the one place its append-only log design is deliberately broken, since rewind is the one operation that needs it to shrink) and `AgentSession` gains its own `truncateTranscriptUpdates()`, the mirror image of the fork-seeding `seedTranscriptUpdates()` already shipped for issue #746.

- 89355b1: Per-project and per-session spend caps with auto-pause (SPEC §7.16; issue #251)

  A session's cumulative cost (the same rollup §7.9's usage meter shows, subagent cost included) can now be capped, and crossing the cap auto-pauses the session rather than letting it run unbounded:

  - Two independent scopes: a project-wide cap (`@loombox/node`'s new `SpendCapStore`, one JSON file per node, mirroring `PermissionPolicyStore`'s shape) and a session-scoped cap (`SessionManager`'s new `Session.spendCapUsd` field, persisted through the existing `SessionStore`). The session's own cap wins when both are set — `NodeDaemon.effectiveSpendCapUsd` is the one place that resolution happens.
  - `NodeDaemon` accumulates each session's cumulative cost from every `usage_update.costUsd` it forwards (a running max, mirroring `@loombox/providers-core`'s `reduceUsage`) and never treats "this agent has never reported a cost" as `$0` real spend — a cap simply cannot fire until a real cost figure exists, no matter how low it's set.
  - Crossing the cap pauses the session (`SessionManager.pauseSession` — the agent process is untouched, exactly per its own "independent of the supervisor's own process-level concerns" design) and pushes a new `'paused'` `session_status` (protocol enum widening, same category as `'queued'`/`'starting'`/`'disconnected'`) carrying a `reason` in the same field issue #730 added for a spawn failure.
  - A cap crossed mid-turn (the agent still `'working'`/`'permission_required'`) is deliberately let finish rather than interrupted — there is no ACP-level turn-interrupt wire message yet (`RelayClient.interruptTurn`'s own doc comment says so directly), and the issue's own acceptance line rules out "silently killed." The pause lands the instant the turn actually settles; the UI never claims `'paused'` early.
  - Resuming is always a deliberate client act, never automatic: `session_spend_cap_resume` (explicit "continue anyway," envelope-less like `run_cancel`) or a `spend_cap_set` that raises the effective cap back above current spend (auto-resumes as a side effect of that one act). Either path advances a watermark so the same cap doesn't immediately re-fire for spend that never actually changed — it re-arms only once NEW spend grows past it.
  - New wire messages: `spend_cap_get`/`spend_cap_set`/`spend_cap_result` (mirrors `permission_policy_get`/`_set`/`_result`'s shape exactly) and `session_spend_cap_resume`, routed by the relay to the owning node without ever seeing a project's or session's actual dollar figure.
  - `apps/web`'s `session-status.ts` (the one place a session status becomes words, read by both the status bar and every session row) now renders `'paused'` distinctly — its own tone plus the always-populated `reason`, so a cap pause never reads like a generic failure or another kind of pause.

  Not in this change (left for a follow-up issue, since the enforcement mechanism above is complete and independently testable over the wire): a settings panel to set caps from the UI, a "Resume" button, and cross-project attention-inbox/push-notification wiring for a paused session. The protocol/node layer is the full, real implementation; the client surface today is read-only (a paused session's status and reason are visible everywhere `SessionStatusV1` already renders) plus the wire API (`spend_cap_get`/`_set`, `session_spend_cap_resume`) any future panel calls directly.

  Verified: `pnpm --filter @loombox/protocol exec vitest run` (594 tests), `pnpm --filter @loombox/node exec vitest run src/node-daemon-spend-cap.test.ts src/spend-cap-store.test.ts src/session-manager.test.ts` (76 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts` (121 tests), `pnpm --filter @loombox/web exec vitest run src/lib/components/StatusBar.test.ts src/routes/page.test.ts` (109 tests), `pnpm -r typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 109184d: Topbar shows `project / branch`, and the session's target chip moves down into the status bar's left zone (Zed-parity decision B3-3, issue #738).

  - `@loombox/protocol`: `SessionPrivateMetaV1` gains an optional, node-computed `branch` field. A client never sends it — only `@loombox/node`'s own `announce()` sets it.
  - `@loombox/node`: a new `resolveSessionBranch` helper resolves the branch a session's own state should report. A worktree-isolated session already knows its own `loombox/session-<id>` branch, no git call needed; an in-place session gets a fresh `git branch --show-current` probe against its project folder on every `announce()` (session creation, a fork, and every reconnect's re-announce) — a detached `HEAD` resolves to `detached@<short-sha>` rather than a blank value, and a plain, non-git folder (SPEC §6) resolves `undefined`, not an error.
  - `@loombox/web`: the topbar's `.topbar-breadcrumb` now reads `project / branch` instead of `project · target`, omitting the branch segment entirely when the node has nothing to report. `StatusBar`'s left zone gains a `selectedSessionTargetLabel` segment (`status-bar-session-target`) carrying the target the old breadcrumb used to show — the target still appears exactly once in the window, just one level down.
  - `@loombox/web`: below `--bp-tablet` (390px phones, same convention `.topbar-breadcrumb`'s own narrow media query already uses), the new `status-bar-session-target` segment drops out of `StatusBar` entirely — it is the least useful LEFT-zone segment at that width, and dropping it is what keeps the bar inside the composer strip's own phone-width budget (`composer-strip.spec.ts`'s "fits one row on a phone"). Still discoverable there: the sessions sheet's own row for the open session already carries the identical label (`session-activity`, reachable from the bottom tab bar).

  This does not live-update an in-place session's branch the instant it changes on disk while the connection stays open — that would need either polling every open session's git directory or a filesystem watcher, neither of which this codebase uses elsewhere, and a person switching branches under a running session is a rare, deliberate action they already know about. It does refresh at every `announce()` (so a reconnect always shows the true current branch) and on a full reload.

- 4291dc3: Add the working-tree diff viewer (SPEC §7.4, issue #206): a session's actual uncommitted changes (staged + unstaged + untracked, compared against `HEAD`), opened as a real tab in the canvas tab strip (issue #737) rather than a dialog.

  - `@loombox/protocol`: new `git_diff_request`/`git_diff_response` wire pair (`packages/protocol/src/v1/git-diff.ts`) — shaped like `fs_read_request`/`fs_read_response` (issue #737), no envelope on the request (asking carries no content, mirroring `checkpoint_list`).
  - `@loombox/node`: `packages/node/src/git-diff.ts`'s `computeWorktreeDiff` runs real `git status`/`git show` through `ExecutionTarget.exec` — the same `git -C <worktree> ...` shape issue #238's `pr-open.ts` already established, so this works against a `local` or an `ssh:` target identically. A binary/symlink change collapses to `DiffViewer`'s existing `oldText: null, newText: ''` structural-only shape; a deleted file gets `newText: ''`; a rename carries `previousPath`.
  - `@loombox/relay`: routes the new pair exactly like the `checkpoint_*`/`fs_read_*` families — always blind to the envelope's contents.
  - `@loombox/web`: `WorktreeDiffViewer.svelte` renders inline (reusing `DiffViewer.svelte` unchanged, per file) and split (reusing `$lib/diff.ts`'s `diffStats`/`computeLineDiff` via the new `pairDiffLinesForSplitView`, laid out in two columns) — no second diff algorithm anywhere. Split degrades to inline below the tablet breakpoint, where two columns have nowhere to go. Opens via a new "Working tree diff" button above the Files panel tree, as `$lib/tabs.svelte.ts`'s new `DiffCanvasTab` tab kind.

### Patch Changes

- 584520e: Named agent profiles that gate which tools a session may use at all (D3-4's "profiles" half, issue #752)

  Zed ships three built-in profiles (Write/Ask/Minimal), each a complete `Record<toolName, boolean>` over a closed tool catalog Zed itself defines. That shape does not fit here: the agent (Claude Code, Codex, a generic ACP binary, whatever MCP servers it connects to) owns its own tool list, not loombox — there is no upfront manifest of every tool an agent might call. A profile here is a **filter over whatever the connected agent actually declares**, not a definition of it.

  - `@loombox/node`: `agent-profile.ts` (new) defines `AgentProfile` — `deniedToolKinds` (ACP's own small, fixed 9-value `toolKind` taxonomy), `deniedToolNamePatterns` (anchored globs, reusing `permission-policy.ts`'s own dependency-free `*`/`?` language via the newly-exported `matchAnchoredGlob`, matched against a tool call's `title`), and `deniedMcpServers` (exact server names, omitted from `mcpServers` entirely before an agent ever spawns — the one place this feature can offer a real "the tool does not exist" guarantee). `evaluateAgentProfile` is the per-call enforcement chokepoint; `filterMcpServersForProfile` is the session-start one. An entry that never matches this agent's actual tools degrades quietly, never errors (issue #752's own acceptance line) — `agent-profile-store.ts` (new) persists the named catalog as one flat, account-scoped JSON file (this node serves exactly one account, so "per account" is "no scoping key at all", the same shape `McpConfigStore`'s own global list already uses).
  - `@loombox/supervisor`: `AgentSession` gains `evaluateToolProfile`, a resolver called fresh on every incoming `session/request_permission` — mirrors `PolicyEnforcedPty`'s `() => PermissionPolicy` resolver being re-read on every submitted line, so switching a session's profile mid-session applies starting with the very next tool call, never retroactively, never half-applied. A denial auto-resolves the request (replying to the agent's still-pending ACP call with a `reject_once` option when the agent offered one, else `cancelled`) before it ever becomes a human-visible `permission_required` — the request never reaches the FIFO queue at all. `AgentSupervisor.start`/`startWithChild` thread it through to `AgentSession.spawn()`.
  - `@loombox/protocol`: `agent-profile.ts` (new) — `agent_profile_list_get`/`_set`/`_result` (the named catalog, account-scoped, following `permission-policy.ts`'s own request/reply shape) and `agent_profile_session_get`/`_set`/`_result` (which profile is active for one session). `permission-policy.ts`'s `ToolRefusalReasonV1` grows the `kind: 'profile'` member #751 already reserved this seam for, and `permission_policy_violation`'s `surface` enum grows `'tool_call'` — reusing the exact same notification `@loombox/node`'s new `sendToolProfileRefusal` sends through, rather than a second, parallel attribution mechanism.
  - `@loombox/relay`: routes the four new client-to-node messages via `routeToOwningNode` and fans the two result types out via `fanOutDirect`, exactly like `permission_policy_get`/`_set`/`_result` — the relay never opens either envelope.
  - `@loombox/web`: `RelayClient` gains `listAgentProfiles`/`saveAgentProfiles`/`getSessionAgentProfile`/`setSessionAgentProfile`. `PermissionPolicyPanel`'s `ATTRIBUTION_LABEL` grows the `profile: 'Profile'` entry the file's own doc comment already anticipated (it was a compile error until this landed) and its `violationDetail` renders a profile refusal's own shape (which profile, matched by tool-kind or tool-name) alongside a policy refusal's — the same "Recent policy blocks" list now attributes both of D3-4's silent-refusal layers; the third (a request-time `allow_always`/`reject_always` answer) is already self-evident in the existing rendered `permission_response` UI and needed no new mechanism.

  Not in this change: a dedicated settings surface for creating/editing the profile catalog and picking a session's active profile from the UI (the wire protocol and `RelayClient` methods are complete and tested; only the panel itself is deferred — see issue #752's tracking comment for the exact resumption point). A session's active-profile choice is in-memory only on the node and does not survive a node restart (re-select it after reconnecting); the catalog itself is persisted and does survive one.

  Verified: `agent-profile.test.ts` (node, 15 tests) covers `evaluateAgentProfile`/`filterMcpServersForProfile` including every quiet-degrade case; `agent-profile-store.test.ts` (5 tests) covers persistence; `agent-profile.test.ts`/`permission-policy.test.ts` (protocol, 17+19 tests) cover the wire schemas including the widened union; `agent-session-profile.test.ts` (supervisor, 4 tests) drives a REAL `session/request_permission` round trip against `providers-core`'s own `permission-acp-agent.mjs` fixture, proving a denial never reaches the human queue and the agent really receives the reply, plus the mid-session-switch-applies-next-call guarantee; `node-daemon-agent-profile.test.ts` (node, 3 tests) drives the same fixture through a real relay + real encrypted session end to end, proving `session_create`'s `profileId` produces a `permission_policy_violation` naming the profile instead of a `permission_request`, that an unrestricted session is unaffected, and the `agent_profile_list_set`/`agent_profile_session_set` wire round trip. `PermissionPolicyPanel.test.ts` gained a test proving the profile badge renders and is distinguishable from the policy badge.

  ```
  pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm test
  ```

  All green (full local gate run because this touches `packages/protocol`).

- a0fb0a6: A session whose agent never started, or failed to start, no longer renders as "Awaiting you" in the sidebar/inbox, and a spawn failure/timeout now reaches the client as a readable error instead of only a node-side `console.warn` (issue #730).

  - `@loombox/protocol`: `sessionStatusEventV1` gains an optional `reason`, set only alongside `'error'`.
  - `@loombox/providers-core`: `TranscriptState`/`AcpSessionStatusEvent` carry that `reason` through as `statusReason`; `reduceSessionEvent` threads it.
  - `@loombox/node`: `sendSessionStatus` takes an optional `reason`, passed through on every spawn failure (`launchLocalSession`'s catch). `ssh:` sessions (`launchReservedSshSession`) now report `'starting'`/`'error'` too — parity with `local`'s issue #516 handling, which they never had.
  - `@loombox/web`: `RelayClient.ensureSubscribed`'s first-ever subscribe for a session now retries `session_resume` until the relay's own `session_announce` acks it (new `sessionResumeRetryMs` option), then backfills anything already buffered with one `resync_request(sinceSeq: 0)` — closing the announce-vs-subscribe race a freshly created session lands in (`RelayClient.createSession`'s own doc comment named this issue's "remaining half"). New `RelayClient.statusReasonFor`. The composer, the sidebar/selvage rows, and the transcript pane now gate on every "no live agent" `SessionStatusV1` (`queued`/`starting`/`error`/`exited`/`disconnected`), not just `'disconnected'` (#702's prior scope), and show the reason where the node sent one.

  Does not fix #729 (the client still never resyncs on an ordinary reconnect for an already-open session) — this PR's resync is scoped to a session's first-ever subscribe, where duplication is provably impossible, not the general reconnect case.

- 0c46b48: Stop dropping `available_commands_update` on the floor, and carry the agent's declared `/`-command catalogue through to a client-side store (issue #741)

  `AcpClient.mapToTranscriptUpdate`'s switch had no case for `available_commands_update`, so it fell into `default: return undefined` — a real agent's declared command list (`omp acp`'s own doc comment already said prompting emits it) was silently dropped, exactly the gap `client.ts:409-461`'s own comment flagged. Both #743 (slash commands in the composer) and #754 (MCP prompts as slash commands) need this catalogue, so it is built once here as shared plumbing, with no UI.

  Follows the config-option catalogue's own shape end to end, the way the issue asked for, rather than inventing a second one:

  - `@loombox/providers-core`: a new `AvailableCommandsStore` (mirrors `ConfigOptionStore` — per-session, wholesale-replaced, `EventEmitter`-backed), fed by `AcpClient.availableCommands` off the real `available_commands_update` notification (`mapAvailableCommands`, same convention as `mapConfigOptions`). `TranscriptState.commands` carries it through `reduceSessionEvent` for the client-side reducer path.
  - `@loombox/protocol`: `acpAvailableCommandV1`/`availableCommandsUpdateEventV1`, a sixth `SessionLifecycleEventV1` member riding the existing `session_update` envelope (no new wire message type).
  - `@loombox/node`: `NodeDaemon.wireAgentSession` forwards `AgentSession.availableCommands`'s `'changed'` event as `available_commands_update`, same sealing/ordering/`sendQueue` as every other session-lifecycle event. `AgentSession` gained an `availableCommands` getter mirroring `configOptions`.
  - `@loombox/relay`: no change. `relay.ts` already forwards `session_update` opaquely without a per-kind switch, so this never needed a new case — checked directly against the drop-silently pattern issue #691 describes, since `available_commands_update` is not a new top-level `WireMessageV1` member.
  - `apps/web`: `RelayClient.commandsFor(sessionId)` reads `TranscriptState.commands`, the same "derived from the one reduced state" shape `configOptionsFor` already uses. No UI wiring — that is #743's job.

  An unrecognized/future field on a command (e.g. a future ACP `AvailableCommand` addition this client has never modeled) survives the whole round trip rather than being dropped: `acpAvailableCommandV1` is `.passthrough()`ed, not `.strict()`, and `mapAvailableCommands` spreads each wire entry through instead of reconstructing a picked-fields object — `AcpAvailableCommand` itself carries an index signature for exactly this, the same passthrough convention `AcpContentBlock` already uses for an unmodeled ACP content-block variant.

  Verified against the real `omp acp` binary (v17.2.9, reachable on this box): recorded a live `initialize` -> `session/new` -> `session/prompt` exchange to confirm `available_commands_update` only ever arrives as a notification during a turn, never seeded on `session/new` unlike config options (`test/fixtures/omp-acp-available-commands-update.json`), then drove the fixture end to end (`config-acp-agent.mjs`'s new `"trigger-commands"` prompt) through a real `AcpClient`, a real `NodeDaemon`/relay/`RelayClient` round trip, and the browser-side zod validation, each with a command carrying an unrecognized field to prove it survives every layer.

- 8a3fcda: A tab strip above the canvas for opened files and diffs, transcript pinned leftmost and non-closable (issue #737, settled pick B2-2)

  Today the canvas showed exactly one session and nothing else, and the file tree could only insert an `@`-mention — there was no way to actually see a file's content outside whatever diff card the agent's own edit produced. This ships a read-only file viewer plus the tab strip around it:

  - `@loombox/protocol`: a new `fs_read_request`/`fs_read_response` wire pair (`fs.ts`), mirroring the existing `fs_list_request`/`fs_list_response` pattern exactly — session-scoped, sealed under the session key, routed to the owning node by `sessionId` alone, fanned back out to every subscribed client. One-shot per open/retry, deliberately not a live subscription (C5-1: the Files panel — and, by the same reasoning, this viewer — stays a browsing tool, not a live view of the agent).
  - `@loombox/relay`: routes `fs_read_request` to the owning node and fans `fs_read_response` out to subscribers, grouped with the existing `fs_list_request`/`fs_list_response` cases.
  - `@loombox/node`: `NodeDaemon` answers `fs_read_request` via the session's existing `ExecutionTarget.readFile`, reusing `fs_list`'s own path-traversal guard. A 1MB cap truncates (reported via `truncated: true`, never silently); a `\u0000` byte anywhere in the decoded text is treated as binary and refused with a real error rather than forwarding garbled bytes.
  - `@loombox/web`:
    - `RelayClient.readFile(sessionId, path)`: a one-shot promise, same "resolves either way, rejects only when unusable" contract as `decommissionTarget`.
    - `$lib/tabs.svelte.ts`'s `CanvasTabsState`: the transcript tab is permanent, pinned first, and structurally never closable/reorderable. Opening the same path from any entry point (the Files panel tree, an `@`-mention pill, a diff card's own new "Open" affordance on `DiffViewer`) activates the same tab rather than duplicating it. The dirty indicator compares each tab's own transcript-position watermark against completed edit tool calls, not a wall clock, so "since you last looked" is exact.
    - `$lib/file-viewer.ts` + `FileViewer.svelte`: reuses `$lib/diff.ts`'s `languageForPath` and `$lib/markdown.ts`'s existing lazy-loaded `renderMarkdownToHtml`/`highlightMarkdownToHtml` pipeline (the file's content is wrapped in a fenced code block CommonMark can never parse as closing early) — no second syntax highlighter.
    - `CanvasTabStrip.svelte`: below `TABLET_VIEWPORT_BREAKPOINT_PX` (768px) the horizontal strip becomes a single active-tab-plus-picker (a `Dialog`-backed list of every open tab), the decisions doc's own named narrow-viewport option, covered by a spec at 390px.
    - Editing stays out of scope — #205 is that work.

- 900bc5c: The `@` composer picker becomes the real thing: removable pills over four sources — files, directories, past sessions (searched by title) and tracker items (searched by id or title), the last two something Zed has no equivalent of at all (issue #742, decisions doc C2-3).

  - `@loombox/web`: new `$lib/mentions.ts` models a picked reference as ACP's own baseline `ContentBlock::ResourceLink` (`AcpResourceLinkContentBlock`'s `uri`/`name`), disambiguated by `uri` scheme (`file:`, `loombox-session:`, `loombox-tracker:`) rather than inventing a loombox-only field. `MentionPicker.svelte` supersedes the files-only `FileReferencePicker.svelte`: a `Dialog`-based picker with a Files/Sessions/Tracker tab strip, fuzzy-filtered (`$lib/fuzzy.ts`), fully keyboard-driven (arrows navigate, Enter picks, Tab/Shift+Tab cycles source, Esc closes). Picking a result never inserts text — `+page.svelte` renders it as a removable pill in a new row above the composer textarea, so editing the surrounding prose can never corrupt or silently drop a reference. `RelayClient.sendPrompt` gains a `mentions` parameter; `resolveMentionsForSend` degrades a session/tracker mention that no longer exists (checked against `RelayClient.sessions`/`trackerSnapshotFor` at send time) back into plain `@name` text rather than breaking the send — a file/directory mention is never checked, since its target is the agent's own filesystem. `PromptPayload` (the `prompt_inject` envelope's plaintext) gains an optional `mentions: {uri, name}[]`, mirrored field-for-field on both ends exactly like `attachments` already is.
  - `@loombox/node`: new `prompt-mentions.ts`'s `renderPromptTextWithMentions` folds `PromptPayload.mentions` into the text `AgentSession.prompt()` takes (still text-only in v1 — see `ResolvedAttachment`'s doc comment) as a "Referenced:" block, one `name — uri` line per mention, appended after the prompt's own prose. A prompt with no mentions is unchanged.

  The existing attachment bar and image paste path are untouched — the pill row is a sibling element inside the composer field, not a change to `AttachmentBar.svelte`.

- 166551b: Surface the node-side permission policy (command/network allow/deny globs) in the UI (D3-4's "rules" half, issue #751)

  `packages/node/src/permission-policy.ts` already enforced a per-project allow/deny glob policy, but nothing under `apps/web/src` referenced it — a user could neither see nor edit it, and it could only be hand-edited as JSON on the node.

  - `@loombox/protocol`: `permission-policy.ts` — `permission_policy_get`/`_set`/`_result` (session-routed, `_set`/`_result` sealed under `encryptedEnvelope`, following `test-runner-config.ts`'s shape) and `permission_policy_violation`, a node-to-client notification carrying `ToolRefusalReasonV1`, a discriminated union with one member today (`kind: 'permission_policy'`) — the seam D3-4's "the UI must say which of the three layers refused it" needs; the profiles half (#752) adds its own `kind: 'profile'` member alongside it rather than a second, parallel concept. Each glob rule is `.trim().min(1)`, so a blank rule is rejected at the schema boundary too.
  - `@loombox/node`: `NodeDaemon` gained `permission_policy_get`/`_set` handlers backed by the already-existing `PermissionPolicyStore`, plus `sendPermissionPolicyViolation`, wired into `PolicyEnforcedPty`'s `onViolation` hook and `executeRun`'s existing policy-denial path. **Fixes a real "no restart" bug found while writing this**: `PolicyEnforcedPty` used to snapshot the policy once at `terminal_open` time; since a terminal is long-lived, a rule added mid-session never took effect until that terminal was closed and reopened. `PolicyEnforcedPtyOptions.policy` is now a resolver (`() => PermissionPolicy`), read fresh on every submitted line, so a saved rule blocks the very next command with no node restart.
  - `@loombox/relay`: routes `permission_policy_get`/`_set` to the owning node and fans `permission_policy_result`/`permission_policy_violation` out to subscribed clients, exactly like `test_runner_config_get`/`_set`/`_result` and `terminal_output` — the relay never opens either envelope.
  - `@loombox/web`: `RelayClient` gains `getPermissionPolicy`/`setPermissionPolicy`/`onPermissionPolicyViolation`. `ProjectConfigPanel` (the right-workbench Config tab, per-project — not global Settings, since the policy is per project) gains a new `PermissionPolicyPanel` section: view/add/remove command and network allow/deny rules, a computed (never separately stored) "default: allow" / "default: only listed commands run" badge per dimension derived from whether that dimension's allow list is empty, and a live "Recent policy blocks" list fed by `permission_policy_violation`, each line naming the exact deny rule that fired. A blank pattern is rejected client-side at the Add button, with a message, before it ever reaches the wire.

  Verified: a new node-level test (`node-daemon-permission-policy.test.ts`) drives a real terminal + real bash + real relay end to end — sends `permission_policy_set` over the wire, then types a now-denied command into the SAME already-open terminal on the SAME running node, and confirms it's blocked with no restart; a companion `policy-enforced-pty.test.ts` test proves the same at the unit level. `node-daemon-test-runner.test.ts` confirms the same violation notification fires from the `run_start` policy-denial path. `PermissionPolicyPanel.test.ts` covers the blank-glob rejection, the add/remove round trip, the default-mode badge, and the attribution list rendering the rule name. `permission-policy.test.ts` (protocol) and `relay.test.ts` cover the wire shapes and blind routing.

- Updated dependencies [f2d51ee]
- Updated dependencies [584520e]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [8a3fcda]
- Updated dependencies [ae1498a]
- Updated dependencies [97598db]
- Updated dependencies [ff1fb1e]
- Updated dependencies [7ad7274]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [d03fc5d]
- Updated dependencies [166551b]
- Updated dependencies [757fa0e]
- Updated dependencies [dace883]
- Updated dependencies [89355b1]
- Updated dependencies [1ae1def]
- Updated dependencies [00e8789]
- Updated dependencies [109184d]
- Updated dependencies [4cc52b4]
- Updated dependencies [4291dc3]
  - @loombox/providers-core@0.4.0
  - @loombox/protocol@0.7.0
  - @loombox/supervisor@0.2.0
  - @loombox/crypto@0.1.0
  - @loombox/shared@0.2.5

## 0.6.0

### Minor Changes

- e6c44d0: Peers announce a build identity alongside the protocol version, and a build mismatch is now visible on a node's own row instead of staying invisible until someone SSHes in and reads process start times (issue #655)

  On 2026-08-04 my resident node had been running since 29 July, across roughly fifty merged PRs including wire-level changes, and it connected to a freshly deployed relay without a word. That is the check working as designed and the design being too coarse: PROTOCOL_V1 has been 1 since the beginning and bumps only on a breaking wire change, so two peers built a week apart both announce it and shake hands happily while silently disagreeing about what several fields mean.

  `initialize`/`initialize_result` now carry an optional `buildIdentity` (package.json version plus, when honestly recoverable, the commit): a node reads its own git HEAD at startup (it runs unbundled from a checkout via tsx, so this is free, no new build step), and the relay reads `LOOMBOX_BUILD_COMMIT` in production (passed through from the exact `$SHA` deploy-prod.sh already writes to DEPLOYED.json) or falls back to git rev-parse in dev. Both fields are additive and optional; a peer that predates this change still connects exactly as before.

  The relay records each connected node's build identity and exposes it on `target_list` entries (`build`), mirroring how `reachable` already works: live-connection-derived, absent for an offline node or one that predates the field. `buildIdentityMismatch` in `@loombox/protocol` is a pure equality/absence check, never version parsing or ordering, matching this issue's own constraint that feature detection stays the protocol's job.

  The client shows a node's version on its own row (`TargetStatusView`) and adds a quiet "Behind" badge when it differs from what the relay itself is serving (`RelayClient.relayBuildIdentity`, from the client's own `initialize_result`). Three outcomes: same protocol and build stays silent, same protocol with a different build connects and gets the badge, an incompatible protocol is still refused via the existing `update_required` path, unchanged.

### Patch Changes

- 6f90259: Files and the terminal used to stop working permanently after a node restart,
  and blame the offline node for it. The eleven session handlers that guarded on
  `if (!bridge) return` (`prompt_inject`, `fs_list_request`, `terminal_open`,
  `terminal_input`, `terminal_resize`, `terminal_close`,
  `test_runner_config_get/set/detect`, `run_start`, `run_cancel`) never actually
  needed the live agent bridge except for `prompt_inject` — listing a directory,
  opening a terminal, and running a saved command only ever touched the session
  record and its target. Ten of the eleven now resolve that record straight from
  `SessionManager`, so they keep working on a session reloaded `'disconnected'`
  after a restart exactly as well as on a live one; `prompt_inject` still can't
  reach an agent that no longer exists, and stays a logged no-op (no reply
  channel exists for it to answer on).

  Widens the wire's `session_status` vocabulary with `'disconnected'`
  (protocol-side, alongside the existing `'queued'`/`'starting'`) and pushes it
  on every reconnect for a node's own disconnected sessions, so the client can
  finally tell a session apart from a live one: the session row shows a
  "Disconnected" badge and the composer disables itself with an explanation,
  instead of offering a prompt that can never be delivered.

- 9b5f66a: Fix the node dropping the config_option wire message, so changing model or thinking effort never reached the agent (issue #718)

  This is the last of three gaps in the same chain. #705 seeded the config-option catalogue from session/new so the pickers had something to show. #707 fixed AcpClient.setConfigOption to send and read the real ACP wire shape. Neither mattered on their own: RelayClient.setConfigOption sent a real config_option wire message, the relay routed it to the owning node correctly, and NodeDaemon.handleInbound hit its default case and dropped it. The comment said so outright. So the only thing that ever happened was the client's own optimistic guess at the new value, which the next real config_options push from the agent would silently revert.

  NodeDaemon.handleInbound now handles config_option: it calls through to the session's live AgentSession.setConfigOption (a new method, delegating to AcpClient.setConfigOption), gated on the same lease check prompt_inject uses for an ssh: session. I confirmed the wire message's existing {category, optionId} shape needed no changes: #707 already resolves configId/type from the session's own catalogue entry.

  A rejected set has to reach the user, not die in a console.warn. There was no wire shape to carry that, so I added one: config_option_result, a new node-to-client reply carrying outcome: 'ok' | 'error' plus the agent's own rejection message, correlated by category rather than a request id (config_option never had one, and category is the natural key every config-option store in this codebase already groups on). Fanned out to a session's subscribed clients exactly like fs_list_response.

  I dropped the client's optimistic update rather than keep and reconcile it. With a real round trip, the agent's own config_options push is what actually updates the picker, so there is no local guess left to ever have to revert on a rejection. RelayClient now tracks which categories it has an outstanding config_option for, so it can tell its own pending request apart from a sibling device's, and publishes a ConfigOptionErrorNotice (mirrors the existing PermissionStaleNotice) when the agent refuses.

  A config_option for a session with no live agent (reloaded 'disconnected' after a restart, a real state since #702) now answers honestly with config_option_result: error instead of being silently dropped.

  Verified against a real omp acp binary through a real node: set the model, set the thinking effort, read both back off the agent's own config_options push, and confirmed a real rejection ("Unknown ACP model: ...") reaches config_option_result. Added a node-level test driving the real config_option wire message; reverted the handler and watched it fail with the exact old symptom before restoring the fix.

- 6f5dbe0: Fixed a real bug behind issue #660 (agent text appearing in one burst instead of streaming): `RelayClient` never resent `session_resume` after a reconnect, so a session's live updates silently stopped arriving once its connection dropped and came back (a slept laptop, a network blip, a heartbeat timeout) until the whole page reloaded. Now every session still marked as subscribed gets resumed again on every fresh handshake, first connect or reconnect alike.

  I also swapped the streaming test fixtures: `echo-acp-agent.mjs` used to send its two reply chunks synchronously, zero delay, which is exactly the shape that let a "batch and flush on turn end" regression pass every existing streaming test undetected. It now sends them with a real gap. I added a new `streaming-acp-agent.mjs` fixture that streams several thought chunks then several answer chunks over real time, and used it to write tests that assert the transcript grows while a turn is still open, not just that it's correct once the turn closes.

- Updated dependencies [6f90259]
- Updated dependencies [e6c44d0]
- Updated dependencies [9b5f66a]
- Updated dependencies [6f5dbe0]
- Updated dependencies [3e2e5f4]
- Updated dependencies [ff47e23]
  - @loombox/protocol@0.6.0
  - @loombox/supervisor@0.1.3
  - @loombox/providers-core@0.3.1
  - @loombox/crypto@0.0.7
  - @loombox/shared@0.2.4

## 0.5.1

### Patch Changes

- 35f3924: Tracker records are addressed by project, not by session, so a project's tracker
  is readable when no agent session is running for it. Adds a project resource key
  to the AMK key tree (`['project', accountId, projectPath]`), re-addresses the
  four tracker record messages to `nodeId` + `projectPath`, and makes the node
  answer every request it receives rather than dropping unanswerable ones.
- Updated dependencies [35f3924]
  - @loombox/crypto@0.0.6
  - @loombox/protocol@0.5.1
  - @loombox/shared@0.2.3

## 0.5.0

### Minor Changes

- 51ef3ac: Add the tracker backend composition layer (SPEC §7.10, §7.26, issue #631)

  `@loombox/node` gets `resolveTrackerBackend` (`tracker-backend-composition.ts`), the one entry point that turns a project's `TrackerMode` into a working `GithubTrackerBackend`/`JiraTrackerBackend` or a typed `TrackerBackendResolutionError`, closing the gap that left #213/#214/#220 unreachable from the UI: it looks `mode.connectionId` up in the connected-account registry, applies issue #227's per-capability account pin (`resolveAccountForRead`/`resolveAccountForWrite`, every hard-fail case mapped to its own error kind), requires the pin's answer to agree with `mode.connectionId` exactly (`connectionPinMismatch` — the mechanism that keeps one project's mode from ever resolving against a different project's pinned account), and only then resolves the credential through this node's keyring (`GithubConnectService.getAccessToken`/`JiraConnectService.getCredential`) — never any other source, and re-asked on every backend call so a revoked/rotated credential takes effect on the next request. A `{kind:'native'}` mode always resolves to `{ok:false, error:{kind:'nativeMode'}}`; composing a native-mode backend is not this module's job.

  `jira-connect.ts`'s and `jira-tracker-backend.ts`'s independently-declared, structurally-identical `JiraCredential` interfaces are deliberately left unconverged — TypeScript already accepts one everywhere the other is expected, and introducing a shared third declaration would force both files to import it, reopening the "a tracker backend never imports a connect module" boundary their own tests guard, to save two five-line interfaces that already cost nothing at the call site.

  Server-side only: this lives in `@loombox/node`, not in `apps/web`'s dependency graph. The bridge dispatch (`readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge`) and the Tracker page's error-state rendering are follow-up work against this module's exported `resolveTrackerBackend`/`TrackerBackendResolutionError`.

- a1038bf: Dispatch the tracker bridge on a project's mode, closing #631's own last gap (SPEC §7.10, §7.26)

  The node now carries a connected-account registry of its own (`connected_account_list_request`, requested on every fresh relay connection alongside `amk_epoch_fetch_request`, mirroring how a client already does this on `attemptOpen()`), and the relay answers it for a node connection exactly like it already does for a client one — the "one open question" #631's plan left open, confirmed and closed.

  `NodeDaemon.readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge` — previously the last unwired piece of #214/#215/#220, both merged and unreachable — now dispatch through one shared `resolveTrackerDispatch(projectPath, intent)` seam: `{kind:'native'}` behaves exactly as before (proven by the existing native tracker test suite passing untouched), `{kind:'live'}` resolves through `resolveTrackerBackend` and reaches the real `GithubTrackerBackend`/`JiraTrackerBackend`, and an unresolvable mode returns a typed error rather than ever falling back to the local native store. Reading and writing thread `intent:'read'`/`intent:'write'` through that one shared resolver — the only place the two bridge paths are allowed to differ — so they cannot resolve a project to two different tracker accounts.

  `tracker-live-bridge.ts` (new) maps a live `TrackerItemLive` into the native tracker's own `TrackerRecordV1`/`TrackerTypeDefinitionV1` wire shape (only `title`/`workflowStatus` roles are mapped — the two the board actually needs to render and categorize), so the kanban/list views and issue #651's workflow-category grouping need no live-specific rendering path at all.

  `trackerSnapshotErrorV1`/`trackerWriteErrorV1` gain an optional structured `reason: TrackerBackendResolutionErrorV1` (a wire mirror of `resolveTrackerBackend`'s own 10-member error union) alongside the existing plain `message` — checked against the existing shapes first per #631's own instruction, and widened only because a bare string cannot let a client switch on `kind`. The Tracker page's `.tracker-live-gap-note` (added by #672 to name this exact gap) is gone, replaced by a real connectivity-error state: `ErrorNotice` plus a reason-specific `Badge` (mirroring `AccountPinPicker.svelte`'s identical per-kind-badge convention).

  **Proven live now, end to end through a real relay with a stubbed GitHub API:** live-mode read (`list`) and write (`update`), read/write resolving to the identical account, and the `accountNotConnected`/`credentialUnavailable` error cases — including a read against a project with a real, on-disk native record, proving the failure never falls back to it. **Still fixture-only:** Jira live coverage beyond `resolveTrackerBackend`'s own suite, `create`/`transition`/board-drag write-back (Jira transition discovery and GitHub's state-field translation are slice-2 work, not this issue's scope), and pagination past a live snapshot's first page (the bridge's wire schema carries no cursor).

- cce97a8: Move a project's tracker mode from browser `localStorage` to the node (SPEC §7.10, issue #631)

  `TrackerMode` used to be persisted only in the browser's `localStorage`, so a project switched to `live` GitHub or Jira tracking saved that choice per BROWSER, not per project, and the node had no way to see it at all — `NodeDaemon.readTrackerSnapshotForBridge` read the local native tracker store unconditionally because it was the only thing the node had, so a switched project silently kept showing local records.

  `@loombox/node` gets `TrackerModeStore` (`tracker-mode-store.ts`), the exact sibling of `AccountPinStore`: one JSON file under `stateDir`, keyed by a project's absolute `projectPath`, re-validated on every read through `@loombox/protocol`'s `safeParseTrackerMode` — an on-disk value that no longer validates reads back as absent, never repaired into a guessed `{kind:'native'}`. `NodeDaemon` gains `tracker_mode_get_request`/`tracker_mode_set_request` handlers replying with `tracker_mode_response`, mirroring the account-pin request/reply convention exactly, plus a synchronous `this.trackerModeStore.get(projectPath)` read for other daemon code (the bridge dispatch consumes this next).

  `@loombox/relay` gets `tracker_mode_get/set_request`/`tracker_mode_response` added to its existing client↔node routing switch (reusing the account-pin request table) — the protocol schemas alone don't make a message reach anywhere without this.

  `apps/web`'s `tracker-mode-store.ts` gets `createRelayTrackerModeStorage`, now what `TrackerPage.svelte` actually constructs: relay-backed, with a real three-state `Readable<TrackerModeState>` (`'loading'`/`'loaded'`/`'error'`) so a saved mode can never flash the "choose a mode" setup step while its own node round trip is still in flight — collapsing "I don't know yet" into "never chosen" would reintroduce the exact guess issue #209 exists to prevent, one layer up. `TrackerConfigPanel.svelte`'s existing synchronous `TrackerModeStorage` (`get`/`set`) contract is unchanged and untouched.

  **Migration, one-shot, node always wins**: on first load, a mode already saved in `localStorage` from before this change is pushed to the node (`tracker_mode_set_request`) and the local key is cleared — but only if the node had nothing saved; a mode the node already has always wins outright, and a failed push leaves the local key alone so a later retry can still migrate it. A project with no mode saved anywhere still reaches the exact same "choose native or live" setup step as before, once loading settles — the choice now lives on the node and is visible from any device.

  The bridge dispatch (`readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge` actually consulting this mode, via `@loombox/node`'s `resolveTrackerBackend`) and the Tracker page's richer connectivity-error rendering are follow-up work on top of this transport.

### Patch Changes

- Updated dependencies [a1038bf]
  - @loombox/protocol@0.5.0
  - @loombox/crypto@0.0.5
  - @loombox/shared@0.2.2

## 0.4.0

### Minor Changes

- ebcf227: Terminal dock: the terminal's own card and duplicated "Terminal" titlebar are gone (issue #669, design spec §4 D1-2/D2-2). One thin bar remains at the top of the dock, carrying live connection status, the session's real working directory, the shell running the active PTY, and a new-tab control that opens genuinely additional terminals for the same session, each kept alive when you switch away from it. `cwd`/`shell` are real values reported by the node (`terminal_opened`'s payload gained these two fields) — never guessed client-side.

  The dock itself moved to `--color-rail` and dropped its hairline border against the canvas, so the seam is a colour step instead of a line; the resize handle stays discoverable on hover and still works from the keyboard.

### Patch Changes

- 7606627: Group the tracker kanban board into three fixed workflow-category columns instead of one column per raw status

  The board rendered one column per distinct `workflowStatus` value, sorted
  alphabetically — "Done" sorted ahead of "In progress"/"Todo", reading the
  workflow backwards, and a status with zero records never rendered a
  column at all, so the board changed shape as work moved and nothing
  could be dragged into an empty state (issue #651, superseded in scope by
  v7 decision F4-2, `2026-08-04-cockpit-v7-decisions.md` §6).

  The board now always renders exactly three columns, in workflow order —
  To Do / In Progress / Done — derived from the tracker rather than
  hand-written per component: `@loombox/protocol` gets
  `resolveWorkflowCategory`/`groupByWorkflowCategory`, which collapse
  loombox's own local status vocabulary into the same
  `new`/`indeterminate`/`done` ids Jira's `statusCategory` already uses
  verbatim. `TrackerBoard.svelte`/`TrackerCard.svelte` group and move
  records by category id, never a raw status string, and an empty category
  still renders its column and still accepts a drop. Three fixed `18rem`
  columns fit any real laptop width with no horizontal scroller — the
  six-raw-status board this replaces could overflow one (1778px of content
  measured in a 1080px container).

  `@loombox/node`'s Jira and GitHub `TrackerBackend`s gain the matching
  `workflowCategory` field on every `TrackerItemLive` they return
  (`deriveJiraWorkflowCategory` reads Jira's own `status.statusCategory.key`
  verbatim; `deriveGithubWorkflowCategory` maps GitHub's `open`/`closed`
  state, since GitHub has no third state of its own). Neither is reachable
  by the board yet — `NodeDaemon.readTrackerSnapshotForBridge` always reads
  the native store regardless of `TrackerMode` (issue #631) — so only the
  local/native half of this is proven live end to end; the Jira/GitHub
  category derivation is unit-tested against realistic API payload
  fixtures pending #631.

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/protocol@0.4.0
  - @loombox/crypto@0.0.4
  - @loombox/shared@0.2.1

## 0.3.0

### Minor Changes

- 535a2ee: Add the SPEC §7.26 connect/disconnect/pin wire protocol, relay routing, node handlers, and `RelayClient` API for connected accounts (issue #230)

  New `@loombox/protocol` message pairs: `github_connect_start_request`/`_cancel_request`/`_device_code`/`_result` (RFC 8628 device flow, issue #222), `jira_connect_request`/`_response` (API-token connect, issue #225), `connected_account_disconnect_request`/`_response`, and `account_pin_get/set/unset_request` + `account_pin_response` + `account_pin_resolve_request`/`_response` (per-project, per-capability pinning and hard-fail preview, issue #227). None of these ever carry a token, API key, or other secret — only metadata and routing fields.

  `packages/relay`: routes every one of the above directly by `nodeId`, scoped to the requester's account, through one consolidated `pendingAccountRequests` table (mirrors the existing `provision_target_request`/`ssh_discovery_request` pattern); a successful disconnect also forgets the account's synced metadata row (`ConnectedAccountStore.remove`, new on the store interface, in-memory and Postgres).

  `packages/node`: `NodeDaemon` now runs `GithubConnectService`/`JiraConnectService`/`AccountPinStore`/`account-pin.ts`'s resolvers against these messages — the device flow's user code streams back before the terminal result, a disconnect deletes the local keyring secret, and pin resolution surfaces `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as real, distinguishable response states.

  `apps/web`'s `RelayClient` gains a `connectedAccounts` reactive store (fed by the existing `connected_account_list` snapshot) plus `startGithubConnect`/`connectJiraAccount`/`disconnectAccount`/`getAccountPins`/`setAccountPin`/`unsetAccountPin`/`resolveAccountPin`/`refreshConnectedAccounts` — the write-path client API #230's UI is built against.

  **Scope note**: this change ships the wire protocol, relay routing, node handlers, and client API only. The Svelte UI itself (a Settings "Accounts" section, the device-flow/API-token connect forms, the per-project pin picker, and the disconnect confirmation) is tracked separately — see issue #230's own thread for the remaining UI work.

- e89b263: Add GitHub `TrackerBackend` transitions, live tracker slice 2 (SPEC §7.10, issue #215)

  `GithubTrackerBackend` now implements `listTransitions`/`transition`, GitHub's fixed two-state model rather than a discovered per-project workflow: `listTransitions` reports `close_completed`/`close_not_planned` when the issue is currently open, and `reopen` when it is closed, by reading the issue's current `state` first. `transition` applies one of those by `PATCH .../issues/{n} {state, state_reason}` (SPEC §7.10), so closing as completed and closing as not planned are distinct, inspectable outcomes end to end — a subsequent read reports the applied `fields.stateReason`, never a bare "closed". An unknown `transitionId` is rejected with `GithubTrackerAccessError` before any request is made.

  `capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #218). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched.

- a006a1e: Add the Jira API-token connect path (SPEC §7.26, issue #225)

  `@loombox/node` gets the zero-infrastructure Jira connect path: `JiraConnectService` (`jira-connect.ts`) takes `{siteUrl, email, apiToken}`, resolves identity via `GET /rest/api/3/myself` over Basic auth (`base64(email:apiToken)`, `jira-identity.ts`'s `resolveJiraIdentity`), and returns the metadata-only `ConnectedAccount` (issue #221) keyed on `(siteUrl-host, accountId)` — the stable Atlassian `accountId`, never the mutable `email`. This is the specific fix for emdash's `jira-connection-service.ts` single-row limitation (keyed on `email`, one row total): connecting a second Jira site, or a second account on the same site, gets its own `ConnectedAccount.id` and never overwrites an existing one.

  `credentialSource` is `'api_token'`. The email/apiToken pair lives only in the node's OS keyring (`keyring.ts`'s `NodeKeyring`, the same abstraction and file-fallback #222's `GithubConnectService` uses) — Basic auth needs both on every request, and `email` is deliberately not a `ConnectedAccount` field, so it travels with the token as one keyring secret rather than living on the synced row. `getCredential` resolves a `ConnectedAccount` into the request base URL and a ready-to-set `Authorization` header — the seam #214's `JiraTrackerBackend` consumes, agreed over IRC while both issues were in flight.

  No Jira OAuth 2.0 (3LO, #226), per-project pinning (#227, already shipped and reusable as-is), node-presence computation (#228), or connect-flow UI (#230) ship here.

- a3c21b7: Add the Jira `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #214)

  `@loombox/node` gets `JiraTrackerBackend` (`jira-tracker-backend.ts`), the second concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209), after GitHub (#213). `list`/`get`/`create`/`update`/`addComment`/`listBindings` go against Jira Cloud REST v3 for a bound project: `list` searches via `POST /rest/api/3/search/jql` (the modern token-paginated replacement for the deprecated `search` endpoint), comment bodies and any `description` field are converted from plain text into a minimal `{type:'doc', version:1, content:[...]}` Atlassian Document Format document (and flattened back to plain text on read), and every request is composed purely from an injected `credential.baseUrl`, so the same backend works unmodified against both an OAuth-3LO-routed base (`https://api.atlassian.com/ex/jira/{cloudId}`) and a direct API-token site host. `create`/`update` each follow up with a `get` since Jira's own create/update responses don't carry the full issue (`{id, key, self}` only, and `204 No Content`, respectively).

  Credentials come only from an injected `resolveCredential(connectionId): Promise<{baseUrl, authHeader}>`; this backend never runs a connect flow and never touches this package's own `keyring.ts`/`jira-connect.ts` directly.

  `capabilities` reports `comments`/`labels: true`, `transitions`/`boards`/`sprints`/`milestones`/`customFields: false` for this slice. No transitions (#216), no boards/sprints (#217) ship here.

- 2592c10: Add Jira `TrackerBackend` workflow transitions, live tracker slice 2 (SPEC §7.10, issue #216)

  `JiraTrackerBackend` now implements `listTransitions`/`transition` by discovering Jira's real, per-project/per-issue-type workflow at runtime instead of assuming a fixed set: `listTransitions` calls `GET .../issue/{key}/transitions` and maps each entry to `{id, name, requiresFields}`, where `requiresFields` is read straight off Jira's own per-transition workflow-screen field map (`required: true`) — most commonly seen on a "Done"-category move that needs a `resolution`. `transition` posts the chosen id via `POST .../issue/{key}/transitions` and accepts an optional fourth argument (`options.fields`/`options.comment`) beyond `TrackerBackend.transition`'s own three-parameter shape, so a Jira-aware caller can supply what a field-requiring move needs; `options.comment` is converted to Atlassian Document Format the same way `addComment` does, sent as `update.comment`. If Jira's own workflow validation still rejects the request over a missing required field, that surfaces as a new typed `JiraTrackerTransitionValidationError` (carrying Jira's per-field messages) — never silently dropped, and never reported as a success.

  `capabilities.transitions` flips to `true`; `boards`/`sprints` are unchanged (still `false`, deferred to #217). Slice 1's `list`/`get`/`create`/`update`/`addComment`/`listBindings` behaviour is untouched, both REST bases (OAuth 3LO `api.atlassian.com/ex/jira/{cloudId}` and direct-site API-token) are exercised for the new calls, and `@loombox/shared`'s `TrackerTransition` gets a new optional `requiresFields` field (GitHub's already-shipped fixed two-state transitions never set it).

- 99e3583: Native tracker: kanban/list UI with custom type support (SPEC §7.10)

  Adds the client surface for loombox's own local tracker (`packages/shared`'s `NativeTrackerStore`, #210): a full-width Tracker page reachable from the left sidebar once a session is selected, with a kanban board and a priority-sorted/assignee-filtered list view, both driven entirely by `@loombox/protocol`'s new role-driven helpers (`resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) so a built-in Task/Bug/Epic and a project-defined custom type render identically — nothing in this feature branches on a record's `primaryType`.

  `@loombox/protocol` gets `tracker-records.ts`: the wire schema (`TrackerRecordV1`/`TrackerTypeDefinitionV1`) plus four new encrypted, session-scoped wire messages — `tracker_snapshot_request`/`_response` (read) and `tracker_write_request`/`_response` (create/update/defineType) — mirroring `fs.ts`'s existing pattern exactly. `@loombox/node` wires these into `NodeDaemon` against the same `NativeTrackerStore` a future MCP host will bind an agent's `tracker_*` tools to, so a human edit and an agent write land in the same on-disk file. `@loombox/relay` routes both pairs to/from the owning node exactly like `fs_list_request`/`_response`.

  The UI ships: empty state with a "New record" CTA, a retryable `ErrorNotice` (matching the Files panel's #582 "didn't answer in time" wording) for both a wire error and a client-owned bounded-wait timeout, and a loading state that always terminates. The kanban board answers issue #212's mobile requirement directly: at <=767px it renders one column at a time with Prev/Next controls instead of a horizontal scroll of narrow columns. Moving a card between columns has two paths — native HTML5 drag-and-drop for a desktop mouse, and a fully keyboard/touch-operable "Move to" `Select` on every card — both calling the same `RelayClient.updateTrackerRecord`, never local component state. A "New type" dialog lets a project define a custom type's `roles` mapping (which `fields` key holds title/status/priority/assignee), after which every generic surface renders it correctly with no code change.

- 7fc92d2: Add the native tracker's MCP tool contract (SPEC §7.10, §7.7)

  `@loombox/node` gets `tracker-mcp-tools.ts`: `createTrackerMcpTools`, which builds `tracker_list`/`tracker_get`/`tracker_create`/`tracker_update`/`tracker_link_session` — the five tools SPEC §7.10 names for agent access to the native tracker — from a `NativeTrackerStore` plus a session's already-resolved `(projectPath, authorId, sessionId)`. Every input schema is a `.strict()` Zod object with no `projectPath`/`authorId`/`sessionId` field, so a session's tools are structurally bound to its own project and identity rather than merely checked against them; a call naming another project's record id fails exactly like a call naming a made-up one. Output is the real `TrackerRecord` (`fields`/`system`/indexed columns from #210's data model), with no ad-hoc DTO.

  No node-side MCP host consumes this yet — this repo's whole MCP surface today only lets a session declare an _external_ MCP server (stdio/http/sse) that the ACP agent connects to itself; there is no mechanism to run an MCP server inside the node and serve tool calls from it. That's a distinct, larger piece of work, filed as a follow-up issue rather than faked here.

- 344b4c7: Add the lazy per-node connected-account presence check (SPEC §7.26 "Node-locality", issue #228)

  `NodeAccountPresence` (`account-presence.ts`) answers "does this node's OS keyring currently hold a connected account's credential" — the local half of SPEC §7.26's node-locality gap: a `ConnectedAccount`'s metadata row syncs through the relay, but its secret lives in one node's keyring, so a second node can see the account and still not be able to use it. The check is computed lazily (never eagerly probed at startup) and cached per `secretRef` in memory; a connect or disconnect on this node invalidates the cached answer via a new `onCredentialChanged` hook both `GithubConnectService` and `JiraConnectService` now call. `isPresent` returns only a boolean — the credential value never leaves the keyring read that produces it.

  `GithubConnectService` and `JiraConnectService` previously each built their own private `NodeKeyring` (same service name, different file-fallback filename). Extracted into `connected-account-keyring.ts`'s `createConnectedAccountKeyring`, which both connect services and `NodeAccountPresence` now share — necessary for correctness, not just DRY: on this devbox's file-fallback path (no OS keyring session), a presence check built from its own independent file would silently report every real account absent.

  `account-pin.ts` (#227) gains `resolveAccountForWriteOnThisNode`, layered on top of the existing `resolveAccountForWrite` (unchanged, same hard-fail cases, same tests green) — throws the new `AccountNotPresentOnNodeError` when the resolved account is not present on this node, a distinct outcome from "no pin" (`AccountPinRequiredError`) and "dangling pin" (`AccountPinDanglingError`).

  Not shipped here: the multi-node wire/UI flow that asks a _different_ node whether it holds a pin's secret (SPEC §7.26 frames that as reusing §7.21's node-health reachability channel) — this issue is scoped to the local, per-node computation only.

- e05423a: Add per-project test/lint/build command configuration and auto-detection (SPEC §7.15, issue #245)

  A project's test/lint/build commands can now be read, saved, and auto-detected through the owning node: `TestRunnerConfigStore` (`@loombox/node`) persists them per project (mirrors `PermissionPolicyStore`'s JSON-file shape), and `detectTestRunnerCommands` proposes commands from `package.json`'s `scripts` block via whichever `ExecutionTarget` the project's session runs on (`local` or `ssh:`), picking `pnpm`/`yarn`/`npm` syntax off the project's lockfile. Detection only ever proposes a command for a script that genuinely exists — never a guessed default for a project with nothing detectable.

  Five new v1 wire messages (`test_runner_config_get`/`_set`/`_detect` client-to-node, `test_runner_config_result`/`_detected` node-to-client), routed/fanned out by the relay exactly like `fs_list_request`/`fs_list_response`, sealed under the session key so no command string ever reaches the relay in the clear. `RelayClient` gains `getTestRunnerConfig`/`setTestRunnerConfig`/`detectTestRunnerConfig`; `ProjectConfigPanel` gains a new "Test, lint & build" section (`TestRunnerConfigPanel`) with per-command explicit save and an "Auto-detect" action whose suggestions are shown for confirmation and never applied without an explicit Accept click.

  This ships the configuration half of SPEC §7.15's test runner (issue #245); the streaming execution half (issue #244, running the configured commands with live output and cancellation) is tracked separately.

- 635e20d: Add the streaming test/lint/build runner surface (SPEC §7.15, issue #244)

  Running a project's configured test/lint/build command (issue #245's config half) now streams live results from the cockpit instead of requiring a raw terminal. `packages/node/src/test-runner-process.ts` runs the command via `sh -c` on either target: locally with `child_process.spawn({ detached: true })`, so a cancel kills the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the launcher; over `ssh:` it reuses the existing `RemoteProcessRunner` (setsid+fifo+log-tail) rather than opening a second channel, adding its own exit-code side-channel on top since that runner never captured one for a background job, and its cancel goes through `RemoteProcessRunner.stop()`, whose `setsid` branch now kills the whole remote process group (issue #642/#645). Both targets classify "command not found" as a uniform POSIX 127 instead of branching on ENOENT vs. remote shell text. `NodeDaemon` evaluates the project's permission policy (`evaluateCommandLine`, the same entry point `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) before ever spawning, so a denied command surfaces as `could_not_start` with a policy reason and never runs.

  Five new v1 wire messages (`run_start`/`run_cancel` client-to-node, `run_started`/`run_output`/`run_exit` node-to-client), modeled on `terminal.ts`, routed/fanned out by the relay exactly like `terminal_open`/`terminal_output`, sealed under the session key so no command, output, or outcome ever reaches the relay in the clear. `RelayClient` gains `startRun`/`cancelRun`/`onRunOutput`/`runsFor`. The right sidebar's Files/Config sub-tabs gain a third "Runner" tab (`RunnerPanel.svelte`): one Run/Cancel action per configured command, its combined output streaming live (reusing the display-only `TerminalOutput` component), settling to a pass/fail/could-not-start state with the real exit code.

  Cancelling reaps the whole process tree on both targets, including forked grandchildren — verified with a `sleep 30 &`-forking fixture at the process, `NodeDaemon`, and (ssh) `RemoteProcessRunner` layers. Closing a node now also cancels every still-running local/ssh run instead of leaking it, the same way it already does for open terminals.

### Patch Changes

- 934301d: Fix `buildStopScript`'s `setsid` branch to kill the whole process group, not just the launcher (issue #642)

  Stopping an `ssh:` session that had fallen back to `setsid` (the common case on a plain server without tmux/screen) ran `kill "$(cat pid)"`, which signals exactly one process. `setsid` makes the launched process a session leader, so its pid is also its process-group id, and anything real it launches (any agent or command that forks children) kept running on the remote host after "stop" returned. The `tmux`/`screen` branches never had this problem since they tear the whole session down.

  `buildStopScript`'s `setsid` branch now sends `TERM` to the process group (`kill -TERM -"$pid"`, the leading dash), polls for up to 2 seconds so a well-behaved child gets a chance to clean up, then escalates to `KILL -"$pid"` for anything still alive. `buildIsRunningScript` is unchanged (it still reads the leader's own pid with `kill -0`), and stays correct because the stop script itself blocks until the group is confirmed dead or force-killed before its `exec()` resolves, so there is no window where a caller can observe a stopped session as still "alive".

  New tests in `packages/node/src/ssh/remote-process-runner.test.ts` (using the `remote-sessions-test-sandbox` harness from #518) launch a `setsid` command that forks a real child, stop the session, and assert the child itself is gone (not just the launcher), plus confirm `isRunning()` still reports correctly across the new stop script.

- Updated dependencies [79f9f19]
- Updated dependencies [535a2ee]
- Updated dependencies [2592c10]
- Updated dependencies [99e3583]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
- Updated dependencies [29da402]
  - @loombox/providers-core@0.3.0
  - @loombox/protocol@0.3.0
  - @loombox/shared@0.2.0
  - @loombox/supervisor@0.1.2
  - @loombox/crypto@0.0.3

## 0.2.0

### Minor Changes

- c907512: Add per-project, per-capability connected-account pin resolution (SPEC §7.26, issue #227)

  `@loombox/node` gets `account-pin.ts`: a pure resolver over the tri-state `AccountPinMap` from SPEC §7.26 (`{ github?: string | null; jira?: string | null; [capability]: string | null | undefined }`) — an absent key means unconfigured, an explicit `null` means opted out, a string is a pinned `ConnectedAccount.id`. `resolveAccountForRead` and `resolveAccountForWrite` are two distinct functions (not one function plus a flag) so a caller cannot forget the difference: a write-back action always throws `AccountPinRequiredError` without an explicit pin, while a read may default silently only when exactly one candidate account matches, throwing `AmbiguousAccountError` for two or more. Both hard-fail with `AccountHostMismatchError` when a pinned account's decoded host/site (via `@loombox/protocol`'s `parseConnectedAccountId`, never string-slicing) doesn't match the project's configured target, mirroring emdash's `githubApiAccountHostMismatch` guard — never a silent fallback to a different account. `AccountPinDanglingError`/`AccountPinMalformedError` cover a pin naming an unknown or unparsable id.

  `account-pin-store.ts` persists the map node-side as one JSON file keyed by `projectPath`, mirroring `permission-policy-store.ts`/`mcp-config-store.ts`'s existing per-project storage shape. `setPin`/`unsetPin` are deliberately separate operations (an explicit `null` opt-out vs. deleting the key back to unconfigured) so the tri-state survives a save/reload round trip intact.

  No tracker backend, no wiring into a write-back call site, no management UI (#230), no safe-disconnect scan (#229), and no node-presence computation (#228) ship here — this is the resolution primitive those build on.

- ac64679: Add the GitHub connect device flow (SPEC §7.26, issue #222)

  `@loombox/node` gets the default GitHub connect path: `runGithubDeviceFlow` (`github-device-flow.ts`) runs RFC 8628's device authorization grant against `github.com` with a public OAuth App client id only (no client secret shipped or required — configurable per deployment via `LOOMBOX_GITHUB_CONNECT_CLIENT_ID`, `github-connect.ts`'s `resolveGithubConnectClientId`), requesting exactly `repo read:user read:org read:project`. It handles every real poll state — `authorization_pending` keeps polling at the server-given `interval`, `slow_down` increases it (honoring an explicit server `interval` or GitHub's documented +5s default), `expired_token`/`access_denied` end the flow with a named `GithubDeviceFlowError`, and an `AbortSignal` cancels it immediately rather than waiting out the current interval.

  `resolveGithubIdentity` (`github-identity.ts`) resolves `GET /user` and rejects any response with no numeric `id` — never falls back to `login`. `GithubConnectService` (`github-connect.ts`) orchestrates both, writes the resulting token to this node's OS keyring (`keyring.ts`'s `NodeKeyring`, same abstraction and file-fallback as `mcp-secrets.ts`), and returns the metadata-only `ConnectedAccount` (issue #221) a caller announces through the existing `connected_account_announce` wire path — the token never appears in that returned value, in a log line, or in any error message.

  No `gh` CLI import (#223), PAT paste (#224), Jira paths (#225, #226), per-project pinning (#227), node-presence computation (#228), or management UI (#230) ship here.

- aad37f8: Add the GitHub `TrackerBackend`, live tracker slice 1 (SPEC §7.10, issue #213)

  `@loombox/node` gets `GithubTrackerBackend` (`github-tracker-backend.ts`), the first concrete implementation of `@loombox/shared`'s `TrackerBackend` extension point (#209). `list`/`get`/`create`/`update`/`addComment`/`listBindings` all go straight to GitHub REST (`docs.github.com/en/rest/issues/*`) for a bound `owner/repo`: `list` paginates via the `Link` header's `rel="next"` (carried opaquely through `TrackerListFilter.cursor`/`TrackerListPage.nextCursor`), a `403` with `x-ratelimit-remaining: 0` raises a distinct `GithubTrackerRateLimitError` with a computed `retryAfterMs` instead of being reported as a permission problem, a `404` raises `GithubTrackerAccessError` (GitHub returns 404, not 403, for a token with no access to a private repo/issue), and pull requests — which GitHub's issues endpoints return alongside real issues — are filtered out of `list` and rejected explicitly from `get`.

  Credentials come only from an injected `resolveCredential(connectionId): Promise<{token}>`; this backend never runs OAuth and never touches this package's own `keyring.ts`/`github-connect.ts` directly, since the real connected-accounts credential registry SPEC §7.10 describes doesn't exist in a directly callable shape yet.

  `capabilities` reports `comments`/`labels`/`milestones: true`, `transitions`/`boards`/`sprints`/`customFields: false` for this slice. No transitions (#215), no boards/Projects v2 (#218), no Jira backend (#214) ship here. Server-side only: this lives in `@loombox/node`, which is not in `apps/web`'s dependency graph, direct or transitive.

- 804933f: Add the native tracker's `TrackerRecord` data model and node-side storage (SPEC §7.10 "Native mode")

  `@loombox/shared` gets `tracker-record.ts`: `TrackerRecord` (a `fields` business-data bag, a `system` object holding author/linked commits/PRs/sessions/activity/comments, and real queryable columns — `id`/`primaryType`/`typeTags`/`issueNumber`/`archived`/`createdAt`/`updatedAt` — around both), `TrackerTypeDefinition` with a `roles` mapping (`title`/`workflowStatus`/`priority`/`assignee`), the three built-in types (Task/Bug/Epic), and `resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`, the role-driven query helpers that make a kanban board, priority sort, and assignee filter work identically whether a record's type is built-in or project-defined. `buildTrackerIndex` builds the in-memory secondary indexes (by id/issue number/primary type/tag, plus active/archived partitions) a non-SQL store needs for real lookups. No `syncStatus`/team-sync field exists anywhere in this shape, enforced by both a compile-time type guard and a runtime test — the native tracker is per-operator by design (SPEC §7.10).

  `@loombox/node` gets `NativeTrackerStore`: a single JSON file per node (mirroring `SessionStore`/`McpConfigStore`'s established shape), keyed by project path, holding each project's custom type definitions and tracker records. This follows the node's existing persistence idiom deliberately rather than introducing a new SQL dependency: every store this package already has is a JSON file, the one SQL engine in the monorepo (`better-sqlite3`) is only ever a Postgres test double for the relay's Better Auth tables, and a native tracker's per-operator, single-writer data doesn't need the relational query planning a real database buys. `create`/`get`/`update`/`list`/`defineType`/`linkSession`/`linkCommit`/`linkPullRequest`/`addComment` round-trip both built-in and custom-type records; `index()` exposes the store's current secondary indexes.

  No consumer wires this into the MCP tool contract or a UI yet — that's issues #211 and #212.

- fa0dbd1: Add a per-project permission policy (SPEC §7.17): allow/deny glob rules matched against the command an agent's process runs and the network destination it reaches, enforced at the node rather than relying on ACP's own agent-discretionary `session/request_permission`.

  Deny always wins over allow; a project's saved policy lives in `PermissionPolicyStore` (`~/.loombox/node/permission-policy.json`, no settings UI yet); an unconfigured project keeps today's behavior (nothing blocked).

  Enforced today at every interactive terminal this node opens (`PolicyEnforcedPty`, local and `ssh:` alike): a denied line is never forwarded to the real shell, the pending input is cleared, and a rejection is written back into that terminal's own output. Also wired into `NodeDaemon.getExecutionTarget()`'s exec seam (`PolicyEnforcedExecutionTarget`) for the project-scoped commands a future editor/git-management feature will drive through it — nothing project-scoped calls that seam yet, so this is not a live gate today beyond the terminal.

  Not covered: an agent's own in-process tool calls (Claude Code/Codex run their own bash tool internally; this node declares `clientCapabilities.terminal: false` to ACP, so it never sees those individual commands) — that gap is namespace/bind-mount sandboxing's job (issue #257). Also named, not closed: `sudo`/`nice`/`ionice` command-prefix unwrapping, and `ssh:`-target symlink resolution.

- a449b22: Add per-target concurrency caps with a FIFO overflow queue (SPEC §7.16)

  `@loombox/node` gets a `SessionConcurrencyGate` (`session-concurrency-gate.ts`), the one chokepoint every session's launch — `local` and `ssh:` alike — passes through in `NodeDaemon.createSessionInternal`/`scheduleSshSession`. Starting a session beyond its target's configured cap queues it (wire status `'queued'`, distinct from the existing `'starting'`) instead of launching it; a session that finishes, crashes, is killed, or is stopped (`session_archive_request`) releases its slot and hands it to the oldest still-queued session on that target, FIFO. A queued session can be cancelled (also via `session_archive_request`) and never launches. Lowering a target's cap never kills sessions already running past the new limit, it only gates future starts.

  The default cap differs by target kind, since their known resources differ: `local` defaults to this host's own CPU core count (`os.cpus().length`, the same source `resource-sampler.ts` already reads), while an `ssh:` target defaults to a conservative `2` (its real capacity is unknown until an operator sets `SshTargetConfig.maxConcurrentSessions` or turns on resource sampling). `local`'s own cap is configurable via `NodeDaemonOptions.localMaxConcurrentSessions` / `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS` / the config file's `localMaxConcurrentSessions`.

  `@loombox/protocol` widens `sessionStatusV1` with `'queued'`, alongside the existing `'starting'` — both synthesized by the node rather than passed through from the agent process. This is an additive enum change: an older peer simply drops a `session_status` envelope carrying a value it doesn't recognize.

  Also fixes a real bug found while building this: `NodeDaemon.close()`/the new per-session stop path called `AgentSupervisor.stop()` with the loombox-level session id, but the supervisor keys its sessions by the ACP-level id the agent's own `session/new` response assigns — the wrong key meant `.stop()` never actually found the session, so the child agent process was never killed, only reaped incidentally when the whole node process exited.

### Patch Changes

- Updated dependencies [5118b26]
- Updated dependencies [804933f]
- Updated dependencies [a449b22]
- Updated dependencies [d09e12b]
- Updated dependencies [c97a2cf]
- Updated dependencies [fc2c12e]
  - @loombox/protocol@0.2.0
  - @loombox/shared@0.1.0
  - @loombox/providers-core@0.2.0
  - @loombox/crypto@0.0.2
  - @loombox/supervisor@0.1.1

## 0.1.0

### Minor Changes

- c0d6291: Make projects real, and give the cockpit one navigation instead of two.

  `Project` is now a first-class thing in the client rather than a `projectPath` string buried in each session's encrypted envelope, so you pick a folder once and spawn sessions into it. Sessions are listed in a tree under their project, and Inbox, Nodes and Settings became pages in the main area instead of drawer tabs that the sidebar also linked to. The drawer keeps only what belongs to the open session: Files, Terminal, Config.

  On the wire, a session's private envelope gains an optional `worktree` field, which is SPEC 7.1's per-session isolate-or-work-in-place choice finally reaching the client, and the target fs listing gains an optional `gitRepo` flag so the picker knows whether to offer it. Both are additive, so a node or client older than its peer keeps parsing. The node also stops requiring a git repository for in-place sessions, which SPEC 6 has always said it should support.

- c86aa72: Survive a node restart, bound the agent spawn, and make the surface coherent

  A node restart no longer forgets every session it owns, so rows stop pointing at sessions nobody tracks and worktrees stop leaking. The agent spawn is bounded, and a session is announced as soon as its worktree exists rather than only once the agent is up.

  The node status numbers were wrong: CPU was a load average mislabelled as utilisation, and RAM counted reclaimable page cache as used. Both fixed, and the reading now carries the machine's hostname, platform and arch so a target called "Local" says which machine it is.

  On the client: one page title instead of two, one Settings entry instead of three, a real form language instead of eight copies of the same hand-rolled input, dense node rows instead of three progress bars, and a transcript that states who is speaking with a composer that is part of it rather than a chat box bolted underneath.

- 8f305d0: Survive a relay restart, follow the agent, and let a session be archived.

  A relay redeploy used to brick every node until someone restarted it by hand: a
  peer built on the WHATWG WebSocket cannot send a transport-level ping, so nodes
  and clients now probe liveness with a `ping`/`pong` pair the relay answers and
  advertises as a `heartbeat` capability, and both reconnect with backoff from a
  single handler wired to close _and_ error.

  The transcript now follows the agent's newest output instead of sitting pinned
  at the first frame, detaching when you scroll up to read.

  Sessions can be archived from the row menu, optionally taking their git
  worktree and branch with them, so a project stops accumulating one worktree per
  session that nobody would ever prune by hand.

- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.

### Patch Changes

- 4f7dcd4: Actually wire the per-target provider probe. `main.ts` never passed `providerCandidates`, which defaults to an empty list and makes the probe a documented no-op, so every production target announced `providers: []` and clients correctly refused to create sessions on it. The candidate list now comes from `AgentSupervisor`'s own default provider set (`DEFAULT_PROVIDER_REQUIREMENTS`), so the advertised set and the spawnable set cannot drift.
- 10df3db: Let a resident node resolve its own account from the token it actually holds.

  A node that linked itself the intended way, through the device-authorization
  flow (it prints a short code, you approve it in the browser, it persists the
  token it mints), then died on startup with "authToken (LOOMBOX_AUTH_TOKEN) is
  not a valid, active Better Auth session". It was holding a token the relay
  accepted on the WebSocket handshake seconds later: the node asked Better Auth's
  `/api/auth/get-session`, which only knows browser sessions, while a device
  token lives in the relay's own `device_tokens`. The only way through was
  setting `LOOMBOX_ACCOUNT_ID` by hand, which defeats the point of the flow.

  The relay now answers the question itself, via `GET /account`, using the same
  `resolveAccountId` the WS handshake uses, so device tokens, Better Auth
  sessions and the no-Postgres dev stub all resolve identically. The node asks
  that endpoint, and falls back to the old Better Auth lookup only when a relay
  is too old to have the route, since self-hosters upgrade relay and node
  independently.

- 3705e0b: Stop tests writing into the developer's real node state directory. `defaultNodeStateDir()` now throws under Vitest, so a test that forgets to inject a `stateDir` fails at the first call instead of corrupting `~/.loombox/node`. Session persistence made that omission destructive: six test files had already left 35 phantom session records in mine, which a real node reloads on boot.
- Updated dependencies [c0d6291]
- Updated dependencies [4f7dcd4]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [55161ed]
- Updated dependencies [a36e07a]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
  - @loombox/supervisor@0.1.0
  - @loombox/providers-core@0.1.0
  - @loombox/crypto@0.0.1
