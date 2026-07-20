import { describe, expect, it } from 'vitest';
import { attentionHint, attentionHintClass } from './attention';

describe('attentionHintClass', () => {
  it('accepts the two v1-live attention-inbox classes', () => {
    for (const value of ['awaiting_input', 'session_outcome']) {
      expect(attentionHintClass.parse(value)).toBe(value);
    }
  });

  it('rejects a class with no live source yet (ci_failure/review_request, SPEC §7.13 v2)', () => {
    expect(() => attentionHintClass.parse('ci_failure')).toThrow();
    expect(() => attentionHintClass.parse('review_request')).toThrow();
  });

  it('rejects the permission class (that one has its own permission_request message)', () => {
    expect(() => attentionHintClass.parse('permission')).toThrow();
  });
});

describe('attentionHint', () => {
  const valid = {
    type: 'attention_hint',
    protocolVersion: 1,
    sessionId: 'sess-1',
    class: 'awaiting_input' as const,
  };

  it('parses a valid attention_hint', () => {
    expect(attentionHint.parse(valid)).toEqual(valid);
  });

  it('parses the session_outcome class too', () => {
    expect(attentionHint.parse({ ...valid, class: 'session_outcome' }).class).toBe(
      'session_outcome',
    );
  });

  it('rejects a missing sessionId', () => {
    const { sessionId: _sessionId, ...rest } = valid;
    expect(() => attentionHint.parse(rest)).toThrow();
  });

  it('rejects an invalid class', () => {
    expect(() => attentionHint.parse({ ...valid, class: 'nope' })).toThrow();
  });

  it('carries no content: only type/protocolVersion/sessionId/class ever ride on this message', () => {
    expect(Object.keys(attentionHint.parse(valid)).sort()).toEqual(
      ['type', 'protocolVersion', 'sessionId', 'class'].sort(),
    );
  });
});
