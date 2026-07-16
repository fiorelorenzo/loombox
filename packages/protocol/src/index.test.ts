import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, baseMessage } from './index';

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
