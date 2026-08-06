import { describe, expect, it } from 'vitest';
import { computeLineDiff, diffStats, languageForPath, pairDiffLinesForSplitView } from './diff';

describe('computeLineDiff', () => {
  it('marks every line as added when oldText is null (a new file)', () => {
    const lines = computeLineDiff(null, 'a\nb\nc');
    expect(lines).toEqual([
      { kind: 'added', text: 'a', oldLineNumber: undefined, newLineNumber: 1 },
      { kind: 'added', text: 'b', oldLineNumber: undefined, newLineNumber: 2 },
      { kind: 'added', text: 'c', oldLineNumber: undefined, newLineNumber: 3 },
    ]);
  });

  it('marks identical text as all context lines', () => {
    const lines = computeLineDiff('a\nb', 'a\nb');
    expect(lines.every((l) => l.kind === 'context')).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('finds a single changed line in the middle, keeping context around it', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nB\nc');
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['removed', 'b'],
      ['added', 'B'],
      ['context', 'c'],
    ]);
  });

  it('handles a pure deletion', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nc');
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['removed', 'b'],
      ['context', 'c'],
    ]);
  });

  it('handles a pure addition', () => {
    const lines = computeLineDiff('a\nc', 'a\nb\nc');
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['added', 'b'],
      ['context', 'c'],
    ]);
  });

  it('treats an empty string as zero lines, not one blank line', () => {
    expect(computeLineDiff('', '')).toEqual([]);
    expect(computeLineDiff(null, '')).toEqual([]);
  });
});

describe('diffStats', () => {
  it('counts added/removed lines and includes the full line list', () => {
    const stats = diffStats('a\nb\nc', 'a\nB\nc');
    expect(stats.hasText).toBe(true);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(1);
    expect(stats.lines).toEqual(computeLineDiff('a\nb\nc', 'a\nB\nc'));
  });

  it('the ACP binary/symlink shape (oldText null, newText empty) has no text and zero counts', () => {
    const stats = diffStats(null, '');
    expect(stats.hasText).toBe(false);
    expect(stats.lines).toEqual([]);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });

  it('an emptied text file (oldText non-null, newText empty) is real content, not the binary fallback', () => {
    const stats = diffStats('a\nb', '');
    expect(stats.hasText).toBe(true);
    expect(stats.removed).toBe(2);
    expect(stats.added).toBe(0);
  });
});

describe('languageForPath', () => {
  it.each([
    ['src/foo.ts', 'js'],
    ['src/foo.tsx', 'js'],
    ['script.py', 'python'],
    ['main.rs', 'rust'],
    ['main.go', 'go'],
    ['data.json', 'json'],
    ['style.css', 'css'],
    ['index.html', 'html'],
    ['README.md', 'markdown'],
    ['Makefile', 'plain'],
  ])('maps %s to %s', (path, expected) => {
    expect(languageForPath(path)).toBe(expected);
  });
});

describe('pairDiffLinesForSplitView', () => {
  it('pairs a context line with itself on both sides', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff('a\nb', 'a\nb'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.left).toBe(row.right);
    }
  });

  it('zips a same-length change block one removed line to one added line', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff('a\nb\nc', 'a\nB\nc'));
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'c'],
    ]);
  });

  it('pads the right side with undefined for a pure removal (more old lines than new)', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff('a\nb\nc', 'a\nc'));
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'],
      ['b', undefined],
      ['c', 'c'],
    ]);
  });

  it('pads the left side with undefined for a pure addition (more new lines than old)', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff('a\nc', 'a\nb\nc'));
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'],
      [undefined, 'b'],
      ['c', 'c'],
    ]);
  });

  it('zips an uneven change block (2 removed, 1 added), padding the shorter side', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff('a\nb\nc\nd', 'a\nX\nd'));
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'],
      ['b', 'X'],
      ['c', undefined],
      ['d', 'd'],
    ]);
  });

  it('a brand-new file (every line added) pairs every row with an undefined left side', () => {
    const rows = pairDiffLinesForSplitView(computeLineDiff(null, 'a\nb'));
    expect(rows).toEqual([
      { left: undefined, right: { kind: 'added', text: 'a', oldLineNumber: undefined, newLineNumber: 1 } },
      { left: undefined, right: { kind: 'added', text: 'b', oldLineNumber: undefined, newLineNumber: 2 } },
    ]);
  });

  it('an empty line list pairs to an empty row list', () => {
    expect(pairDiffLinesForSplitView([])).toEqual([]);
  });
});
