import { describe, expect, it } from 'vitest';
import { PROTOCOL_V1 } from './handshake';
import {
  nodeIdentityConflict,
  nodeIdentityConflictOutcome,
  nodeIdentityConflictWarning,
} from './node-identity-conflict';

describe('nodeIdentityConflictOutcome', () => {
  it('accepts both outcomes claimNodeRouting can produce', () => {
    expect(nodeIdentityConflictOutcome.safeParse('superseded').success).toBe(true);
    expect(nodeIdentityConflictOutcome.safeParse('rejected').success).toBe(true);
  });

  it('rejects an unrelated string', () => {
    expect(nodeIdentityConflictOutcome.safeParse('evicted').success).toBe(false);
  });
});

describe('nodeIdentityConflict', () => {
  it('parses a "superseded" notice — sent to the old connection on an ordinary reconnect', () => {
    const result = nodeIdentityConflict.safeParse({
      type: 'node_identity_conflict',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      outcome: 'superseded',
      message: 'a new connection for nodeId node_1 took over routing (same device)',
    });
    expect(result.success).toBe(true);
  });

  it('parses a "rejected" notice — sent to the rival connection before the relay closes it', () => {
    const result = nodeIdentityConflict.safeParse({
      type: 'node_identity_conflict',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      outcome: 'rejected',
      message: 'nodeId node_1 is already live from a different device',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a notice missing nodeId', () => {
    const result = nodeIdentityConflict.safeParse({
      type: 'node_identity_conflict',
      protocolVersion: PROTOCOL_V1,
      outcome: 'rejected',
      message: 'nodeId node_1 is already live from a different device',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message — the whole point is telling the loser why', () => {
    const result = nodeIdentityConflict.safeParse({
      type: 'node_identity_conflict',
      protocolVersion: PROTOCOL_V1,
      nodeId: 'node_1',
      outcome: 'rejected',
      message: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('nodeIdentityConflictWarning', () => {
  it('parses the shape mirrored onto TargetListEntry.identityConflict', () => {
    const result = nodeIdentityConflictWarning.safeParse({
      rivalDeviceId: 'device-rival',
      detectedAt: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a warning missing rivalDeviceId', () => {
    const result = nodeIdentityConflictWarning.safeParse({ detectedAt: 1_700_000_000_000 });
    expect(result.success).toBe(false);
  });
});
