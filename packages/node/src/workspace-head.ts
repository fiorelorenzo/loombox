import type { ExecutionTarget } from './target';

/**
 * Resolves the git commit sha a session's worktree is currently at (SPEC
 * §7.14/§7.15; issue #247) — the shared "which change is this" identity
 * `NodeDaemon` uses (`./auto-iterate-drive-gate.ts`) to tell a local
 * runner failure and a remote CI failure apart when they are really the
 * same underlying change, so `CiAutoIterateController.onFailure` is never
 * driven twice for one failing commit.
 *
 * Mirrors `session-branch.ts`'s own probe shape almost exactly (same
 * `target.exec` seam, same "no git repo/target unreachable degrades to
 * `undefined`, never an error" contract) but reports the full `HEAD` sha
 * rather than a branch name. A plain non-git project (SPEC §6) simply has
 * no such identity — and since `openPr`/CI watching both already require a
 * real git repo, a local run there is never a candidate for the
 * cross-source dedup this resolves for in the first place.
 */
export async function resolveWorkspaceHeadSha(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const repoCheck = await target.exec('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') return undefined;

    const sha = await target.exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
    if (sha.exitCode !== 0) return undefined; // unborn HEAD, or a real failure — nothing to report either way
    const trimmed = sha.stdout.trim();
    return trimmed || undefined;
  } catch {
    // `git` missing from the target's PATH, or the transport itself
    // failed — the same "nothing to report" outcome as a plain non-git
    // folder, never a reason to fail the caller's own run tracking.
    return undefined;
  }
}
