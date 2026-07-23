import { describe, expect, it } from 'vitest';
import {
  provisionProgress,
  provisionStepIdV1,
  provisionStepStatusV1,
  provisionTargetHostInputV1,
  provisionTargetRequest,
  provisionTargetResult,
} from './provisioning';

describe('provisionTargetHostInputV1', () => {
  const valid = { host: '10.0.0.5', port: 22, user: 'loombox', alias: 'devbox', label: 'Dev box' };

  it('parses a fully-specified host input', () => {
    expect(provisionTargetHostInputV1.parse(valid)).toEqual(valid);
  });

  it('accepts just a bare host (manual entry, no autodetected alias)', () => {
    expect(provisionTargetHostInputV1.parse({ host: '10.0.0.5' })).toEqual({ host: '10.0.0.5' });
  });

  it('rejects an empty host', () => {
    expect(() => provisionTargetHostInputV1.parse({ host: '' })).toThrow();
  });

  it('rejects a non-positive port', () => {
    expect(() => provisionTargetHostInputV1.parse({ host: 'x', port: 0 })).toThrow();
  });

  it('never carries a password or private key field (routing metadata only)', () => {
    const parsed = provisionTargetHostInputV1.parse({
      host: 'x',
      password: 'hunter2',
      privateKey: 'secret',
    } as never);
    expect(parsed).not.toHaveProperty('password');
    expect(parsed).not.toHaveProperty('privateKey');
  });
});

describe('provisionStepIdV1', () => {
  it('accepts every step in the provision-and-pair sequence', () => {
    for (const step of [
      'verify_and_persist',
      'runtime_bootstrap',
      'supervisor_install',
      'target_identity',
      'mint_node_token',
      'amk_handoff',
      'resident_node_install',
    ]) {
      expect(provisionStepIdV1.parse(step)).toBe(step);
    }
  });

  it('rejects an unknown step id', () => {
    expect(() => provisionStepIdV1.parse('teleport')).toThrow();
  });
});

describe('provisionStepStatusV1', () => {
  it('accepts started/ok/failed', () => {
    expect(provisionStepStatusV1.parse('started')).toBe('started');
    expect(provisionStepStatusV1.parse('ok')).toBe('ok');
    expect(provisionStepStatusV1.parse('failed')).toBe('failed');
  });

  it('rejects any other status', () => {
    expect(() => provisionStepStatusV1.parse('pending')).toThrow();
  });
});

describe('provisionTargetRequest', () => {
  const valid = {
    type: 'provision_target_request' as const,
    protocolVersion: 1 as const,
    requestId: 'req-1',
    nodeId: 'node-1',
    targetId: 'ssh:devbox',
    host: { host: '10.0.0.5', user: 'loombox' },
  };

  it('parses a valid provision_target_request', () => {
    expect(provisionTargetRequest.parse(valid)).toEqual(valid);
  });

  it('rejects a missing nodeId (this is addressed directly, not resolved via an existing target)', () => {
    const { nodeId: _nodeId, ...rest } = valid;
    expect(() => provisionTargetRequest.parse(rest)).toThrow();
  });

  it('rejects a missing targetId', () => {
    const { targetId: _targetId, ...rest } = valid;
    expect(() => provisionTargetRequest.parse(rest)).toThrow();
  });

  it('rejects a malformed host descriptor', () => {
    expect(() => provisionTargetRequest.parse({ ...valid, host: { host: '' } })).toThrow();
  });
});

describe('provisionProgress', () => {
  const valid = {
    type: 'provision_progress' as const,
    protocolVersion: 1 as const,
    requestId: 'req-1',
    nodeId: 'node-1',
    targetId: 'ssh:devbox',
    step: 'runtime_bootstrap' as const,
    status: 'ok' as const,
    message: 'runtime bootstrap ok',
  };

  it('parses a valid provision_progress', () => {
    expect(provisionProgress.parse(valid)).toEqual(valid);
  });

  it('rejects an empty message', () => {
    expect(() => provisionProgress.parse({ ...valid, message: '' })).toThrow();
  });

  it('rejects an invalid step/status pair', () => {
    expect(() => provisionProgress.parse({ ...valid, step: 'nope' })).toThrow();
    expect(() => provisionProgress.parse({ ...valid, status: 'nope' })).toThrow();
  });
});

describe('provisionTargetResult', () => {
  const ok = {
    type: 'provision_target_result' as const,
    protocolVersion: 1 as const,
    requestId: 'req-1',
    nodeId: 'node-1',
    targetId: 'ssh:devbox',
    ok: true,
    message: 'devbox provisioned and paired',
  };

  it('parses a successful result with no failedStep', () => {
    expect(provisionTargetResult.parse(ok)).toEqual(ok);
  });

  it('parses a failed result naming the step it stopped at', () => {
    const failed = {
      ...ok,
      ok: false,
      failedStep: 'mint_node_token' as const,
      message: 'mint failed',
    };
    expect(provisionTargetResult.parse(failed)).toEqual(failed);
  });

  it('rejects a malformed failedStep', () => {
    expect(() => provisionTargetResult.parse({ ...ok, ok: false, failedStep: 'nope' })).toThrow();
  });
});
