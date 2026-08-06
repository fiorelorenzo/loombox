import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import { resolveSessionBranch } from './session-branch';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('resolveSessionBranch (issue #738, B3-3)', () => {
  const target = new LocalExecutionTarget();

  it('returns the worktree branch directly, with no git call at all, for an isolated session', async () => {
    // A bogus `worktreePath` proves this: if it fell through to the git
    // probe it would find nothing there and return `undefined`.
    const branch = await resolveSessionBranch(target, {
      branch: 'loombox/session-abc123',
      worktreePath: '/does/not/exist',
    });
    expect(branch).toBe('loombox/session-abc123');
  });

  describe("an in-place session (branch === '')", () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await mkdtemp(join(tmpdir(), 'loombox-session-branch-test-'));
    });

    afterEach(async () => {
      await rm(projectPath, { recursive: true, force: true });
    });

    it('resolves undefined for a plain, non-git folder (SPEC §6) — not an error', async () => {
      const branch = await resolveSessionBranch(target, {
        branch: '',
        worktreePath: projectPath,
      });
      expect(branch).toBeUndefined();
    });

    it('resolves the real current branch when one is checked out, even a long-named one', async () => {
      await git(projectPath, ['init', '-b', 'main']);
      await git(projectPath, ['config', 'user.email', 'test@loombox.dev']);
      await git(projectPath, ['config', 'user.name', 'loombox test']);
      await git(projectPath, ['commit', '--allow-empty', '-m', 'initial']);
      const longName = 'feature/a-very-long-branch-name-that-a-real-team-actually-used-once';
      await git(projectPath, ['checkout', '-b', longName]);

      const branch = await resolveSessionBranch(target, {
        branch: '',
        worktreePath: projectPath,
      });
      expect(branch).toBe(longName);
    });

    it('resolves a legible detached@<sha> marker for a detached HEAD, rather than a blank value', async () => {
      await git(projectPath, ['init', '-b', 'main']);
      await git(projectPath, ['config', 'user.email', 'test@loombox.dev']);
      await git(projectPath, ['config', 'user.name', 'loombox test']);
      await git(projectPath, ['commit', '--allow-empty', '-m', 'initial']);
      const sha = await git(projectPath, ['rev-parse', 'HEAD']);
      await git(projectPath, ['checkout', sha]);

      const branch = await resolveSessionBranch(target, {
        branch: '',
        worktreePath: projectPath,
      });
      expect(branch).toBe(`detached@${sha.slice(0, 7)}`);
    });

    it('resolves undefined for a folder that does not exist on disk at all', async () => {
      const branch = await resolveSessionBranch(target, {
        branch: '',
        worktreePath: join(projectPath, 'never-created'),
      });
      expect(branch).toBeUndefined();
    });
  });
});
