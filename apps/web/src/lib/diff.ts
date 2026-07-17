/**
 * A small, dependency-free line diff (SPEC.md §7.24 "Diffs"; issue #141).
 * Hand-rolled rather than pulling in a diff library, per this wave's brief:
 * a classic LCS (longest common subsequence) over lines, then walked back
 * into a flat list of context/added/removed rows — the same algorithm every
 * textbook line-diff implementation uses (`diff -u`, git's own default,
 * Myers' algorithm's simpler O(n*m) cousin). Good enough for the tool-call
 * diffs and working-tree diffs this viewer renders; not meant to compete
 * with Myers on huge files.
 */

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old file; absent for an added line. */
  oldLineNumber: number | undefined;
  /** 1-based line number in the new file; absent for a removed line. */
  newLineNumber: number | undefined;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Computes the line-level diff between `oldText` and `newText`. `null`
 * `oldText` means "no previous content" (a new file) — every `newText` line
 * renders as added, matching ACP v1's `Diff.oldText: string | null`.
 */
export function computeLineDiff(oldText: string | null, newText: string): DiffLine[] {
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldText === null) {
    return newLines.map((text, index) => ({
      kind: 'added' as const,
      text,
      oldLineNumber: undefined,
      newLineNumber: index + 1,
    }));
  }

  // Standard LCS dynamic-programming table over lines.
  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({
        kind: 'context',
        text: oldLines[i],
        oldLineNumber: i + 1,
        newLineNumber: j + 1,
      });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({
        kind: 'removed',
        text: oldLines[i],
        oldLineNumber: i + 1,
        newLineNumber: undefined,
      });
      i++;
    } else {
      lines.push({
        kind: 'added',
        text: newLines[j],
        oldLineNumber: undefined,
        newLineNumber: j + 1,
      });
      j++;
    }
  }
  while (i < m) {
    lines.push({
      kind: 'removed',
      text: oldLines[i],
      oldLineNumber: i + 1,
      newLineNumber: undefined,
    });
    i++;
  }
  while (j < n) {
    lines.push({
      kind: 'added',
      text: newLines[j],
      oldLineNumber: undefined,
      newLineNumber: j + 1,
    });
    j++;
  }
  return lines;
}

/** File-extension -> a loose language tag, for the diff viewer's syntax-aware coloring class. */
export function languageForPath(path: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path);
  const ext = match?.[1]?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
      return 'markdown';
    default:
      return 'plain';
  }
}
