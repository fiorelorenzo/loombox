import { describe, expect, it } from 'vitest';
import { presence, resyncMarker, resyncRequest } from './presence';

describe('presence', () => {
  const valid = { type: 'presence', protocolVersion: 1, deviceId: 'device-1', online: true };

  it('parses a valid presence message', () => {
    expect(presence.parse(valid)).toEqual(valid);
  });

  it('parses an offline transition', () => {
    expect(presence.parse({ ...valid, online: false }).online).toBe(false);
  });

  it('rejects a non-boolean online field', () => {
    expect(() => presence.parse({ ...valid, online: 'yes' })).toThrow();
  });
});

describe('resyncRequest', () => {
  const valid = {
    type: 'resync_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    sinceSeq: 10,
  };

  it('parses a valid resyncRequest', () => {
    expect(resyncRequest.parse(valid)).toEqual(valid);
  });

  it('accepts sinceSeq 0 (resync from the beginning)', () => {
    expect(resyncRequest.parse({ ...valid, sinceSeq: 0 }).sinceSeq).toBe(0);
  });

  it('rejects a negative sinceSeq', () => {
    expect(() => resyncRequest.parse({ ...valid, sinceSeq: -1 })).toThrow();
  });
});

describe('resyncMarker', () => {
  const valid = {
    type: 'resync_marker',
    protocolVersion: 1,
    sessionId: 'sess-1',
    fromSeq: 5,
    toSeq: 12,
    dropped: true,
  };

  it('parses a valid resyncMarker signaling a drop-oldest gap', () => {
    expect(resyncMarker.parse(valid)).toEqual(valid);
  });

  it('rejects a missing dropped field', () => {
    const { dropped: _dropped, ...rest } = valid;
    expect(() => resyncMarker.parse(rest)).toThrow();
  });

  it('rejects a non-integer toSeq', () => {
    expect(() => resyncMarker.parse({ ...valid, toSeq: 1.1 })).toThrow();
  });
});
