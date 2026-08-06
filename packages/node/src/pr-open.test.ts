import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import { openPr, previewPrOpen, PrOpenError } from './pr-open';
import type { ExecutionTarget } from './target';

const execFileAsync = promisify(execFile);

const NOT_IMPLEMENTED = () => Promise.reject(new Error('fakeExecutionTarget: not implemented'));

/** A minimal {@link ExecutionTarget} exercising only `exec` — everything `pr-open.ts` actually touches — for the two pure-parsing tests below that need no real process at all. */
function fakeExecutionTarget(exec: ExecutionTarget['exec']): ExecutionTarget {
  return {
    kind: 'local',
    exec,
    readFile: NOT_IMPLEMENTED,
    writeFile: NOT_IMPLEMENTED,
    mkdir: NOT_IMPLEMENTED,
    readdir: NOT_IMPLEMENTED,
    readdirDetailed: NOT_IMPLEMENTED,
  };
}

describe('openPr — argv contract and PR URL parsing (issue #238), fully mocked exec', () => {
  function mockedTarget(): { target: ExecutionTarget; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn<ExecutionTarget['exec']>(async (command, args = []) => {
      if (command === 'sh') return { stdout: 'gh\n', stderr: '', exitCode: 0 };
      if (command === 'gh' && args[0] === 'auth') return { stdout: '', stderr: '', exitCode: 0 };
      if (command === 'gh' && args[0] === 'repo') {
        return { stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: '', exitCode: 0 };
      }
      if (command === 'gh' && args[0] === 'pr') {
        // Extra blank lines before the URL — `openPr` must take the last
        // non-blank line, not assume the URL is the only output line.
        return {
          stdout:
            '\nCreating pull request for loombox/session-test into main\n\nhttps://github.com/acme/widgets/pull/7\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command === 'git' && args.includes('fetch'))
        return { stdout: '', stderr: '', exitCode: 0 };
      if (command === 'git' && args.includes('rev-list')) {
        return { stdout: '3\n', stderr: '', exitCode: 0 };
      }
      if (command === 'git' && args.includes('push'))
        return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`mockedTarget: unexpected exec(${command}, ${JSON.stringify(args)})`);
    });
    return { target: fakeExecutionTarget(exec), exec };
  }

  it('passes title/body/head/base straight through to gh pr create and parses the last non-blank stdout line', async () => {
    const { target, exec } = mockedTarget();

    const result = await openPr(
      target,
      { branch: 'loombox/session-test', worktreePath: '/work/session-test' },
      { title: 'Add widget', body: 'Body text\nwith a newline' },
    );

    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/7', number: 7 });
    const createCall = exec.mock.calls.find(
      ([command, args]) => command === 'gh' && args?.[0] === 'pr',
    );
    expect(createCall?.[1]).toEqual([
      'pr',
      'create',
      '--title',
      'Add widget',
      '--body',
      'Body text\nwith a newline',
      '--head',
      'loombox/session-test',
      '--base',
      'main',
    ]);
    const pushCall = exec.mock.calls.find(
      ([command, args]) => command === 'git' && args?.includes('push'),
    );
    expect(pushCall?.[1]).toEqual([
      '-C',
      '/work/session-test',
      'push',
      '--set-upstream',
      'origin',
      'loombox/session-test',
    ]);
  });

  it('create_failed when gh pr create exits 0 but prints nothing shaped like a pull request URL', async () => {
    const exec = vi.fn<ExecutionTarget['exec']>(async (command, args = []) => {
      if (command === 'sh') return { stdout: 'gh\n', stderr: '', exitCode: 0 };
      if (command === 'gh' && args[0] === 'auth') return { stdout: '', stderr: '', exitCode: 0 };
      if (command === 'gh' && args[0] === 'repo') {
        return { stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: '', exitCode: 0 };
      }
      if (command === 'gh' && args[0] === 'pr')
        return { stdout: 'ok, done\n', stderr: '', exitCode: 0 };
      if (command === 'git' && args.includes('fetch'))
        return { stdout: '', stderr: '', exitCode: 0 };
      if (command === 'git' && args.includes('rev-list'))
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      if (command === 'git' && args.includes('push'))
        return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected exec(${command}, ${JSON.stringify(args)})`);
    });

    const error = await openPr(
      fakeExecutionTarget(exec),
      { branch: 'loombox/session-test', worktreePath: '/work/session-test' },
      { title: 'Add widget', body: '' },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('create_failed');
  });
});

describe('previewPrOpen / openPr against a real local git repo, hermetic PATH (issue #238)', () => {
  let binDir: string;
  let bareDir: string;
  let worktreePath: string;
  let hermeticTarget: ExecutionTarget;

  async function execGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  /** Writes a fake `gh` shell script into `binDir` — dispatched by its first two args (`auth status` / `repo view` / `pr create`), mirroring the real CLI's own subcommand shape closely enough for `pr-open.ts` to drive it. */
  async function stubGh(script: string): Promise<void> {
    const file = join(binDir, 'gh');
    await writeFile(file, `#!/bin/sh\n${script}\nexit 1\n`, 'utf8');
    await chmod(file, 0o755);
  }

  const GH_OK = [
    'case "$1 $2" in',
    '"auth status") exit 0 ;;',
    '"repo view") echo \'{"defaultBranchRef":{"name":"main"}}\'; exit 0 ;;',
    '"pr create") echo "https://github.com/acme/widgets/pull/42"; exit 0 ;;',
    'esac',
  ].join('\n');

  beforeEach(async () => {
    // Hermetic PATH (mirrors `provider-availability.test.ts`'s identical
    // technique): deterministic regardless of what's actually installed
    // on the machine running the suite. `sh`/`git` are symlinked in real
    // (this suite wants genuine git behavior); `gh` is always a stub this
    // test writes itself, per test.
    binDir = await mkdtemp(join(tmpdir(), 'loombox-pr-open-bin-'));
    await symlink('/bin/sh', join(binDir, 'sh'));
    await symlink('/usr/bin/git', join(binDir, 'git'));

    const localTarget = new LocalExecutionTarget();
    hermeticTarget = {
      kind: 'local',
      exec: (command, args, options = {}) =>
        localTarget.exec(command, args, { ...options, env: { ...options.env, PATH: binDir } }),
      readFile: (p) => localTarget.readFile(p),
      writeFile: (p, content) => localTarget.writeFile(p, content),
      mkdir: (p) => localTarget.mkdir(p),
      readdir: (p) => localTarget.readdir(p),
      readdirDetailed: (p) => localTarget.readdirDetailed(p),
    };

    bareDir = await mkdtemp(join(tmpdir(), 'loombox-pr-open-remote-'));
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-pr-open-work-'));
    await execFileAsync('git', ['clone', bareDir, worktreePath]);
    await execGit(worktreePath, ['config', 'user.email', 'test@loombox.dev']);
    await execGit(worktreePath, ['config', 'user.name', 'loombox test']);
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'initial']);
    await execGit(worktreePath, ['push', 'origin', 'main']);
    await execGit(worktreePath, ['checkout', '-b', 'loombox/session-test']);
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
    await rm(bareDir, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  });

  const session = () => ({ branch: 'loombox/session-test', worktreePath });

  it('previewPrOpen resolves branch/base/commitCount for a session with commits ahead of the default branch', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work 1']);
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work 2']);
    await stubGh(GH_OK);

    const preview = await previewPrOpen(hermeticTarget, session());

    expect(preview).toEqual({ branch: 'loombox/session-test', base: 'main', commitCount: 2 });
  });

  it("openPr pushes the branch (verifiable on the real bare remote) and creates the PR, returning gh's own URL/number", async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    await stubGh(GH_OK);

    const result = await openPr(hermeticTarget, session(), {
      title: 'Add widget',
      body: 'Body text',
    });

    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/42', number: 42 });
    const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
    expect(remoteRefs.stdout).toContain('refs/heads/loombox/session-test');
  });

  it('no_commits: a session branch with nothing ahead of the default branch produces a distinct, visible reason', async () => {
    await stubGh(GH_OK);

    const error = await previewPrOpen(hermeticTarget, session()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('no_commits');
    expect((error as PrOpenError).message).toContain('loombox/session-test');
  });

  it('gh_missing: no gh on the target PATH at all produces a distinct, visible reason', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    // Deliberately never calling stubGh — binDir has sh/git only.

    const error = await previewPrOpen(hermeticTarget, session()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('gh_missing');
  });

  it('gh_unauthenticated: gh present but signed out produces a distinct, visible reason (never the same as gh_missing)', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    await stubGh(
      ['case "$1 $2" in', '"auth status") echo "not logged in" >&2; exit 1 ;;', 'esac'].join('\n'),
    );

    const error = await previewPrOpen(hermeticTarget, session()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('gh_unauthenticated');
    expect((error as PrOpenError).message).toContain('not logged in');
  });

  it('repo_lookup_failed: gh authenticated but repo view fails (e.g. no GitHub remote)', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    await stubGh(
      [
        'case "$1 $2" in',
        '"auth status") exit 0 ;;',
        '"repo view") echo "no git remotes found" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );

    const error = await previewPrOpen(hermeticTarget, session()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('repo_lookup_failed');
  });

  it('push_failed: preview passes but the actual push fails (bad push destination) — distinct from create_failed', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    await stubGh(GH_OK);
    await execGit(worktreePath, [
      'remote',
      'set-url',
      '--push',
      'origin',
      '/does/not/exist-loombox-pr-open',
    ]);

    const error = await openPr(hermeticTarget, session(), { title: 'Add widget', body: '' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('push_failed');
  });

  it('create_failed: push succeeds but gh pr create fails (e.g. a PR already exists)', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    await stubGh(
      [
        'case "$1 $2" in',
        '"auth status") exit 0 ;;',
        '"repo view") echo \'{"defaultBranchRef":{"name":"main"}}\'; exit 0 ;;',
        '"pr create") echo "a pull request for this branch already exists" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );

    const error = await openPr(hermeticTarget, session(), { title: 'Add widget', body: '' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('create_failed');
    expect((error as PrOpenError).message).toContain('already exists');

    // The branch was still genuinely pushed before gh failed to create the
    // PR — push_failed and create_failed are distinct failure points, and
    // a caller retrying after fixing gh should not need to push again.
    const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
    expect(remoteRefs.stdout).toContain('refs/heads/loombox/session-test');
  });

  it('no_branch: a detached HEAD with no session.branch produces a distinct, visible reason', async () => {
    await execGit(worktreePath, ['commit', '--allow-empty', '-m', 'session work']);
    const sha = await execGit(worktreePath, ['rev-parse', 'HEAD']);
    await execGit(worktreePath, ['checkout', sha]);
    await stubGh(GH_OK);

    const error = await previewPrOpen(hermeticTarget, { branch: '', worktreePath }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrOpenError);
    expect((error as PrOpenError).category).toBe('no_branch');
  });
});
