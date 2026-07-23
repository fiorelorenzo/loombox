import { describe, expect, it } from 'vitest';
import { parseWireMessageV1, safeParseWireMessageV1, wireMessageV1 } from './message';

const validEnvelope = {
  resourceId: 'res-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const validSessionMetaPublic = {
  id: 'sess-1',
  nodeId: 'node-1',
  targetId: 'local',
  accountId: 'acct-1',
  provider: 'claude',
  createdAt: 1_700_000_000_000,
};

/** One valid instance of every v1 message family, keyed by its `type` discriminator. */
const messagesByType: Record<string, unknown> = {
  initialize: {
    type: 'initialize',
    protocolVersion: 1,
    role: 'node',
    authToken: 'tok',
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  },
  initialize_result: {
    type: 'initialize_result',
    protocolVersion: 1,
    negotiatedVersion: 1,
    capabilities: ['e2e'],
  },
  device_register: {
    type: 'device_register',
    protocolVersion: 1,
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  },
  device_revoke: {
    type: 'device_revoke',
    protocolVersion: 1,
    deviceId: 'device-1',
    newEpoch: 1,
    rewrappedAmk: [],
  },
  device_rotate: {
    type: 'device_rotate',
    protocolVersion: 1,
    deviceId: 'device-1',
    newDevicePublicKey: 'YWJjZA==',
  },
  amk_escrow: { type: 'amk_escrow', protocolVersion: 1, wrappedAmk: 'YWJjZA==' },
  amk_epoch_fetch_request: {
    type: 'amk_epoch_fetch_request',
    protocolVersion: 1,
    deviceId: 'device-2',
  },
  amk_epoch_fetch_response: {
    type: 'amk_epoch_fetch_response',
    protocolVersion: 1,
    deviceId: 'device-2',
    pending: {
      epoch: 1,
      fromDeviceId: 'device-1',
      fromDevicePublicKey: 'YWJjZA==',
      envelope: validEnvelope,
    },
  },
  new_device_bootstrap_request: {
    type: 'new_device_bootstrap_request',
    protocolVersion: 1,
    deviceId: 'device-2',
    devicePublicKey: 'YWJjZA==',
  },
  new_device_bootstrap_response: {
    type: 'new_device_bootstrap_response',
    protocolVersion: 1,
    wrappedAmk: 'YWJjZA==',
  },
  qr_pairing_request: {
    type: 'qr_pairing_request',
    protocolVersion: 1,
    pairingCode: '123-456',
    newDeviceId: 'device-3',
    newDevicePublicKey: 'YWJjZA==',
  },
  qr_pairing_response: {
    type: 'qr_pairing_response',
    protocolVersion: 1,
    pairingCode: '123-456',
    envelope: validEnvelope,
  },
  target_announce: {
    type: 'target_announce',
    protocolVersion: 1,
    nodeId: 'node-1',
    targets: [{ id: 'local', kind: 'local', label: 'This machine' }],
  },
  target_list_request: {
    type: 'target_list_request',
    protocolVersion: 1,
    requestId: 'req-1',
  },
  target_list: {
    type: 'target_list',
    protocolVersion: 1,
    requestId: 'req-1',
    targets: [
      {
        nodeId: 'node-1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
      },
    ],
  },
  target_status: {
    type: 'target_status',
    protocolVersion: 1,
    nodeId: 'node-1',
    samples: [
      {
        targetId: 'local',
        cpuPercent: 12,
        memPercent: 20,
        memUsedBytes: 1,
        memTotalBytes: 2,
        diskPercent: 5,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        healthy: true,
        sampledAt: 1,
      },
    ],
  },
  session_create: {
    type: 'session_create',
    protocolVersion: 1,
    sessionId: 'sess-1',
    targetId: 'local',
    provider: 'claude',
    privateEnvelope: validEnvelope,
  },
  session_announce: {
    type: 'session_announce',
    protocolVersion: 1,
    session: validSessionMetaPublic,
    privateEnvelope: validEnvelope,
  },
  session_resume: { type: 'session_resume', protocolVersion: 1, sessionId: 'sess-1' },
  session_list_request: { type: 'session_list_request', protocolVersion: 1 },
  session_list: {
    type: 'session_list',
    protocolVersion: 1,
    sessions: [{ session: validSessionMetaPublic, privateEnvelope: validEnvelope }],
  },
  session_update: {
    type: 'session_update',
    protocolVersion: 1,
    sessionId: 'sess-1',
    seq: 0,
    envelope: validEnvelope,
  },
  prompt_inject: {
    type: 'prompt_inject',
    protocolVersion: 1,
    sessionId: 'sess-1',
    promptId: 'p1',
    envelope: validEnvelope,
  },
  permission_request: {
    type: 'permission_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  permission_response: {
    type: 'permission_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    decision: 'allow_once',
  },
  config_option: {
    type: 'config_option',
    protocolVersion: 1,
    sessionId: 'sess-1',
    category: 'model',
    optionId: 'claude-sonnet',
  },
  blob_upload: {
    type: 'blob_upload',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  blob_ref: {
    type: 'blob_ref',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  blob_download: { type: 'blob_download', protocolVersion: 1, sessionId: 'sess-1', ref: 'ref-1' },
  blob_download_response: {
    type: 'blob_download_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  presence: { type: 'presence', protocolVersion: 1, deviceId: 'device-1', online: true },
  resync_request: {
    type: 'resync_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    sinceSeq: 0,
  },
  resync_marker: {
    type: 'resync_marker',
    protocolVersion: 1,
    sessionId: 'sess-1',
    fromSeq: 0,
    toSeq: 3,
    dropped: true,
  },
  attention_hint: {
    type: 'attention_hint',
    protocolVersion: 1,
    sessionId: 'sess-1',
    class: 'awaiting_input',
  },
};

describe('wireMessageV1', () => {
  it('routes every v1 message family through the discriminated union', () => {
    for (const [type, message] of Object.entries(messagesByType)) {
      const parsed = wireMessageV1.parse(message);
      expect(parsed.type).toBe(type);
    }
  });

  it('rejects an unknown type discriminator', () => {
    expect(() => wireMessageV1.parse({ type: 'not_a_real_type', protocolVersion: 1 })).toThrow();
  });

  it('rejects a v0-shaped message (missing v1-only fields) even with type reused, e.g. session_list', () => {
    // v0's session_list carries `sessions: SessionMeta[]` directly; v1's carries
    // `{ session, privateEnvelope }[]`. The two unions are independent, but a
    // same-named v0 payload must not slip through the v1 parser.
    const v0Shaped = {
      type: 'session_list',
      protocolVersion: 1,
      sessions: [{ id: 'sess-1', nodeId: 'node-1', title: 'leak' }],
    };
    expect(() => wireMessageV1.parse(v0Shaped)).toThrow();
  });
});

describe('parseWireMessageV1', () => {
  it('routes a session_update payload to the right variant', () => {
    const parsed = parseWireMessageV1(messagesByType.session_update);
    expect(parsed.type).toBe('session_update');
    if (parsed.type === 'session_update') {
      expect(parsed.seq).toBe(0);
    }
  });

  it('throws on garbage input', () => {
    expect(() => parseWireMessageV1({ foo: 'bar' })).toThrow();
    expect(() => parseWireMessageV1(null)).toThrow();
    expect(() => parseWireMessageV1('nope')).toThrow();
  });
});

describe('safeParseWireMessageV1', () => {
  it('returns a success result for a valid message', () => {
    const result = safeParseWireMessageV1(messagesByType.presence);
    expect(result.success).toBe(true);
  });

  it('returns a failure result for garbage input, without throwing', () => {
    const result = safeParseWireMessageV1({ nope: true });
    expect(result.success).toBe(false);
  });
});
