---
name: ci-operations
description: Use when checking loombox PR/CI status, extracting failure logs from a GitHub Actions run, or polling many loombox PRs for CI results at once
metadata:
  version: 1.0.0
  updated: 2026-08-24
  origin: authored
  source: harvested from ~/.claude/projects/-home-dev-projects-personal-loombox (archived skill ci-operations, ./--home-dev-Progetti-loombox--/skills/ci-operations/SKILL.md in the omp-memories-dead-slugs-2026-08-24 archive)
  status: active
---

# CI operations (loombox)

Polling CI status, debugging failures, and extracting logs for
`fiorelorenzo/loombox`'s GitHub Actions workflows.

## CI shape (`.github/workflows/ci.yml`)

- `verify` — lint · typecheck · test · brand-asset drift.
- `e2e` — Playwright, `apps/web` (uploads a trace/screenshot report on failure).
- `licenses` — fails on any AGPL/GPL-family dependency.
- `changes` + `desktop` — a path filter gates the macOS/Windows/Ubuntu desktop
  matrix on PRs (it always runs on a push to `main`); most PRs never pay for it.
- Concurrency group `ci-${{ github.ref }}`, `cancel-in-progress: true` — a
  superseded run on the same ref shows as **cancelled**, not failed. Don't
  read a cancelled run as a real failure.
- The repo is public, so Actions minutes are free/unlimited here — unlike a
  private repo, an all-cancelled or empty-looking run is never a
  minutes-exhaustion signal, it's just the concurrency group doing its job.

## PR status check

```bash
gh pr checks <PR> --json state,link --jq '.[]|select(.state=="FAILURE")'
gh api repos/fiorelorenzo/loombox/pulls/<n> --jq '{mergeable,mergeStateStatus,reviewDecision,statusCheckRollup}'
```

## Polling many PRs at once

Define once per session, then poll in a loop with a real sleep between rounds
(never a tight loop):

```js
globalThis.__ci = async (pr) => {
  const checks = await (await fetch(`https://api.github.com/repos/fiorelorenzo/loombox/commits/...check_runs`)).json();
  const bad = checks.check_runs.filter(c => c.conclusion !== 'success' && c.conclusion !== 'skipped').map(c => c.name);
  return { bad };
};
```

```js
const prs = [954, 953, 955];
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 60000));
  // call globalThis.__ci(pr) per PR, break once every array is empty
}
```

## Log extraction

```bash
RUN=$(gh pr checks <PR> --json state,link --jq '.[]|select(.state=="FAILURE")|.link' | head -1)
ID=${RUN##*/runs/}; ID=${ID%%/*}
gh run view "$ID" --log-failed | grep -E "Error|error TS|##\[error\]|Cannot find|worktree-leak"
```

`gh run view --log-failed` can exceed a 150s timeout on a large run (the
`desktop` matrix especially). Workarounds, in order: tighten the grep
pattern (above), narrow the time window, or use the checks API instead —
`gh api repos/fiorelorenzo/loombox/commits/<sha>/check-runs --paginate --jq '.[] | select(.conclusion != "success")'`.

## GitHub API hang prevention

```bash
timeout 25 gh api repos/fiorelorenzo/loombox/rate_limit
echo "Exit: $?"
curl -s -o /dev/null -w '%{http_code} %{time_total}' https://api.github.com/
```

**Never** run a long polling loop against `gh api rate_limit` directly — it
can hang indefinitely with no output. Always wrap `gh`/`curl` calls to the
GitHub API in `timeout`, and check the exit code rather than assuming success.
