import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  parseSessionTemplateListResultPayloadV1,
  parseSessionTemplateListSetPayloadV1,
  sessionTemplateListGet,
  sessionTemplateListResult,
  sessionTemplateListResultPayloadV1,
  sessionTemplateListSet,
  sessionTemplateListSetPayloadV1,
  sessionTemplateV1,
} from './session-template';

const base = {
  protocolVersion: 1 as const,
  nodeId: 'node_1',
  targetId: 'local',
  requestId: 'req_1',
};
const validEnvelope = {
  resourceId: 'local',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const dailyCheckin = {
  id: 'tpl_daily',
  name: 'Daily check-in',
  targetId: 'local',
  provider: 'claude',
  worktree: true,
  title: 'Daily check-in',
};

describe('sessionTemplateV1', () => {
  it('parses a full template', () => {
    expect(sessionTemplateV1.parse(dailyCheckin)).toEqual(dailyCheckin);
  });

  it('parses the minimal shape — only id, name, targetId, provider required', () => {
    const minimal = { id: 'tpl_min', name: 'Minimal', targetId: 'local', provider: 'claude' };
    expect(sessionTemplateV1.parse(minimal)).toEqual(minimal);
  });

  it('accepts a customAgent record when provider is the custom sentinel', () => {
    const withCustomAgent = {
      id: 'tpl_custom',
      name: 'My internal agent',
      targetId: 'local',
      provider: 'custom',
      customAgent: { name: 'internal', command: 'omp', args: ['acp'] },
    };
    expect(sessionTemplateV1.parse(withCustomAgent).customAgent).toEqual({
      name: 'internal',
      command: 'omp',
      args: ['acp'],
    });
  });

  it('rejects a blank name', () => {
    expect(() => sessionTemplateV1.parse({ ...dailyCheckin, name: '' })).toThrow();
  });

  it('rejects a blank targetId', () => {
    expect(() => sessionTemplateV1.parse({ ...dailyCheckin, targetId: '' })).toThrow();
  });
});

describe('session_template_list_get/set/result wire messages', () => {
  it('session_template_list_get requires no envelope, addressed by nodeId+targetId directly', () => {
    const message = { type: 'session_template_list_get' as const, ...base };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(sessionTemplateListGet.parse(message)).toEqual(message);
  });

  it('session_template_list_set requires an envelope', () => {
    const withEnvelope = {
      type: 'session_template_list_set' as const,
      ...base,
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(withEnvelope)).not.toThrow();
    expect(() => sessionTemplateListSet.parse({ ...withEnvelope, envelope: undefined })).toThrow();
  });

  it('session_template_list_result carries targetId (no nodeId) plus an envelope, mirroring target_fs_list_response', () => {
    const message = {
      type: 'session_template_list_result' as const,
      protocolVersion: 1 as const,
      targetId: 'local',
      requestId: 'req_1',
      envelope: validEnvelope,
    };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(sessionTemplateListResult.parse(message)).toEqual(message);
    expect('nodeId' in message).toBe(false);
  });
});

describe('session_template_list_result/_set payloads', () => {
  it('parses a catalog with multiple templates', () => {
    const codexReview = {
      id: 'tpl_codex',
      name: 'Codex review',
      targetId: 'local',
      provider: 'codex',
    };
    const payload = { templates: [dailyCheckin, codexReview] };
    expect(parseSessionTemplateListResultPayloadV1(payload)).toEqual(payload);
    expect(sessionTemplateListResultPayloadV1.parse(payload)).toEqual(payload);
  });

  it('parses an empty catalog', () => {
    expect(parseSessionTemplateListSetPayloadV1({ templates: [] })).toEqual({ templates: [] });
    expect(sessionTemplateListSetPayloadV1.parse({ templates: [] })).toEqual({ templates: [] });
  });
});
