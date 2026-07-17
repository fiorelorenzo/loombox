import { describe, expect, it } from 'vitest';
import { computeLineDiff, languageForPath } from './diff';

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
