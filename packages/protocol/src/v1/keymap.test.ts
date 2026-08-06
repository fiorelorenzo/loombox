import { describe, expect, it } from 'vitest';
import { wireMessageV1 } from './message';
import { keymapGetRequest, keymapResult, keymapSetRequest, keymapV1 } from './keymap';

const validEnvelope = {
  resourceId: 'acct-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

describe('keymapV1', () => {
  it('parses an actionId -> chord record', () => {
    expect(keymapV1.parse({ 'stop-turn': 'Mod+.', 'new-session': 'Mod+N' })).toEqual({
      'stop-turn': 'Mod+.',
      'new-session': 'Mod+N',
    });
  });

  it('parses an empty keymap (nothing remapped)', () => {
    expect(keymapV1.parse({})).toEqual({});
  });

  it('rejects a blank action id key', () => {
    expect(() => keymapV1.parse({ '': 'Mod+.' })).toThrow();
  });

  it('rejects a blank chord value', () => {
    expect(() => keymapV1.parse({ 'stop-turn': '' })).toThrow();
  });

  it('rejects a non-string chord value', () => {
    expect(() => keymapV1.parse({ 'stop-turn': 42 })).toThrow();
  });
});

describe('keymap_get_request / keymap_set_request / keymap_result wire messages', () => {
  it('parses a valid get request', () => {
    const message = {
      type: 'keymap_get_request',
      protocolVersion: 1,
      requestId: 'req-1',
    };
    expect(keymapGetRequest.parse(message)).toEqual(message);
  });

  it('parses a valid set request', () => {
    const message = {
      type: 'keymap_set_request',
      protocolVersion: 1,
      requestId: 'req-1',
      envelope: validEnvelope,
    };
    expect(keymapSetRequest.parse(message)).toEqual(message);
  });

  it('rejects a set request with no envelope', () => {
    expect(() =>
      keymapSetRequest.parse({
        type: 'keymap_set_request',
        protocolVersion: 1,
        requestId: 'req-1',
      }),
    ).toThrow();
  });

  it('parses a result carrying a saved keymap envelope', () => {
    const message = {
      type: 'keymap_result',
      protocolVersion: 1,
      requestId: 'req-1',
      envelope: validEnvelope,
    };
    expect(keymapResult.parse(message)).toEqual(message);
  });

  it('parses a result with a null envelope — the "nothing saved yet" case', () => {
    const message = {
      type: 'keymap_result',
      protocolVersion: 1,
      requestId: 'req-1',
      envelope: null,
    };
    expect(keymapResult.parse(message)).toEqual(message);
  });

  it('every keymap message type-checks against the full v1 wire union', () => {
    expect(
      wireMessageV1.safeParse({ type: 'keymap_get_request', protocolVersion: 1, requestId: 'r' })
        .success,
    ).toBe(true);
    expect(
      wireMessageV1.safeParse({
        type: 'keymap_set_request',
        protocolVersion: 1,
        requestId: 'r',
        envelope: validEnvelope,
      }).success,
    ).toBe(true);
    expect(
      wireMessageV1.safeParse({
        type: 'keymap_result',
        protocolVersion: 1,
        requestId: 'r',
        envelope: null,
      }).success,
    ).toBe(true);
  });
});
