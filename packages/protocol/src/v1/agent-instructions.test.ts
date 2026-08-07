import { describe, expect, it } from 'vitest';
import {
  agentInstructionsFileNameV1,
  agentInstructionsFileStateV1,
  agentInstructionsGetRequest,
  agentInstructionsGetResponse,
  agentInstructionsSetRequest,
  agentInstructionsSetRequestPayloadV1,
  agentInstructionsSetResponse,
  parseAgentInstructionsGetResponsePayloadV1,
  parseAgentInstructionsSetRequestPayloadV1,
  parseAgentInstructionsSetResponsePayloadV1,
  safeParseAgentInstructionsGetResponsePayloadV1,
  safeParseAgentInstructionsSetRequestPayloadV1,
  safeParseAgentInstructionsSetResponsePayloadV1,
} from './agent-instructions';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('agentInstructionsFileNameV1', () => {
  it.each(['AGENTS.md', 'CLAUDE.md'] as const)('accepts %s', (fileName) => {
    expect(agentInstructionsFileNameV1.safeParse(fileName).success).toBe(true);
  });

  it('rejects an unknown file name', () => {
    expect(agentInstructionsFileNameV1.safeParse('README.md').success).toBe(false);
  });
});

describe('agentInstructionsFileStateV1', () => {
  it('accepts a file with content and a hash', () => {
    expect(
      agentInstructionsFileStateV1.safeParse({
        fileName: 'AGENTS.md',
        content: '# instructions',
        hash: 'abc123',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty hash', () => {
    expect(
      agentInstructionsFileStateV1.safeParse({ fileName: 'AGENTS.md', content: '', hash: '' })
        .success,
    ).toBe(false);
  });
});

describe('agentInstructionsGetResponsePayloadV1', () => {
  it('parses the ok outcome with zero, one, or both files', () => {
    expect(parseAgentInstructionsGetResponsePayloadV1({ outcome: 'ok', files: [] })).toEqual({
      outcome: 'ok',
      files: [],
    });
    const both = parseAgentInstructionsGetResponsePayloadV1({
      outcome: 'ok',
      files: [
        { fileName: 'AGENTS.md', content: 'a', hash: 'h1' },
        { fileName: 'CLAUDE.md', content: 'c', hash: 'h2' },
      ],
    });
    expect(both.outcome).toBe('ok');
    if (both.outcome === 'ok') {
      expect(both.files.map((file) => file.fileName)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    }
  });

  it('parses the error outcome', () => {
    const result = parseAgentInstructionsGetResponsePayloadV1({
      outcome: 'error',
      message: 'worktree unreachable',
    });
    expect(result).toEqual({ outcome: 'error', message: 'worktree unreachable' });
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(safeParseAgentInstructionsGetResponsePayloadV1({ outcome: 'pending' }).success).toBe(
      false,
    );
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseAgentInstructionsGetResponsePayloadV1(null).success).toBe(false);
  });
});

describe('agentInstructionsSetRequestPayloadV1', () => {
  it('accepts a create (baseHash: null)', () => {
    expect(
      parseAgentInstructionsSetRequestPayloadV1({
        fileName: 'AGENTS.md',
        content: '# new',
        baseHash: null,
      }),
    ).toEqual({ fileName: 'AGENTS.md', content: '# new', baseHash: null });
  });

  it('accepts an edit (baseHash: a prior hash)', () => {
    expect(
      agentInstructionsSetRequestPayloadV1.safeParse({
        fileName: 'CLAUDE.md',
        content: 'edited',
        baseHash: 'h1',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing baseHash field entirely', () => {
    expect(
      safeParseAgentInstructionsSetRequestPayloadV1({ fileName: 'AGENTS.md', content: 'x' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown file name', () => {
    expect(
      agentInstructionsSetRequestPayloadV1.safeParse({
        fileName: 'README.md',
        content: 'x',
        baseHash: null,
      }).success,
    ).toBe(false);
  });
});

describe('agentInstructionsSetResponsePayloadV1', () => {
  it('parses the ok outcome', () => {
    const result = parseAgentInstructionsSetResponsePayloadV1({
      outcome: 'ok',
      fileName: 'AGENTS.md',
      content: 'saved',
      hash: 'h2',
    });
    expect(result).toEqual({ outcome: 'ok', fileName: 'AGENTS.md', content: 'saved', hash: 'h2' });
  });

  it('parses the conflict outcome with the current on-disk state', () => {
    const result = parseAgentInstructionsSetResponsePayloadV1({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: { fileName: 'AGENTS.md', content: 'changed underneath', hash: 'h3' },
    });
    expect(result).toEqual({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: { fileName: 'AGENTS.md', content: 'changed underneath', hash: 'h3' },
    });
  });

  it('parses the conflict outcome when the file was deleted underneath (current: null)', () => {
    const result = parseAgentInstructionsSetResponsePayloadV1({
      outcome: 'conflict',
      fileName: 'AGENTS.md',
      current: null,
    });
    expect(result).toEqual({ outcome: 'conflict', fileName: 'AGENTS.md', current: null });
  });

  it('parses the error outcome', () => {
    const result = parseAgentInstructionsSetResponsePayloadV1({
      outcome: 'error',
      fileName: 'CLAUDE.md',
      message: 'permission denied',
    });
    expect(result).toEqual({
      outcome: 'error',
      fileName: 'CLAUDE.md',
      message: 'permission denied',
    });
  });

  it('rejects an outcome outside the three known variants', () => {
    expect(
      safeParseAgentInstructionsSetResponsePayloadV1({ outcome: 'pending', fileName: 'AGENTS.md' })
        .success,
    ).toBe(false);
  });
});

describe('agentInstructionsGetRequest / agentInstructionsGetResponse (the top-level wire messages)', () => {
  it('agentInstructionsGetRequest carries no envelope — asking carries no content', () => {
    const request = {
      type: 'agent_instructions_get_request' as const,
      protocolVersion: 1 as const,
      sessionId: 'sess-1',
      requestId: 'req-1',
    };
    expect(agentInstructionsGetRequest.safeParse(request).success).toBe(true);
    expect('envelope' in request).toBe(false);
  });

  it('rejects a request missing sessionId/requestId', () => {
    expect(
      agentInstructionsGetRequest.safeParse({
        type: 'agent_instructions_get_request',
        protocolVersion: 1,
        sessionId: '',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('agentInstructionsGetResponse requires an envelope', () => {
    expect(
      agentInstructionsGetResponse.safeParse({
        type: 'agent_instructions_get_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      agentInstructionsGetResponse.safeParse({
        type: 'agent_instructions_get_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });
});

describe('agentInstructionsSetRequest / agentInstructionsSetResponse (the top-level wire messages)', () => {
  it('agentInstructionsSetRequest requires an envelope, unlike agentInstructionsGetRequest', () => {
    expect(
      agentInstructionsSetRequest.safeParse({
        type: 'agent_instructions_set_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      agentInstructionsSetRequest.safeParse({
        type: 'agent_instructions_set_request',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
      }).success,
    ).toBe(false);
  });

  it('agentInstructionsSetResponse requires an envelope', () => {
    expect(
      agentInstructionsSetResponse.safeParse({
        type: 'agent_instructions_set_response',
        protocolVersion: 1,
        sessionId: 'sess-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });
});
