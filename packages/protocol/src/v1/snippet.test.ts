import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import {
  parseSnippetListResultPayloadV1,
  parseSnippetListSetPayloadV1,
  snippetListGet,
  snippetListResult,
  snippetListResultPayloadV1,
  snippetListSet,
  snippetListSetPayloadV1,
  snippetV1,
} from './snippet';

const base = {
  protocolVersion: 1 as const,
  sessionId: 'sess_1',
  requestId: 'req_1',
};
const validEnvelope = {
  resourceId: 'sess_1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const standupPrompt = {
  id: 'snip_standup',
  name: 'Daily standup',
  text: 'Summarize what changed since the last standup and flag anything blocked.',
};

describe('snippetV1', () => {
  it('parses a full snippet', () => {
    expect(snippetV1.parse(standupPrompt)).toEqual(standupPrompt);
  });

  it('rejects a blank name', () => {
    expect(() => snippetV1.parse({ ...standupPrompt, name: '' })).toThrow();
  });

  it('rejects a whitespace-only name', () => {
    expect(() => snippetV1.parse({ ...standupPrompt, name: '   ' })).toThrow();
  });

  it('rejects blank text', () => {
    expect(() => snippetV1.parse({ ...standupPrompt, text: '' })).toThrow();
  });

  it('preserves text verbatim — leading/trailing whitespace is never trimmed', () => {
    const withWhitespace = { ...standupPrompt, text: '  keep this indent\n\n' };
    expect(snippetV1.parse(withWhitespace).text).toBe('  keep this indent\n\n');
  });
});

describe('snippet_list_get/set/result wire messages', () => {
  it('snippet_list_get requires no envelope, addressed by sessionId directly', () => {
    const message = { type: 'snippet_list_get' as const, ...base };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(snippetListGet.parse(message)).toEqual(message);
  });

  it('snippet_list_set requires an envelope', () => {
    const withEnvelope = { type: 'snippet_list_set' as const, ...base, envelope: validEnvelope };
    expect(() => wireMessageV1.parse(withEnvelope)).not.toThrow();
    expect(() => snippetListSet.parse({ ...withEnvelope, envelope: undefined })).toThrow();
  });

  it('snippet_list_result carries sessionId plus an envelope, mirroring agent_profile_list_result', () => {
    const message = { type: 'snippet_list_result' as const, ...base, envelope: validEnvelope };
    expect(() => wireMessageV1.parse(message)).not.toThrow();
    expect(snippetListResult.parse(message)).toEqual(message);
  });
});

describe('snippet_list_result/_set payloads', () => {
  it('parses a catalog with multiple snippets', () => {
    const retroPrompt = {
      id: 'snip_retro',
      name: 'Retro notes',
      text: "What went well, what didn't, one action item.",
    };
    const payload = { snippets: [standupPrompt, retroPrompt] };
    expect(parseSnippetListResultPayloadV1(payload)).toEqual(payload);
    expect(snippetListResultPayloadV1.parse(payload)).toEqual(payload);
  });

  it('parses an empty catalog', () => {
    expect(parseSnippetListSetPayloadV1({ snippets: [] })).toEqual({ snippets: [] });
    expect(snippetListSetPayloadV1.parse({ snippets: [] })).toEqual({ snippets: [] });
  });
});
