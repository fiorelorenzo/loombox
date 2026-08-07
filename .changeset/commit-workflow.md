---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Commit workflow with AI-generated commit messages (SPEC §7.6; issue #233)

Builds on #232's hunk-level staging: the index is now something a user can actually curate, so this is the next step — commit what's staged, with a message drafted from the staged diff.

- `@loombox/protocol`'s new `git-commit.ts` adds `git_commit_draft_request`/`git_commit_draft_response` (read-only, envelope-less request mirroring `git_hunk_diff_request`, enveloped reply) and `git_commit_request`/`git_commit_response` (enveloped, mutating, mirrors `git_hunk_action_request`). `@loombox/relay` routes both exactly like their `git_hunk_*` siblings — the relay never sees the staged diff, the drafted message, or the final commit message in the clear.
- `@loombox/node`'s new `git-commit.ts` adds `computeStagedDiffText`/`commitStaged` (real `git diff --cached`/`git commit -F -` through `ExecutionTarget.exec`, works identically against a `local` or an `ssh:` target) and `buildCommitDraftPrompt`. Message generation happens in `NodeDaemon.draftGitCommitMessageForBridge`/`draftCommitMessageViaAgent`, which prompts the session's OWN live `AgentSession` (never a new, separately-configured provider call — the issue's own constraint) and captures the resulting turn's text as the draft; a session with no live agent, or nothing staged, reports a clear `outcome: 'error'` instead. `commitStaged` refuses an empty index or an empty message with a clear `GitCommitError`, never a silent no-op.
- `@loombox/web`: `WorktreeDiffViewer`'s staging surface gains a "Commit staged changes" button (disabled until at least one hunk is staged), opening the new `CommitDialog` — mirrors `PrOpenDialog`'s own "auto-load on open, only an explicit click acts" two-phase split, except the auto-loaded step is the AI draft itself. The draft is purely advisory: nothing is committed until the "Commit" click, and an unedited textarea sends the draft verbatim while an edited one sends whatever text is currently there.

Verified: `pnpm --filter @loombox/node exec vitest run src/git-commit.test.ts src/node-daemon.test.ts` (10+97 tests, including a real temp-git-repo suite for `commitStaged`/`computeStagedDiffText` and a node-daemon suite proving the draft-then-explicit-confirm flow over the real wire with a live agent, an empty index refused with a clear reason, and no commit until the operator confirms), `pnpm --filter @loombox/protocol exec vitest run` (719 tests), `pnpm --filter @loombox/relay exec vitest run` (490 tests, plus `message-routing.test.ts`'s exhaustiveness check), `pnpm --filter @loombox/web exec vitest run src/lib/components/CommitDialog.test.ts src/lib/components/WorktreeDiffViewer.test.ts` (11+25 tests) and the full web suite (1879 tests), `pnpm --filter @loombox/{protocol,node,relay,web} typecheck`, `pnpm exec eslint` on every changed file, the full `pnpm format:check`, and the full `pnpm test` (5076 tests; 1 pre-existing failure in `packages/providers/codex/src/codex-acp-capabilities.test.ts` unrelated to this change, already fixed on `main` in #834 after this branch was cut).
