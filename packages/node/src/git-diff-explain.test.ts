import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitDiffExplainScopeV1 } from '@loombox/protocol';
import {
  buildDiffExplainPrompt,
  computeExplainDiffText,
  GitDiffExplainError,
  MAX_EXPLAIN_DIFF_TEXT_CHARS,
} from './git-diff-explain';
import { LocalExecutionTarget } from './local-execution-target';
import type { ExecutionTarget } from './target';

const execFileAsync = promisify(execFile);

describe('computeExplainDiffText against a real local git repo (issue #236)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-diff-explain-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
    await execGit(['commit', '-q', '--allow-empty', '-m', 'initial commit']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("extracts one unstaged hunk's real patch text, and only that hunk", async () => {
    await writeFile(join(worktreePath, 'a.txt'), 'one\ntwo\nthree\n');
    await execGit(['add', 'a.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);
    await writeFile(join(worktreePath, 'a.txt'), 'one\nEDITED\nthree\n');

    const scope: GitDiffExplainScopeV1 = {
      kind: 'hunk',
      path: 'a.txt',
      side: 'unstaged',
      hunkIndex: 0,
    };
    const text = await computeExplainDiffText(target, worktreePath, scope);

    expect(text).toContain('@@');
    expect(text).toContain('-two');
    expect(text).toContain('+EDITED');
  });

  it('extracts a staged hunk addressed by side: staged, distinct from an unstaged edit on the same file', async () => {
    await writeFile(join(worktreePath, 'b.txt'), 'one\ntwo\n');
    await execGit(['add', 'b.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);
    await writeFile(join(worktreePath, 'b.txt'), 'one\nSTAGED\n');
    await execGit(['add', 'b.txt']);
    await writeFile(join(worktreePath, 'b.txt'), 'one\nSTAGED\nUNSTAGED\n');

    const stagedText = await computeExplainDiffText(target, worktreePath, {
      kind: 'hunk',
      path: 'b.txt',
      side: 'staged',
      hunkIndex: 0,
    });
    expect(stagedText).toContain('+STAGED');
    expect(stagedText).not.toContain('UNSTAGED');

    const unstagedText = await computeExplainDiffText(target, worktreePath, {
      kind: 'hunk',
      path: 'b.txt',
      side: 'unstaged',
      hunkIndex: 0,
    });
    expect(unstagedText).toContain('+UNSTAGED');
    expect(unstagedText).not.toContain('STAGED\nUNSTAGED');
  });

  it('concatenates staged and unstaged hunks for a file scope, unlike a single hunk scope', async () => {
    await writeFile(join(worktreePath, 'c.txt'), 'one\ntwo\n');
    await execGit(['add', 'c.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);
    await writeFile(join(worktreePath, 'c.txt'), 'one\nSTAGED-EDIT\n');
    await execGit(['add', 'c.txt']);
    await writeFile(join(worktreePath, 'c.txt'), 'one\nSTAGED-EDIT\nUNSTAGED-APPEND\n');

    const text = await computeExplainDiffText(target, worktreePath, {
      kind: 'file',
      path: 'c.txt',
    });

    expect(text).toContain('+STAGED-EDIT');
    expect(text).toContain('+UNSTAGED-APPEND');
  });

  it("explains an untracked file for free, via computeHunkDiff's own synthetic single hunk", async () => {
    await writeFile(join(worktreePath, 'new.txt'), 'brand new content\n');

    const text = await computeExplainDiffText(target, worktreePath, {
      kind: 'file',
      path: 'new.txt',
    });

    expect(text).toContain('+brand new content');
  });

  it('throws GitDiffExplainError for a path with no current changes', async () => {
    await expect(
      computeExplainDiffText(target, worktreePath, { kind: 'file', path: 'nonexistent.txt' }),
    ).rejects.toThrow(GitDiffExplainError);
  });

  it('throws GitDiffExplainError for a hunkIndex past the end of the addressed side, rather than crashing', async () => {
    await writeFile(join(worktreePath, 'd.txt'), 'content\n');
    await execGit(['add', 'd.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);
    await writeFile(join(worktreePath, 'd.txt'), 'changed\n');

    await expect(
      computeExplainDiffText(target, worktreePath, {
        kind: 'hunk',
        path: 'd.txt',
        side: 'unstaged',
        hunkIndex: 7,
      }),
    ).rejects.toThrow(GitDiffExplainError);
  });

  it('truncates diff text past MAX_EXPLAIN_DIFF_TEXT_CHARS rather than growing the prompt unbounded', async () => {
    // 5,000 distinct lines, each well past 4 characters, comfortably
    // clears the 20,000-char cap once rendered as `+`-prefixed diff text.
    const hugeContent = Array.from({ length: 5_000 }, (_, i) => `line number ${i}`).join('\n');
    await writeFile(join(worktreePath, 'huge.txt'), hugeContent);

    const text = await computeExplainDiffText(target, worktreePath, {
      kind: 'file',
      path: 'huge.txt',
    });

    expect(text.length).toBe(MAX_EXPLAIN_DIFF_TEXT_CHARS);
  });

  it('leaves a diff comfortably under the cap untouched', async () => {
    await writeFile(join(worktreePath, 'small.txt'), 'short content\n');

    const text = await computeExplainDiffText(target, worktreePath, {
      kind: 'file',
      path: 'small.txt',
    });

    expect(text.length).toBeLessThan(MAX_EXPLAIN_DIFF_TEXT_CHARS);
  });
});

describe('buildDiffExplainPrompt (issue #236)', () => {
  it('embeds the diff text verbatim and asks for the explanation alone, with no diff regurgitation', () => {
    const prompt = buildDiffExplainPrompt(
      { kind: 'file', path: 'src/a.ts' },
      '@@ -1,1 +1,1 @@\n-old\n+new\n',
    );

    expect(prompt).toContain('@@ -1,1 +1,1 @@\n-old\n+new\n');
    expect(prompt).toMatch(/ONLY the explanation/i);
    expect(prompt).toContain('src/a.ts');
    expect(prompt.match(/```/g)).toHaveLength(2); // exactly one fenced ```diff block, opened and closed
  });

  it('names the hunk scope distinctly from the file scope, so the agent knows how much it is looking at', () => {
    const filePrompt = buildDiffExplainPrompt({ kind: 'file', path: 'a.ts' }, 'diff text');
    const hunkPrompt = buildDiffExplainPrompt(
      { kind: 'hunk', path: 'a.ts', side: 'staged', hunkIndex: 2 },
      'diff text',
    );

    expect(filePrompt).toMatch(/whole current diff/i);
    expect(hunkPrompt).toMatch(/one staged hunk/i);
    expect(filePrompt).not.toBe(hunkPrompt);
  });
});
