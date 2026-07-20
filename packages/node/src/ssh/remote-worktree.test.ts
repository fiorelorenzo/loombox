import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sessionWorktreeBranch } from '../session-manager';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { LocalProcessTransport } from './local-process-transport';
import { createRemoteWorktree, posixJoin, removeRemoteWorktree } from './remote-worktree';
import { Ssh2Transport } from './ssh2-transport';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('posixJoin', () => {
  it('joins segments with a single slash, regardless of leading/trailing slashes', () => {
    expect(posixJoin('/home/dev/repo', '.loombox', 'worktrees', 'abc')).toBe(
      '/home/dev/repo/.loombox/worktrees/abc',
    );
    expect(posixJoin('/home/dev/repo/', '/.loombox/', '/worktrees/')).toBe(
      '/home/dev/repo/.loombox/worktrees',
    );
  });
});

// Exercised for real against `LocalProcessTransport` (a real child-process
// "remote" on this machine, real `git`), matching `session-manager.test.ts`'s
// own local-target coverage of the identical create/remove behavior.
describe('remote-worktree (hermetic, via LocalProcessTransport)', () => {
  let repoPath: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'loombox-remote-worktree-repo-'));
    await git(repoPath, ['init', '-b', 'main']);
    await git(repoPath, ['config', 'user.email', 'test@loombox.dev']);
    await git(repoPath, ['config', 'user.name', 'loombox test']);
    await execFileAsync(
      'git',
      ['-C', repoPath, 'commit', '--allow-empty', '-m', 'initial commit'],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'loombox test',
          GIT_AUTHOR_EMAIL: 'test@loombox.dev',
          GIT_COMMITTER_NAME: 'loombox test',
          GIT_COMMITTER_EMAIL: 'test@loombox.dev',
        },
      },
    );

    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('creates an isolated worktree on a fresh branch, at the same path convention SessionManager uses locally', async () => {
    const sessionId = 'sess-abc123';
    const branch = sessionWorktreeBranch(sessionId);

    const handle = await createRemoteWorktree(transport, {
      projectPath: repoPath,
      sessionId,
      branch,
    });

    expect(handle.branch).toBe('loombox/session-sess-abc123');
    expect(handle.worktreePath).toBe(join(repoPath, '.loombox', 'worktrees', sessionId));

    const dirStat = await stat(handle.worktreePath);
    expect(dirStat.isDirectory()).toBe(true);

    const insideWorkTree = await git(handle.worktreePath, ['rev-parse', '--is-inside-work-tree']);
    expect(insideWorkTree).toBe('true');
    const currentBranch = await git(handle.worktreePath, ['branch', '--show-current']);
    expect(currentBranch).toBe(handle.branch);

    const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).toContain(handle.worktreePath);
  });

  it('removes a worktree it created', async () => {
    const sessionId = 'sess-remove-me';
    const branch = sessionWorktreeBranch(sessionId);
    const handle = await createRemoteWorktree(transport, {
      projectPath: repoPath,
      sessionId,
      branch,
    });

    await removeRemoteWorktree(transport, {
      projectPath: repoPath,
      worktreePath: handle.worktreePath,
    });

    await expect(stat(handle.worktreePath)).rejects.toThrow();
    const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toContain(handle.worktreePath);
  });

  it('rejects when the remote git command fails (e.g. projectPath is not a repo)', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'loombox-not-a-repo-'));
    try {
      await expect(
        createRemoteWorktree(transport, {
          projectPath: notARepo,
          sessionId: 'sess-x',
          branch: 'loombox/session-sess-x',
        }),
      ).rejects.toThrow(/remote-worktree/);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

// Real-sshd integration (issue #75's "the same behavior is verified on both
// the local target and the ssh: target (via the Dockerized fixture)").
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  'remote-worktree (Dockerized sshd fixture, issues #70/#75)',
  () => {
    let fixture: DockerSshdFixture;
    let transport: Ssh2Transport;

    beforeAll(async () => {
      fixture = await startDockerSshdFixture();
    }, 120_000);

    afterAll(async () => {
      await fixture?.stop();
    }, 30_000);

    beforeEach(async () => {
      transport = new Ssh2Transport({
        host: fixture.host,
        port: fixture.port,
        username: fixture.username,
        privateKeyPath: fixture.privateKeyPath,
      });
      await transport.connect();
    });

    afterEach(async () => {
      await transport.close();
    });

    it('creates and removes a worktree on the remote fixture repo over a real sshd', async () => {
      const sessionId = 'sess-real-sshd';
      const branch = sessionWorktreeBranch(sessionId);

      const handle = await createRemoteWorktree(transport, {
        projectPath: fixture.remoteRepoPath,
        sessionId,
        branch,
      });
      expect(handle.worktreePath).toBe(`${fixture.remoteRepoPath}/.loombox/worktrees/${sessionId}`);

      const listed = await transport.exec(
        `git -C ${fixture.remoteRepoPath} worktree list --porcelain`,
      );
      expect(listed.stdout).toContain(handle.worktreePath);

      await removeRemoteWorktree(transport, {
        projectPath: fixture.remoteRepoPath,
        worktreePath: handle.worktreePath,
      });

      const listedAfter = await transport.exec(
        `git -C ${fixture.remoteRepoPath} worktree list --porcelain`,
      );
      expect(listedAfter.stdout).not.toContain(handle.worktreePath);
    });
  },
);
