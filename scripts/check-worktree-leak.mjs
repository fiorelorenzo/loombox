#!/usr/bin/env node
/**
 * Guard against issue #948: a parallel agent working in a `.claude/worktrees/*`
 * checkout addresses a read/edit/write with a relative path, which resolves
 * against the session's original working directory (the shared root checkout)
 * rather than the worktree the agent believes it is in. Nothing about that
 * write fails — it lands on `main` in root, silently, and the agent's own
 * worktree stays clean. That has happened in every wave for five waves
 * running, caught only when someone happened to run `git status` in root.
 *
 * A git hook can't catch this: agents never commit in the root checkout, so
 * a pre-commit hook there never fires. What actually fires reliably is this:
 * wired into `pretypecheck`/`preformat:check`/`pretest`-equivalent hooks and
 * vitest's `globalSetup` (see AGENTS.md and the wiring in each package.json /
 * vitest.config.ts / eslint.config.js), it runs at the start of a
 * verification command an agent already runs constantly, and FAILS that
 * command instead of merely printing something a human might not read.
 *
 * Signature checked: the main worktree (always listed first by
 * `git worktree list`, regardless of which linked worktree this runs from)
 * is on `main` AND has uncommitted changes to already-tracked files. Both
 * conditions matter:
 *   - Only `main`, never any other branch: a human legitimately checking out
 *     a feature branch directly in root and editing it there is a normal,
 *     non-agent workflow (nobody works in root while intentionally on
 *     `main`), and must never be flagged.
 *   - Only tracked-file changes, never untracked: an incidental untracked
 *     scratch file sitting in root is a much weaker signal than a modified
 *     tracked source file, and flagging it would false-positive on totally
 *     unrelated clutter every single run.
 */
import { execFileSync } from 'node:child_process';

/** @returns {string} */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * @returns {{ leaked: boolean, root?: string, files?: string[] }}
 */
export function checkWorktreeLeak() {
  let listing;
  try {
    listing = git(['worktree', 'list', '--porcelain'], process.cwd());
  } catch {
    return { leaked: false }; // not a git repo / git unavailable: nothing to guard
  }

  // `git worktree list` always lists the main working tree first.
  const rootMatch = listing.match(/^worktree (.+)$/m);
  if (!rootMatch) return { leaked: false };
  const root = rootMatch[1];

  let status;
  try {
    // `-b` prints the branch as the first line (`## main...`); combining it
    // with the status query saves a second git process per check.
    status = git(['status', '--porcelain=v1', '-b', '--untracked-files=no'], root);
  } catch {
    return { leaked: false };
  }

  const lines = status.split('\n');
  const branchLine = lines[0] ?? '';
  const onMain = /^## main(\.\.\.|$| )/.test(branchLine);
  if (!onMain) return { leaked: false };

  const files = lines
    .slice(1)
    .filter(Boolean)
    .map((l) => l.slice(3));
  if (files.length === 0) return { leaked: false };

  return { leaked: true, root, files };
}

function formatMessage({ root, files }) {
  return [
    '',
    "WORKTREE LEAK GUARD (issue #948): the shared root checkout is on 'main'",
    `with uncommitted changes to tracked files (${root}):`,
    '',
    ...files.map((f) => `  ${f}`),
    '',
    "This is #948's failure mode: a relative read/edit/write path resolved",
    "against the session's original working directory (root) instead of the",
    'worktree you believe you are working in, so this work is NOT on your',
    'branch and NOT where you think it is.',
    '',
    'Stop and recover before doing anything else (AGENTS.md, "Worktrees"):',
    `  1. git -C ${root} diff -- <your files>              # capture what leaked`,
    '  2. git apply --check, then git apply, in YOUR worktree  # replay it there',
    `  3. git -C ${root} status --short                    # verify it applied`,
    `  4. git -C ${root} checkout -- <your files>          # only then clean root`,
    'Re-read the moved files from the worktree path before editing again: their',
    'snapshot tags and line numbers are stale for the new location, and an',
    'anchored edit against a stale tag mangles the file.',
    '',
  ].join('\n');
}

/**
 * Throws when the leak signature is present. The idiomatic entry point for
 * anything that already runs inside a JS process (vitest's `globalSetup`,
 * `eslint.config.js`) — throwing there fails the command with this message
 * instead of continuing into tests/lint against a checkout that never
 * received the work it was supposed to.
 */
export function assertNoWorktreeLeak() {
  const result = checkWorktreeLeak();
  if (result.leaked) throw new Error(formatMessage(result));
}

/**
 * Default export so this file can be dropped directly into vitest's
 * `globalSetup` (which requires a default-exported function, run once before
 * any test in the process) with zero adapter code.
 */
export default function globalSetup() {
  assertNoWorktreeLeak();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    assertNoWorktreeLeak();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
