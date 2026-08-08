import { describe, expect, it } from 'vitest';
import { PROTOCOL_V1 } from './handshake';
import { withEnvelope } from './wire-envelope';
import { targetListRequest } from './targets';
import { ping } from './heartbeat';
import { provisionProgress } from './provisioning';

describe('withEnvelope', () => {
  it('defaults protocolVersion to PROTOCOL_V1', () => {
    const message = withEnvelope('target_list_request', { requestId: 'req-1' });
    expect(message).toEqual({
      type: 'target_list_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
    });
    expect(targetListRequest.parse(message)).toEqual(message);
  });

  it('preserves every other field the variant needs, unmodified', () => {
    const message = withEnvelope('ping', { nonce: 'abc' });
    expect(message).toEqual({ type: 'ping', protocolVersion: PROTOCOL_V1, nonce: 'abc' });
    expect(ping.parse(message)).toEqual(message);
  });

  it('accepts a spread payload, matching the pre-refactor call-site shape', () => {
    const progress = {
      requestId: 'req-1',
      nodeId: 'node-1',
      targetId: 'target-1',
      step: 'runtime_bootstrap' as const,
      status: 'started' as const,
      message: 'bootstrapping runtime',
    };
    const message = withEnvelope('provision_progress', { ...progress });
    expect(message).toEqual({
      type: 'provision_progress',
      protocolVersion: PROTOCOL_V1,
      ...progress,
    });
    expect(provisionProgress.parse(message)).toEqual(message);
  });

  it('produces the bare envelope for a variant with no other required fields', () => {
    const message = withEnvelope('connected_account_list_request', {});
    expect(message).toEqual({
      type: 'connected_account_list_request',
      protocolVersion: PROTOCOL_V1,
    });
  });
});
