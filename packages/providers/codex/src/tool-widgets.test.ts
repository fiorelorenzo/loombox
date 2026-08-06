import { describe, expect, it } from 'vitest';

import { codexBespokeToolName, hasCodexBespokeWidget } from './tool-widgets';

// Real Codex tool-call shapes (issue #182 build-time verification spike;
// docs/research/codex-acp-completeness.md §3), not the old, unconfirmed
// "Patch(...)"/"Diff(...)"/"Bash(...)" title-prefix guess (issue #819).
describe('codexBespokeToolName / hasCodexBespokeWidget', () => {
  it('matches a real Codex file-change tool call ("Editing files", toolKind edit)', () => {
    expect(codexBespokeToolName({ title: 'Editing files', toolKind: 'edit' })).toBe('edit');
  });

  it('is case-insensitive on the edit title', () => {
    expect(codexBespokeToolName({ title: 'EDITING FILES', toolKind: 'edit' })).toBe('edit');
  });

  it('matches a real Codex shell-command tool call by toolKind alone (its title is the arbitrary command text, bash prefix already stripped)', () => {
    expect(codexBespokeToolName({ title: 'ls -la', toolKind: 'execute' })).toBe('bash');
    expect(codexBespokeToolName({ title: 'pnpm test', toolKind: 'execute' })).toBe('bash');
  });

  it('does not match an edit-kind call with a different title (not a catch-all on toolKind alone)', () => {
    expect(
      codexBespokeToolName({ title: 'Editing something else', toolKind: 'edit' }),
    ).toBeUndefined();
    expect(codexBespokeToolName({ title: undefined, toolKind: 'edit' })).toBeUndefined();
  });

  it('does not match a real Codex sub-action tool call not in the bespoke set (falls back to the generic row)', () => {
    expect(
      codexBespokeToolName({ title: "Read file 'src/foo.ts'", toolKind: 'read' }),
    ).toBeUndefined();
    expect(
      codexBespokeToolName({ title: "Search for 'TODO'", toolKind: 'search' }),
    ).toBeUndefined();
    expect(
      codexBespokeToolName({ title: "List files in 'src'", toolKind: 'read' }),
    ).toBeUndefined();
  });

  it('returns undefined with no toolKind at all, even if the title happens to read "Editing files"', () => {
    expect(codexBespokeToolName({ title: 'Editing files', toolKind: undefined })).toBeUndefined();
  });

  it('hasCodexBespokeWidget mirrors codexBespokeToolName', () => {
    expect(hasCodexBespokeWidget({ title: 'ls -la', toolKind: 'execute' })).toBe(true);
    expect(hasCodexBespokeWidget({ title: 'Editing files', toolKind: 'edit' })).toBe(true);
    expect(hasCodexBespokeWidget({ title: "Read file 'x'", toolKind: 'read' })).toBe(false);
  });
});
