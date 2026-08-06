import { z } from 'zod';

import { probeProviderAvailability } from './provider-availability';
import { resolveSessionBranch } from './session-branch';
import type { Session } from './session-manager';
import type { ExecutionTarget } from './target';

/**
 * Opens a pull request from a session's own pushed branch, running `gh` on
 * the session's own {@link ExecutionTarget} (SPEC §7.14; issue #238).
 *
 * **Credential source (deliberately NOT SPEC §7.26's connected-account
 * registry, `GithubConnectService`, issue #222/#230).** This module never
 * touches it. Instead every `gh`/`git` call below runs through `target`,
 * authenticated by whatever `gh auth login` that TARGET's own operator has
 * already run there — the exact same already-present credential that lets
 * `git push` reach that target's remote at all. Two concrete reasons this
 * is the right seam, not a shortcut:
 *
 * 1. `GithubConnectService`'s token lives in one *node's* OS keyring,
 *    never synced anywhere else (`account-presence.ts`'s own doc comment).
 *    A `local` target already runs on that same node, so there would be
 *    no real boundary to cross for it — but an `ssh:` target runs
 *    elsewhere, and `./target.ts`'s `ExecOptions.env` doc comment states
 *    plainly that a per-call env override (how a token would reach a
 *    spawned `gh` process without landing in its argv or a file) is
 *    "Local only". There is structurally no way to hand this node's own
 *    token to an `ssh:` target's `gh` invocation today.
 * 2. Even where it technically could reach (`local`), doing so would be a
 *    second, redundant credential path alongside the one that already has
 *    to work for this feature to matter at all: a session's branch is
 *    only ever "pushable" because the target it runs on already has
 *    working git-push credentials for that repo's remote. Piggybacking
 *    `gh` on that same access, rather than asking the operator to also
 *    connect a SPEC §7.26 account, is one credential to keep straight
 *    instead of two that could disagree about which GitHub identity is
 *    acting.
 *
 * No token or credential of any kind is read, held, or transmitted by
 * this module — `gh`/`git`'s own already-configured auth on `target` is
 * what authenticates every call, and only `gh`'s stdout/stderr (branch
 * names, commit counts, a PR URL — never a secret) ever crosses back
 * through the relay to a client.
 *
 * `gh` presence is detected via {@link probeProviderAvailability} (the
 * same `command -v` PATH probe every registered agent provider is checked
 * with), mirroring issue #750's "a missing binary produces a distinct,
 * visible reason" bar for a missing MCP server binary — `gh_missing` here
 * is that same category, just for this feature's own one required binary.
 */

export type PrOpenFailureCategory =
  | 'no_branch'
  | 'no_commits'
  | 'gh_missing'
  | 'gh_unauthenticated'
  | 'repo_lookup_failed'
  | 'push_failed'
  | 'create_failed';

/** Thrown by every function in this module for a named, distinguishable failure — never a bare `Error`, so a caller (`NodeDaemon`'s wire handlers) can always report {@link category} on the wire rather than collapsing everything into one generic reason. */
export class PrOpenError extends Error {
  constructor(
    readonly category: PrOpenFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'PrOpenError';
  }
}

export interface PrOpenPreview {
  /** The session's own branch (`resolveSessionBranch`, issue #738). */
  branch: string;
  /** The repository's default branch, resolved via `gh repo view` — what {@link openPr} targets with `--base`. */
  base: string;
  /** Commits on `branch` not on `base`; always >= 1 (a count of 0 throws `no_commits` instead of ever being returned). */
  commitCount: number;
}

const GH_CANDIDATE = { id: 'gh', requiredCommand: 'gh' } as const;

async function assertGhAvailable(target: ExecutionTarget): Promise<void> {
  const found = await probeProviderAvailability(target, [GH_CANDIDATE]);
  if (!found.includes('gh')) {
    throw new PrOpenError(
      'gh_missing',
      "gh CLI not found on this target's PATH — install it (https://cli.github.com) before opening a pull request from here.",
    );
  }
}

async function assertGhAuthenticated(target: ExecutionTarget, cwd: string): Promise<void> {
  const result = await target.exec('gh', ['auth', 'status'], { cwd });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new PrOpenError(
      'gh_unauthenticated',
      `gh is not authenticated on this target — run "gh auth login" there first.${detail ? ` (${detail})` : ''}`,
    );
  }
}

/** `gh repo view --json defaultBranchRef`'s one field this function reads, validated rather than cast (external command output — SPEC repo convention: validate at the boundary, mirrors `test-runner-detect.ts`'s identical treatment of `package.json`). */
const ghRepoViewShape = z.object({
  defaultBranchRef: z.object({ name: z.string().min(1) }).optional(),
});

