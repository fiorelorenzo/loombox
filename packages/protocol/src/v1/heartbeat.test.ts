import { describe, expect, it } from 'vitest';
import { HEARTBEAT_CAPABILITY, ping, pong } from './heartbeat';
import { safeParseWireMessageV1 } from './message';

describe('heartbeat', () => {
  it('accepts a ping and a pong on the wire union', () => {
    expect(safeParseWireMessageV1({ type: 'ping', protocolVersion: 1, nonce: 'n1' }).success).toBe(
      true,
    );
    expect(safeParseWireMessageV1({ type: 'pong', protocolVersion: 1, nonce: 'n1' }).success).toBe(
      true,
    );
  });

  it('requires a non-empty nonce, since a peer matches the reply to the probe by it', () => {
    expect(ping.safeParse({ type: 'ping', protocolVersion: 1, nonce: '' }).success).toBe(false);
    expect(pong.safeParse({ type: 'pong', protocolVersion: 1 }).success).toBe(false);
  });

  it('names the capability a relay advertises before a peer may arm a pong deadline', () => {
    expect(HEARTBEAT_CAPABILITY).toBe('heartbeat');
  });
});
