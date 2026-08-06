import type { ExecutionTarget } from './target';
import type { Session } from './session-manager';

/**
 * Resolves the git branch a session's own state should report over the wire
 * (Zed-parity decision B3-3, issue #738) — what `NodeDaemon.announce()` puts
 * in `SessionPrivateMetaV1.branch`.
 *
 * A worktree-isolated session (`session.branch` non-empty — see
 * `session-manager.ts`'s own doc comment) already KNOWS its branch: it was
 * created on `loombox/session-<id>` and never moves off it for the whole
 * life of the session, so this returns that name directly with no git call
 * at all.
 *
 * An in-place session (`session.branch === ''`, `worktreePath ===
 * projectPath`) has no such guarantee — a person can `git checkout` a
 * different branch, or none at all, on disk while the session stays open —
 * so this probes the folder's actual `HEAD` every time it's called instead
 * of caching anything, mirroring `NodeDaemon.listDirectoryForTarget`'s own
 * pre-session `git rev-parse --is-inside-work-tree` probe rather than
 * assuming a git repo: SPEC §6 lets a project be a plain folder with no git
 * at all, and that must read as "nothing to report" (`undefined`), never an
 * error.
 *
 * Three outcomes for the probe, run via `target` so this works identically
 * for `local` and `ssh:` alike: not inside a work tree at all (no `.git`,
 * or `git` missing from the target's own `PATH`) resolves `undefined`;
 * `git branch --show-current` naming a branch resolves that name directly;
 * and that same command reporting an empty string — real git behaviour for
 * a detached `HEAD`, not a failure — resolves `detached@<short-sha>` so the
 * client still has something legible to show instead of a blank segment.
 */
export async function resolveSessionBranch(
  target: ExecutionTarget,
  session: Pick<Session, 'branch' | 'worktreePath'>,
): Promise<string | undefined> {
  if (session.branch) return session.branch;

  try {
    const repoCheck = await target.exec('git', [
      '-C',
      session.worktreePath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') return undefined;

    const current = await target.exec('git', [
      '-C',
      session.worktreePath,
      'branch',
      '--show-current',
    ]);
    const name = current.exitCode === 0 ? current.stdout.trim() : '';
    if (name) return name;

    // Detached HEAD: `branch --show-current` succeeds with empty output
    // rather than failing, so there is a real branch-less state to name
    // here, not an error to swallow.
    const sha = await target.exec('git', ['-C', session.worktreePath, 'rev-parse', '--short', 'HEAD']);
    const short = sha.exitCode === 0 ? sha.stdout.trim() : '';
    return short ? `detached@${short}` : undefined;
  } catch {
    // `git` missing from the target's PATH, or the transport itself
    // failed — the same "nothing to report" outcome as a plain non-git
    // folder, never a reason to fail the session's own announce.
    return undefined;
  }
}
