import { describe, expect, it } from 'vitest';

import { codexBespokeToolName, hasCodexBespokeWidget } from './tool-widgets';

describe('codexBespokeToolName / hasCodexBespokeWidget', () => {
  it('matches each of Codex bespoke tool-widget tools by title prefix', () => {
    expect(codexBespokeToolName({ title: 'Patch(src/foo.ts)' })).toBe('patch');
    expect(codexBespokeToolName({ title: 'Diff(src/bar.ts)' })).toBe('diff');
    expect(codexBespokeToolName({ title: 'Bash(pnpm test)' })).toBe('bash');
  });

  it('is case-insensitive', () => {
    expect(codexBespokeToolName({ title: 'patch(src/foo.ts)' })).toBe('patch');
  });

  it('returns undefined for a tool not in the bespoke set (falls back to the generic row)', () => {
    expect(codexBespokeToolName({ title: 'Grep(pattern)' })).toBeUndefined();
    expect(codexBespokeToolName({ title: 'WebFetch' })).toBeUndefined();
  });

  it('returns undefined for a missing/empty title', () => {
    expect(codexBespokeToolName({ title: undefined })).toBeUndefined();
    expect(codexBespokeToolName({ title: '' })).toBeUndefined();
    expect(codexBespokeToolName({ title: '   ' })).toBeUndefined();
  });

  it('hasCodexBespokeWidget mirrors codexBespokeToolName', () => {
    expect(hasCodexBespokeWidget({ title: 'Bash(ls)' })).toBe(true);
    expect(hasCodexBespokeWidget({ title: 'Grep' })).toBe(false);
  });
});
