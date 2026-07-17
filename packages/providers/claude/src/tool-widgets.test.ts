import { describe, expect, it } from 'vitest';

import { claudeBespokeToolName, hasClaudeBespokeWidget } from './tool-widgets';

describe('claudeBespokeToolName / hasClaudeBespokeWidget', () => {
  it('matches each of Claude Code bespoke tool-widget tools by title prefix', () => {
    expect(claudeBespokeToolName({ title: 'Edit(src/foo.ts)' })).toBe('edit');
    expect(claudeBespokeToolName({ title: 'Write(src/bar.ts)' })).toBe('write');
    expect(claudeBespokeToolName({ title: 'Bash(pnpm test)' })).toBe('bash');
    expect(claudeBespokeToolName({ title: 'TodoWrite' })).toBe('todowrite');
  });

  it('is case-insensitive', () => {
    expect(claudeBespokeToolName({ title: 'edit(src/foo.ts)' })).toBe('edit');
  });

  it('returns undefined for a tool not in the bespoke set (falls back to the generic row)', () => {
    expect(claudeBespokeToolName({ title: 'Grep(pattern)' })).toBeUndefined();
    expect(claudeBespokeToolName({ title: 'WebFetch' })).toBeUndefined();
  });

  it('returns undefined for a missing/empty title', () => {
    expect(claudeBespokeToolName({ title: undefined })).toBeUndefined();
    expect(claudeBespokeToolName({ title: '' })).toBeUndefined();
    expect(claudeBespokeToolName({ title: '   ' })).toBeUndefined();
  });

  it('hasClaudeBespokeWidget mirrors claudeBespokeToolName', () => {
    expect(hasClaudeBespokeWidget({ title: 'Bash(ls)' })).toBe(true);
    expect(hasClaudeBespokeWidget({ title: 'Grep' })).toBe(false);
  });
});
