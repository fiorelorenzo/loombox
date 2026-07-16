import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  baseMessage,
  clientHello,
  nodeHello,
  parseWireMessage,
  promptInject,
  safeParseWireMessage,
  sessionAnnounce,
  sessionList,
  sessionMeta,
  sessionUpdate,
  sessionUpdateEnvelope,
  wireMessage,
} from './index';

const validSessionMeta = {
  id: 'sess-1',
  nodeId: 'node-1',
  projectPath: '/home/dev/project',
  worktreePath: '/home/dev/project',
  target: 'local' as const,
  provider: 'claude',
  createdAt: Date.now(),
};

describe('@loombox/protocol bootstrap', () => {
  it('exports a numeric protocol version', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
  });

  it('accepts a message carrying the current version', () => {
    expect(baseMessage.parse({ protocolVersion: PROTOCOL_VERSION })).toEqual({
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('rejects a message carrying a different version', () => {
    expect(() => baseMessage.parse({ protocolVersion: 999 })).toThrow();
  });
});

describe('sessionMeta', () => {
  it('parses a valid session meta', () => {
    expect(sessionMeta.parse(validSessionMeta)).toEqual(validSessionMeta);
  });

  it('accepts an optional title', () => {
    const withTitle = { ...validSessionMeta, title: 'My session' };
    expect(sessionMeta.parse(withTitle)).toEqual(withTitle);
  });

  it('rejects a missing required field', () => {
    const { nodeId: _nodeId, ...missingNodeId } = validSessionMeta;
    expect(() => sessionMeta.parse(missingNodeId)).toThrow();
  });

  it('rejects a target other than local', () => {
    expect(() => sessionMeta.parse({ ...validSessionMeta, target: 'ssh' })).toThrow();
  });
});

describe('sessionUpdate', () => {
  it('parses an agent_message_chunk', () => {
    const msg = { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' };
    expect(sessionUpdate.parse(msg)).toEqual(msg);
  });

  it('parses a user_message_chunk', () => {
    const msg = { kind: 'user_message_chunk', messageId: 'm1', text: 'hi' };
    expect(sessionUpdate.parse(msg)).toEqual(msg);
  });

  it('parses an agent_turn_end', () => {
    const msg = { kind: 'agent_turn_end', messageId: 'm1' };
    expect(sessionUpdate.parse(msg)).toEqual(msg);
  });

  it('parses an error update', () => {
    const msg = { kind: 'error', message: 'boom' };
    expect(sessionUpdate.parse(msg)).toEqual(msg);
  });

  it('rejects an unknown kind', () => {
    expect(() => sessionUpdate.parse({ kind: 'unknown_kind', text: 'x' })).toThrow();
  });

  it('rejects a chunk missing its text field', () => {
    expect(() => sessionUpdate.parse({ kind: 'agent_message_chunk', messageId: 'm1' })).toThrow();
  });
});

describe('nodeHello', () => {
  const valid = { type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId: 'node-1' };

  it('parses a valid node_hello', () => {
    expect(nodeHello.parse(valid)).toEqual(valid);
  });

  it('accepts an optional nodeName', () => {
    const withName = { ...valid, nodeName: 'devbox' };
    expect(nodeHello.parse(withName)).toEqual(withName);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => nodeHello.parse({ ...valid, type: 'client_hello' })).toThrow();
  });

  it('rejects the wrong protocolVersion', () => {
    expect(() => nodeHello.parse({ ...valid, protocolVersion: 999 })).toThrow();
  });

  it('rejects a missing nodeId', () => {
    const { nodeId: _nodeId, ...rest } = valid;
    expect(() => nodeHello.parse(rest)).toThrow();
  });
});

describe('clientHello', () => {
  const valid = { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client-1' };

  it('parses a valid client_hello', () => {
    expect(clientHello.parse(valid)).toEqual(valid);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => clientHello.parse({ ...valid, type: 'node_hello' })).toThrow();
  });

  it('rejects a missing clientId', () => {
    const { clientId: _clientId, ...rest } = valid;
    expect(() => clientHello.parse(rest)).toThrow();
  });
});

describe('sessionAnnounce', () => {
  const valid = {
    type: 'session_announce',
    protocolVersion: PROTOCOL_VERSION,
    session: validSessionMeta,
  };

  it('parses a valid session_announce', () => {
    expect(sessionAnnounce.parse(valid)).toEqual(valid);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => sessionAnnounce.parse({ ...valid, type: 'session_list' })).toThrow();
  });

  it('rejects a malformed session', () => {
    expect(() =>
      sessionAnnounce.parse({ ...valid, session: { ...validSessionMeta, id: undefined } }),
    ).toThrow();
  });
});

describe('sessionList', () => {
  const valid = {
    type: 'session_list',
    protocolVersion: PROTOCOL_VERSION,
    sessions: [validSessionMeta],
  };

  it('parses a valid session_list', () => {
    expect(sessionList.parse(valid)).toEqual(valid);
  });

  it('accepts an empty sessions array', () => {
    expect(sessionList.parse({ ...valid, sessions: [] })).toEqual({ ...valid, sessions: [] });
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => sessionList.parse({ ...valid, type: 'session_announce' })).toThrow();
  });

  it('rejects a non-array sessions field', () => {
    expect(() => sessionList.parse({ ...valid, sessions: validSessionMeta })).toThrow();
  });
});

describe('sessionUpdateEnvelope', () => {
  const valid = {
    type: 'session_update',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'sess-1',
    update: { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' },
  };

  it('parses a valid session_update envelope', () => {
    expect(sessionUpdateEnvelope.parse(valid)).toEqual(valid);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => sessionUpdateEnvelope.parse({ ...valid, type: 'prompt_inject' })).toThrow();
  });

  it('rejects a malformed update', () => {
    expect(() => sessionUpdateEnvelope.parse({ ...valid, update: { kind: 'not_real' } })).toThrow();
  });
});

describe('promptInject', () => {
  const valid = {
    type: 'prompt_inject',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'sess-1',
    promptId: 'p1',
    text: 'do the thing',
  };

  it('parses a valid prompt_inject', () => {
    expect(promptInject.parse(valid)).toEqual(valid);
  });

  it('rejects the wrong type discriminator', () => {
    expect(() => promptInject.parse({ ...valid, type: 'session_update' })).toThrow();
  });

  it('rejects a missing text field', () => {
    const { text: _text, ...rest } = valid;
    expect(() => promptInject.parse(rest)).toThrow();
  });
});

describe('wireMessage', () => {
  it('parses each variant through the union', () => {
    const messages = [
      { type: 'node_hello', protocolVersion: PROTOCOL_VERSION, nodeId: 'node-1' },
      { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client-1' },
      {
        type: 'session_announce',
        protocolVersion: PROTOCOL_VERSION,
        session: validSessionMeta,
      },
      { type: 'session_list', protocolVersion: PROTOCOL_VERSION, sessions: [validSessionMeta] },
      {
        type: 'session_update',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 'sess-1',
        update: { kind: 'agent_turn_end', messageId: 'm1' },
      },
      {
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 'sess-1',
        promptId: 'p1',
        text: 'go',
      },
    ];
    for (const msg of messages) {
      expect(wireMessage.parse(msg)).toEqual(msg);
    }
  });

  it('rejects an unknown type discriminator', () => {
    expect(() =>
      wireMessage.parse({ type: 'not_a_real_type', protocolVersion: PROTOCOL_VERSION }),
    ).toThrow();
  });
});

describe('parseWireMessage', () => {
  it('routes a session_update payload to the right variant', () => {
    const payload = {
      type: 'session_update',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'sess-1',
      update: { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' },
    };
    const parsed = parseWireMessage(payload);
    expect(parsed.type).toBe('session_update');
    if (parsed.type === 'session_update') {
      expect(parsed.update.kind).toBe('agent_message_chunk');
    }
  });

  it('throws on garbage input', () => {
    expect(() => parseWireMessage({ foo: 'bar' })).toThrow();
    expect(() => parseWireMessage(null)).toThrow();
    expect(() => parseWireMessage('nope')).toThrow();
  });
});

describe('safeParseWireMessage', () => {
  it('returns a success result for a valid message', () => {
    const payload = { type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'c1' };
    const result = safeParseWireMessage(payload);
    expect(result.success).toBe(true);
  });

  it('returns a failure result for garbage input, without throwing', () => {
    const result = safeParseWireMessage({ nope: true });
    expect(result.success).toBe(false);
  });
});
