# @loombox/web

## 0.7.0

### Minor Changes

- 7b8e591: Per-project agent instructions surface (SPEC §7.18; issue #260)

  Surfaces and edits a project's own `AGENTS.md`/`CLAUDE.md` directly from the cockpit, read from and written back to the session's real worktree — not a new store, a read/write surface over a real file.

  - `@loombox/protocol`'s new `agent-instructions.ts` adds `agent_instructions_get_request`/`_response` (envelope-less request, mirrors `git_diff_request`) and `agent_instructions_set_request`/`_response` (enveloped on both sides, mirrors `git_hunk_action_request`). `agent_instructions_get_response`'s `files` array reports every one of `AGENTS.md`/`CLAUDE.md` that actually exists right now (0, 1, or both) — the client decides "offer to create" vs "let the user pick" from that list's length. The write side is optimistic-concurrency, not last-write-wins: every file state carries a `hash` (sha256 of its content), sent back as `baseHash` on save; a stale or missing `baseHash` comes back `outcome: 'conflict'` with what is actually on disk right now, never silently overwritten.
  - `@loombox/relay` routes the new pair exactly like the `fs_read_*`/`git_hunk_action_*` families — always blind to the envelope's contents.
  - `@loombox/node`'s new `agent-instructions.ts` reads and writes the files through the session's `ExecutionTarget` (works identically against a `local` or an `ssh:` target, the same seam `git-diff.ts` uses), with a `readdir` reachability canary distinguishing "worktree unreachable" from "file simply doesn't exist yet". `NodeDaemon` wires the two new handlers in exactly the same "decrypt, apply, always reply" / "no live bridge needed" shape as its `fs_read`/`git_hunk_action` siblings.
  - `@loombox/web`: `RelayClient` gains `getAgentInstructions`/`setAgentInstructions` (same "resolves either way, rejects only when unusable" contract as `readFile`/`applyGitHunkAction`). New `AgentInstructionsPanel.svelte` mounts in `ProjectConfigPanel`'s Config tab: both files are always offered as tabs, whether or not they exist yet (a missing file opens as an empty, clearly-labeled create draft, defaulting to `AGENTS.md`); a `'conflict'` save outcome shows what changed on disk and requires an explicit "Reload latest version" click before anything can be saved again.

  Verified: `pnpm --filter @loombox/protocol exec vitest run src/v1/agent-instructions.test.ts src/v1/message.test.ts` (30 tests), `pnpm --filter @loombox/relay exec vitest run src/relay.test.ts src/message-routing.test.ts` (300 tests), `pnpm --filter @loombox/node exec vitest run src/agent-instructions.test.ts src/node-daemon-agent-instructions.test.ts src/node-daemon.test.ts` (98 tests — the first two new: a real temp-dir pure-module suite and a real relay/node/worktree wire round trip proving the conflict-safe write end to end), `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/AgentInstructionsPanel.test.ts src/lib/components/ProjectConfigPanel.test.ts` (190 tests), `pnpm --filter @loombox/{protocol,relay,node,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5086 passed, 1 pre-existing unrelated failure — `packages/providers/codex/src/codex-acp-capabilities.test.ts`, the known #158/#182 cross-branch mismatch already fixed on `main` via #834, which landed after this branch's base commit `e087fb9`; this branch never touches any `providers-codex`/`providers-core` file).

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

- 9c20ae1: Surface failing CI checks in the attention inbox (SPEC §7.13/§7.14; issue #243)

  Issue #239's CI check watcher already streams a session's latest check-run state to the client over `ci_check_status`. This wires that state into the cross-project attention inbox as a real, live `'ci_failure'` item, following the exact conventions the inbox already uses for `permission`/`awaiting_input`/`session_outcome`:

  - `RelayClient` decrypts `ci_check_status` into a new per-session store and recomputes the inbox whenever it changes, same as the transcript/permission-queue stores already do. A session contributes a `'ci_failure'` item exactly while its latest known state is `'failing'` - independently of its live status, so a session can be idle/finished and have a failing check on its open PR at the same time. The item clears the instant a later poll reports anything else (`'passing'`, `'pending'`, `'unknown'`), so a check going green never leaves a stale item behind, and a flapping check never accumulates duplicates - it is always the one latest reading for that session.
  - The item carries what's needed to act on it: the session, the failing check run names (`failingChecks`), and the PR's own URL/number (`prUrl`/`prNumber`) so a renderer can link straight to it.
  - New `@loombox/shared` export `isFailingCiConclusion`: the same conservative "which GitHub check-run conclusions count as a failure" judgment the node's own `ci-check-watcher.ts` uses, now also available to the browser so it names the exact same failing check(s) rather than guessing independently.
  - `AttentionInbox.svelte` names the failing check(s) in the row body instead of a bare "CI check failed", and adds a "View PR" link for a `'ci_failure'` row. `'review_request'` remains the one still-unwired extension point (needs the tracker integration work, v2).

  Verified: `pnpm --filter @loombox/web exec vitest run src/lib/relay-client.test.ts src/lib/components/AttentionInbox.test.ts src/lib/components/pages/InboxPage.test.ts` (196 tests), `pnpm --filter @loombox/shared test` (24 tests), `pnpm --filter @loombox/web typecheck`, `pnpm --filter @loombox/shared typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 12cc8ec: Load and concurrency-limits UI (SPEC §7.16; issue #255)

  Surfaces what the node already knows about its own load and per-target concurrency, and makes a queued session's wait explicable rather than indistinguishable from "slow".

  - `@loombox/protocol`'s `targetDescriptor`/`targetListEntry` gain optional `maxConcurrentSessions`/`maxConcurrentSessionsSource` (`'configured' | 'default'`) — additive, exactly like `loadPercent`/`hostname` before them: an older node/relay simply omits them.
  - `@loombox/node` computes and forwards both fields in `target_announce`, straight off `SessionConcurrencyGate.maxFor` and whether the operator actually set `LOOMBOX_LOCAL_MAX_CONCURRENT_SESSIONS`/`localMaxConcurrentSessions` (or, for an `ssh:` target, its own `SshTargetConfig.maxConcurrentSessions`) versus the node's own computed default.
  - `@loombox/relay` forwards the same two fields verbatim from a node's announce into `target_list`'s `TargetListEntry`, exactly like `providers`.
  - `@loombox/web`: a queued session's row badge now reads its own wait context ("Queued: waiting for a slot", or "Queued: position N of M waiting for a slot" when more than one session is queued on the same target) instead of a bare "Queued" indistinguishable from "starting slowly" — computed client-side (`target-concurrency.ts`) from data already on the wire (each session's `nodeId`/`targetId`/live status/its transition timestamp, via the new `RelayClient.statusUpdatedAtFor`), no new wire message needed for the position itself. Settings > Nodes (`TargetStatusView.svelte`) now shows each target's `running/cap` slot count, the cap's honest source, and a queued-count badge when nonzero, right next to the existing load/RAM/disk readings.

  Verified: `pnpm --filter @loombox/protocol build` (typecheck), `pnpm --filter @loombox/node exec vitest run src/node-daemon-target-concurrency-announce.test.ts src/session-concurrency-gate.test.ts src/node-daemon-target-providers.test.ts` (18 tests), `pnpm --filter @loombox/web exec vitest run src/lib/target-concurrency.test.ts src/lib/components/TargetStatusView.test.ts src/lib/components/pages/SettingsPage.test.ts src/routes/page.test.ts` (163 tests), `pnpm --filter @loombox/web exec playwright test tests-e2e/target-concurrency-mobile.spec.ts` (2 tests, real relay/node/browser, 390px viewport), full `pnpm test` (5365 passed, 2 skipped, 442 files), `pnpm --filter @loombox/{node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, full `pnpm format:check`.

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

- 88c9d09: Client-side in-transcript search (SPEC §7.19; issues #262/#263)

  `Mod+F` (or the "Search transcript" command palette entry) opens a search bar over the open session's transcript. Search runs entirely client-side against the reducer's own `TranscriptState.items` array (`$lib/transcript/search.ts`), never against the DOM — the windowed transcript renderer (issue #755) only ever mounts a scrollable slice of that array, so a naive DOM/native-find scan would silently miss any match outside it. A match found this way is navigated to with the same `TranscriptJumpTarget` mechanism issue #740 shipped for "jump to this file's diff": the target row is forced into the mounted window and scrolled into view, then highlighted using the CSS Custom Highlight API (`$lib/transcript/search-highlight.ts`), never manual DOM text-node wrapping.

  Search covers message text (including agent thoughts, regardless of their current collapse state) and tool-call titles/diff file paths; it deliberately never indexes a tool call's raw input, content, or diff body text — see `search.ts`'s own doc comment for the full, explicit field list. A linear scan measured well under 10ms even at 100,000 transcript items in this repo's own dev container.

  This ships the search mechanism common to issues #262 and #263; it does not add the multi-project archive of past/ended sessions #262 also describes (listing sessions with a cost rollup, browsing one read-only) — see the PR description for the scope decision.

### Patch Changes

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
- Updated dependencies [9400cb4]
- Updated dependencies [05f8339]
- Updated dependencies [eb16820]
- Updated dependencies [e087fb9]
- Updated dependencies [ed2392d]
  - @loombox/providers-core@0.5.0
  - @loombox/protocol@0.8.0
  - @loombox/shared@0.3.0
  - @loombox/crypto@0.1.1

## 0.6.0

### Minor Changes

- f2d51ee: Curated catalogue of known-good ACP agents, one click instead of a command line (D1-3 second half, issue #749)

  `@loombox/providers-core`: a new `agent-catalogue.ts` (browser-safe, exported from both `.`/`./browser`) mirroring `mcp-presets.ts`'s exact pattern — `AGENT_CATALOGUE`, a small list of `AgentCatalogueEntry` (a blurb, a literal `CustomAgentRecordV1`-shaped `config`, and a `verification` record naming the exact version checked, the date, and the doc URL read), plus `instantiateAgentCatalogueEntry` (the one path from an entry to a real record, routed through the same `customAgentRecordV1` validator a hand-typed custom agent goes through). Ships two entries verified straight from their own docs: Gemini CLI (`gemini --acp`, `@google/gemini-cli@0.54.0`) and Qwen Code (`qwen --acp`, `@qwen-code/qwen-code@0.21.6`) — Claude Code and Codex are already registered providers, so they're not catalogued. `isAgentCatalogueEntryStale`/`agentCatalogueEntryStaleAt` turn "nobody re-verified this in a while" into a loud failure two ways: `agent-catalogue.test.ts` fails the day any entry crosses its own staleness window, and `instantiateAgentCatalogueEntry` itself throws `StaleAgentCatalogueEntryError` for an already-stale entry instead of silently handing back a possibly-wrong invocation. Convenience only, never a second trust tier: the node's own allowlist (`custom-agent.ts`, issue #748) is unchanged and untouched by any of this.

  `@loombox/web`: `custom-agent-store.ts` grew `addCustomAgentFromCatalogueEntry` (the catalogue counterpart of `mcp-server-store.ts`'s `addMcpServerFromPreset` — expands an entry via `instantiateAgentCatalogueEntry` and adds it through the exact same `addCustomAgent`). `NewSessionDialog`'s custom-agent section now leads with a "Quick-add from the curated catalogue" row: one button per `AGENT_CATALOGUE` entry, its verified-against version/date shown as a visible badge (not just a source comment), and a stale entry rendered as a danger badge instead of a normal one. Picking an entry pre-fills and selects it exactly like a hand-typed custom agent, then — when the injected client implements the new optional `NewSessionClient.probeCustomAgent` — immediately probes it against the project's own node/target and shows, in plain language, whether this specific node has actually allowlisted the command (`not on this node's allowlist yet…`) or is ready to run. The probe never gates the add itself: picking a catalogue entry always succeeds client-side, exactly like typing the same command by hand would.

- 7932180: Checkpoint list, on-demand "checkpoint now", and a restore confirmation dialog (SPEC §7.20, issue #268) over the wire surface #603/PR #805 built. `RelayClient` gains `createCheckpoint`/`listCheckpoints`/`previewCheckpointRestore`/`restoreCheckpoint`, each resolving the whole `checkpoint_*_result` outcome union (`'ok'` | `'error'`, `restoreCheckpoint` also `'confirmation_required'`) rather than throwing for a named `errorType` — an `ssh:` session's `unsupported_target` or a live turn's `turn_in_progress` are expected, renderable states, not transport failures.

  A new "Checkpoints" right-sidebar sub-tab (`CheckpointPanel.svelte`, beside Files/Config/Runner) lists a session's checkpoints oldest-to-newest-on-screen with their label and time, offers a "Checkpoint now" affordance with an optional label, and opens `CheckpointRestoreDialog.svelte` per row. The dialog loads `checkpoint_restore_preview`'s own `RestorePreview` before ever enabling its "Restore checkpoint" button, states exactly what will be discarded (uncommitted changes) versus preserved (real commits since the checkpoint), and gives a sharper warning when `isWorkInPlace` is set. An `ssh:` session's list renders a dedicated "checkpoints aren't available here" state instead of a dead "Checkpoint now" button or a generic error; a restore refused mid-turn shows the node's own `turn_in_progress` message verbatim, never a generic failure.

  Kept deliberately scoped to the checkpoint list and its dialog — issue #747 (rewind) consumes the same `GitCheckpointStore` engine from the transcript side in parallel and owns its own files.

- e91f51f: Remember the last-used model/effort/mode per agent, with a project-scoped override that wins (Zed-parity decision D4-3, issue #753)

  Every session used to start at the agent's own defaults; the config-option catalogue is agent-declared per session and nothing persisted between sessions. Now:

  - `$lib/config-option-defaults.ts` remembers each provider's last-used value per category, account-wide — one un-parameterized `localStorage` key holding every agent's values, the same persistence mechanism `$lib/accent.ts`/`$lib/expand-thoughts.ts` already use for a single account-scoped preference (D4-2).
  - `$lib/config-option-overrides.ts` layers a project-scoped override on top, stored the same per-project-path way `$lib/mcp-server-store.ts` already stores its own config (`mcp-server-store.ts:44`). A project override beats the account-wide value when both exist (D4-3's core rule).
  - `$lib/config-option-resolution.ts` resolves the two against a session's live catalog: project beats account beats the agent's own default, and a remembered/overridden value the agent no longer offers is dropped silently rather than sent — `RelayClient.setConfigOption` already rejects an unsupported value (issue #718), so this never resurrects that failure mode.
  - `+page.svelte` applies a brand-new session's resolved defaults the moment its real catalog arrives (never optimistically — the agent's own ack is still the only source of truth), and remembers a genuine user pick's ack as the account's new last-used value once it lands. Applying a remembered/overridden value never itself counts as a fresh "last used" pick — otherwise a project's own override would immediately bleed back into the account-wide value the moment its ack arrived, the exact cross-project bleed D4-3 exists to prevent.
  - `ConfigBar.svelte` shows which layer produced each category's current value — a `Badge` per category (`Project`/`Account`/`Agent default`) plus a `title` summary on the trigger — and a `pin`/`unpin` `IconButton` per category to set or clear that project's override. This is the named cost the D4-3 pick calls out explicitly: "whichever surface ships this has to show which one is currently winning."

  Session templates (D4-4, issue #259) stay explicitly out of scope.

  `NewSessionDialog`'s `onCreated` callback now also passes the provider id the session was created with, so the caller can resolve which agent's remembered defaults/overrides apply without a race against the session announce.

  Verified: `pnpm --filter @loombox/web exec vitest run src/lib/config-option-defaults.test.ts src/lib/config-option-overrides.test.ts src/lib/config-option-resolution.test.ts src/lib/components/ConfigBar.test.ts src/lib/components/NewSessionDialog.test.ts src/routes/page.test.ts` (129 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 97598db: Custom ACP agents defined per project, gated by a node-side allowlist (D1-3, issue #748)

  `@loombox/protocol`: `customAgentRecordV1` (name/command/args/env/defaultMode/defaultConfigOptions) rides `sessionPrivateMetaV1.customAgent`, encrypted exactly like `title`/`projectPath`. A new `custom_agent_probe_request`/`custom_agent_probe_response` pair (mirrors `target-fs.ts`) lets a client check installed-vs-allowed on a target before ever creating a session. `sessionStatusEventV1` grew an optional `reason` so an `'error'` status can carry a verbatim message.

  `@loombox/node`: `custom-agent.ts` — `assertCustomAgentAllowed`/`isCustomAgentCommandAllowed` (the actual security boundary), `CustomAgentNotAllowedError`, `createCustomAgentProvider`. The allowlist itself (`NodeCliConfig.customAgentAllowlist`) is file/env-only (`LOOMBOX_CUSTOM_AGENT_ALLOWLIST` or the config file's `customAgentAllowlist`), defaults to `[]` on a fresh node, and has no wire message that reads or writes it — never reachable from a client. `NodeDaemon` gates every custom-agent launch (`local` and `ssh:`) through it before ever registering a spawn recipe; a refusal reports `session_status: 'error'` with `reason` naming the allowlist. `applyCustomAgentDefaults` best-effort-applies a custom agent's `defaultMode`/`defaultConfigOptions` via the existing `session/set_config_option` mechanism.

  `@loombox/relay`: routes `custom_agent_probe_request`/`response` by `nodeId`, same pending-request-table pattern as `target_fs_list_request`.

  `@loombox/web`: `RelayClient.createSession` now takes an optional `customAgent`, sealed into the same private envelope as `title`/`projectPath`; `RelayClient.probeCustomAgent` is the client half of the probe pair. A new per-project `custom-agent-store.ts` (`localStorage`-keyed, mirrors `mcp-server-store.ts`'s CRUD pattern) backs `NewSessionDialog`'s "+ Define a custom agent" form, which folds a project's custom agents into the same Agent picker as its registered providers (`custom-agent:<name>` ids, never colliding with a real provider id) and sends `provider: 'custom'` alongside the record on submit.

  **The allowlist's edit path**, in full: an operator sets `LOOMBOX_CUSTOM_AGENT_ALLOWLIST` (comma-separated) or the node config file's `customAgentAllowlist` (JSON array) and restarts the node (`packages/node/src/config.ts`'s `NodeCliConfig.customAgentAllowlist` doc comment, threaded through by `main.ts`'s `start()`). No wire message reads or writes it, so it is architecturally unreachable from any client, no matter which device or account.

- ff1fb1e: Fork a session from any turn into a new one (issue #746, Zed-parity decision C6-2). The transcript up to that turn is copied into a brand-new session with its own worktree, seeded from the source's branch tip plus an overlay of the source's uncommitted and untracked files, so the fork's files match the transcript it starts from. The original session and its worktree are untouched: nothing here reverts anything, which stays C6-3's job and depends on #603.
- 6d3ad95: Consume MCP prompts and surface them as slash commands (Zed-parity D5-2, issue #754). The node now speaks MCP directly (`@loombox/providers-core`'s new `mcp-prompt-client.ts`, hand-rolled JSON-RPC over stdio/HTTP, mirroring `AcpClient`'s own conventions) — a second, independent connection per launched server, separate from whatever the ACP agent itself does with `mcpServers` at `session/new`, since a real `omp acp` binary never forwards an MCP server's prompt catalogue onto its own `available_commands_update`.

  Right alongside `mcp_server_status`, a new `mcp_server_prompts` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, same "ride the existing `session_update` envelope, no-op on an empty list" shape) carries every launched server's own `prompts/list` catalogue, attributed by server name. A server with no prompts contributes nothing; an unreachable server is silently excluded rather than breaking the push for the others.

  Selecting one in the composer's `/` picker (merged with the agent's own `commandsFor` catalogue, each MCP-sourced row tagged `mcpServer`/`mcpArguments`) sends the server's own rendered definition, not the raw typed text: a new `mcp_prompt_get_request`/`mcp_prompt_get_response` wire pair (`@loombox/relay` routes/fans it out exactly like `fs_list_request`/`fs_list_response`) asks the node to call that prompt's real `prompts/get`, with the user's typed argument text folded in. A failed render falls back to sending the user's raw typed text rather than blocking the send.

  Resources (D5-3) stay out of scope.

- d03fc5d: Open a pull request from a session's own branch (SPEC §7.14, issue #238). `@loombox/protocol` gains `pr.ts`'s `pr_open_preview_request`/`_result` and `pr_open_request`/`_result` wire pair, routed session-scoped through the relay exactly like `permission_policy_get`/`_set` (the relay only ever forwards `sessionId`/`requestId` plus opaque `EncryptedEnvelope`s — never a branch name, commit count, PR title/body, or the created PR's URL).

  `@loombox/node`'s new `pr-open.ts` runs `git`/`gh` on the session's own `ExecutionTarget` (`local` or `ssh:`), authenticated by that target's own already-signed-in `gh` CLI — deliberately not SPEC §7.26's connected-account registry (`GithubConnectService`), whose token lives in one node's OS keyring and cannot reach an `ssh:` target's `gh` invocation at all (`ExecOptions.env` is local-only) or add anything a target's own git-push credentials don't already provide for a `local` one. `previewPrOpen` is read-only (resolves the session's branch via `resolveSessionBranch`, issue #738; the repo's default branch via `gh repo view`; and the commit count ahead of it) and reports one of seven named failure categories (`no_branch` | `no_commits` | `gh_missing` | `gh_unauthenticated` | `repo_lookup_failed` | `push_failed` | `create_failed`) rather than one generic error, mirroring issue #750's `AcpMcpServerFailureCategory` precedent. `openPr` re-verifies that same preview immediately before it pushes the branch and runs `gh pr create` — the one point in the whole feature with a real side effect on the operator's own repository.

  `apps/web`'s `RelayClient` gains `previewPrOpen`/`openPr`, and a new `PrOpenDialog.svelte` — reached from any session row's "⋯" menu ("Open pull request…"), alongside "Archive session…"/"Export transcript": an occasional, per-session action, not a permanent workbench sub-tab beside Files/Config/Runner (those stay relevant for a session's whole lifetime; opening a PR happens once, near the end). The dialog shows the preview (branch, base, commit count) the moment it opens, then only pushes and opens the PR once the operator has typed a title and clicked "Push & open pull request", surfacing the resulting URL or a distinct failure reason inline. No AI-drafted PR body here (issue #233's scope, not this one's).

- 757fa0e: Per-project scoped secret/env injection for agent execution (issue #258): a project can declare env vars its spawned agent process gets at start, each either a literal value or a reference to a node-local secret by name — resolved and injected only on the executing node, never sent to the relay or a client.

  - `@loombox/providers-core`'s `project-env.ts` mirrors `mcp-secret-grants.ts` (issue #189): `ProjectEnvVarDecl`, a per-secret `ProjectEnvGrantStore` (deliberately separate from `McpSecretGrantStore` — direct agent-env injection is a distinct trust boundary from an MCP server grant), and `resolveProjectEnv`, which fails fast on an ungranted/missing secret before returning anything.
  - `@loombox/protocol`'s `sessionPrivateMetaV1.projectEnvDecls` carries a client's declared list inside the same encrypted envelope as `title`/`projectPath`/`mcpServerConfigs`.
  - `@loombox/node`'s `NodeProjectEnvManager` persists only the grant ACL and reuses `NodeMcpSecretManager`'s existing keyring-backed secret-value storage rather than a second store, so a secret set once is usable by both an MCP server grant and direct env injection. `NodeDaemon` resolves it alongside `mcpServers` at session start, in the same before-any-worktree preflight path that already fails clearly on a bad MCP grant — a missing/ungranted secret now gets the identical treatment (a minimal `session_announce` plus `session_status: 'error'` naming the env var and secret). `ssh:` targets refuse a declared env var outright for now (the sandboxing dependency, issue #257, is still open) rather than silently starting an agent missing it.
  - `@loombox/supervisor`'s `AgentSupervisor.start()` gains an `env` option, merged into the provider's own `spawnConfig.env` before spawning — never sent anywhere but the local `child_process.spawn()` call.
  - `@loombox/web` gets `project-env-store.ts` (client-side declaration CRUD, mirrors `mcp-server-store.ts`) and `ProjectSecretsPanel.svelte`, mounted in the Config panel next to MCP servers; `RelayClient.createSession()` and `NewSessionDialog` forward the declared list on every session creation, the same way `mcpServerConfigs` does.

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

- b8bc9db: The thinking-display preference goes from a boolean to three states, automatic as the default (Zed-parity decision C4-2, issue #745; closes #661).

  `$lib/expand-thoughts.ts`'s store now holds a `ThoughtDisplayMode` (`'collapsed' | 'expanded' | 'automatic'`) instead of a boolean, persisted to `localStorage` the same way `$lib/accent.ts`/`$lib/theme.ts` persist their own — a plain string, no JSON. A pre-#745 stored boolean is migrated rather than discarded: `'true'` becomes `'expanded'`, and `'false'` becomes `'automatic'`, not the new `'collapsed'` — `false` used to mean "collapsed once settled, forced visible while producing" (issue #660's fix), which is exactly what `'automatic'` means now, so an existing user's thoughts keep streaming visibly exactly as before rather than silently going dark. `'collapsed'` is new: a stronger, previously-unavailable "never, period" choice that suppresses a thought's body even while it's actively producing text (the header's timer and woven-thread motif still show activity).

  `MessageItem.svelte` computes each mode's own baseline (`'expanded'`/`'collapsed'` are constants, `'automatic'` is exactly the existing `thinking` prop) and layers a per-thought manual override on top: clicking the disclosure always sets it, and it then wins over the mode's baseline for as long as that thought's component instance stays mounted. This is what keeps automatic mode from reintroducing issue #661 — a thought expanded by hand stays expanded for that thought straight through its own settle transition — without turning the display mode itself back into per-component state (v8's B2-1, issue #709, stays settled): the mode is still one global preference, read once and applied to every thought in every session, and the override sets no default for any other, future thought.

  The Appearance settings panel (`AppearanceSettings.svelte`) gets a third "Thinking" section, a radiogroup styled identically to the existing Theme control, with Automatic listed first to match its status as the default.

  Verified: `pnpm --filter @loombox/web exec vitest run src/lib/expand-thoughts.test.ts src/lib/components/MessageItem.test.ts src/lib/components/AppearanceSettings.test.ts src/lib/components/pages/SettingsPage.test.ts` (67 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.

- 109184d: Topbar shows `project / branch`, and the session's target chip moves down into the status bar's left zone (Zed-parity decision B3-3, issue #738).

  - `@loombox/protocol`: `SessionPrivateMetaV1` gains an optional, node-computed `branch` field. A client never sends it — only `@loombox/node`'s own `announce()` sets it.
  - `@loombox/node`: a new `resolveSessionBranch` helper resolves the branch a session's own state should report. A worktree-isolated session already knows its own `loombox/session-<id>` branch, no git call needed; an in-place session gets a fresh `git branch --show-current` probe against its project folder on every `announce()` (session creation, a fork, and every reconnect's re-announce) — a detached `HEAD` resolves to `detached@<short-sha>` rather than a blank value, and a plain, non-git folder (SPEC §6) resolves `undefined`, not an error.
  - `@loombox/web`: the topbar's `.topbar-breadcrumb` now reads `project / branch` instead of `project · target`, omitting the branch segment entirely when the node has nothing to report. `StatusBar`'s left zone gains a `selectedSessionTargetLabel` segment (`status-bar-session-target`) carrying the target the old breadcrumb used to show — the target still appears exactly once in the window, just one level down.
  - `@loombox/web`: below `--bp-tablet` (390px phones, same convention `.topbar-breadcrumb`'s own narrow media query already uses), the new `status-bar-session-target` segment drops out of `StatusBar` entirely — it is the least useful LEFT-zone segment at that width, and dropping it is what keeps the bar inside the composer strip's own phone-width budget (`composer-strip.spec.ts`'s "fits one row on a phone"). Still discoverable there: the sessions sheet's own row for the open session already carries the identical label (`session-activity`, reachable from the bottom tab bar).

  This does not live-update an in-place session's branch the instant it changes on disk while the connection stays open — that would need either polling every open session's git directory or a filesystem watcher, neither of which this codebase uses elsewhere, and a person switching branches under a running session is a rare, deliberate action they already know about. It does refresh at every `announce()` (so a reconnect always shows the true current branch) and on a full reload.

- 4cc52b4: A full user keymap, remappable and synced per account (Zed-parity F3-3, issue #760, building on the action registry #758 and default binding set #759).

  Every registered action is remappable from Settings → Keyboard. Storage: a new account-scoped `keymaps` table on the relay (`keymap_get_request`/`keymap_set_request`/`keymap_result`), sealed under `@loombox/crypto`'s new `deriveKeymapKey` (`['keymap', accountId]`, no session or project involved at all — a keymap edit works with zero nodes online). Fetched proactively on every fresh connection, so a remap survives a new device sign-in from first paint; saved live to `RelayClient.keymap`, which `action-registry.ts`'s `effectiveShortcut`/`matchShortcut` now accept as an `overrides` param, so a remap takes effect without a reload everywhere the registry is read — the palette, the keyboard dispatcher, and `CanvasZeroState`.

  The two questions the decision required answering, not glossing over:

  1. **The phone.** The Keyboard settings section never renders on a narrow viewport (`SettingsPage.svelte`, gated on `viewport.ts`'s `isNarrowViewport`) — recording a chord has nothing to attach to with no physical keyboard to press. The resolved bindings still apply globally regardless of viewport (harmless with no keyboard, useful with a paired one).
  2. **Per-device availability.** The keymap stays a single per-account record with no per-device field. `$lib/keymap.ts`'s `isChordUnavailableHere` computes a runtime "unavailable here" state instead, generalizing issue #759's own browser-reserved-chord rule (`Mod+N`, `Mod+Alt+Right`/`Left`) to any user-remapped chord that lands on one of those reservations — a binding reserved on this device still saves and still works on another.

  An invalid or conflicting candidate (unknown action id, malformed chord, two actions sharing a chord) is rejected client-side by `$lib/keymap.ts`'s `validateKeymapCandidate`, naming the offending entry, before it is ever sent — the previously saved keymap is never touched. Two tabs on the same account: last full write wins at the relay, and every other open connection on that account is pushed the winning state live (not just the requester), so a losing tab corrects itself instead of drifting stale.

- 4291dc3: Add the working-tree diff viewer (SPEC §7.4, issue #206): a session's actual uncommitted changes (staged + unstaged + untracked, compared against `HEAD`), opened as a real tab in the canvas tab strip (issue #737) rather than a dialog.

  - `@loombox/protocol`: new `git_diff_request`/`git_diff_response` wire pair (`packages/protocol/src/v1/git-diff.ts`) — shaped like `fs_read_request`/`fs_read_response` (issue #737), no envelope on the request (asking carries no content, mirroring `checkpoint_list`).
  - `@loombox/node`: `packages/node/src/git-diff.ts`'s `computeWorktreeDiff` runs real `git status`/`git show` through `ExecutionTarget.exec` — the same `git -C <worktree> ...` shape issue #238's `pr-open.ts` already established, so this works against a `local` or an `ssh:` target identically. A binary/symlink change collapses to `DiffViewer`'s existing `oldText: null, newText: ''` structural-only shape; a deleted file gets `newText: ''`; a rename carries `previousPath`.
  - `@loombox/relay`: routes the new pair exactly like the `checkpoint_*`/`fs_read_*` families — always blind to the envelope's contents.
  - `@loombox/web`: `WorktreeDiffViewer.svelte` renders inline (reusing `DiffViewer.svelte` unchanged, per file) and split (reusing `$lib/diff.ts`'s `diffStats`/`computeLineDiff` via the new `pairDiffLinesForSplitView`, laid out in two columns) — no second diff algorithm anywhere. Split degrades to inline below the tablet breakpoint, where two columns have nowhere to go. Opens via a new "Working tree diff" button above the Files panel tree, as `$lib/tabs.svelte.ts`'s new `DiffCanvasTab` tab kind.

### Patch Changes

- 2739a30: Move the command palette's hand-built actions array onto a real action registry (`$lib/action-registry.ts`, Zed-parity F1-3, issue #758). Every capability — `stop-turn`, `toggle-sessions-sidebar`, `open-inbox`, `open-nodes`, plus two new palette-only entries `next-session`/`previous-session` — is now declared once with an id, a label, an optional `Mod+<key>` binding and an `isAvailable` predicate. The palette (`paletteActions`) and the global keydown dispatcher (`handleGlobalKeydown`) both read the same array, so a row and its shortcut can never disagree about whether they currently do anything: "Stop current turn" shows and fires only while a turn is active, "Next session"/"Previous session" only with more than one session open. `Mod+B` (issue #438), previously invisible to the palette, is now a registered row. One deliberate behaviour change: `Mod+.` used to call `interruptTurn` unconditionally whenever a session was selected, even with no turn running (a harmless no-op); it now shares `stop-turn`'s predicate and does nothing in that case, same as the palette row always did. Action ids are permanent once #760's user keymap ships — documented on the registry itself, since #760 depends on that promise.
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

- c854a81: Fill the canvas zero state with recent sessions, the last transcript's tail, and the bindings that matter (Zed-parity B4-2, issue #739). With no session selected and a project/target both connected, `+page.svelte` used to render a bare dimmed `BrandMark` plus one sentence — measured at roughly 70% of the window at 1728px. `CanvasZeroState.svelte` replaces that void with three panels: recent sessions (reusing the sidebar's own `sessions` array and `projectDisplayName`/`sessionTargetLabel`/`formatSessionActivity` helpers, no new subscription), the most recent session's last few transcript items (`$lib/transcript-tail.ts`'s pure `transcriptTail`, fed by a small dedicated `client.transcriptFor` subscription scoped to the zero state), and every keyboard shortcut declared in issue #758's `actionRegistry`, read directly rather than hardcoded a second time. Two honest empty cases render their own distinct copy instead of a blank region or a fabricated example: a brand-new project with zero sessions yet, and a real session that genuinely has zero turns. The "connect a node" / "add a project" prerequisite states are unchanged (a plain `EmptyState`) since neither has any session history to show yet by definition.
- ae1498a: The client now resyncs on reconnect, not only on a session's first-ever subscribe (issue #729): a dropped socket, a laptop sleep, or a page reload all recover whatever the relay buffered while disconnected, instead of losing it silently.

  - `@loombox/providers-core`: `TranscriptItem` gains a `gap` variant (`TranscriptGapItem`) and a new `reduceResyncGap` reducer — a relay `resync_marker` (`dropped: true`) becomes a visible, idempotent-by-range gap row in the transcript instead of a silent skip.
  - `@loombox/web`: `RelayClient` tracks the highest `session_update.seq` applied per session and sends `resync_request(sinceSeq: <that seq>)` on every successful `session_resume` ack — first subscribe (`sinceSeq: 0`, #772's existing path, unchanged) and every reconnect alike, guarded to once per (session, connection) so a first-subscribe's own retry storm doesn't fire it repeatedly. A live delivery and a resync replay of the identical `seq` are deduped so the item is applied exactly once; per-session `session_update` application is now strictly ordered by receipt (not decrypt-completion order), so an older status/config replay can never regress a newer one already applied. `resync_marker` renders via a new `TranscriptGap` row in `TranscriptTimeline`.

- f03fca2: Adopt the full eighteen-row default keyboard binding set on the action registry, VS Code's keys where Zed and VS Code differ (Zed-parity F2-3, issue #759). Every binding is declared on `actionRegistry` (`$lib/action-registry.ts`), not a second keydown handler, so it is automatically reachable via the palette (`Mod+K`, plus the new `Mod+Shift+P`/`Mod+P` aliases) with its shortcut shown next to it: `Mod+N` new session, `Mod+Alt+B` toggle workbench panel, `Mod+J` toggle terminal dock, `Mod+I` focus composer, `Mod+,` open settings, `Mod+Shift+M` cycle model/effort, `Mod+Shift+A` open inbox (its first real shortcut). `$lib/keyboard.ts`'s `matchesShortcut` replaces the old single-key `isModShortcut`, matching every `Mod+[Shift+][Alt+]<key>` chord exactly (an `Alt` chord compares `event.code` so macOS's `Option+<letter>` remap can't break it) — the old parser only ever looked at the last `+` segment, so `Mod+P`/`Mod+Shift+P` could never have been told apart.

  The two rows the decision names as a real cost, not an inherited no-op: next/previous session on `Mod+Alt+Right`/`Mod+Alt+Left` collide with a Windows/Linux browser tab's own forward/back history navigation, a chord no `preventDefault()` reaches there. Both actions' `shortcutFor` now resolves per environment (`keyboard.ts`'s new `isDesktopShell`/`isMacPlatform`): bound inside the desktop shell and on a Mac browser tab, withheld — not silently offered and silently ignored — on a Windows/Linux browser tab, where the action stays reachable by clicking its palette row. `Mod+N` (new session) inherits the same treatment for the same reason, gated on the desktop shell alone since a browser reserves it on every platform.

- 79f55e0: Wires the browser's own MCP config/status surface into the one resolution path #750 (D2-2) built on the node (issue #794).

  - `apps/web`'s Config panel (`McpServerConfigPanel.svelte`) now forwards its per-project `mcp-server-store.ts` list — only the currently-enabled records — into `RelayClient.createSession`'s new `mcpServerConfigs` option, which seals it into `session_create`'s private envelope exactly like `title`/`projectPath`. A server added there is launched for the very next session on that project.
  - The node's `mcp_server_status` event gains a `disabled` flag (`@loombox/protocol`'s `mcpServerStatusEntryV1`, mirrored in `@loombox/providers-core`'s `AcpMcpServerStatusEntry`): `true` only on the exact failure that just auto-disabled the node's own `McpConfigStore` record after three consecutive failures (`NodeDaemon.recordMcpServerOutcome`/`autoDisableMcpServer`, now reporting instead of only logging).
  - The Config panel renders a new "Server status" section off `RelayClient.mcpServerStatusesFor(sessionId)` (threaded through `ProjectConfigPanel`): every failed server by name and reason, with an auto-disabled one visibly distinct from one that will simply be retried next session — including a server only the node itself is configured with, not just this device's own list.
  - New copy on the "Configured servers" section makes the two-store merge legible: this device's own declarations are one input the owning node merges with its own store, not the whole truth.
  - No secret value crosses either surface: `mcp-server-store.ts` never held one, and `mcp_server_status.reason` is always the human-readable failure detail, never a secret (`mcp-secret-grants.ts`'s node-local boundary unweakened).

- 900bc5c: The `@` composer picker becomes the real thing: removable pills over four sources — files, directories, past sessions (searched by title) and tracker items (searched by id or title), the last two something Zed has no equivalent of at all (issue #742, decisions doc C2-3).

  - `@loombox/web`: new `$lib/mentions.ts` models a picked reference as ACP's own baseline `ContentBlock::ResourceLink` (`AcpResourceLinkContentBlock`'s `uri`/`name`), disambiguated by `uri` scheme (`file:`, `loombox-session:`, `loombox-tracker:`) rather than inventing a loombox-only field. `MentionPicker.svelte` supersedes the files-only `FileReferencePicker.svelte`: a `Dialog`-based picker with a Files/Sessions/Tracker tab strip, fuzzy-filtered (`$lib/fuzzy.ts`), fully keyboard-driven (arrows navigate, Enter picks, Tab/Shift+Tab cycles source, Esc closes). Picking a result never inserts text — `+page.svelte` renders it as a removable pill in a new row above the composer textarea, so editing the surrounding prose can never corrupt or silently drop a reference. `RelayClient.sendPrompt` gains a `mentions` parameter; `resolveMentionsForSend` degrades a session/tracker mention that no longer exists (checked against `RelayClient.sessions`/`trackerSnapshotFor` at send time) back into plain `@name` text rather than breaking the send — a file/directory mention is never checked, since its target is the agent's own filesystem. `PromptPayload` (the `prompt_inject` envelope's plaintext) gains an optional `mentions: {uri, name}[]`, mirrored field-for-field on both ends exactly like `attachments` already is.
  - `@loombox/node`: new `prompt-mentions.ts`'s `renderPromptTextWithMentions` folds `PromptPayload.mentions` into the text `AgentSession.prompt()` takes (still text-only in v1 — see `ResolvedAttachment`'s doc comment) as a "Referenced:" block, one `name — uri` line per mention, appended after the prompt's own prose. A prompt with no mentions is unchanged.

  The existing attachment bar and image paste path are untouched — the pill row is a sibling element inside the composer field, not a change to `AttachmentBar.svelte`.

- d89a42a: Extend monospace to every structural identifier, everywhere, including inside prose (Zed-parity decision A4-1, issue #735).

  The pick: project paths, branch names, target/node names, session/account ids, tool names, file names in tool rows, and every numeric figure (counts, durations, token and cost numbers) render in `--font-mono`, not just code/diffs/terminal surfaces. Built as one rule, not per-call-site guesswork: the existing `.font-mono` utility (`$lib/styles/typography.css`) is widened — via its doc comment, not new CSS — to cover the enumeration, and applied at each render site: `+page.svelte`'s topbar breadcrumb and session row meta line, `GenericToolRow`/`EditWriteWidget`/`PermissionCard` titles, `DiffViewer`'s path and +/- stats, `TodoWidget`'s done/total count, `PermissionQueueBar`'s pending count, `ConfigBar`'s token/cost meter, `TargetStatusView`'s metric percentages/bytes/relative age/sampled-at/overload threshold, `MessageItem`'s thinking-timer duration, and the project-path/file-path rows in `CommandPalette`/`AttentionInbox`/`FileReferencePicker`. Two pre-existing component-local `font-family: var(--font-mono)` declarations in `+page.svelte` (`.account`, `.topbar-breadcrumb`) are folded into the shared class rather than left duplicated.

  The style-reference route (`/style-reference`) gets a new "Structural identifiers" section enumerating all ten kinds with a live mono example and its real call sites, plus a note naming the two places the pick's own inherited caveat — a lone relative timestamp, or a single number inside a sentence, has nothing to align against — reads worst: `MessageItem`'s ticking `.thinking-timer` and `TargetStatusView`'s `.target-age`.

  No new hardcoded font-family anywhere; every rule reads `--font-mono`.

  Verified: `pnpm --filter @loombox/web exec vitest run src/routes/page.test.ts src/routes/style-reference/page.test.ts src/lib/components/GenericToolRow.test.ts src/lib/components/tool-widgets/EditWriteWidget.test.ts src/lib/components/tool-widgets/TodoWidget.test.ts src/lib/components/PermissionCard.test.ts src/lib/components/PermissionQueueBar.test.ts src/lib/components/DiffViewer.test.ts src/lib/components/ConfigBar.test.ts src/lib/components/TargetStatusView.test.ts src/lib/components/MessageItem.test.ts src/lib/components/CommandPalette.test.ts src/lib/components/AttentionInbox.test.ts src/lib/components/FileReferencePicker.test.ts` (231 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, `pnpm format:check`, and a headless-browser visual check of `/style-reference`'s new section in both the light and dark theme.

- 166551b: Surface the node-side permission policy (command/network allow/deny globs) in the UI (D3-4's "rules" half, issue #751)

  `packages/node/src/permission-policy.ts` already enforced a per-project allow/deny glob policy, but nothing under `apps/web/src` referenced it — a user could neither see nor edit it, and it could only be hand-edited as JSON on the node.

  - `@loombox/protocol`: `permission-policy.ts` — `permission_policy_get`/`_set`/`_result` (session-routed, `_set`/`_result` sealed under `encryptedEnvelope`, following `test-runner-config.ts`'s shape) and `permission_policy_violation`, a node-to-client notification carrying `ToolRefusalReasonV1`, a discriminated union with one member today (`kind: 'permission_policy'`) — the seam D3-4's "the UI must say which of the three layers refused it" needs; the profiles half (#752) adds its own `kind: 'profile'` member alongside it rather than a second, parallel concept. Each glob rule is `.trim().min(1)`, so a blank rule is rejected at the schema boundary too.
  - `@loombox/node`: `NodeDaemon` gained `permission_policy_get`/`_set` handlers backed by the already-existing `PermissionPolicyStore`, plus `sendPermissionPolicyViolation`, wired into `PolicyEnforcedPty`'s `onViolation` hook and `executeRun`'s existing policy-denial path. **Fixes a real "no restart" bug found while writing this**: `PolicyEnforcedPty` used to snapshot the policy once at `terminal_open` time; since a terminal is long-lived, a rule added mid-session never took effect until that terminal was closed and reopened. `PolicyEnforcedPtyOptions.policy` is now a resolver (`() => PermissionPolicy`), read fresh on every submitted line, so a saved rule blocks the very next command with no node restart.
  - `@loombox/relay`: routes `permission_policy_get`/`_set` to the owning node and fans `permission_policy_result`/`permission_policy_violation` out to subscribed clients, exactly like `test_runner_config_get`/`_set`/`_result` and `terminal_output` — the relay never opens either envelope.
  - `@loombox/web`: `RelayClient` gains `getPermissionPolicy`/`setPermissionPolicy`/`onPermissionPolicyViolation`. `ProjectConfigPanel` (the right-workbench Config tab, per-project — not global Settings, since the policy is per project) gains a new `PermissionPolicyPanel` section: view/add/remove command and network allow/deny rules, a computed (never separately stored) "default: allow" / "default: only listed commands run" badge per dimension derived from whether that dimension's allow list is empty, and a live "Recent policy blocks" list fed by `permission_policy_violation`, each line naming the exact deny rule that fired. A blank pattern is rejected client-side at the Add button, with a message, before it ever reaches the wire.

  Verified: a new node-level test (`node-daemon-permission-policy.test.ts`) drives a real terminal + real bash + real relay end to end — sends `permission_policy_set` over the wire, then types a now-denied command into the SAME already-open terminal on the SAME running node, and confirms it's blocked with no restart; a companion `policy-enforced-pty.test.ts` test proves the same at the unit level. `node-daemon-test-runner.test.ts` confirms the same violation notification fires from the `run_start` policy-denial path. `PermissionPolicyPanel.test.ts` covers the blank-glob rejection, the add/remove round trip, the default-mode badge, and the attribution list rendering the rule name. `permission-policy.test.ts` (protocol) and `relay.test.ts` cover the wire shapes and blind routing.

- b495760: Remove the Starting prompt field from the New session dialog and everything behind it (issue #761). A session is always created empty now; the first thing said goes through the composer's ordinary follow-up path instead. `CreateSessionOptions` drops its `prompt` field along with the `timeoutMs` field and the poll-until-the-node-announces-it wait `RelayClient.createSession` used to do purely to time that prompt safely — neither has anything left to do once there is no prompt to time, so `createSession` now simply returns the generated session id the moment `session_create` is on the wire. This also removes one trigger for issue #730 (a prompt silently dropped in the window between the node's announce and the agent bridge existing); #730's other half — a session with no agent yet must not render as "Awaiting you" — is unrelated and still open.
- 17afa20: Remove the paced text reveal entirely, so streamed text renders as it arrives (Zed-parity decision E2, issue #757).

  `$lib/text-pacer.ts` and its test are deleted, along with every call site: `MessageItem.svelte` no longer tracks a `revealedLength`/`TextPacer` pair, it now derives `rendered` straight off `item.text`. The turn-end flush path that pushed the remaining backlog when `turn_ended` arrived (`pacer.flush()` on `!turnActive`) goes with it — there is no backlog left to flush once nothing paces the reveal in the first place. `turnActive` stays as a prop: it still gates `splitStreamingMarkdown`'s `finalized` flag, which is what actually settles a still-open Markdown construct (an unterminated fence, a building list) once the turn ends, independent of reveal timing.

  This was blocked until two prerequisites landed, and both have: #755 windows the transcript so an unbounded list stays cheap, and #756 moved envelope decryption off the main thread. Both are what make removing the pacer safe rather than a regression — the pacer existed to stop a burst thrashing the DOM on the same thread that was decrypting it against an unwindowed list; neither condition holds anymore.

  Verified: `pnpm --filter @loombox/web exec vitest run src/lib/components/MessageItem.test.ts src/lib/markdown.test.ts` (58 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, `pnpm format:check`, and `pnpm --filter @loombox/web exec playwright test tests-e2e/transcript-follow.spec.ts tests-e2e/live-transcript.spec.ts` (3 tests). See the PR body for the burst-timing measurement and which acceptance criterion is satisfied by the module's absence versus by a test.

- 43e3fbf: Typing `/` in the composer lists exactly what the connected agent declared (Zed-parity C2-4, `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §3; issue #743).

  Backed entirely by issue #741's plumbing (`RelayClient.commandsFor(sessionId)`, itself a thin `derived` over `TranscriptState.commands`) — there is no hardcoded loombox command list anywhere in this change, and none was added: `+page.svelte` mirrors `commands` off that store exactly the way it already mirrors `configOptions`, and `SlashCommandPicker.svelte` (new, modeled directly on `FileReferencePicker.svelte`'s `@file` picker — same `Dialog`, same hand-rolled `fuzzyFilter`, same arrow-key/Enter/Esc handling) renders whatever that list currently holds, nothing else. An agent that has declared no commands renders zero rows and no placeholder, and `handleComposerInput`'s new `/`-trigger branch never even opens the picker in that case: typing `/` truly does nothing.

  `/` only triggers at the very start of the composer (a whole-message convention, unlike `@file` which can appear mid-sentence) — `handleComposerInput` gained a second, independent branch alongside the existing `@`-trigger one, guarded on `commands.length > 0`. Selecting a row inserts `/name ` (plain text, replacing the triggering `/partial-query`) and closes the picker; the argument itself is whatever the user types next and is sent as an ordinary prompt on submit, exactly like every other composer message — no loombox schema parses or validates it. A declared `input.hint` (e.g. `<plan|scan|status>`) renders next to the row as on-screen guidance only, never inserted as literal text. Because `commands` is a live store subscription, a mid-session `available_commands_update` (the agent pushing a new catalogue) is reflected immediately, with no reload and no re-subscription.

  Verified: `SlashCommandPicker.test.ts` (component-level: empty catalog renders no rows/no placeholder, fuzzy filter, click/Enter/Esc, a `commands` prop replacement re-renders without remounting) plus a new `composer:` describe block in `page.test.ts` (the real `/`-trigger regex, mid-sentence non-trigger, keyboard-only open/filter/select/insert/send, Esc leaves the draft untouched, and a `commandsFor(id).set(...)` mid-session push reflected on reopen).

- 3db008b: Zed-parity A1-2 (issue #733): the dark theme's neutral ramp inverts — chrome (`--color-rail`) is now the lightest surface, the content well (`--color-bg`, i.e. `.canvas`) the darkest, each of the four values roughly 7 L* apart with a real blue-grey hue (~258°) instead of the old near-zero-chroma near-black. `--color-surface`/`--color-surface-raised` keep their existing "higher tier reads lighter" ordering between those two ends.

  - Dark's alpha hairlines (`--color-border-*`/`--color-fill-*`) are re-tuned (9/16/28% → 13/23/40%, fill 6/12% → 8/17%) so the three-tier ladder holds the same lightness separation on the new, lighter ground (A3-1: same hairline/shadow model, only the numbers moved — no shadow gained or lost anywhere).
  - `--color-text-secondary`/`--color-text-muted` are re-lightened so they still clear AA/large-text contrast against `--color-rail`, the lightest and hardest of the four grounds.
  - `--color-danger`/`--color-info` and all six `accent-presets.ts` dark values are re-lightened in-hue so they still clear `AA_CONTRAST_MIN` (4.5:1) as text against `--color-surface-raised`. `--color-success`/`--color-warning` already cleared it unchanged.
  - Light theme is untouched — it isn't being inverted, and its own hue (~267-272°) already sits close enough to dark's new ~258° that the two read as one family.
  - `InteractiveTerminal.svelte`'s jsdom/no-stylesheet CSS-token fallbacks are updated to match.

- 83449e8: Adds a permanent status bar (Zed-parity decision B1-1, issue #736), rendered on every page — inbox, settings, tracker, and the session view — not only while a session is open.

  - Left zone: relay connection (every state gets a reading now, including healthy, unlike the retired conditional chip), aggregate target health, and a Behind badge (build identity mismatch) — both target segments open Settings > Nodes.
  - Right zone: the selected session's own status (all eight `SessionStatusV1` values render distinctly; "No session selected" reads honestly rather than showing stale session state), a queued-session count, and the context/cost meter.
  - The context/cost meter **moved out of** `ConfigBar` onto this bar (it is not duplicated) — `ConfigBar` no longer takes `usage`/`cumulativeCostUsd` props.
  - The topbar's conditional connection chip and the account avatar's/Settings-menu's health dots are **removed** outright, not hidden — retired in favor of the bar's own connection/target-health segments.

- 1ae1def: Subagent and nested tool-call tree rendering (issue #200; spike #199).

  **What was checked before building anything (real runs, not inferred):**

  - **Claude Code**, driven live against the real `@agentclientprotocol/claude-agent-acp` v0.65.0 npx bridge on this devbox: a Task-tool subagent's own nested tool calls arrive with `_meta.claudeCode.parentToolUseId` pointing at the launching tool call's own id (which itself carries `_meta.claudeCode.subagent: true`) — regardless of whether the client opts into the `subagent-transcript` capability. That capability only gates whether the subagent's own message/thinking text is _also_ forwarded (2 `agent_message_chunk`s without it vs. 5 with it, in the same live run); it does not gate tool-call nesting.
  - **Codex**, source-verified against the published `@agentclientprotocol/codex-acp` (no live run possible — no `codex` CLI/credentials on this devbox): a spawned subagent surfaces as one summarizing `spawnAgent`/`subAgentActivity` tool call carrying thread-scoped `_meta.codex.collaboration`/`_meta.codex.subagent` metadata, reusing the same `toolCallId` throughout. The subagent's own individual tool calls are never forwarded as separate ACP events, so there is nothing to attribute a `parentToolCallId` to today.
  - **`omp acp`** (oh-my-pi 17.2.9), driven live: a spawned subagent's tool activity is summarized inline inside the single spawning tool call's own `rawOutput` (`details.progress[].recentTools`), never emitted as separate ACP events, and the `subagent-transcript` capability is silently ignored.

  **What shipped, given that:**

  - `AcpClient.initialize()` now advertises `clientCapabilities._meta['subagent-transcript'] = true` (harmless for a provider that doesn't recognize it, verified against both `omp acp` and the Claude bridge).
  - `@loombox/providers-claude`'s `claudeProviderModule.enrich()` promotes a real `_meta.claudeCode.parentToolUseId` onto `parentToolCallId`, replacing the old no-op — the exact signal verified live above. `@loombox/providers-codex`'s stays a no-op; its doc comment now records the source-verified reason instead of "not yet confirmed".
  - `@loombox/providers-core`'s `transcript.ts` gains `computeToolCallNesting(items)`, a one-pass, per-`items`-reference lookup (`ReadonlyMap<id, { depth, parentTitle }>`) alongside the existing `ancestorChainForToolCall`. An orphan child — `parentToolCallId` set, but that id never arrived as its own item — resolves to `depth: 0`, identical to a genuine root call; a cycle is defused the same way. Exported from both `index.ts` and `browser.ts`.
  - `@loombox/web`'s `TranscriptTimeline.svelte` renders a nested tool call indented (capped at 3 levels; true depth is preserved in `data-nesting-depth` regardless) with a "nested in …" caption naming the resolved immediate parent, computed from the _full_ transcript on every `items` change — never from the windowed/mounted slice, so a child renders correctly even while its parent's own row is scrolled out of the mounted window (#755). `ToolCallRow`'s own markup is untouched; nesting is purely a wrapper affordance on the `<li>`, so the one-line row shape (v7 C1-1) is unaffected.

  Verification: `pnpm --filter @loombox/providers-core exec vitest run src/transcript.test.ts src/client.test.ts`, `pnpm --filter @loombox/providers-claude exec vitest run`, `pnpm --filter @loombox/providers-codex exec vitest run`, `pnpm --filter @loombox/web exec vitest run src/lib/components/TranscriptTimeline.test.ts src/lib/styles/tokens.test.ts src/lib/primitive-override-scope.test.ts`, `pnpm -r typecheck`, `pnpm exec eslint <changed files>`, `pnpm format:check`.

- 3bc375a: Fixed `InteractiveTerminal.svelte` proposing more xterm rows than the dock actually has room for (issue #663), leaving unexplained blank/clipped space at the bottom of an open terminal.

  Reproduced and measured: `.xterm-container`'s `padding: var(--space-2xs)` (4px) sat directly on the element passed to `terminal.open()`/`FitAddon`. With `box-sizing: border-box` (`typography.css`), `FitAddon.proposeDimensions()`'s `getComputedStyle(terminal.element.parentElement).height` already included that padding, and the padding it separately tries to subtract is read off `terminal.element` itself (xterm.js's own always-unpadded `.xterm` root) — never off the container. The container's own padding therefore silently escaped the row-count arithmetic, over-proposing rows by however many pixels of padding didn't add up to a whole cell height (matches xtermjs/xterm.js#2958). Fix: the padding now lives on `.xterm-container` alone; a new zero-padding `.xterm-canvas` inside it is what `terminal.open()`/`FitAddon`/the `ResizeObserver` actually measure, so `FitAddon` sees a box whose full extent really is available.

  New Playwright coverage in `cockpit-shell.spec.ts` measures live DOM geometry (`.xterm-rows`' own per-row pixel height vs. `.xterm-container`'s real content box) at three dock heights, including one not a whole multiple of the line height, and confirms switching terminal tabs and collapsing/reopening the dock never leaves a stale fit.

- fbedad7: The session transcript now mounts only the visible range plus a small overscan, not every item a session ever received (issue #755, cockpit-parity decision E1-3). A 2000-item transcript used to pay for 2000 mounted rows on every render, on a phone as much as a desktop; it now mounts on the order of a few dozen.

  Hand-rolled windowing (`$lib/transcript/windowing.svelte.ts`), not a dependency: the crux of this issue is a bespoke anchoring contract (streaming stays pinned to the bottom with no jump; reading history doesn't get yanked around as off-screen rows get measured), and that glue is most of the work regardless of which engine computes the visible range. Owning the ~90 lines of offsets/binary-search math keeps it testable against plain numbers instead of a third party's `ResizeObserver` internals, for zero added dependency surface. Row heights are unknown until measured (a one-line tool row versus a 400px diff), so every row starts at a flat estimate and is re-measured via `ResizeObserver` once mounted; two spacer `<li>`s stand in for whatever's hidden above/below, sized from the engine's own running offsets, so the existing `.items` flex/gap rhythm (including the tool-call "compact" spacing) keeps working unmodified for whichever rows are actually mounted.

  `TranscriptTimeline.svelte` is a new component carrying everything the transcript region owned before (the scroll container, follow-the-bottom state, "Jump to latest") plus the new anchoring: while following, it keeps re-reading the browser's own accurate `scrollHeight` (issue #508's original mechanism, now re-run on a measured-height change too, not only a new item); while reading history, a row above the window trading its estimate for a real height nudges `scrollTop` by that exact delta instead of a `content-visibility`-style silent jump.

  Accepted consequence: native browser find (Ctrl/Cmd+F) can only match currently-mounted rows, not the whole transcript. SPEC.md §7.19/§7.24's planned in-app search (issues #203/#263) is designed against the reducer's event model rather than the DOM for exactly this reason and is unaffected.

- d231989: One tightened default for the whole chrome, no setting (issue #734, Zed-parity decisions doc A2-1): `--nav-row-height` 40→30px, `--topbar-height` 48→36px, `Button` md/sm padding one rung down the spacing scale (~37/25px → ~25/20px), `--text-body-size` 15.2→14.4px, `--text-code-size` 13.6→12.8px.

  - `.destination-row` (the sidebar's Inbox/Nodes/Tracker rows) gets the same `@media (pointer: coarse)` 44px floor `Button`/`IconButton`/`Input` already carry — it never had one, and shrinking the row by 10px would have shrunk a real tap target on the tablet session sheet with nothing to catch it.
  - New structural tokens `--touch-target-min` (44px) and `--touch-target-compact` (40px) in `tokens.css`, both plain `px`. `html`'s own font-size is `var(--text-body-size)`, so every `rem` value anywhere in the app (including every existing `2.75rem`/`2.5rem` coarse-pointer floor literal) computes against that token's value — tightening it would have silently shrunk every touch-target floor in the package (`Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `ConfigBar`, `PermissionCard`, `PlanCard`, `TurnEditsBar`, `AppearanceSettings`) from ~41.8px actual down to ~39.6px. These two tokens pin every one of those floors to a fixed physical size instead.
  - No density setting — that's A2-2, and it wasn't picked.

- 00e8789: Tool-call rows now carry a per-kind icon, elapsed time and, where honest, an attributed cost figure (Zed-parity C3-3, issue #744). The v7 C1-1 one-line shape is unchanged; this is only what shares that line.

  `@loombox/providers-core`'s `TranscriptToolCallItem` gains four new fields, computed purely by the reducer:

  - `startedAtMs` — set only from a real, non-terminal `tool_call` (never from a `tool_call_update`, so a call whose start this client never watched — e.g. one attached mid-session, or a resumed session's history replaying an already-finished call as one settled snapshot — never gets an invented start time).
  - `elapsedMs` — frozen once, the instant a later `tool_call_update` first carries a terminal status; `undefined` whenever `startedAtMs` is.
  - `costAtStartUsd` — internal bookkeeping, not for display.
  - `attributedCostUsd` — a client-side heuristic over `usage_update`'s session-level running cost total (it carries no `toolCallId` at all): the delta between session start and terminal update, shown only when this call was the sole active top-level tool call throughout its own lifetime and the total actually grew. Any other case — overlap with a sibling call, a nested/subagent call, no cost reporting at all — leaves it `undefined`, never a fabricated `$0.00`.

  `reduceTranscript`/`reduceSessionEvent` both take an optional `now` (default `Date.now()`) for deterministic tests, the same clock-injection convention `permission-queue-state.ts` already used.

  `@loombox/web`'s `apps/web/src/lib/components/icons/icon-paths.ts` adds six glyphs — `tool-read`, `tool-delete`, `tool-move`, `tool-search`, `tool-think`, `tool-fetch` — so every ACP `ToolKind` (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`) renders a distinct icon instead of `search`/`read`/`fetch`/`delete`/`move` all sharing the generic wrench; an unrecognized future kind still falls back to it via `$lib/tool-widgets.ts`'s new `toolKindIcon`. A new shared `ToolCallMeta` component (mirroring the existing `ToolCallGutter`/`ToolCallStatus` pattern) renders the elapsed-time/cost badges next to `ToolCallStatus` in `GenericToolRow` and every `tool-widgets/*` bespoke widget.

- d539ebc: Add a read-only turn summary bar and a Review Changes surface (issue #740, settled pick C1-3). A turn's edits used to be three separate tool cards with no answer anywhere to "what did this turn change in total"; the composer footer now shows an `Edits · N files · +X −Y` bar for the latest turn whenever it touched a file, expanding to per-file rows that jump the (possibly windowed-out, issue #755) transcript to that file's own diff card, plus a `Review Changes` button opening a dialog that stacks every changed file with its diff in place. Both surfaces read `$lib/transcript/turn-review.ts`'s aggregation of the same `TranscriptToolCallItem.diff`/`$lib/diff.ts`'s new shared `diffStats` values `DiffViewer` already renders inside each tool card — no second diff implementation, no new wire message. Deliberately read-only: C1-4 (keep/reject per file/hunk) was not picked and depends on #603, so neither surface has any control that reverts, restores, keeps, or discards anything on disk.
- 7f524e3: Move session/project/target envelope decrypt+encrypt (SPEC §8) off the main thread into a bundled Web Worker, and batch a burst of same-tick envelopes into one `Promise.all` inside the worker's own message handler (issue #756, cockpit-parity decision E3-4).

  `RelayClient` no longer holds the raw AMK or calls `crypto.subtle` directly for session traffic: `envelope-crypto-client.ts`'s `createEnvelopeCrypto` picks a worker-backed implementation in any real browser/Electron context (`typeof Worker !== 'undefined'`) and falls back to an in-process one only where no `Worker` global exists (Node/vitest). The AMK crosses to the worker exactly once, as a Transferable `ArrayBuffer` (a dedicated copy, not the caller's own array), detaching the main thread's copy immediately. The worker is loaded via a static, literal Vite `?worker` import — same-origin, bundled, no dynamic URL, no `eval` — and survives the PWA's `injectManifest` service-worker precaching with no `vite.config.ts` changes (its emitted chunk already matches the existing `client/**/*.js` glob, verified against a real production build).

  A decrypt failure still surfaces exactly as before (the same `console.warn` call sites, unchanged); a corrupt envelope in a batch fails only its own slot, never the rest of the batch.

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
  - @loombox/crypto@0.1.0

## 0.5.0

### Minor Changes

- e6c44d0: Peers announce a build identity alongside the protocol version, and a build mismatch is now visible on a node's own row instead of staying invisible until someone SSHes in and reads process start times (issue #655)

  On 2026-08-04 my resident node had been running since 29 July, across roughly fifty merged PRs including wire-level changes, and it connected to a freshly deployed relay without a word. That is the check working as designed and the design being too coarse: PROTOCOL_V1 has been 1 since the beginning and bumps only on a breaking wire change, so two peers built a week apart both announce it and shake hands happily while silently disagreeing about what several fields mean.

  `initialize`/`initialize_result` now carry an optional `buildIdentity` (package.json version plus, when honestly recoverable, the commit): a node reads its own git HEAD at startup (it runs unbundled from a checkout via tsx, so this is free, no new build step), and the relay reads `LOOMBOX_BUILD_COMMIT` in production (passed through from the exact `$SHA` deploy-prod.sh already writes to DEPLOYED.json) or falls back to git rev-parse in dev. Both fields are additive and optional; a peer that predates this change still connects exactly as before.

  The relay records each connected node's build identity and exposes it on `target_list` entries (`build`), mirroring how `reachable` already works: live-connection-derived, absent for an offline node or one that predates the field. `buildIdentityMismatch` in `@loombox/protocol` is a pure equality/absence check, never version parsing or ordering, matching this issue's own constraint that feature detection stays the protocol's job.

  The client shows a node's version on its own row (`TargetStatusView`) and adds a quiet "Behind" badge when it differs from what the relay itself is serving (`RelayClient.relayBuildIdentity`, from the client's own `initialize_result`). Three outcomes: same protocol and build stays silent, same protocol with a different build connects and gets the badge, an incompatible protocol is still refused via the existing `update_required` path, unchanged.

- 717a8c0: Collapse `ConfigBar`'s model, thinking and mode pickers behind one consolidated trigger and popover (cockpit v8 decision E1-2, issue #711)

  The three separate inline pickers used to sit directly in the composer row. They now collapse behind one trigger reading e.g. "Opus 5 · High" (every non-`mode` category's current selection, dot-joined) that opens a single popover holding all of them: one `Select` per non-`mode` category plus `mode`'s existing segmented control, unchanged. This is the trade Lorenzo picked explicitly - a second click, for the narrowest footprint of the layouts considered in `docs/design/ux-review-2026-08-05/section-e-model-effort.html` (option E1-2).

  Presentation only, laid on top of whatever the session's `ConfigOptionStore` already carries (issue #705 is what actually populates it from a real agent). No hardcoded model list, thinking scale, or assumption that exactly two or three categories exist: the trigger's own text and the popover's own section list are both driven off `options` generically, so a synthetic fourth category (or a fifth, or a first if `model`/`thought_level` are ever renamed) renders as one more section and joins the trigger's summary the same way, rather than vanishing. `mode`'s separate `modes` ACP field is already folded into its own `configOptions` entry upstream (`client.ts`'s `mapConfigOptions`, issue #705), so exactly one mode picker ever renders here.

  The popover follows `Select`'s own "anchored, no `Overlay` scrim" contract, extended to a compound panel: opening it moves focus onto its first real control (mirrors `Dialog`'s focus-on-open), Escape closes it and returns focus to the trigger, Tab traps and wraps within it (`Dialog`'s own `focusableElements`/keydown pattern, minus the `Overlay` backdrop), and a click outside closes it without stealing focus (mirrors `Select`'s own click-outside listener). Caught and fixed while building this: a naive focus-trap selector (`button:not([disabled])`) doesn't respect `mode`'s existing roving `tabindex="-1"` on its unselected segments, since a native `<button>` matches that selector regardless of its own `tabindex` value - an unselected mode segment was a real Tab stop until a second filter pass excludes anything explicitly marked `tabindex="-1"`.

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

- 39f6b36: Fixed the tool-call gutter icon sitting off the command's baseline in every
  tool row (issue #703 — reported in the real desktop app: "le icone dei
  comandi eseguiti di quando esegue un tool non sono allineate con il testo del
  comando"). `ToolCard`'s plain variant (used by `BashWidget`,
  `EditWriteWidget`, and the resting/collapsed state of `GenericToolRow` and
  `TodoWidget`) carried its own `padding-top` copied from `ToolCallGutter`'s,
  on the theory that matching the value would keep the two aligned — instead it
  sank the header text by that same amount a second time, since the gutter's
  own padding was already the one nudge needed (an SVG icon at `1em` has no
  font leading, so it needs pushing down to land where the text's ascent
  metrics put its first line). Removed the redundant copy from `ToolCard`.

  Rather than replacing the gutter's own hand-tuned pixel offset with a
  different hand-tuned pixel offset (which only ever matches the one font/size
  it was measured against, and this column serves several — monospace
  commands, UI-sans titles, two different type sizes), the gutter now reserves
  one line of height (`1lh`) and centers the icon in it, so it tracks whatever
  `line-height` the header text next to it actually uses instead of a constant
  someone eyeballed against one row.

- 6f5dbe0: Fixed a real bug behind issue #660 (agent text appearing in one burst instead of streaming): `RelayClient` never resent `session_resume` after a reconnect, so a session's live updates silently stopped arriving once its connection dropped and came back (a slept laptop, a network blip, a heartbeat timeout) until the whole page reloaded. Now every session still marked as subscribed gets resumed again on every fresh handshake, first connect or reconnect alike.

  I also swapped the streaming test fixtures: `echo-acp-agent.mjs` used to send its two reply chunks synchronously, zero delay, which is exactly the shape that let a "batch and flush on turn end" regression pass every existing streaming test undetected. It now sends them with a real gap. I added a new `streaming-acp-agent.mjs` fixture that streams several thought chunks then several answer chunks over real time, and used it to write tests that assert the transcript grows while a turn is still open, not just that it's correct once the turn closes.

- f842504: Thoughts and user turns get their v8 look (design spec `2026-08-05-cockpit-v8-decisions.md` §2, issue #709).

  B1-1: dropped the thought's own card and italic. A thought is plain text now, a real size and colour step down from an answer (`--text-small-size`/`--color-text-secondary` instead of `opacity: 0.65; font-style: italic`), so type is the only thing marking where a thought starts or ends. The gutter column still paints nothing sighted, same as v7 left it; this isn't a licence to bring back a gutter accent bar.

  B2-1: the expand/collapse choice is one preference now, not per-thought local state. `$lib/expand-thoughts.ts` stores a single boolean in `localStorage`, the same shape `$lib/accent.ts` already uses, read once on startup and applied to every thought in every session. It defaults to expanded, matching what Lorenzo actually asked for. The disclosure toggle moved above the thought and lost its "Show thought" text; it's icon-only now and carries its own `aria-label` ("Expand thought"/"Collapse thought") so the accessible name survives losing the visible text.

  That preference collides with issue #660 on purpose: a thought that's actively producing text stays visible no matter what the resting preference says, so a streaming thought under a collapsed preference is never invisible until you open it and it all lands at once. Proved with a test that fails against the unfixed gate (reverted `displayExpanded`'s `|| thinking` and watched the streaming-visibility test go red before restoring it).

  B3-3: the user turn's fill is `color-mix(in srgb, var(--color-accent) 8%, transparent)` instead of the flat `--color-surface-raised`, which measured three times starker in light than in dark. Verified in a real browser, both themes, against a real link and a real Send button, that 8% reads as a quiet fill rather than a clickable surface.

- e96fdbd: Topbar gets its v8 shape (design spec `2026-08-05-cockpit-v8-decisions.md` §3, issue #710).

  C1-3: the labelled `Workbench` button (`+page.svelte`'s topbar actions) is a plain icon toggle now, in the same position and order — no `.panel-word` at any viewport width, unlike `Terminal`/`Jump to…` beside it, which keep revealing theirs at `--bp-wide`. This deliberately does only half of what Lorenzo first asked: the Files/Config/Runner group stays inside the right sidebar's own header, exactly where it already was. `cockpit-shell.spec.ts:227`'s `workbench-toggle`/`aria-pressed` assertion still holds; the specs asserting the sub-tabs live in the panel now say so as a permanent contract, not an incidental one.

  D1-1: the Agent/Tracker switch moves into the topbar, centred, tied to the currently selected session's own project (mirrors `selectSession`'s own project assignment so it can't show a stale project's board just because the sidebar's "open tracker for project" menu ran more recently). `.topbar` is a real `grid-template-columns: 1fr auto 1fr` now, not the old two-zone `space-between` flex — the two flanking columns are forced to equal width by the grid algorithm, which is what keeps the centre column's midpoint pinned to the topbar's own midpoint regardless of how long the left zone's project path/title gets or how many icons the right zone carries. Verified with `getBoundingClientRect`, not a screenshot: centre-to-centre delta stays ≤2px across five widths (1024–1920px) with both a short and a deliberately long title/project/target, and while showing that session's own Tracker board.

  Narrow-window answer, decided and tested: below `--bp-desktop` (1024px) the switch drops out of the topbar entirely rather than fight the truncating left zone or the rigid right one for width. It doesn't get a full-width bar of its own down there, because it isn't that width's only route — the sidebar's own `destination-tracker` row (demoted, not deleted) is already primary navigation below that breakpoint for every other destination too.

  Proved the four new/rewritten `cockpit-shell.spec.ts` assertions actually exercise the fix: reverted `+page.svelte`'s half of the diff (keeping the tests) and watched all four go red — the icon-only assertion found the label still present, the two D1-1 tests couldn't find `topbar-view-switch` at all — before restoring it.

- 1df8a0e: Widened the transcript's reading measure from 90ch to 100ch (v8 decision A1-1). One token, `--measure` in `tokens.css`; the transcript column, the composer/toolbar strip beneath it, and the escrow/auth banner all read wider since they were already tied to the same value. `--measure-wide` (diffs, code, terminal, page shells) is untouched at 120ch and stays inert inside the transcript, same as before.
- Updated dependencies [6f90259]
- Updated dependencies [e6c44d0]
- Updated dependencies [9b5f66a]
- Updated dependencies [6f5dbe0]
- Updated dependencies [3e2e5f4]
- Updated dependencies [ff47e23]
  - @loombox/protocol@0.6.0
  - @loombox/providers-core@0.3.1
  - @loombox/crypto@0.0.7

## 0.4.1

### Patch Changes

- 35f3924: Tracker records are addressed by project, not by session, so a project's tracker
  is readable when no agent session is running for it. Adds a project resource key
  to the AMK key tree (`['project', accountId, projectPath]`), re-addresses the
  four tracker record messages to `nodeId` + `projectPath`, and makes the node
  answer every request it receives rather than dropping unanswerable ones.
- Updated dependencies [35f3924]
  - @loombox/crypto@0.0.6
  - @loombox/protocol@0.5.1

## 0.4.0

### Minor Changes

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

## 0.3.0

### Minor Changes

- ebcf227: Terminal dock: the terminal's own card and duplicated "Terminal" titlebar are gone (issue #669, design spec §4 D1-2/D2-2). One thin bar remains at the top of the dock, carrying live connection status, the session's real working directory, the shell running the active PTY, and a new-tab control that opens genuinely additional terminals for the same session, each kept alive when you switch away from it. `cwd`/`shell` are real values reported by the node (`terminal_opened`'s payload gained these two fields) — never guessed client-side.

  The dock itself moved to `--color-rail` and dropped its hairline border against the canvas, so the seam is a colour step instead of a line; the resize handle stays discoverable on hover and still works from the keyboard.

- 537b32a: Tracker page owns setup: the empty state asks, and the mode picker moves into its header

  Two settled decisions from the 2026-08-04 review (spec
  `2026-08-04-cockpit-v7-decisions.md` §6, F1-1/F2-2, issue #672).

  **F1-1**: the Tracker page's empty state stops being blank. A project with
  no tracker mode chosen yet meets the real setup step right there — native
  (loombox's own local tracker) or live against a connected GitHub/Jira
  account — instead of a panel with nothing in it. Connecting a GitHub or
  Jira account is reachable from the same spot when none is connected yet
  ("Connect GitHub"/"Connect Jira" alongside the existing "use native
  instead"), scoped to the session's own node.

  **F2-2**: the tracker-mode picker moves out of Config and into the
  Tracker page header. Once a mode is saved, the header carries a compact
  badge + "Change tracker mode" control — one surface answers both "what is
  this" and "change what this is". Config's Tracker section is deleted
  outright, not mirrored (F2-1 was reviewed and not picked): leaving both
  would reintroduce the exact two-places-for-one-fact problem this decision
  exists to remove.

  **A known, documented gap**: `NodeDaemon.readTrackerSnapshotForBridge`
  (issue #631) reads the local native tracker unconditionally and does not
  yet consult the saved mode, so a project switched to `live` still shows
  local records underneath. This issue does not wait on that node-side fix;
  the Tracker page names it directly (`#631`) whenever a `live` mode is
  saved, rather than silently showing data that doesn't match the choice.

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

- 77689ba: Turn delimitation v7 (design spec `2026-08-04-cockpit-v7-decisions.md` §2, issue #667: B1-2 amended + B2-4).

  **B1-2 amended** — a user turn keeps its `--color-surface-raised` fill; an agent turn now has no fill at all and runs straight into the page background (the pre-v6 behaviour, restored on purpose); neither carries a gutter accent bar anymore — the bar the option was drawn with is gone, per Lorenzo's amendment. Exactly one signal per role, and for the agent that signal is absence.

  **B2-4** — the decorative provider glyph that used to sit in the transcript's role gutter is gone. The `.sr-only` accessible role label stays on every turn (a screen reader still announces "You"/the provider name regardless), which is the whole reason this is a design choice and not an accessibility regression. `showAttribution` and the consecutive-run grouping it drove (`$lib/transcript-attribution.ts`) are removed with it — there is nothing left in the gutter for that logic to suppress.

  The shared `--gutter` token (`tokens.css`) narrows from `4.75rem` to `2.5rem`: it no longer needs to fit a word or an icon, only the alignment job every sibling row (`ToolCallGutter`, `PlanCard`, `QueuedPromptBar`, the composer) still reads from `var(--gutter)`.

  `MessageItem.svelte`'s "one timeline metaphor" doc comment is rewritten for this pass; thought turns are unaffected (out of scope) and keep their existing quiet `--color-surface` surface. No change to the per-row hover-revealed copy button (B3).

- bbacaf9: Composer: drop both separators and lift the field, bigger attach glyph, Stop replaces Send with progress on the gutter

  Three settled decisions from the 2026-08-04 review (v7 §1, issue #666), shipped
  together because they share one strip of markup.

  - **A1-3**: both of the composer's separators are gone — `.canvas-footer`'s
    `border-top` hairline and the flat rule that used to sit directly above the
    field's own border. The field keeps its border, moves to
    `--color-surface-raised`, and gains a soft `--shadow-md`, so it reads as
    floating above the page. This is deliberately the ONLY raised surface in an
    otherwise flat app — the composer is the one always-docked control surface,
    and it is allowed to be the one lifted one. Don't harmonise it back flat,
    and don't spread the shadow to another surface.
  - **A2-1**: the attach glyph goes from 16px to 20px (still on `IconButton`'s
    existing hover fill). The placeholder stops teaching `@` ("Send a follow-up
    prompt…" now, was "…(type @ to reference a file)"); the `@` instruction
    moves into the hidden hint line already wired via `aria-describedby` —
    verified end to end against Chromium's own accessibility tree (CDP
    `Accessibility.getFullAXTree`), not just the DOM's `id` match.
  - **A3-2**: one button in one slot. While a turn runs, Send is replaced by
    Stop (gone, not disabled-and-present) — both render at the same `Button`
    size now, so the slot's footprint never changes at the swap. The pulsing
    `StatusDot` that used to sit on the Stop button is gone too: progress now
    belongs to the turn, not the control — a live "Working…" line renders in
    `.canvas-footer` on the transcript's own `--gutter` column (reusing
    `.composer-gutter`, not a second copy of the token) whenever a turn is
    active and the transcript has no live signal of its own for it yet (i.e.
    not already covered by a streaming thought's own inline loader), and
    clears the moment the turn ends.

  The composer's gutter also drops the inset accent bar it used to carry for
  "your turn" (v7 §2's amended B1-2/B2-4, issue #667) — role is surface-only
  now, matching every transcript row.

- ac9c65f: Move transcript export out of the session header into the session row's `⋯` menu, and stop drawing it as a copy icon

  The session header carried a bare copy-glyph icon button next to the
  Workbench and Terminal toggles, with no label to say what it did — it
  turned out to be transcript export. The header now carries exactly the
  two toggles that actually open a panel, both labelled, one consistent row
  (design spec `2026-08-04-cockpit-v7-decisions.md` §4, D3-3, issue #670).

  Export moved into the session row's `⋯` menu (sidebar), next to Copy
  project path and Archive session…, as a plain "Export transcript" menu
  item — no copy glyph anywhere on this action now, matching the real verb.
  It is offered only from the currently open session's own row, since that
  is the only transcript this page holds decoded client-side; the copy
  behaviour itself (`exportTranscriptText` + `copyToClipboard`) is
  unchanged, only its trigger moved.

  Accepted cost, stated so it doesn't get relitigated: exporting the
  transcript is now a hop back to the sidebar from inside it.

- e262dba: Attention Inbox: a card per session with the agent's message in full, a dim-then-clear undo window, and j/k/digit keyboard triage

  Each inbox row now shows the agent's actual last message in full
  (`AttentionInboxItem.agentMessage`, plumbed by #662), rendered through the
  same sanitised Markdown pipeline the transcript itself uses — no more
  one-line derived "need" label with nothing else to go on (design spec
  `2026-08-04-cockpit-v7-decisions.md` §5, E1-3, issue #671).

  Answering a permission or a reply no longer removes the row on the next
  store tick. It dims, shows the outcome, and offers Undo for a couple of
  seconds before the real `resolvePermission`/`sendPrompt` call actually
  fires (E2-1) — Undo cancels that deferred call outright, so it is a true
  restore, not a race against an already-sent resolution.

  `j`/`k` move a list-wide keyboard cursor across rows; a digit key answers
  whichever row the cursor is on (the same binding `PermissionCard`'s own
  `#148` keydown handler already provides when it holds literal focus
  directly); Enter drops into a focused `awaiting_input` row's reply box.
  Per the spec's own conflict resolution: the permission option buttons no
  longer print a `1`/`2`/`3` digit of their own (E1-3's amendment) — the
  key bindings still work, and the inbox's own hint bar is now the only
  place a digit shortcut is advertised.

- bcf35fe: The Attention Inbox row is a real card again (background, border, hover tint) instead of bare text, and its Open trigger's title reads above the subtitle, left-aligned, instead of both centred. The onboarding "Set up this device" choice cards are left-aligned too. Both were the same bug: a CSS override handed to `Button`/`Row`/`IconButton` always lost to the primitive's own specificity and was silently discarded. `Button` gains an `align` prop (`'center'` default, `'start'` for a left-aligned, stacked label) and `Row` gains a `surface` prop (the card background/border/hover treatment) so a caller states the layout it needs instead of fighting the primitive's CSS.
- 7a66d82: Tool calls in the transcript now rest as a single line (command plus outcome), with output behind a disclosure instead of always expanded — a passing multi-line call costs the same row as a one-liner until you click to expand it. A failed call is the one exception: it always renders in full, uncapped, with its disclosure locked open so it can't be collapsed by accident. Consecutive tool calls now render as a tight, compact list instead of each carrying full turn spacing.
- 55187f8: Show a tool call's actual output instead of its wire envelope. `content`
  arrives from ACP as an array of `ToolCallContent`, and anything that was not
  already a plain string was rendered with `JSON.stringify` — so a failed
  command printed `[{"type":"content","content":{"type":"text",...}}]` where its
  error should have been (issue #689).
- 46a3f76: Local tracker: built-in Task/Bug/Epic, a `bug:` title prefix, and a real "Manage types" surface (v7 decision F3-1, issue #673)

  Task/Bug/Epic already shipped as built-in types on the node side
  (`NativeTrackerStore.listTypes()` always includes them), but the client
  put "New type" right next to "New record" in the Tracker page's own
  header — equally prominent, so a fresh project's first Tracker visit
  still looked like it needed data modeling before you could record
  anything.

  Typing `bug:`/`task:`/`epic:` (or any custom type's own id), case-
  insensitively, at the start of the title in `TrackerRecordDialog` now
  picks that type and strips the prefix from the stored title — matched
  against every currently known type, longest id wins so a more specific
  custom type never gets shadowed by a shorter built-in one. Only applies
  in create mode; editing an existing record never re-derives its type
  from the title.

  "New type" moves behind a new "Manage types" action, which is also the
  actual fix for the write-only complaint: the old dialog only ever
  rendered a blank create form, with no surface anywhere that showed a
  type back once you'd defined it. `TrackerManageTypesDialog` is a single
  dialog (mirroring `AddTargetWizard`'s own single-panel, multi-step
  convention — never two stacked overlays) that lists every known type and
  swaps to the same define-type form for "New type"; the list renders
  whatever `types` the caller's live snapshot holds, so a defined type
  shows up there again on reopen and survives a reload — proven with a
  component test that unmounts and remounts against a fake backend
  external to the Svelte tree, not local component state. The node-side
  persistence and the wire round trip were already covered
  (`native-tracker-store.test.ts`'s "persists across a simulated restart",
  `relay-client.test.ts`'s `defineTrackerType` suite) — the actual gap was
  purely the missing UI surface.

  Existing records and the built-in type ids/labels/roles are untouched,
  so nothing remaps across this change.

  Not addressed here: `NodeDaemon.readTrackerSnapshotForBridge` reads the
  native store regardless of `TrackerMode` (issue #631), so a project
  switched to GitHub/Jira still sees local tracker data with no error. #673
  is scoped to the local tracker itself and ships with that gap
  undisturbed — a picker for GitHub/Jira project is a separate concern
  (v7 decision F1-1/F2-2).

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/protocol@0.4.0
  - @loombox/crypto@0.0.4

## 0.2.0

### Minor Changes

- 661aac2: Build the SPEC §7.26 connected-accounts Settings UI (issue #230), the Svelte-only remainder after #643 shipped the wire protocol/relay/node/client-API layer.

  Settings gains an "Accounts" section (`ConnectedAccountsSection`), reachable in both the desktop sub-nav and the narrow segmented control:

  - `ConnectedAccountsList` — a `Row`-based list mirroring `TargetStatusView`'s row/expansion/confirm pattern, rendering `label`/`avatarUrl`/`host`/`capabilities` from the real synced `ConnectedAccount` fields. `secretRef` is never rendered.
  - `GithubConnectFlow` — a `Dialog` driving `RelayClient.startGithubConnect`'s device flow: the user code renders large, monospace, and selectable (with a copy button) as soon as it arrives, then a waiting state, then success/failure. Cancel calls the flow's own `cancel()`.
  - `JiraConnectForm` — a three-field `Dialog` form (`siteUrl`/`email`/`apiToken`) over `connectJiraAccount`; a successful connect clears the form and stays open rather than closing, so a second/third Jira site adds a row instead of replacing one.
  - Disconnect mirrors `TargetStatusView`'s `confirmingRemove` inline-bar pattern, with a generic warning that a pinned project may break (the full per-pin scan is issue #229).
  - `AccountPinPicker` — the per-project, per-capability tri-state pin map (`getAccountPins`/`setAccountPin`/`unsetAccountPin`) as a real three-way `RadioGroup` (Unconfigured / Opted out / a specific account), plus a `resolveAccountPin` preview that renders `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as five distinct states with a concrete next step, never a raw error string.

  Every account operation is node-scoped (connect/disconnect/pin storage all run on a specific node); the section carries one shared node picker, hidden when only one node is known.

  `+page.svelte` passes `client`/`connectedAccounts` into `SettingsPage`, which gates the new "Accounts" nav entry on `client` being present, the same pattern `deviceId` already gates "Push" on.

- 535a2ee: Add the SPEC §7.26 connect/disconnect/pin wire protocol, relay routing, node handlers, and `RelayClient` API for connected accounts (issue #230)

  New `@loombox/protocol` message pairs: `github_connect_start_request`/`_cancel_request`/`_device_code`/`_result` (RFC 8628 device flow, issue #222), `jira_connect_request`/`_response` (API-token connect, issue #225), `connected_account_disconnect_request`/`_response`, and `account_pin_get/set/unset_request` + `account_pin_response` + `account_pin_resolve_request`/`_response` (per-project, per-capability pinning and hard-fail preview, issue #227). None of these ever carry a token, API key, or other secret — only metadata and routing fields.

  `packages/relay`: routes every one of the above directly by `nodeId`, scoped to the requester's account, through one consolidated `pendingAccountRequests` table (mirrors the existing `provision_target_request`/`ssh_discovery_request` pattern); a successful disconnect also forgets the account's synced metadata row (`ConnectedAccountStore.remove`, new on the store interface, in-memory and Postgres).

  `packages/node`: `NodeDaemon` now runs `GithubConnectService`/`JiraConnectService`/`AccountPinStore`/`account-pin.ts`'s resolvers against these messages — the device flow's user code streams back before the terminal result, a disconnect deletes the local keyring secret, and pin resolution surfaces `AccountPinRequiredError`/`AccountPinMalformedError`/`AccountHostMismatchError`/`AccountPinDanglingError`/`AmbiguousAccountError` as real, distinguishable response states.

  `apps/web`'s `RelayClient` gains a `connectedAccounts` reactive store (fed by the existing `connected_account_list` snapshot) plus `startGithubConnect`/`connectJiraAccount`/`disconnectAccount`/`getAccountPins`/`setAccountPin`/`unsetAccountPin`/`resolveAccountPin`/`refreshConnectedAccounts` — the write-path client API #230's UI is built against.

  **Scope note**: this change ships the wire protocol, relay routing, node handlers, and client API only. The Svelte UI itself (a Settings "Accounts" section, the device-flow/API-token connect forms, the per-project pin picker, and the disconnect confirmation) is tracked separately — see issue #230's own thread for the remaining UI work.

- 99e3583: Native tracker: kanban/list UI with custom type support (SPEC §7.10)

  Adds the client surface for loombox's own local tracker (`packages/shared`'s `NativeTrackerStore`, #210): a full-width Tracker page reachable from the left sidebar once a session is selected, with a kanban board and a priority-sorted/assignee-filtered list view, both driven entirely by `@loombox/protocol`'s new role-driven helpers (`resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) so a built-in Task/Bug/Epic and a project-defined custom type render identically — nothing in this feature branches on a record's `primaryType`.

  `@loombox/protocol` gets `tracker-records.ts`: the wire schema (`TrackerRecordV1`/`TrackerTypeDefinitionV1`) plus four new encrypted, session-scoped wire messages — `tracker_snapshot_request`/`_response` (read) and `tracker_write_request`/`_response` (create/update/defineType) — mirroring `fs.ts`'s existing pattern exactly. `@loombox/node` wires these into `NodeDaemon` against the same `NativeTrackerStore` a future MCP host will bind an agent's `tracker_*` tools to, so a human edit and an agent write land in the same on-disk file. `@loombox/relay` routes both pairs to/from the owning node exactly like `fs_list_request`/`_response`.

  The UI ships: empty state with a "New record" CTA, a retryable `ErrorNotice` (matching the Files panel's #582 "didn't answer in time" wording) for both a wire error and a client-owned bounded-wait timeout, and a loading state that always terminates. The kanban board answers issue #212's mobile requirement directly: at <=767px it renders one column at a time with Prev/Next controls instead of a horizontal scroll of narrow columns. Moving a card between columns has two paths — native HTML5 drag-and-drop for a desktop mouse, and a fully keyboard/touch-operable "Move to" `Select` on every card — both calling the same `RelayClient.updateTrackerRecord`, never local component state. A "New type" dialog lets a project define a custom type's `roles` mapping (which `fields` key holds title/status/priority/assignee), after which every generic surface renders it correctly with no code change.

- e05423a: Add per-project test/lint/build command configuration and auto-detection (SPEC §7.15, issue #245)

  A project's test/lint/build commands can now be read, saved, and auto-detected through the owning node: `TestRunnerConfigStore` (`@loombox/node`) persists them per project (mirrors `PermissionPolicyStore`'s JSON-file shape), and `detectTestRunnerCommands` proposes commands from `package.json`'s `scripts` block via whichever `ExecutionTarget` the project's session runs on (`local` or `ssh:`), picking `pnpm`/`yarn`/`npm` syntax off the project's lockfile. Detection only ever proposes a command for a script that genuinely exists — never a guessed default for a project with nothing detectable.

  Five new v1 wire messages (`test_runner_config_get`/`_set`/`_detect` client-to-node, `test_runner_config_result`/`_detected` node-to-client), routed/fanned out by the relay exactly like `fs_list_request`/`fs_list_response`, sealed under the session key so no command string ever reaches the relay in the clear. `RelayClient` gains `getTestRunnerConfig`/`setTestRunnerConfig`/`detectTestRunnerConfig`; `ProjectConfigPanel` gains a new "Test, lint & build" section (`TestRunnerConfigPanel`) with per-command explicit save and an "Auto-detect" action whose suggestions are shown for confirmation and never applied without an explicit Accept click.

  This ships the configuration half of SPEC §7.15's test runner (issue #245); the streaming execution half (issue #244, running the configured commands with live output and cancellation) is tracked separately.

- 635e20d: Add the streaming test/lint/build runner surface (SPEC §7.15, issue #244)

  Running a project's configured test/lint/build command (issue #245's config half) now streams live results from the cockpit instead of requiring a raw terminal. `packages/node/src/test-runner-process.ts` runs the command via `sh -c` on either target: locally with `child_process.spawn({ detached: true })`, so a cancel kills the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the launcher; over `ssh:` it reuses the existing `RemoteProcessRunner` (setsid+fifo+log-tail) rather than opening a second channel, adding its own exit-code side-channel on top since that runner never captured one for a background job, and its cancel goes through `RemoteProcessRunner.stop()`, whose `setsid` branch now kills the whole remote process group (issue #642/#645). Both targets classify "command not found" as a uniform POSIX 127 instead of branching on ENOENT vs. remote shell text. `NodeDaemon` evaluates the project's permission policy (`evaluateCommandLine`, the same entry point `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) before ever spawning, so a denied command surfaces as `could_not_start` with a policy reason and never runs.

  Five new v1 wire messages (`run_start`/`run_cancel` client-to-node, `run_started`/`run_output`/`run_exit` node-to-client), modeled on `terminal.ts`, routed/fanned out by the relay exactly like `terminal_open`/`terminal_output`, sealed under the session key so no command, output, or outcome ever reaches the relay in the clear. `RelayClient` gains `startRun`/`cancelRun`/`onRunOutput`/`runsFor`. The right sidebar's Files/Config sub-tabs gain a third "Runner" tab (`RunnerPanel.svelte`): one Run/Cancel action per configured command, its combined output streaming live (reusing the display-only `TerminalOutput` component), settling to a pass/fail/could-not-start state with the real exit code.

  Cancelling reaps the whole process tree on both targets, including forked grandchildren — verified with a `sleep 30 &`-forking fixture at the process, `NodeDaemon`, and (ssh) `RemoteProcessRunner` layers. Closing a node now also cancels every still-running local/ssh run instead of leaking it, the same way it already does for open terminals.

- 8c833f3: Add the per-project TrackerMode picker and live-target configuration UI (SPEC §7.10, issue #220)

  `ProjectConfigPanel`'s right-sidebar config surface now has a Tracker section, ahead of MCP servers/plugins since it's the one config choice SPEC §7.10 calls "every project chooses, once" that everything else in a future tracker view will depend on.

  A project with no `TrackerMode` set (reading `tracker-mode-store.ts`, issue #209) opens straight into the picker: a `role="radiogroup"` choice between native and live, following #549's precedent for a genuinely mutually-exclusive control. Choosing live reveals a provider choice (GitHub/Jira) and then that provider's own target fields (`owner`/`repo`/optional Projects v2 board number for GitHub, `cloudId`/`projectKey` for Jira) — the fields are conditional on provider, never one flat set. The connected account is picked from a new `ConnectedAccountPicker`, backed by a new `RelayClient.connectedAccounts` store (fed by the `connected_account_list` snapshot #221 already syncs, the same "request once on handshake" shape `sessions` uses). No connected account for the chosen provider renders an `EmptyState` with a real, working next step ("Use native mode instead") rather than an empty dropdown — there is no in-app "connect an account" flow yet (that's #230), so this doesn't invent one.

  Once a mode is saved, switching it is explicit: a summary card with a "Change tracker mode" button, not an always-editable form — the editor reopens pre-filled from the current mode, never blank. Draft validation goes through a new `tracker-config-form.ts`, a thin wrapper over `@loombox/protocol`'s own `trackerMode` Zod schema, so the form can never accept something the rest of the app's own re-validation would then reject; a bad or incomplete draft shows a real error, never a silent no-op.

  New: `apps/web/src/lib/tracker-config-form.ts`, `apps/web/src/lib/components/ConnectedAccountPicker.svelte`, `apps/web/src/lib/components/TrackerConfigPanel.svelte`, plus their tests. `RelayClient` gained a `connectedAccounts` readable store (relay-client.ts, relay-client.test.ts) and `ProjectConfigPanel`/`+page.svelte` wire it through. `tests-e2e/form-rhythm.spec.ts` gained a case for the new form's field stacking.

### Patch Changes

- 7806db0: Lazily load the transcript Markdown syntax highlighter instead of shipping it in the cockpit's first chunk (issue #600)

  #574 landed full Markdown rendering in the transcript, and `highlight.js` plus its 18 registered grammars (`rehype-highlight` in `apps/web/src/lib/markdown.ts`) landed eagerly in the cockpit route's own chunk — measured at +101,550 B gzip on top of #574's own pipeline. `$lib/markdown.ts`'s `renderMarkdownToHtml` (the synchronous first render every message goes through) no longer highlights at all; a new async `highlightMarkdownToHtml` dynamically imports `rehype-highlight` and only the grammar(s) a given message's fences actually reference, then upgrades the render in place once it resolves. A closed fence renders plain monospace (readable, escaped, already carrying its `language-xxx` class from `remark-rehype`'s own fenced-code handling) until then — the same state an _open_, still-streaming fence already renders as, so there's no new visual state and no flash to design around.

  `MessageItem.svelte` composes the two independent async triggers (streaming's fence-close re-render, and the highlighter's own async arrival) without racing: a highlight result only applies if the stable source it was computed for is still current when it resolves.

  Sanitisation ordering is unchanged — `highlightMarkdownToHtml` re-runs the identical pipeline (`remark-parse`/`remark-gfm` → `remark-rehype` without `allowDangerousHtml` → `rehype-sanitize` on the unmodified default schema → the trusted `externalLinks`/`wrapTables` plugins → `rehype-highlight` → `rehype-stringify`), just invoked asynchronously; highlighting still runs after sanitisation in every case.

  Measured with `vite build` on `apps/web`: the cockpit route's own chunk (`nodes/2.*.js`) drops from 977,513 B / 269,244 B gzip to 811,570 B / 217,331 B gzip (−165,943 B raw, −51,913 B gzip, −19.3%). The highlighter and its grammars (~100 kB raw / ~33 kB gzip, in a shared chunk split out of the cockpit bundle) are now fetched only the first time a message's fence actually needs highlighting — never, for a session with no code blocks.

- 29da402: Validate decrypted session_update/permission_request payloads with Zod instead of casting them (issue #593)

  `apps/web`'s `relay-client.ts` opened every decrypted `session_update`/`permission_request` envelope with a bare `openJson<T>()` generic cast — nothing ever checked the JSON actually matched `AcpSessionWireEvent`/`PermissionRequestPayload`. `AcpToolCallUpdate.id` was declared `string` but could be `undefined` at runtime, the root cause behind #548 (patched there one reducer-level comparison at a time).

  `@loombox/providers-core` gets a new `acp-wire-schema.ts`: Zod schemas for `AcpTranscriptUpdate`'s five ACP-native kinds (message/thought chunks, `tool_call`/`tool_call_update`, `plan_update`, `usage_update`) plus the `permission_request` payload — the half of `AcpSessionWireEvent` this package owns. The other half, loombox's five invented session-lifecycle kinds, is validated by `@loombox/protocol`'s existing `sessionLifecycleEventV1` schema instead of a new duplicate, since that package already documents itself as their "one validated source of truth" and providers-core keeps zero workspace dependencies by design.

  `relay-client.ts` now parses (not casts) both payloads; a malformed one is dropped and logged before it ever reaches the transcript reducer or the permission queue. #548's reducer-level `id === undefined` guard stays in place as defense in depth, though it is no longer reachable through this path.

- Updated dependencies [79f9f19]
- Updated dependencies [535a2ee]
- Updated dependencies [99e3583]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
- Updated dependencies [29da402]
  - @loombox/providers-core@0.3.0
  - @loombox/protocol@0.3.0
  - @loombox/crypto@0.0.3

## 0.1.8

### Patch Changes

- d6fa86b: Add the Badge and Row UI primitives, give Button arbitrary data-_/aria-_ passthrough, and migrate the safe call sites off their hand-rolled duplicates

  `Badge` replaces four slightly-different hand-rolled badges (MCP server config's secret badge, the target picker's kind/unreachable badges, and the target status view's kind/agent-health badges — the last of which now composes the real `StatusDot` instead of redrawing it). `Row` is the new shared leading/content/trailing list-row shape, adopted first by the attention inbox. `Button` now accepts arbitrary `data-*`/`aria-*` attributes without letting a caller override the props it already owns, which is what let the permission card's overflow toggle move onto it. Also migrated: the add-target wizard's back link, the onboarding choice cards (now `Card` + `Button`), the diff viewer's outer card, and the recovery code card's now-unnecessary wrapper div. Both new primitives are covered on `/style-reference`.

- 9379bde: Give the composer a visible resting surface and a real focus ring

  The composer textarea had no border, no background, no padding and no
  radius (`+page.svelte:4509-4519`), and the one hairline in the whole footer
  belonged to `.canvas-footer`, shared with the plan card, the queued-prompt
  bar and the permission card. Against that, the composer read as plain text
  run against the page background rather than an input.

  Worse, it had no focus indicator at all. A comment at the old
  `:4528-4531` claimed "the focus ring lives on the strip", but no
  `:focus-within` rule targeting the composer existed anywhere in the file.
  At-rest and focused screenshots were byte-identical (md5 match), on both
  desktop and phone: clicking into the composer changed nothing on screen,
  a WCAG 2.4.7 failure.

  `.composer-field` (the textarea plus its controls row: attach, pickers,
  the context/cost figures, Send) now carries a border, `--color-surface-raised`,
  `--radius-md` and real padding, the same vocabulary `ui/TextArea` already
  gives the inbox reply box and the New Session dialog fields. A
  `:focus-within` rule on that same box uses the existing focus-ring token,
  so the ring stays lit while the textarea, the attach button or a picker
  inside the strip holds focus. Send moves from `variant="secondary"` to
  `primary`, so the most-used action in the product is no longer the
  quietest button on the screen.

  The composer's own textarea stays borderless and transparent: its surface
  is the field box around it now, and a second nested border would double
  the chrome. Nothing about the docked-field layout changes, the composer
  still ends the timeline aligned to the same role gutter every transcript
  row uses.

- 3a839c4: Add Windows and Linux electron-builder targets, with icons generated from the same mark

  `apps/desktop/electron-builder.yml` gets a `win` block (NSIS installer plus a portable
  build, `assets/icon.ico`) and a `linux` block (AppImage plus deb, `category:
Development`, `assets/icons`), alongside the existing `mac` block. `package:win` and
  `package:linux` join `package:mac` in `apps/desktop/package.json`.

  Every new icon is generated, not drawn: `gen-brand-assets.mjs` now also emits
  `assets/icon.ico` (rasterized PNG sizes packed into one `.ico` via `png-to-ico`, since
  `@resvg/resvg-js` only renders PNG), the Linux icon set `assets/icons/<N>x<N>.png`
  electron-builder's linux target reads, and a colored (azure) tray glyph pair
  (`assets/tray-icon-azure{,@2x}.png`) alongside the existing macOS template pair. The
  template PNGs themselves are untouched.

  `createTray`'s call site (`src/main/index.ts`) now picks the platform-appropriate tray
  icon via a new pure `pickTrayIconPath` (`src/main/tray-icon.ts`): the macOS `Template`
  image on darwin, which the OS tints itself, and the colored render everywhere else,
  since Windows and a dark Linux panel apply no tinting at all.

  CI coverage for all three platforms is a follow-up (#567).

- 8177b63: Give the mode segments a role a screen reader can read

  `ConfigBar`'s mode control (Auto | Plan) was a `role="group"` wrapping two
  plain `Button`s, with the current mode marked only by a background tint via a
  `selected` class. A screen reader heard "Auto, button. Plan, button." with no
  way to tell which one was current, the one fact the control exists to carry.

  It is now a `role="radiogroup"` of `role="radio"` segments with `aria-checked`
  and a roving `tabindex` (WAI-ARIA APG's radio group pattern): Tab enters the
  group once, landing on the checked segment, and Left/Up and Right/Down move
  both the focus and the selection, wrapping at the ends.

  I picked radiogroup over the topbar panel switch's `aria-pressed` (`Button`'s
  `pressed` prop from the earlier topbar fix) because the two controls mean
  different things. Mode is mutually exclusive and always has exactly one value,
  which is what a radio group is for. The panel switch is not: `toggleDrawer` in
  `+page.svelte` closes the open panel on a second click of its own segment, so
  "none selected" is a real, reachable state there, which is exactly what
  `aria-pressed` (independently on/off, legitimately all-off) describes and a
  radio group cannot. The panel switch keeps `aria-pressed`; I am not touching
  it here, and I do not think it needs to change either, since it is not a
  radio group by nature. `Button` gained plain pass-through `role`,
  `ariaChecked`, `tabindex` and `onkeydown` props to carry this without a
  hand-rolled `<button>` inside `ConfigBar`, so the segmented-control idiom
  stays one shared primitive; every existing call site is unaffected.

  `ConfigBar.test.ts` now asserts the selected mode through the accessibility
  tree (`getByRole('radio', { checked })`), not the class name, which is what
  let this ship unmarked.

- a98b97c: Put the task title first in the New session dialog and make the starting prompt optional. The form now reads Title, Agent, Workspace, Starting prompt, and the title is the field the dialog focuses on open: what identifies a session on the board is the task, not the first thing you happened to say to the agent. The starting prompt drops its `required` mark, shrinks from six rows to three, and its help text now says it can be sent later from the composer instead. Pressing Create with everything blank creates a session titled after the project folder, with no prompt sent at all (previously the dialog sent an empty string). `RelayClient.createSession` already typed `prompt` as optional and only sent the follow-up when non-empty, and the node already fell back to the project folder's basename for an empty title, so this is a dialog-only change.
- 7a5d6a0: Move Nodes into Settings, give Settings real section navigation

  Nodes & targets was a sidebar destination competing with Inbox for
  attention, even though it is setup, not somewhere you go while working:
  you visit it to add a target, connect a node, or find out why one is
  unhealthy. It now lives inside Settings as its own section, alongside
  Appearance, Notifications and Push. `sidebar-destinations` carries Inbox
  alone; the mobile tabbar drops its Nodes item too.

  Settings outgrew a flat `<h2>` stack once a fourth, differently-shaped
  section (infrastructure with its own actions and live polling, next to
  three per-device preference panels) moved in, so `SettingsPage` gets real
  section navigation: a left sub-nav at `--bp-tablet` and above, a
  horizontally-scrolling segmented control below it.

  Two things had to survive the move rather than get dropped silently:

  - The health dot `hasUnhealthyTarget` used to light on the sidebar's Nodes
    row moved onto the account-menu trigger and its "Settings" entry, so an
    unhealthy target is still visible without opening Settings. It is a
    boolean-driven dot, not an inbox item, so it can't accumulate one per
    poll and clears the moment every target recovers.
  - The ⋯ "Target status" deep link (`openTargetStatus`) still lands on the
    right target, highlighted — it now switches to Settings with the Nodes
    section selected instead of its own destination.

  The account-menu entry reads "Settings" instead of "Appearance &
  settings", and the command palette gains "Open nodes and targets" now
  that Nodes is one click deeper than before.

  `docs/superpowers/specs/2026-07-25-ia-v4-design.md` gets an amendment note
  recording that Nodes is no longer a primary destination, since its §3.1
  listed it as one.

- a9dcef0: Give the Files and Terminal panels a bounded wait and a real failure state

  Both panels sat on an indefinite spinner when a node stopped answering. The
  Files panel's loading branch (`FileTreePanel.svelte`) had no failure path at
  all, and the terminal (`InteractiveTerminal.svelte`) initialised
  `status = 'opening'` and only ever left it once the PTY handshake completed. A
  node that had died looked exactly like one that was briefly slow, forever.
  The v6 audit hit both with a fake node that never answers: the panels just
  said "Loading…" and "Connecting…" and stayed there.

  Both now bound the wait to 10 seconds, matching every other request-shaped
  `RelayClient` default. A directory or a terminal still waiting when its own
  timer fires gets a retryable `ErrorNotice`, worded to match what the shell
  already says elsewhere: "the node may be asleep, offline, or on an older
  relay" is `DirectoryPicker`'s exact phrasing from issue #505, not a third
  convention. For the terminal the wording is deliberately careful, since a
  timeout there does not mean the PTY open failed, only that this client
  stopped waiting: "this isn't necessarily a failure, we simply stopped
  waiting". A late real answer, however long after the deadline, still lands
  and clears the failure state, and a directory or terminal that resolves
  just under the deadline never shows an error at all.

  Retry re-requests rather than only dismissing the notice. The Files panel
  calls `onExpand` again, the same lever `expandDirectory`'s own doc comment
  already describes for retrying a directory that came back `'error'`. The
  terminal asks the node to close whichever attempt just timed out and opens
  a genuinely new one, since `RelayClient.openTerminal` treats every call as
  an additional terminal with its own id; the keystroke/output/resize wiring
  now reads the current terminal id at send time instead of one captured at
  mount, so it follows a retry rather than staying pinned to the stale one.

  Covered by fake-timer unit tests in `FileTreePanel.test.ts` and
  `InteractiveTerminal.test.ts`: a silent node reaching the failure state
  within the deadline, a slow-but-alive node answering just under it never
  tripping the error, and retry actually re-requesting rather than just
  clearing the flag.

- 23f8d41: Right workbench sidebar: Files/Config sub-tabs, docked, no dead pin at 1280px

  Two things, closed together because the second bug lived entirely inside the first fix.

  **#573**: the workbench panel's pin control was visible and inert at exactly
  1280px, because `viewport.ts:38`'s `isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX)`
  built `(max-width: 1280px)` and `+page.svelte`'s own CSS built
  `(min-width: 1280px)` for the same decision, both true at 1280 itself. Fixed
  `isNarrowViewport` with an `exclusive` option that subtracts a fixed epsilon
  (`EXCLUSIVE_BREAKPOINT_EPSILON_PX = 0.02`) from the breakpoint before building
  the query, so the two sides of a boundary decision partition the pixel to
  exactly one side. Covered directly in `viewport.test.ts` at 1279/1280/1281,
  with a `matchMedia` stub that actually evaluates the query string rather than
  returning one fixed value regardless of it.

  **#571**: the Drawer's Files/Terminal/Config panel was `position: fixed` by
  default (a modal-strength scrim on every open, `Overlay.svelte:135-141`, and
  the same scrim strength as the New Session dialog), with the "pushes instead
  of covers" behavior gated behind a pin control nobody could find, off by
  default, and dead at the exact width above. Rebuilt on `$lib/dock-panel.svelte.ts`
  (#570), the same shared behaviour the left sidebar runs on: collapse,
  drag-resize, persistence, no second implementation. Docked (no scrim at all)
  at/above `--bp-desktop` (1024px); a side sheet at 768-1023px; a bottom sheet
  below 768px, unchanged from before. Open by default at/above `--bp-wide`
  (1280px) once a session is selected, and sticky to whatever the user actually
  chooses (open/close, or a drag-resize) from the first real interaction on.

  Files and Config are sub-tabs inside the panel's own header now (a
  `radiogroup`, the same mutually-exclusive-always-one-selected idiom
  `ConfigBar`'s mode switch already uses), not a second copy of the topbar's
  former three-button switch. The topbar keeps exactly one control for the
  sidebar itself; the panel choice lives only in its own header. Both panels
  stay mounted (the native `hidden` attribute) once a session/project exists,
  so switching Files to Config never remounts the other one.

  The terminal leaves this panel entirely. Its own bottom dock is issue #572,
  not built here — closing this PR means the terminal is temporarily
  unreachable from the app until #572 lands; `InteractiveTerminal.svelte` and
  its `openTerminal`/PTY logic are untouched and unchanged, just unmounted from
  this component.

- 1d3056e: Give the terminal its own bottom dock, horizontal instead of a 340px-wide overlay column

  The terminal used to be the third tab of the right-hand panel, so it got a
  narrow vertical column for something inherently wide and short, and
  opening it meant giving up Files/Config since only one panel tab could be
  open at a time.

  It is its own bottom dock now (design spec `2026-08-03-cockpit-v6-design.md`
  §3.1-§3.3), built on the shared `DockPanel` behaviour (`edge: 'bottom'`)
  issue #570 extracted: full canvas width, drag-resizable height (12rem
  minimum), toggleable and closed by default, height and open state
  persisted per user (`localStorage`, matching every other dock). It sits
  below the left sidebar, transcript, composer and right sidebar, all of
  which stay visible and interactive while it is open — it never scrims.

  `InteractiveTerminal.svelte` now loads `@xterm/addon-fit` and calls
  `fitAddon.fit()` on mount and on every `ResizeObserver` notification for
  its container, so a continuous drag reflows the terminal to real cols/rows
  (not just a CSS height change), coalesced to one `fit()` per render frame
  regardless of how many `pointermove` events the drag fires. Collapsing the
  dock no longer unmounts the terminal or kills its PTY: it stays mounted,
  hidden by height/transform, so a collapse/reopen round trip keeps the same
  terminal and its scrollback.

  Below 1024px it becomes a bottom sheet with a backdrop, reusing the
  sessions sidebar's own always-mounted/CSS-transform mechanism (not a
  second one), and follows the same one-panel-at-a-time rule the left and
  right sidebars already have below that width.

- d09e12b: Stop a tool call with no `id` from wearing the "awaiting permission" outline

  `+page.svelte` computed `awaitingPermission={permissionHead?.toolCall.id === item.id}`. With no permission in flight, `permissionHead` is `undefined` and the optional chain short-circuits to `undefined`; if the transcript item's own `id` is also `undefined`, the comparison is `undefined === undefined`, true, and the row painted the amber `outline: 2px solid var(--color-warning)` even though nothing was pending. `item.id` is reachable as `undefined` from real traffic: the transcript payload is opaque ciphertext to the protocol, and the client casts the decrypted JSON with `openJson<AcpSessionWireEvent>` rather than parsing it with Zod, so nothing rejects a `tool_call` that omits `id`. The comparison now short-circuits on `permissionHead !== undefined` first.

  The same shape turned up twice more in a sweep of every optional-chain/possibly-undefined equality comparison across the web client and its shared protocol reducer. `RelayClient.discardStalePermissionForToolCall` compared `request.toolCall.id === event.id`; a malformed `tool_call_update` with no `id` could match a pending permission request whose own `toolCall.id` was equally malformed (the paired `permission_request` payload goes through the same unvalidated cast), cancelling it and publishing a false "resolved on another device" notice. `@loombox/providers-core`'s `reduceToolCall` looked up an existing transcript row by `item.id === update.id`; two unrelated malformed tool calls with no `id` would merge into a single row, the second silently overwriting the first's title/status. Both now refuse to match when the incoming `id` is `undefined`, so a malformed event always ends up in its own row/no-op rather than colliding with an earlier one.

- e526691: Tool-call cards: one level of chrome instead of two

  A tool call used to render as two nested boxes: a bordered card with a
  header line, wrapping a second inset surface (`--color-fill-subtle`) for
  the payload. For a call whose entire payload was a single fact already
  named in its title (`Read apps/web/src/lib/terminal.ts` whose `rawInput`
  was that same path again), that was a lot of chrome for one line of text,
  and a run of several tool calls in a row read as a stack of boxes rather
  than a conversation with work in it.

  `tool-widgets/ToolCard.svelte` now takes a required `surface` prop instead
  of always drawing a border: `surface={true}` keeps the v5 bordered-card
  treatment for content with no surface of its own (`TodoWidget`'s checklist,
  `GenericToolRow`'s own multi-line output or multi-entry `rawInput`);
  `surface={false}` draws nothing but layout, for a single-line row or for a
  widget whose body already carries its own surface (`BashWidget`'s
  `TerminalOutput`, `EditWriteWidget`'s `DiffViewer`) — never both at once.
  `GenericToolRow` decides "one line or a block" from the payload's own
  shape (does it contain a newline, does it carry more than one key/value
  pair) and folds a single-line payload directly onto the header line,
  dropping it entirely when it only repeats what the title already said.

  Status also moves: a new shared `ToolCallStatus` component drops the
  "Completed" caption once a card has settled (the dot alone still carries
  it to screen readers via its own `aria-label`) and makes "Failed" the one
  state allowed to shout — bold, `--color-danger`, on its own chip — so a
  failure in a run of otherwise-quiet completed calls is what actually draws
  the eye.

  The bespoke widgets (bash, edit/write, todo) keep their own visual
  language unchanged; only the redundant outer frame goes.

- c97a2cf: Add the `TrackerMode` config and the pluggable `TrackerBackend` extension point (SPEC §7.10)

  `@loombox/protocol` gets `v1/tracker.ts`: Zod-validated `githubTarget`/`jiraTarget` and the `trackerMode` discriminated union (`{kind:'native'}` or `{kind:'live', provider, connectionId, target}`), exported and registered in `schemasV1` alongside every other v1 schema. The exported `TrackerMode` type keeps SPEC's literal `target: GitHubTarget | JiraTarget` shape (not correlated to `provider` at the type level, exactly as specced), but the schema adds a `superRefine` cross-check so a GitHub-shaped target submitted under `provider: 'jira'` (or the reverse) is rejected at parse time, since that correlation is clearly the spec's intent even though its type block does not encode it.

  `@loombox/shared` gets its first real export: `TrackerBackend` and `TrackerBackendCapabilities`, plus the `TrackerBinding`/`TrackerListFilter`/`TrackerListPage`/`TrackerItemLive`/`TrackerTransition`/`TrackerBoard`/`TrackerSprint` shapes those methods reference. `list`/`get`/`create`/`update`/`listBindings` are required; `addComment`/`listTransitions`/`transition`/`listBoards`/`listSprints`/`moveToSprint` are optional, matching SPEC §7.10's phased delivery (issues/comments first, transitions next, boards/sprints last). A type-level `satisfies TrackerBackend` check in `tracker-backend.test.ts` proves a stub implementing only the required methods still satisfies the interface with every optional method absent, and fails to compile if that ever stops being true.

  `apps/web` gets `$lib/tracker-mode-store.ts`, a per-project persisted `TrackerMode` (localStorage today, same injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`). `get()` returns `TrackerMode | undefined`: an unset project, or one whose stored value no longer validates, both read as `undefined`, never silently coerced to `{kind:'native'}`. No consumer wires this store into the UI yet; that is issue #212's job.

- 23e157d: Render Markdown in the transcript instead of printing it literally

  `MessageItem.svelte` interpolated `displayText` straight into a `<p>` with
  `white-space: pre-wrap`, so a fenced code block showed its own backtick
  fences and a `-` list showed dashes with no markers. There was no Markdown
  dependency anywhere in `apps/web`. This was the largest finding of the v6
  cockpit audit: most turns of real substance from a coding agent contain code
  or a list, or both.

  Agent and user turns now go through a real pipeline: `remark-parse` +
  `remark-gfm` for CommonMark plus tables/strikethrough/task lists,
  `remark-rehype` (without `allowDangerousHtml`, so a literal `<script>` or
  `<img onerror=…>` typed by the agent is dropped before it ever becomes an
  element rather than escaped-and-shown or executed), `rehype-sanitize` on
  GitHub's own default schema (strips a `javascript:` link/image protocol),
  then two small trusted plugins that run after sanitisation on purpose (an
  external-link `target`/`rel` setter and a table-scroll wrapper), and finally
  `rehype-highlight` with an explicit ~18-language `highlight.js` subset
  (`typescript`, `javascript`, `python`, `bash`, `json`, `go`, `rust`, `sql`,
  css/yaml/xml/markdown/dockerfile/java/cpp/csharp/ruby/diff and their common
  aliases) rather than every grammar it ships. `$lib/markdown.ts` documents the
  full ordering and why each step has to come where it does.

  The transcript streams character by character (`TextPacer`, issue #137), and
  re-running that whole pipeline on every 32ms reveal tick does not hold up on
  a long turn. `splitStreamingMarkdown` finds the last point in the revealed
  text where every block that has opened has also closed — the end of a
  closing fence, or a blank line outside any fence — and only that "stable"
  prefix is parsed; `MessageItem` only re-runs the real render when that
  boundary itself advances, not on every tick. A still-open fenced code block
  renders as a plain monospace box (the same code surface `GenericToolRow`'s
  `.output` and `BashWidget`'s terminal already use, not a second visual
  language) and is only syntax-highlighted the instant its closing fence
  arrives, so a half-typed fence never flickers through a half-tokenised
  state. Everything else (lists, tables, headings, emphasis) is styled with
  Deck tokens directly in `MessageItem.svelte`'s own `<style>` block, not a
  library stylesheet; a wide table scrolls horizontally inside its own wrapper
  instead of stretching the transcript row.

  `PlanCard` and tool-call output are explicitly out of scope here: `$lib/markdown`
  is a plain, reusable module, but `ToolCallRow.svelte`/`PlanCard.svelte` and
  the `tool-widgets/` tree were being worked on concurrently by other agents
  during this change, so wiring them in is left as a small follow-up rather
  than risking a collision.

  Bundle cost, measured with `vite build` on `apps/web`: the client JS under
  `_app/immutable` goes from 813,029 bytes raw / 231,245 bytes gzip to
  1,144,276 bytes raw / 332,795 bytes gzip (+331,247 raw, +101,550 gzip, about
  +44% gzip) — almost entirely inside the cockpit route's own chunk
  (`nodes/2.*.js`, 265,788 bytes gzip on its own), which the client only loads
  once a session is actually opened, not on first paint of the sign-in/inbox
  screens.

- 6b1465e: Replace the YOU/CLAUDE/TOOL gutter words with a glyph and a surface

  The transcript gutter used to hold a `--text-caption-size` uppercase word
  per row — `You`, the provider's name, or `Tool` — muted further to
  `opacity: 0.5` on a thought. Only the user turn got a surface of its own;
  an agent turn had none at all, so a long answer ran as an unbounded stream
  of prose against the page background (v6 audit finding T3), and on the
  phone that prose read low-contrast enough to pass as disabled text
  (finding T5).

  Settled with Lorenzo 2026-08-03: attribution by surface and glyph, not by
  a label. Not a colour-only rail (fails for colour-blind readers), not a
  circular avatar (drags the transcript toward chat), not spacing alone.

  - An agent/thought turn now draws a small decorative provider glyph
    (`icon-paths.ts`'s new `provider-claude`/`provider-codex`/`provider-gemini`/
    `provider-ohmypi`/`provider-generic` marks, sourced from `$lib/providers`'s
    existing `PROVIDER_LABELS`) and sits on its own quiet `--color-surface`,
    so it reads as a bounded block instead of loose prose.
  - The user turn keeps what already worked: the raised surface and the
    gutter's accent bar. It never had a glyph and still doesn't.
  - A tool call's gutter drops the "Tool" word — the tool-kind icon already
    said it, and that column was already `aria-hidden` as a whole, so
    nothing accessible is lost.
  - A visually-hidden label (`.sr-only`, the same short word v5 painted
    visibly) carries the role to assistive tech on every turn, in the same
    reading-order position a sighted v5 reader's eye used to land on first.
  - Consecutive turns from the same speaker (skipping over any tool calls in
    between) no longer repeat the visible glyph — `$lib/transcript-attribution.ts`'s
    `showsAttribution` decides this in `+page.svelte`'s transcript loop — but
    the accessible label and each turn's own surface never get suppressed,
    only the glyph does.
  - The composer's gutter follows suit: no more caption-case "YOU", just the
    same accent bar a `user` transcript row draws on its own gutter, still
    aligned to the exact column every row shares.

  Measured on the real rendered page at 390px (both themes, `--color-surface`
  background against `--color-text-primary` prose): dark 15.5:1, light
  17.8:1 — both well past the WCAG AA minimum of 4.5:1 for body text.

- fc2c12e: Fix the per-session usage meter and add a near-context-limit warning (SPEC §7.9, issue #248)

  The composer's context/cost meter (`ConfigBar.svelte`, previously wired up for the model/mode/reasoning-effort bar) is SPEC §7.9's live usage meter — this doesn't add a second one, it fixes and extends the one already there. Three real bugs, all in `@loombox/providers-core`, none visible from `ConfigBar.svelte`'s own diff:

  - `AcpClient` was reading a raw `usage_update` wire event for field names (`tokensUsed`/`contextWindow`/`costUsd`) that don't exist on ACP's real shape. The protocol's actual `UsageUpdate` is `{used, size, cost}` with `cost: {amount, currency} | null` (agentclientprotocol.com/protocol/v1/schema) — so the meter never actually populated against a real ACP agent. Fixed in `client.ts`'s wire mapping; a non-USD `cost.currency` is left unconverted (`costUsd: undefined`) rather than mislabeled as dollars.
  - `cost.amount` is documented as the session's running cumulative total, not a per-update delta — the reducer was summing it, double-counting every update after the first. `cumulativeCostUsd` now tracks the latest reported total (`Math.max` against the previous value, guarding only against an out-of-order delivery ever making it visibly shrink).
  - A subagent tool call's `usage_update` reports its own, much smaller context window. The reducer now freezes the parent's `tokensUsed`/`contextWindow` across a subagent-attributed update instead of letting it overwrite them (previously masked by a UI-side guard, which just traded "the meter shows the wrong number" for "the meter shows nothing" while the subagent tool call was in flight) — the percentage no longer bounces either way. The subagent's cost is still folded into the cumulative figure, since ACP's own cumulative total already includes it.

  The subagent/parent split has no protocol support — ACP's `usage_update` carries no tool-call linkage at all — so it stays a documented client-side heuristic (`UsageRecord.attributedToSubagent`'s doc comment in `transcript.ts` spells out what it keys on and the two known ways it can misfire).

  New: a near-context-limit warning on the meter itself, at the newly-exported `CONTEXT_NEAR_LIMIT_THRESHOLD` (80%) — grounded against real-world auto-compaction thresholds observed on Claude Code (reported anywhere from ~80% to ~95% depending on source/version), so the warning fires before the earliest point any of them might silently compact. Carried to assistive tech via a `.sr-only` span (the meter's percentage track stays `aria-hidden`).

  Cost stays whatever the agent process itself reports via ACP's `cost.amount` — there is no per-token price table anywhere in this repo, and none is added here; a provider that omits `cost` simply doesn't move the cumulative figure for that update rather than getting an invented number.

  No aggregate spend-over-time view (issue #249) and no spend caps (issue #251) ship here — those build on `cumulativeCostUsd`, not the other way around. The broader attention-inbox surfacing of a near-limit session (issue #250) is separate too; this issue's own acceptance only asked for the warning on the meter itself.

- 00ca502: Invert the dock icon and PWA home-screen icons to a white tile with the azure mark

  `squircleTileSvg` (`apps/web/scripts/gen-brand-assets.mjs`) drew an azure tile
  with the mark punched out in near-black `ACCENT_CONTRAST`. That read wrong in
  the Dock: the mark disappeared into the fill instead of standing on it.

  The tile is now white and the mark is stroked in the existing `AZURE` token
  (`#3b9df7`), same geometry, padding and corner radius, just the two fills
  swapped. `TILE_BG` moved from the old dark `#0b0d10` to `#ffffff` and is now
  shared by `apple-touch-icon-180.png` and `maskable-512.png` too, so the app
  icon is the same object on macOS, iOS and Android instead of a per-target
  accident. The maskable-icon spec only requires an opaque background, not a
  particular color, and its safe zone is about content placement, not
  contrast, so nothing in the spec pushed back on white.

  The menu-bar tray icons (`tray-iconTemplate.png`, `tray-iconTemplate@2x.png`)
  are untouched: they stay alpha-only template images tinted by macOS, and a
  colored tile there would render as an opaque blob.

- Updated dependencies [5118b26]
- Updated dependencies [a449b22]
- Updated dependencies [d09e12b]
- Updated dependencies [c97a2cf]
- Updated dependencies [fc2c12e]
  - @loombox/protocol@0.2.0
  - @loombox/providers-core@0.2.0
  - @loombox/crypto@0.0.2

## 0.1.7

### Patch Changes

- c4ed67e: Give the linked-device screen a way out, and the sign-in button a visible wait

  Three things a real first run on a fresh dev loop turned up, all on the two
  screens you meet before the cockpit.

  The `/device` card ended in "you can close this tab and return to the node",
  which is only true in a browser. In the desktop shell there is no tab and no
  address bar, so approving a device left you looking at a screen you could not
  leave, with a linked node you could not go and use. Both terminal states
  (approved and denied) now end in an `Open loombox` button.

  "Sign in with GitHub" gave no feedback while it worked. The click costs a round
  trip to the relay before the browser leaves for GitHub, and against a hosted
  relay that gap is long enough to read as a dead button, so it now shows its
  `loading` state until the redirect happens (and drops back, naming the failure,
  if the relay rejects the attempt).

  That exposed the third: `WovenLoader` hardcoded `color: var(--color-accent)`,
  which inside a filled `primary` `Button` is exactly the button's own background.
  Measured on the sign-in gate: button background and all five thread strokes both
  `rgb(31, 127, 208)`, so every attribute said "busy" and nothing showed on
  screen. The loader takes a `tone` prop now (`accent` by default, `inherit` for a
  loader inside a filled control) and `Button` passes `inherit`.

## 0.1.6

### Patch Changes

- efc16d9: Say why a GitHub sign-in failed instead of doing nothing

  `AuthStore.signInWithGithub` called Better Auth's `signIn.social` and ignored
  what came back. That client reports failures in `{ error }` rather than throwing
  (the two email/password paths beside it already check it), so a relay with no
  GitHub provider configured answered `404 PROVIDER_NOT_FOUND`, the promise
  resolved as if a redirect had started, and the button was simply dead: no
  navigation, no message, nothing in the UI to explain it.

  That is the exact state a relay starts in without `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` in its env, so the message names both the relay's URL and
  the missing pair rather than passing Better Auth's bare "Provider not found"
  through. The `/device` approval page's own sign-in button never caught anything
  either, so it turned a failure into an unhandled rejection; it now shows the
  same notice the cockpit does.

  `scripts/dev.sh` grows a matching preflight: a non-empty client id is not a real
  one, and this loop ran for three days on a hand-exported placeholder, where
  every process came up healthy and the only symptom was github.com's own error
  page at the end of the redirect. GitHub's device-code endpoint distinguishes an
  unregistered client id (`Not Found`) from a real app (`device_flow_disabled`)
  with no user session and no secret, so the loop now refuses to start on a client
  id GitHub has never heard of, and prints how to register one.

## 0.1.5

### Patch Changes

- e2fdd7a: Give the topbar's controls names, and let the phone have its width back

  The cockpit's topbar carried five grey icon-only buttons in a row: three that
  open one drawer between three panels, one that copies the transcript, one that
  opens the command palette. Nothing said the first three were the same drawer,
  nothing said which one was open, and no word for any of them existed anywhere on
  screen, only a `title` a pointer had to hover for and a touch device never gets.

  The three panel toggles are now one bordered segmented group with a selected
  segment, and each control says its name in words wherever the topbar has the
  room (measured: at 1280px the whole cluster with every word visible is 344px of
  a 992px topbar). Below that the words go and the accessible names stay, since
  they are props on the buttons rather than the hidden spans.

  Three defects came out of building it, all pre-existing:

  - The Drawer, as an overlay, started at `top: 0` and covered the topbar's whole
    control cluster, backdrop included. A click aimed at the palette landed on the
    Drawer's own pin button, and the switch could not be used while a panel was
    open. It starts below the topbar now, and the backdrop dims the canvas only.
  - The Drawer's header carried a second copy of the same three-way switch, also
    labelled "Panels". It states which panel is open instead, so there is one
    switch, in one place, whether the panel is open, closed, overlaid or pinned.
  - The composer's text column sat 7.6px right of the transcript's: `.composer-row`
    added a `gap` on top of the same role gutter every transcript row uses, so the
    textarea began at 486.2px while the prose above it began at 493.8px.

  On a phone the timeline's role column collapses and each turn's word (`YOU`,
  `CLAUDE`, `TOOL`) moves above its content. That column spent 84px of a 390px
  screen on a six-letter word and left the prose a 244px measure; it is 316px now.
  Every surface sharing the column moves at the same breakpoint, so the timeline
  keeps one left edge.

  `Button` gains `pressed` (a real `aria-pressed` toggle, matching `IconButton`'s)
  and `title`; `CopyButton` gains `prominent` for a standalone call site where its
  half-opacity resting state read as disabled.

## 0.1.4

### Patch Changes

- 0c27349: Fold the composer's toolbar into one row under the text

  The composer had two strips: a mini-toolbar above it (paperclip, model/mode
  pickers, context/cost) and a keyboard hint below the textarea. They are now one
  row directly under the text, inside the field's own column, so everything about
  the turn you are composing reads in one place.

  The paperclip moved into that row, which means the drop zone now wraps the field
  instead of sitting beside it. That fixes two things that silently did nothing
  before: dropping a file on the textarea, and pasting an image into it. Only the
  strip above was ever a live target.

  The meter reports the context in use against its maximum (`76k / 200k`) instead
  of a bare percentage, with a 3px track that tints amber at 80% and red at 95%,
  and the agent's own name now stands in front of the model picker where the word
  "Model" used to be. On a phone the pickers still collapse behind a "···", but
  the cost and context stay on screen: the old strip hid the lot, so the first
  thing to disappear was the number a user watches.

  The `Enter to send` hint is screen-reader only now. It stays the textarea's
  accessible description, it just no longer spends a row of pixels on a sentence
  read once in a lifetime.

## 0.1.3

### Patch Changes

- 2840683: Take the theme toggle off the signed-out screens.

  The gate shell pinned a theme control to a corner of every pre-cockpit screen
  (checking session, sign-in, onboarding, `/device`). It was there on the reasoning
  that a blinding light screen is hard to sign in through, but the saved preference
  is already applied by the time any of those screens paint, and its default
  (`system`) follows the OS, so the control changed nothing for almost everyone
  while being the only button on screen that was not the point of the screen.

  Appearance stays where it belongs, in the cockpit's own settings after sign-in.

- 9f6d04a: Spend a dot only where a dot means something.

  The header already worked this way: a healthy connection shows nothing, because
  "a permanently green dot in the app's highest-attention corner spent those pixels
  saying nothing". Three surfaces still ignored that rule.

  Session rows drew a status dot for every tone including the neutral ones (no
  status yet, awaiting input, exited), so the common case was an identical grey
  speck in the row's leading indent and the dot could not be read as meaning
  anything. It now appears for the three tones that do mean something (working,
  needs permission, error), into a grid column that holds its width either way, so
  a title never jogs sideways when its session starts working. The status label
  still reaches a screen reader on every row.

  Transcript turns and queued prompts drew a 4px dot above the role word: muted for
  an agent, accent for the user. On a right-aligned gutter it landed over the
  label's last letter, unattached to anything. The accent moved onto the word
  itself, so the cue survives and the speck does not.

  Also in the sidebar: the account button showed the full address truncated
  mid-domain while the menu it opens repeated the whole thing one line above, and
  "Sign out" was styled as a destructive action. The button carries a short
  identity now, and signing out is a normal menu item.

  `StatusDot`'s two diameters became tokens, since a caller reserving the dot's
  slot needs the same number the component uses.

## 0.1.2

### Patch Changes

- fe8da63: Give the signed-out gate a composition it never had.

  Checking session, sign-in, first-run onboarding and the `/device` approval page
  now share one centred layout (`GateShell`): brand lockup, tagline, then that
  screen's own floating `Card`, on a low-contrast woven field, with a single theme
  control in the corner.

  They had no layout before. `main` was a top-aligned padded column, under a
  comment claiming the pre-cockpit screens kept "the original padded, centered
  column layout" when that rule had no `justify-content`, no `align-items` and no
  `max-width`. So the sign-in card sat directly under the header with two thirds
  of the window empty below it, and the "Checking session…" line was stranded in
  the top-left corner (x=15, y=106 in a 1280x860 window) while the lockup above
  it was centred: two alignment systems on one screen.

  Four other things went with it:

  - The brand mark was drawn twice, about 110px apart, once coloured in the
    lockup and once dimmed inside `EmptyState`. Onboarding added a third copy.
  - `EmptyState` was the wrong primitive for a front door. Its documented job is
    empty sessions, empty inbox, empty targets, so it dressed the sign-in screen
    as "nothing here yet" instead of "welcome".
  - The waiting weave was `WovenLoader`'s default `sm` (1em, so 12px), the size
    meant for sitting inline in a button. It is `md` now, the 2.5rem motif
    `/style-reference` documents, centred in the panel.
  - The Relay URL override was a hand-rolled `<label>` plus a raw `<input>`
    beside the app's own `Field` and `Input`. It now uses those, folded into a
    disclosure so it stays available to self-hosters without competing with the
    one action everyone else is here for.

  The panel keeps the same position and width in every state, so resolving the
  session swaps the panel's contents without moving anything on screen. That is
  covered by a Playwright spec rather than a unit test, since jsdom has no layout.

  The gate's "Appearance" toggle is gone (it opened the whole accent and style
  panel before the app knew who you were, and in the cockpit that lives in the
  account menu). The theme toggle stays, since reading a blinding light screen
  well enough to sign in is a real need.

- ea6cbe7: Fix the app hanging on "Checking session…" for every visit after the first.

  `+page.svelte`'s `onMount` syncs this device's notification preferences into the
  service worker before it restores the session. It posted the `$state` object
  itself, which is a proxy, and structured clone cannot clone a proxy, so
  `postMessage` threw `DataCloneError: #<Object> could not be cloned` and took the
  rest of `onMount` with it. The session was never restored, so the app sat on the
  "Checking session…" screen forever, with no `/api/auth/get-session` request ever
  made.

  It only happened from the second visit on, because a service worker does not
  claim the page that registered it: on the first load `navigator.serviceWorker
.controller` is still null and the sync is a no-op. That is also why no test
  caught it, since none of them loaded the app twice in one browser context.

  Found on production (app.loombox.dev) by driving the deployed app in a real
  browser: unregistering the worker made the same page work immediately, and an
  in-page error capture installed before hydration showed the `DataCloneError`.

  The message now carries a `$state.snapshot`, and the whole sync is wrapped in a
  `try`/`catch`: syncing notification preferences has no business being able to
  stop someone signing in. Both a unit test (the posted payload must survive
  `structuredClone`) and a Playwright spec (a second visit, with the worker
  controlling the page, still reaches the sign-in button) cover it.

## 0.1.1

### Patch Changes

- fb4e08e: Draw the sidebar's show/hide control as a panel, not a disclosure chevron.

  The control that shuts the Sessions column reused `collapse-chevron`, the glyph
  eight disclosure rows already use, so one mark meant two unrelated things. It
  also pointed down for a column on the left, and its `scaleX(-1)` state variant
  was a no-op: the chevron's path is symmetric about x=32, so both states drew an
  identical glyph and the button never showed which one it was in.

  It now uses a new `sidebar-panel` glyph that names the surface being toggled,
  the convention in VS Code, Zed and Linear. It is deliberately never mirrored:
  flipping it would move the marked column to the right, which reads as "the
  panel moves to the other side" rather than "the panel is shut". State is
  carried by `IconButton`'s own `aria-pressed` styling and the label, which a new
  test now holds to, since they are the only things that distinguish the two
  states.

  The control is also always visible now, just quiet until the sidebar is hovered
  or holds focus. It used to be `opacity: 0` until then, which meant the only
  pointer affordance for closing the column was invisible unless you happened to
  hover the header.

## 0.1.0

### Minor Changes

- c0d6291: Make projects real, and give the cockpit one navigation instead of two.

  `Project` is now a first-class thing in the client rather than a `projectPath` string buried in each session's encrypted envelope, so you pick a folder once and spawn sessions into it. Sessions are listed in a tree under their project, and Inbox, Nodes and Settings became pages in the main area instead of drawer tabs that the sidebar also linked to. The drawer keeps only what belongs to the open session: Files, Terminal, Config.

  On the wire, a session's private envelope gains an optional `worktree` field, which is SPEC 7.1's per-session isolate-or-work-in-place choice finally reaching the client, and the target fs listing gains an optional `gitRepo` flag so the picker knows whether to offer it. Both are additive, so a node or client older than its peer keeps parsing. The node also stops requiring a git repository for in-place sessions, which SPEC 6 has always said it should support.

- c86aa72: Survive a node restart, bound the agent spawn, and make the surface coherent

  A node restart no longer forgets every session it owns, so rows stop pointing at sessions nobody tracks and worktrees stop leaking. The agent spawn is bounded, and a session is announced as soon as its worktree exists rather than only once the agent is up.

  The node status numbers were wrong: CPU was a load average mislabelled as utilisation, and RAM counted reclaimable page cache as used. Both fixed, and the reading now carries the machine's hostname, platform and arch so a target called "Local" says which machine it is.

  On the client: one page title instead of two, one Settings entry instead of three, a real form language instead of eight copies of the same hand-rolled input, dense node rows instead of three progress bars, and a transcript that states who is speaking with a composer that is part of it rather than a chat box bolted underneath.

- edf90ad: Say something true when a new session times out: the node cuts the worktree before the agent is up and only announces afterwards, so a timeout there is not evidence the session failed. The dialog no longer shows the raw wire identifier, and no longer claims it did not happen.
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

- 60378d7: One `<h1>` per view, naming the view rather than the app. The sidebar wordmark was a heading too, so every screen carried two and one of them was always wrong: the app's name never changes, so it cannot be the heading of what you are looking at. The session view's title in the topbar takes the role the three destination pages already had.
- 9eff82e: Make the desktop shell's dev-server override actually work, and unbreak `vite dev`. `resolvePwaUrl` now accepts a `--pwa-url=<url>` argv flag (which `open --args` delivers) instead of relying only on `LOOMBOX_DESKTOP_PWA_URL`, which a LaunchServices-started app on macOS 26 never inherits from `launchctl setenv` — so `scripts/mac-desktop.sh`'s documented `PWA_URL=` override silently loaded production. Separately, `@xterm/xterm` is now SSR-bundled: as an external CommonJS dep its named `Terminal` import made `vite dev` 500 on every page.
- 604a6f4: Stop the New session dialog wiping what you type. Its reset effect called `resetForm()`, which reads the `providers` prop, and a Svelte 5 `$effect` tracks reads made inside the functions it calls — so the reset re-ran whenever `providers` changed identity, which `+page.svelte` does on every re-render (it derives the list from the polled target status). Measured against the deployed relay, a prompt typed into the open dialog was wiped within a second, repeatedly. The reset now fires on the closed-to-open transition instead, which also covers `open` being re-assigned the same `true`.
- 55161ed: Give `@loombox/providers-core` a browser-safe entry point (`@loombox/providers-core/browser`) and move `McpServerSecretMissingError` out of `client.ts` into `mcp-secret-grants.ts`, beside the logic that raises it. The barrel exports `AcpClient`/`PermissionQueue`/`ConfigOptionStore`, which extend Node's `EventEmitter`; `vite build` tree-shakes them away, but `vite dev` evaluates every module it serves, so the web app painted a healthy page and then died on hydration with `Cannot access "node:events.EventEmitter" in client code`. `apps/web` now imports the browser entry, and a test asserts nothing reachable from it imports a `node:` builtin.
- Updated dependencies [c0d6291]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [55161ed]
- Updated dependencies [a36e07a]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
  - @loombox/providers-core@0.1.0
  - @loombox/crypto@0.0.1
