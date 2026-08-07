import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  configOption,
  configOptionResult,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  promptInjectResult,
  promptInjectV1,
} from './steering';

const validEnvelope = {
  resourceId: 'session:sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('promptInjectV1', () => {
  const valid = {
    type: 'prompt_inject',
    protocolVersion: 1,
    sessionId: 'sess-1',
    promptId: 'p1',
    envelope: validEnvelope,
  };

  it('parses a valid encrypted prompt_inject', () => {
    expect(promptInjectV1.parse(valid)).toEqual(valid);
  });

  it('rejects a missing promptId', () => {
    const { promptId: _promptId, ...rest } = valid;
    expect(() => promptInjectV1.parse(rest)).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() =>
      promptInjectV1.parse({ ...valid, envelope: { ...validEnvelope, iv: 'bad' } }),
    ).toThrow();
  });
});

describe('permissionDecision', () => {
  it('accepts every ACP permission-decision kind', () => {
    for (const decision of ['allow_once', 'allow_always', 'reject_once', 'reject_always']) {
      expect(permissionDecision.parse(decision)).toBe(decision);
    }
  });

  it('rejects an unrecognized decision', () => {
    expect(() => permissionDecision.parse('maybe')).toThrow();
  });
});

describe('permissionRequest', () => {
  const valid = {
    type: 'permission_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  };

  it('parses a valid permissionRequest', () => {
    expect(permissionRequest.parse(valid)).toEqual(valid);
  });

  it('rejects a missing requestId', () => {
    const { requestId: _requestId, ...rest } = valid;
    expect(() => permissionRequest.parse(rest)).toThrow();
  });
});

describe('permissionResponse', () => {
  const valid = {
    type: 'permission_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    decision: 'allow_once' as const,
  };

  it('parses a valid permissionResponse', () => {
    expect(permissionResponse.parse(valid)).toEqual(valid);
  });

  it('rejects an invalid decision', () => {
    expect(() => permissionResponse.parse({ ...valid, decision: 'sure' })).toThrow();
  });
});

describe('configOption', () => {
  const valid = {
    type: 'config_option',
    protocolVersion: 1,
    sessionId: 'sess-1',
    category: 'model',
    optionId: 'claude-sonnet',
  };

  it('parses a valid configOption', () => {
    expect(configOption.parse(valid)).toEqual(valid);
  });

  it('accepts a future/unrecognized category string (SPEC §7.24: renders generically, never hidden)', () => {
    expect(configOption.parse({ ...valid, category: 'future_category' }).category).toBe(
      'future_category',
    );
  });

  it('rejects a missing optionId', () => {
    const { optionId: _optionId, ...rest } = valid;
    expect(() => configOption.parse(rest)).toThrow();
  });
});

describe('configOptionResult (issue #718)', () => {
  const valid = {
    type: 'config_option_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    category: 'model',
    result: { outcome: 'ok' as const },
  };

  it('parses a valid ok result', () => {
    expect(configOptionResult.parse(valid)).toEqual(valid);
  });

  it('parses a valid error result carrying the agent\u2019s own rejection reason', () => {
    const errorResult = {
      ...valid,
      result: { outcome: 'error' as const, message: 'Unsupported value: gpt-9000' },
    };
    expect(configOptionResult.parse(errorResult)).toEqual(errorResult);
  });

  it('rejects an error result with no message (the whole point is carrying the reason)', () => {
    expect(() => configOptionResult.parse({ ...valid, result: { outcome: 'error' } })).toThrow();
  });

  it('rejects an outcome outside ok/error', () => {
    expect(() => configOptionResult.parse({ ...valid, result: { outcome: 'pending' } })).toThrow();
  });

  it('rejects a missing category', () => {
    const { category: _category, ...rest } = valid;
    expect(() => configOptionResult.parse(rest)).toThrow();
  });
});

describe('promptInjectResult (issue #706)', () => {
  const valid = {
    type: 'prompt_inject_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    promptId: 'p1',
    result: { outcome: 'ok' as const },
  };

  it('parses a valid ok result', () => {
    expect(promptInjectResult.parse(valid)).toEqual(valid);
  });

  it('parses a valid error result carrying why the prompt could not be delivered', () => {
    const errorResult = {
      ...valid,
      result: {
        outcome: 'error' as const,
        message: "Couldn't restart this session's agent: spawn ENOENT",
      },
    };
    expect(promptInjectResult.parse(errorResult)).toEqual(errorResult);
  });

  it('rejects an error result with no message (the whole point is carrying the reason)', () => {
    expect(() => promptInjectResult.parse({ ...valid, result: { outcome: 'error' } })).toThrow();
  });

  it('rejects an outcome outside ok/error', () => {
    expect(() => promptInjectResult.parse({ ...valid, result: { outcome: 'reviving' } })).toThrow();
  });

  it('rejects a missing promptId', () => {
    const { promptId: _promptId, ...rest } = valid;
    expect(() => promptInjectResult.parse(rest)).toThrow();
  });

  it('slots into wireMessageV1, which is what makes it reachable at all (a merge that drops it from the union would fail here first)', () => {
    expect(() => wireMessageV1.parse(valid)).not.toThrow();
    const errorResult = {
      ...valid,
      result: { outcome: 'error' as const, message: 'revival failed' },
    };
    expect(() => wireMessageV1.parse(errorResult)).not.toThrow();
    expect(wireMessageV1.parse(valid).type).toBe('prompt_inject_result');
  });
});
