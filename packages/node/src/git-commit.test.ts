import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import {
  buildCommitDraftPrompt,
  commitStaged,
  computeStagedDiffText,
  GitCommitError,
} from './git-commit';
import { applyGitHunkAction } from './git-diff';
import type { ExecutionTarget } from './target';

const execFileAsync = promisify(execFile);

describe('commitStaged against a real local git repo (issue #233)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-commit-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial commit']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('commits the staged content with the given message, author, and lands it as the new HEAD', async () => {
    await writeFile(join(worktreePath, 'a.txt'), 'first line\n');
    await execGit(['add', 'a.txt']);
    const headBefore = await execGit(['rev-parse', 'HEAD']);

    const result = await commitStaged(target, worktreePath, 'Add a.txt\n\nBecause it was missing.');

    const headAfter = await execGit(['rev-parse', 'HEAD']);
    expect(result.sha).toBe(headAfter);
    expect(headAfter).not.toBe(headBefore);

    expect(await execGit(['log', '-1', '--format=%s'])).toBe('Add a.txt');
    expect(await execGit(['log', '-1', '--format=%b'])).toBe('Because it was missing.');
    expect(await execGit(['log', '-1', '--format=%an'])).toBe('loombox test');
    expect(await execGit(['log', '-1', '--format=%ae'])).toBe('test@loombox.dev');
    expect(await execGit(['show', 'HEAD:a.txt'])).toBe('first line');
  });

  it('commits only what is staged, leaving an unstaged edit on the same file out of the commit', async () => {
    await writeFile(
      join(worktreePath, 'b.txt'),
      'line one\nline two\nline three\nline four\nline five\n',
    );
    await execGit(['add', 'b.txt']);
    await execGit(['commit', '-q', '-m', 'seed b.txt']);
    await writeFile(
      join(worktreePath, 'b.txt'),
      'line one\nline two\nline three\nline four\nline five\nline six\n',
    );
    await execGit(['add', 'b.txt']);
    // A second, unstaged edit on top of the staged one.
    await writeFile(
      join(worktreePath, 'b.txt'),
      'line one\nline two\nline three\nline four\nline five\nline six\nline seven\n',
    );

    const result = await commitStaged(target, worktreePath, 'Append line six');

    expect(await execGit(['show', `${result.sha}:b.txt`])).toBe(
      'line one\nline two\nline three\nline four\nline five\nline six',
    );
    // The unstaged "line seven" edit is still sitting in the worktree, untouched.
    expect(await execGit(['diff', '--stat'])).toContain('b.txt');
  });

  it('refuses an empty index with a clear reason, and creates no commit', async () => {
    const headBefore = await execGit(['rev-parse', 'HEAD']);

    await expect(commitStaged(target, worktreePath, 'nothing to see here')).rejects.toThrow(
      GitCommitError,
    );
    await expect(commitStaged(target, worktreePath, 'nothing to see here')).rejects.toThrow(
      /nothing staged/i,
    );

    expect(await execGit(['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  it('refuses an empty index even when there is an untouched unstaged edit sitting in the worktree', async () => {
    await writeFile(join(worktreePath, 'c.txt'), 'seed\n');
    await execGit(['add', 'c.txt']);
    await execGit(['commit', '-q', '-m', 'seed c.txt']);
    await writeFile(join(worktreePath, 'c.txt'), 'seed\nedited, but never staged\n');
    const headBefore = await execGit(['rev-parse', 'HEAD']);

    await expect(commitStaged(target, worktreePath, 'should not land')).rejects.toThrow(
      /nothing staged/i,
    );

    expect(await execGit(['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  it('refuses an empty (or whitespace-only) message, and creates no commit', async () => {
    await writeFile(join(worktreePath, 'd.txt'), 'content\n');
    await execGit(['add', 'd.txt']);
    const headBefore = await execGit(['rev-parse', 'HEAD']);

    await expect(commitStaged(target, worktreePath, '   \n  ')).rejects.toThrow(GitCommitError);
    await expect(commitStaged(target, worktreePath, '   \n  ')).rejects.toThrow(/empty/i);

    expect(await execGit(['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  it('commits a message with a leading hyphen and embedded newlines verbatim — never misread as a git flag', async () => {
    await writeFile(join(worktreePath, 'e.txt'), 'content\n');
    await execGit(['add', 'e.txt']);
    const tricky = '- looks like a flag\n\nbut is only ever text, passed via stdin, not argv.';

    await commitStaged(target, worktreePath, tricky);

    expect(await execGit(['log', '-1', '--format=%B'])).toBe(tricky);
  });

  it('commits a hunk-level partial stage the same way a human curating the index with git add -p would', async () => {
    const numbered = (n: number) =>
      Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    await writeFile(join(worktreePath, 'multi.txt'), numbered(20));
    await execGit(['add', 'multi.txt']);
    await execGit(['commit', '-q', '-m', 'seed multi.txt']);
    const edited = numbered(20).replace('line2', 'LINE2').replace('line18', 'LINE18');
    await writeFile(join(worktreePath, 'multi.txt'), edited);
    await applyGitHunkAction(target, worktreePath, {
      path: 'multi.txt',
      hunkIndex: 0,
      action: 'stage',
    });

    const result = await commitStaged(target, worktreePath, 'Fix line 2 only');

    const committed = await execGit(['show', `${result.sha}:multi.txt`]);
    expect(committed).toContain('LINE2');
    expect(committed).not.toContain('LINE18');
    // "line18" is still only an unstaged worktree edit after the commit.
    expect(await execGit(['diff', '--stat'])).toContain('multi.txt');
  });
});

describe('computeStagedDiffText against a real local git repo (issue #233)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-commit-diff-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial commit']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('resolves an empty string for a clean index, even with an unstaged edit sitting in the worktree', async () => {
    await writeFile(join(worktreePath, 'a.txt'), 'seed\n');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: worktreePath });
    await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: worktreePath });
    await writeFile(join(worktreePath, 'a.txt'), 'seed\nedited but never staged\n');

    expect(await computeStagedDiffText(target, worktreePath)).toBe('');
  });

  it('returns the real staged unified diff text for a staged new file', async () => {
    await writeFile(join(worktreePath, 'new.txt'), 'brand new content\n');
    await execGit(['add', 'new.txt']);

    const diffText = await computeStagedDiffText(target, worktreePath);

    expect(diffText).toContain('new.txt');
    expect(diffText).toContain('+brand new content');
  });
});

describe('buildCommitDraftPrompt (issue #233)', () => {
  it('embeds the staged diff text verbatim and asks for the message alone, with no explanation', () => {
    const prompt = buildCommitDraftPrompt('diff --git a/x b/x\n+hello\n');

    expect(prompt).toContain('diff --git a/x b/x\n+hello\n');
    expect(prompt).toMatch(/ONLY the commit message/i);
    expect(prompt.match(/```/g)).toHaveLength(2); // exactly one fenced ```diff block, opened and closed
  });
});
