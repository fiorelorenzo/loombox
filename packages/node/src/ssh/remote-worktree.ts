import { shQuote, type RemoteTransport } from './remote-transport';

/**
 * Git worktree create/remove for `ssh:` targets (issue #75), the remote
 * counterpart to `../session-manager.ts`'s existing local implementation:
 * same placement convention (`<projectPath>/.loombox/worktrees/<sessionId>`)
 * and same branch-naming convention (`loombox/session-<sessionId>`, exported
 * from `session-manager.ts` as {@link sessionWorktreeBranch} and reused here
 * verbatim) so a session's worktree looks and behaves identically regardless
 * of which kind of target it runs on — just expressed as `git` commands run
 * over `RemoteTransport.exec()` instead of a local `child_process` call.
 *
 * Deliberately mirrors `RemoteProcessRunner`'s style: paths built with plain
 * `/`-joins (the remote host's own path separator, which is not necessarily
 * this Node process's `path.sep`), every interpolated argument passed
 * through {@link shQuote}.
 */

/** Joins POSIX path segments with `/`, collapsing any doubled slashes at the seams — the remote host's own separator, independent of this process's `path.sep` (SPEC §5.2: the remote host is not assumed to share this node's OS). */
export function posixJoin(...segments: string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 ? segment.replace(/\/+$/, '') : segment.replace(/^\/+|\/+$/g, ''),
    )
    .filter((segment) => segment.length > 0)
    .join('/');
}

export interface RemoteWorktreeHandle {
  worktreePath: string;
  branch: string;
}

function assertOk(exitCode: number, stderr: string, description: string): void {
  if (exitCode !== 0) {
    throw new Error(
      `remote-worktree: ${description} failed (exit ${exitCode}): ${stderr.trim() || '(no stderr)'}`,
    );
  }
}

/**
 * Creates an isolated git worktree for `sessionId` on the remote host at
 * `<projectPath>/.loombox/worktrees/<sessionId>`, branched from the repo's
 * current `HEAD` onto `options.branch` — pass `sessionWorktreeBranch(sessionId)`
 * (`../session-manager.ts`) for parity with the local target's naming, which
 * this module deliberately does not hardcode itself, so the one convention
 * lives in one place.
 */
export async function createRemoteWorktree(
  transport: RemoteTransport,
  options: { projectPath: string; sessionId: string; branch: string },
): Promise<RemoteWorktreeHandle> {
  const worktreePath = posixJoin(options.projectPath, '.loombox', 'worktrees', options.sessionId);
  const command = [
    `cd ${shQuote(options.projectPath)}`,
    `git worktree add -b ${shQuote(options.branch)} ${shQuote(worktreePath)} HEAD`,
  ].join(' && ');

  const result = await transport.exec(command);
  assertOk(result.exitCode, result.stderr, `git worktree add for session ${options.sessionId}`);

  return { worktreePath, branch: options.branch };
}

/**
 * Removes a remote worktree created by {@link createRemoteWorktree} — `git
 * worktree remove --force`, then a belt-and-suspenders `rm -rf` of the
 * directory, mirroring `SessionManager.removeSession`'s exact same
 * two-step (git's own removal, then a forced directory delete in case it
 * left something behind) so both target kinds clean up identically.
 */
export async function removeRemoteWorktree(
  transport: RemoteTransport,
  options: { projectPath: string; worktreePath: string },
): Promise<void> {
  const removeCommand = [
    `cd ${shQuote(options.projectPath)}`,
    `git worktree remove --force ${shQuote(options.worktreePath)}`,
  ].join(' && ');
  const result = await transport.exec(removeCommand);
  assertOk(result.exitCode, result.stderr, `git worktree remove for ${options.worktreePath}`);

  // Belt-and-suspenders, matching `SessionManager.removeSession`: run even
  // though `git worktree remove` above already deletes the directory on
  // success, in case it was left behind by an earlier partial failure.
  await transport.exec(`rm -rf ${shQuote(options.worktreePath)}`);
}