async function resolveBaseBranch(target: ExecutionTarget, cwd: string): Promise<string> {
  const result = await target.exec('gh', ['repo', 'view', '--json', 'defaultBranchRef'], { cwd });
  if (result.exitCode !== 0) {
    throw new PrOpenError(
      'repo_lookup_failed',
      `Could not resolve this repository's default branch via "gh repo view": ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new PrOpenError(
      'repo_lookup_failed',
      `"gh repo view" returned unparseable JSON: ${result.stdout.trim()}`,
    );
  }
  const shape = ghRepoViewShape.safeParse(parsed);
  const name = shape.success ? shape.data.defaultBranchRef?.name : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PrOpenError(
      'repo_lookup_failed',
      `"gh repo view" reported no default branch name: ${result.stdout.trim()}`,
    );
  }
  return name;
}

/** Refreshes `origin/<base>` (a normal, non-destructive fetch of one ref — never touches the working tree) and counts commits on `branch` not yet on it. */
async function countCommitsAhead(
  target: ExecutionTarget,
  worktreePath: string,
  base: string,
  branch: string,
): Promise<number> {
  const fetch = await target.exec('git', ['-C', worktreePath, 'fetch', 'origin', base]);
  if (fetch.exitCode !== 0) {
    throw new PrOpenError(
      'repo_lookup_failed',
      `"git fetch origin ${base}" failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    );
  }
  const count = await target.exec('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `origin/${base}..${branch}`,
  ]);
  if (count.exitCode !== 0) {
    throw new PrOpenError(
      'repo_lookup_failed',
      `"git rev-list --count origin/${base}..${branch}" failed: ${count.stderr.trim() || count.stdout.trim()}`,
    );
  }
  const parsed = Number.parseInt(count.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read-only: checks `gh` presence/auth, resolves the session's branch and
 * the repo's default base branch, and counts commits ahead — never
 * pushes, never calls `gh pr create`. What a client's confirmation step
 * shows before ever calling {@link openPr}.
 */
export async function previewPrOpen(
  target: ExecutionTarget,
  session: Pick<Session, 'branch' | 'worktreePath'>,
): Promise<PrOpenPreview> {
  await assertGhAvailable(target);
  await assertGhAuthenticated(target, session.worktreePath);

  const branch = await resolveSessionBranch(target, session);
  if (!branch || branch.startsWith('detached@')) {
    throw new PrOpenError(
      'no_branch',
      'This session has no named branch to open a pull request from (detached HEAD, or not a git repository).',
    );
  }

  const base = await resolveBaseBranch(target, session.worktreePath);
  const commitCount = await countCommitsAhead(target, session.worktreePath, base, branch);
  if (commitCount <= 0) {
    throw new PrOpenError(
      'no_commits',
      `"${branch}" has no commits ahead of "${base}" — nothing to open a pull request for.`,
    );
  }

  return { branch, base, commitCount };
}

export interface OpenPrOptions {
  title: string;
  body: string;
}

export interface OpenPrResult {
  url: string;
  number: number;
}

/** The last non-blank line of `gh pr create`'s stdout ends in this — its own documented success output is the created PR's URL and nothing else. */
const PR_URL_PATTERN = /\/pull\/(\d+)\/?$/;

/**
 * Pushes the session's branch (`git push --set-upstream origin <branch>` —
 * idempotent: a no-op "Everything up-to-date" when nothing changed since
 * the last push) and then runs `gh pr create` against it. Re-runs
 * {@link previewPrOpen}'s whole check right before acting rather than
 * trusting a caller-supplied preview: real time passes between a client
 * showing a preview and the operator clicking confirm, in which `gh`
 * could have been uninstalled or signed out, or `branch` could have lost
 * its lead over `base` — so the push only ever runs against freshly
 * re-verified state, never a stale one.
 */
export async function openPr(
  target: ExecutionTarget,
  session: Pick<Session, 'branch' | 'worktreePath'>,
  options: OpenPrOptions,
): Promise<OpenPrResult> {
  const preview = await previewPrOpen(target, session);

  const push = await target.exec('git', [
    '-C',
    session.worktreePath,
    'push',
    '--set-upstream',
    'origin',
    preview.branch,
  ]);
  if (push.exitCode !== 0) {
    throw new PrOpenError(
      'push_failed',
      `git push failed: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }

  const create = await target.exec(
    'gh',
    [
      'pr',
      'create',
      '--title',
      options.title,
      '--body',
      options.body,
      '--head',
      preview.branch,
      '--base',
      preview.base,
    ],
    { cwd: session.worktreePath },
  );
  if (create.exitCode !== 0) {
    throw new PrOpenError(
      'create_failed',
      `gh pr create failed: ${create.stderr.trim() || create.stdout.trim()}`,
    );
  }

  const url = create.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  const match = url ? PR_URL_PATTERN.exec(url) : null;
  if (!url || !match) {
    throw new PrOpenError(
      'create_failed',
      `gh pr create produced no parseable pull request URL: ${create.stdout.trim()}`,
    );
  }
  return { url, number: Number.parseInt(match[1], 10) };
}
