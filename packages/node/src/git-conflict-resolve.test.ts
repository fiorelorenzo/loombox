import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitConflictResolutionHunkV1 } from '@loombox/protocol';
import {
  assembleResolvedContent,
  buildConflictResolvePrompt,
  GitConflictResolveError,
  MAX_CONFLICT_HUNKS_PER_RESOLVE,
  parseConflictMarkers,
  resolveHunkOrigin,
} from './git-conflict-resolve';

const execFileAsync = promisify(execFile);

describe('parseConflictMarkers against a REAL git merge conflict (issue #237)', () => {
  let worktreePath: string;

  async function execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath });
    return stdout.trim();
  }

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-git-conflict-resolve-'));
    await execGit(['init', '-q', '-b', 'main']);
    await execGit(['config', 'user.email', 'test@loombox.dev']);
    await execGit(['config', 'user.name', 'loombox test']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("parses a real 'git merge' conflict's own markers — one hunk, both sides exact, and the surrounding lines untouched", async () => {
    await writeFile(join(worktreePath, 'greeting.txt'), 'one\ntwo\nthree\n');
    await execGit(['add', 'greeting.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);

    await execGit(['checkout', '-q', '-b', 'feature']);
    await writeFile(join(worktreePath, 'greeting.txt'), 'one\nFEATURE-EDIT\nthree\n');
    await execGit(['commit', '-q', '-am', 'feature edit']);

    await execGit(['checkout', '-q', 'main']);
    await writeFile(join(worktreePath, 'greeting.txt'), 'one\nMAIN-EDIT\nthree\n');
    await execGit(['commit', '-q', '-am', 'main edit']);

    await expect(execGit(['merge', 'feature'])).rejects.toThrow();

    const conflicted = await readFile(join(worktreePath, 'greeting.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('>>>>>>>');

    const hunks = parseConflictMarkers(conflicted);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      index: 0,
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
      oursText: 'MAIN-EDIT\n',
      theirsText: 'FEATURE-EDIT\n',
      baseText: null,
    });

    // Reassembling with each side's own real text verbatim round-trips
    // exactly what `git checkout --ours`/`--theirs` would leave for this
    // one hunk — proof the splice points are exactly right, not just
    // "close enough".
    const oursResolution: GitConflictResolutionHunkV1[] = [
      { index: 0, origin: 'ours', resolvedText: hunks[0]!.oursText },
    ];
    expect(assembleResolvedContent(conflicted, oursResolution)).toBe('one\nMAIN-EDIT\nthree\n');
  });

  it('parses several hunks in one real conflicted file, each addressed independently', async () => {
    await writeFile(join(worktreePath, 'multi.txt'), 'a\nb\nc\nd\ne\nf\n');
    await execGit(['add', 'multi.txt']);
    await execGit(['commit', '-q', '-m', 'seed']);

    await execGit(['checkout', '-q', '-b', 'feature']);
    await writeFile(join(worktreePath, 'multi.txt'), 'FEAT-A\nb\nc\nd\ne\nFEAT-F\n');
    await execGit(['commit', '-q', '-am', 'feature edits both ends']);

    await execGit(['checkout', '-q', 'main']);
    await writeFile(join(worktreePath, 'multi.txt'), 'MAIN-A\nb\nc\nd\ne\nMAIN-F\n');
    await execGit(['commit', '-q', '-am', 'main edits both ends']);

    await expect(execGit(['merge', 'feature'])).rejects.toThrow();
    const conflicted = await readFile(join(worktreePath, 'multi.txt'), 'utf8');

    const hunks = parseConflictMarkers(conflicted);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.oursText).toBe('MAIN-A\n');
    expect(hunks[0]!.theirsText).toBe('FEAT-A\n');
    expect(hunks[1]!.oursText).toBe('MAIN-F\n');
    expect(hunks[1]!.theirsText).toBe('FEAT-F\n');

    const resolution: GitConflictResolutionHunkV1[] = [
      { index: 0, origin: 'rewritten', resolvedText: 'MERGED-A\n' },
      { index: 1, origin: 'rewritten', resolvedText: 'MERGED-F\n' },
    ];
    expect(assembleResolvedContent(conflicted, resolution)).toBe(
      'MERGED-A\nb\nc\nd\ne\nMERGED-F\n',
    );
  });

  it('throws GitConflictResolveError for a file with no conflict markers at all', () => {
    expect(() => parseConflictMarkers('just some ordinary content\n')).toThrow(
      GitConflictResolveError,
    );
  });

  it('parses diff3-style markers (an optional ||||||| base section) without losing the base text', () => {
    const content =
      '<<<<<<< HEAD\nmain line\n||||||| merged common ancestors\nbase line\n=======\nfeature line\n>>>>>>> feature\n';
    const hunks = parseConflictMarkers(content);
    expect(hunks).toEqual([
      {
        index: 0,
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
        oursText: 'main line\n',
        theirsText: 'feature line\n',
        baseText: 'base line\n',
      },
    ]);
  });
});

