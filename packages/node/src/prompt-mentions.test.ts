import { describe, expect, it } from 'vitest';
import { renderPromptTextWithMentions } from './prompt-mentions';

describe('renderPromptTextWithMentions (issue #742: the agent receives a resolved reference, not a display string)', () => {
  it('returns the text unchanged when there are no mentions', () => {
    expect(renderPromptTextWithMentions('check this out', undefined)).toBe('check this out');
    expect(renderPromptTextWithMentions('check this out', [])).toBe('check this out');
  });

  it('appends a single mention as a Referenced: block, one uri/name pair per line', () => {
    const result = renderPromptTextWithMentions('check this out', [
      { uri: 'file:apps/web/src/lib/relay-client.ts', name: 'relay-client.ts' },
    ]);
    expect(result).toBe(
      'check this out\n\nReferenced:\n- relay-client.ts — file:apps/web/src/lib/relay-client.ts',
    );
  });

  it('appends every mention in order, kind-agnostically (file, session, and tracker uris rendered identically)', () => {
    const result = renderPromptTextWithMentions('does the same backoff apply', [
      { uri: 'file:apps/web/src/lib/relay-client.ts', name: 'relay-client.ts' },
      { uri: 'loombox-session:sess_abc123', name: 'Fix login bug' },
      { uri: 'loombox-tracker:node-1/%2Fproj/rec_99', name: '#142 Fix login bug' },
    ]);
    expect(result).toBe(
      [
        'does the same backoff apply',
        '',
        'Referenced:',
        '- relay-client.ts — file:apps/web/src/lib/relay-client.ts',
        '- Fix login bug — loombox-session:sess_abc123',
        '- #142 Fix login bug — loombox-tracker:node-1/%2Fproj/rec_99',
      ].join('\n'),
    );
  });

  it('an empty prompt text with mentions renders the Referenced: block alone, no leading blank line', () => {
    const result = renderPromptTextWithMentions('', [{ uri: 'file:README.md', name: 'README.md' }]);
    expect(result).toBe('Referenced:\n- README.md — file:README.md');
  });
});
