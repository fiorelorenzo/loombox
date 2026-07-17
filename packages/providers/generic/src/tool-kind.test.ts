import { describe, expect, it } from 'vitest';

import { classifyGenericToolKind } from './tool-kind';

describe('classifyGenericToolKind', () => {
  it('passes through every real ACP ToolKind unchanged', () => {
    const kinds = [
      'read',
      'edit',
      'delete',
      'move',
      'search',
      'execute',
      'think',
      'fetch',
      'other',
    ] as const;
    for (const toolKind of kinds) {
      expect(classifyGenericToolKind({ toolKind })).toBe(toolKind);
    }
  });

  it('falls back to "other" when the agent omits toolKind entirely', () => {
    expect(classifyGenericToolKind({ toolKind: undefined })).toBe('other');
  });
});