describe('resolveHunkOrigin (issue #237: never trust the agent — derive it)', () => {
  const hunk = {
    index: 0,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
    oursText: 'ours line\n',
    theirsText: 'theirs line\n',
    baseText: null,
  };

  it("reports 'ours' for an exact match to the our side", () => {
    expect(resolveHunkOrigin(hunk, 'ours line\n')).toBe('ours');
  });

  it("reports 'ours' even when the agent's reply differs only by trailing newline/CRLF noise", () => {
    expect(resolveHunkOrigin(hunk, 'ours line')).toBe('ours');
    expect(resolveHunkOrigin(hunk, 'ours line\r\n')).toBe('ours');
  });

  it("reports 'theirs' for an exact match to the their side", () => {
    expect(resolveHunkOrigin(hunk, 'theirs line\n')).toBe('theirs');
  });

  it("reports 'rewritten' for text matching neither side — a genuine combination or fresh rewrite, never silently attributed to one side", () => {
    expect(resolveHunkOrigin(hunk, 'a brand new line combining both\n')).toBe('rewritten');
  });
});

describe('assembleResolvedContent (issue #237)', () => {
  it("pads a hunk's resolved text with a trailing newline when the agent's reply omitted one, so it never runs on into the next line", () => {
    const content = 'before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nafter\n';
    const resolution: GitConflictResolutionHunkV1[] = [
      { index: 0, origin: 'rewritten', resolvedText: 'no trailing newline' },
    ];
    expect(assembleResolvedContent(content, resolution)).toBe(
      'before\nno trailing newline\nafter\n',
    );
  });

  it('throws GitConflictResolveError when resolution is missing an entry for a real hunk', () => {
    const content = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n';
    expect(() => assembleResolvedContent(content, [])).toThrow(GitConflictResolveError);
  });
});

describe('buildConflictResolvePrompt (issue #237)', () => {
  const hunk = {
    index: 0,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
    oursText: 'main line\n',
    theirsText: 'feature line\n',
    baseText: null,
  };

  it('names the file, states which hunk this is out of how many, and carries both real sides verbatim', () => {
    const prompt = buildConflictResolvePrompt('src/a.ts', hunk, 2, 3);
    expect(prompt).toContain('merge conflict 2 of 3 in "src/a.ts"');
    expect(prompt).toContain('"HEAD" side (ours):');
    expect(prompt).toContain('main line');
    expect(prompt).toContain('"feature" side (theirs):');
    expect(prompt).toContain('feature line');
    expect(prompt).toMatch(/ONLY the final text/i);
    // The instruction text itself legitimately names the markers ("no
    // <<<<<<</=======/>>>>>>> markers") — what must never leak is a real
    // marker LINE from the hunk's own sides, which `oursText`/`theirsText`
    // can't carry by construction (the parser already stripped them).
    expect(prompt).not.toMatch(/^<<<<<<< /m);
    expect(prompt).not.toMatch(/^>>>>>>> /m);
  });

  it('names a single-hunk file distinctly from a multi-hunk one', () => {
    const prompt = buildConflictResolvePrompt('a.ts', hunk, 1, 1);
    expect(prompt).toContain('the one merge conflict in "a.ts"');
  });
});

describe('MAX_CONFLICT_HUNKS_PER_RESOLVE', () => {
  it('is a real, positive bound', () => {
    expect(MAX_CONFLICT_HUNKS_PER_RESOLVE).toBeGreaterThan(0);
  });
});
