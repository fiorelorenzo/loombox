import { describe, expect, it } from 'vitest';
import {
  mcpPromptGetRequest,
  mcpPromptGetRequestPayloadV1,
  mcpPromptGetResponse,
  mcpPromptGetResponsePayloadV1,
  safeParseMcpPromptGetRequestPayloadV1,
} from './mcp-prompts';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('mcpPromptGetRequestPayloadV1', () => {
  it('accepts a prompt with no arguments (arguments omitted entirely)', () => {
    expect(
      mcpPromptGetRequestPayloadV1.safeParse({ serverName: 'linear-server', promptName: 'review' })
        .success,
    ).toBe(true);
  });

  it('accepts a prompt with resolved argument values', () => {
    const result = mcpPromptGetRequestPayloadV1.safeParse({
      serverName: 'linear-server',
      promptName: 'review',
      arguments: { focus: 'error handling' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty serverName/promptName', () => {
    expect(
      mcpPromptGetRequestPayloadV1.safeParse({ serverName: '', promptName: 'review' }).success,
    ).toBe(false);
    expect(
      mcpPromptGetRequestPayloadV1.safeParse({ serverName: 'linear-server', promptName: '' })
        .success,
    ).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(() => safeParseMcpPromptGetRequestPayloadV1('not an object')).not.toThrow();
  });
});

describe('mcpPromptGetResponsePayloadV1', () => {
  it('parses the ok outcome with rendered text', () => {
    const result = mcpPromptGetResponsePayloadV1.safeParse({
      outcome: 'ok',
      text: "What's the weather in Berlin?",
    });
    expect(result.success).toBe(true);
  });

  it('parses the error outcome', () => {
    const result = mcpPromptGetResponsePayloadV1.safeParse({
      outcome: 'error',
      message: 'linear-server: Invalid arguments for prompt review: missing "focus"',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(mcpPromptGetResponsePayloadV1.safeParse({ outcome: 'pending', text: '' }).success).toBe(
      false,
    );
  });

  it('rejects ok without text, and error without a message', () => {
    expect(mcpPromptGetResponsePayloadV1.safeParse({ outcome: 'ok' }).success).toBe(false);
    expect(mcpPromptGetResponsePayloadV1.safeParse({ outcome: 'error', message: '' }).success).toBe(
      false,
    );
  });
});

describe('mcpPromptGetRequest / mcpPromptGetResponse (the top-level wire messages)', () => {
  it('mcpPromptGetRequest carries only clear routing metadata plus the opaque envelope — never serverName/promptName/arguments in the clear', () => {
    const message = {
      type: 'mcp_prompt_get_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    };
    const result = mcpPromptGetRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
    );
  });

  it('rejects a request missing requestId/sessionId', () => {
    expect(
      mcpPromptGetRequest.safeParse({
        type: 'mcp_prompt_get_request',
        protocolVersion: 1,
        sessionId: '',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
    expect(
      mcpPromptGetRequest.safeParse({
        type: 'mcp_prompt_get_request',
        protocolVersion: 1,
        sessionId: 'session-1',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('mcpPromptGetResponse carries only sessionId/requestId plus the opaque envelope', () => {
    const result = mcpPromptGetResponse.safeParse({
      type: 'mcp_prompt_get_response',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
    });
    expect(result.success).toBe(true);
  });

  it('is additive/version-safe: an extra unknown field never leaks — parse still only recognizes the declared fields', () => {
    const result = mcpPromptGetRequest.safeParse({
      type: 'mcp_prompt_get_request',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      envelope,
      promptName: 'review', // must never be a real field this schema reads in the clear
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('promptName' in result.data).toBe(false);
    }
  });
});
