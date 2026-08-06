import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  agentProfileListGet,
  agentProfileListResult,
  agentProfileListResultPayloadV1,
  agentProfileListSet,
  agentProfileListSetPayloadV1,
  agentProfileSessionErrorPayloadV1,
  agentProfileSessionGet,
  agentProfileSessionPayloadV1,
  agentProfileSessionResult,
  agentProfileSessionSet,
  agentProfileV1,
  parseAgentProfileListResultPayloadV1,
  parseAgentProfileListSetPayloadV1,
  parseAgentProfileSessionPayloadV1,
} from './agent-profile';

const base = { protocolVersion: 1 as const, sessionId: 'sess-1', requestId: 'req-1' };
const validEnvelope = {
  resourceId: 'sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const askFirst = {
  id: 'prof_ask',
  name: 'Ask First',
  deniedToolKinds: ['execute', 'delete'],
  deniedToolNamePatterns: ['mcp__github__*'],
  deniedMcpServers: ['github'],
};

describe('agentProfileV1', () => {
  it('parses a full profile', () => {
    expect(agentProfileV1.parse(askFirst)).toEqual(askFirst);
  });

  it('parses an empty (all-empty-list) profile — denies nothing', () => {
    const empty = {
      id: 'prof_1',
      name: 'Write',
      deniedToolKinds: [],
      deniedToolNamePatterns: [],
      deniedMcpServers: [],
    };
    expect(agentProfileV1.parse(empty)).toEqual(empty);
  });

  it('rejects a blank name', () => {
    expect(() => agentProfileV1.parse({ ...askFirst, name: '   ' })).toThrow();
  });

  it('rejects a blank entry in any denied list — never a silently-unsatisfiable rule', () => {
    expect(() => agentProfileV1.parse({ ...askFirst, deniedToolNamePatterns: [''] })).toThrow();
  });

  it('trims a denied entry before validating it', () => {
    expect(
      agentProfileV1.parse({ ...askFirst, deniedMcpServers: ['  github  '] }).deniedMcpServers,
    ).toEqual(['github']);
  });
});

describe('agent_profile_list_get/set/result wire messages', () => {
  it('agent_profile_list_get requires no envelope', () => {
    const message = { type: 'agent_profile_list_get' as const, ...base };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(agentProfileListGet.parse(message)).toEqual(message);
  });

  it('agent_profile_list_set requires an envelope', () => {
    const withEnvelope = {
      type: 'agent_profile_list_set' as const,
      ...base,
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(withEnvelope)).not.toThrow();
    expect(() => agentProfileListSet.parse({ ...withEnvelope, envelope: undefined })).toThrow();
  });

  it('agent_profile_list_result requires an envelope', () => {
    const message = {
      type: 'agent_profile_list_result' as const,
      ...base,
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(agentProfileListResult.parse(message)).toEqual(message);
  });
});

describe('agent_profile_list_result/_set payloads', () => {
  it('parses a catalog with multiple profiles', () => {
    const payload = { profiles: [askFirst] };
    expect(parseAgentProfileListResultPayloadV1(payload)).toEqual(payload);
    expect(parseAgentProfileListSetPayloadV1(payload)).toEqual(payload);
  });

  it('parses an empty catalog — a node with nothing saved yet', () => {
    expect(agentProfileListResultPayloadV1.parse({ profiles: [] })).toEqual({ profiles: [] });
    expect(agentProfileListSetPayloadV1.parse({ profiles: [] })).toEqual({ profiles: [] });
  });
});

describe('agent_profile_session_get/set/result wire messages', () => {
  it('agent_profile_session_get requires no envelope', () => {
    const message = { type: 'agent_profile_session_get' as const, ...base };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(agentProfileSessionGet.parse(message)).toEqual(message);
  });

  it('agent_profile_session_set requires an envelope', () => {
    const withEnvelope = {
      type: 'agent_profile_session_set' as const,
      ...base,
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(withEnvelope)).not.toThrow();
    expect(() => agentProfileSessionSet.parse({ ...withEnvelope, envelope: undefined })).toThrow();
  });

  it('agent_profile_session_result requires an envelope', () => {
    const message = {
      type: 'agent_profile_session_result' as const,
      ...base,
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(agentProfileSessionResult.parse(message)).toEqual(message);
  });
});

describe('agent_profile_session payload', () => {
  it('parses a real profileId', () => {
    expect(parseAgentProfileSessionPayloadV1({ profileId: 'prof_ask' })).toEqual({
      profileId: 'prof_ask',
    });
  });

  it('parses null — no profile active, unrestricted', () => {
    expect(parseAgentProfileSessionPayloadV1({ profileId: null })).toEqual({ profileId: null });
  });

  it('rejects a blank profileId — never an empty-string stand-in for null', () => {
    expect(() => agentProfileSessionPayloadV1.parse({ profileId: '' })).toThrow();
  });
});

describe('agent_profile_session error payload', () => {
  it('parses the "no live agent" error shape (mirrors ConfigOptionSetResult)', () => {
    const payload = { outcome: 'error' as const, message: 'This session has no live agent.' };
    expect(agentProfileSessionErrorPayloadV1.parse(payload)).toEqual(payload);
  });
});
