import { describe, expect, it } from 'vitest';

import {
  acpPermissionRequestPayloadSchema,
  acpToolCallUpdateSchema,
  acpTranscriptUpdateSchema,
} from './acp-wire-schema';

describe('acpTranscriptUpdateSchema', () => {
  it('parses every one of the five AcpTranscriptUpdate kinds', () => {
    const samples: unknown[] = [
      { kind: 'agent_message_chunk', turnId: 't1', messageId: 'm1', text: 'hi' },
      { kind: 'user_message_chunk', turnId: 't1', messageId: 'm1', text: 'hi' },
      { kind: 'agent_thought_chunk', turnId: 't1', messageId: 'm1', text: 'hmm' },
      { kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts', toolKind: 'edit', status: 'pending' },
      { kind: 'tool_call_update', id: 'tc1', status: 'completed' },
      { kind: 'plan_update', entries: [{ content: 'step 1', status: 'pending' }] },
      { kind: 'usage_update', sessionId: 'sess-1', tokensUsed: 10, contextWindow: 100 },
    ];
    for (const sample of samples) {
      expect(() => acpTranscriptUpdateSchema.parse(sample)).not.toThrow();
    }
  });

  it("rejects a tool_call_update whose id is missing (issue #548's root cause)", () => {
    const result = acpTranscriptUpdateSchema.safeParse({
      kind: 'tool_call_update',
      status: 'completed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool_call carrying id: undefined explicitly, same as a missing key', () => {
    const result = acpTranscriptUpdateSchema.safeParse({ kind: 'tool_call', id: undefined });
    expect(result.success).toBe(false);
  });

  it('rejects a known field carrying the wrong type (status as a number, not the enum)', () => {
    const result = acpTranscriptUpdateSchema.safeParse({
      kind: 'tool_call_update',
      id: 'tc1',
      status: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a message chunk using the wrong field name (message instead of text)', () => {
    const result = acpTranscriptUpdateSchema.safeParse({
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      message: 'hi',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a kind outside the closed AcpTranscriptUpdate set', () => {
    const result = acpTranscriptUpdateSchema.safeParse({
      kind: 'session_status',
      status: 'working',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object garbage without throwing', () => {
    expect(acpTranscriptUpdateSchema.safeParse(null).success).toBe(false);
    expect(acpTranscriptUpdateSchema.safeParse('nope').success).toBe(false);
    expect(acpTranscriptUpdateSchema.safeParse(42).success).toBe(false);
  });

  it('strips an unknown extra field instead of rejecting the whole payload (forward compatibility)', () => {
    const result = acpTranscriptUpdateSchema.safeParse({
      kind: 'tool_call',
      id: 'tc1',
      fromTheFuture: 'ignored',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: 'tool_call', id: 'tc1' });
    }
  });
});

describe('acpToolCallUpdateSchema', () => {
  it('accepts a minimal tool_call carrying only kind + id', () => {
    expect(acpToolCallUpdateSchema.safeParse({ kind: 'tool_call', id: 'tc1' }).success).toBe(true);
  });

  it('rejects a tool_call_update kind literal used with the message-chunk shape', () => {
    expect(
      acpToolCallUpdateSchema.safeParse({ kind: 'tool_call_update', turnId: 't1', messageId: 'm1' })
        .success,
    ).toBe(false);
  });
});

describe('acpPermissionRequestPayloadSchema', () => {
  const validOptions = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ];

  it('parses a well-formed permission_request payload unchanged', () => {
    const payload = {
      toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit foo.ts' },
      options: validOptions,
    };
    expect(acpPermissionRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a payload whose toolCall.id is missing (issue #548's malformed case)", () => {
    const result = acpPermissionRequestPayloadSchema.safeParse({
      toolCall: { kind: 'tool_call', title: 'Mystery permission' },
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an option carrying an unrecognized kind value', () => {
    const result = acpPermissionRequestPayloadSchema.safeParse({
      toolCall: { kind: 'tool_call', id: 'tc1' },
      options: [{ optionId: 'x', name: 'X', kind: 'maybe_later' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing the options array entirely', () => {
    const result = acpPermissionRequestPayloadSchema.safeParse({
      toolCall: { kind: 'tool_call', id: 'tc1' },
    });
    expect(result.success).toBe(false);
  });
});
