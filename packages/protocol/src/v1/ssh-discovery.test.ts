import { describe, expect, it } from 'vitest';
import {
  sshAgentIdentityV1,
  sshAgentInfoV1,
  sshDiscoveryRequest,
  sshDiscoveryResponse,
  sshDiscoveryResultV1,
  sshHostCandidateV1,
} from './ssh-discovery';

describe('sshHostCandidateV1', () => {
  const valid = {
    alias: 'devbox',
    hostName: '100.87.202.117',
    user: 'lorenzo',
    port: 22,
    identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
  };

  it('parses a fully-specified candidate', () => {
    expect(sshHostCandidateV1.parse(valid)).toEqual(valid);
  });

  it('accepts a candidate with no user/port and no identity files (host defaults to its own alias)', () => {
    expect(sshHostCandidateV1.parse({ alias: 'mac', hostName: 'mac', identityFiles: [] })).toEqual({
      alias: 'mac',
      hostName: 'mac',
      identityFiles: [],
    });
  });

  it('rejects an empty alias or hostName', () => {
    expect(() => sshHostCandidateV1.parse({ ...valid, alias: '' })).toThrow();
    expect(() => sshHostCandidateV1.parse({ ...valid, hostName: '' })).toThrow();
  });

  it('rejects a non-positive port', () => {
    expect(() => sshHostCandidateV1.parse({ ...valid, port: 0 })).toThrow();
  });
});

describe('sshAgentIdentityV1 / sshAgentInfoV1', () => {
  it('parses an available agent with identities', () => {
    const agent = {
      available: true,
      socketPath: '/tmp/ssh-agent.sock',
      identities: [
        { bits: 256, fingerprint: 'SHA256:abc', comment: 'dev@devbox', type: 'ED25519' },
      ],
    };
    expect(sshAgentInfoV1.parse(agent)).toEqual(agent);
    expect(sshAgentIdentityV1.parse(agent.identities[0])).toEqual(agent.identities[0]);
  });

  it('parses an unavailable agent (no socketPath, no identities)', () => {
    expect(sshAgentInfoV1.parse({ available: false, identities: [] })).toEqual({
      available: false,
      identities: [],
    });
  });
});

describe('sshDiscoveryResultV1', () => {
  it('parses the ok outcome with candidates and the agent', () => {
    const result = {
      outcome: 'ok' as const,
      candidates: [
        { alias: 'devbox', hostName: '100.87.202.117', identityFiles: ['/home/l/.ssh/id_ed25519'] },
      ],
      agent: { available: false, identities: [] },
      requiresManualEntry: false,
    };
    expect(sshDiscoveryResultV1.parse(result)).toEqual(result);
  });

  it('parses the ok outcome with zero candidates and requiresManualEntry true', () => {
    const result = {
      outcome: 'ok' as const,
      candidates: [],
      agent: { available: false, identities: [] },
      requiresManualEntry: true,
    };
    expect(sshDiscoveryResultV1.parse(result)).toEqual(result);
  });

  it('parses the error outcome', () => {
    const result = { outcome: 'error' as const, message: 'ssh config unreadable' };
    expect(sshDiscoveryResultV1.parse(result)).toEqual(result);
  });

  it('rejects an outcome outside the two known variants', () => {
    expect(sshDiscoveryResultV1.safeParse({ outcome: 'pending' }).success).toBe(false);
  });

  it('rejects an error outcome with an empty message', () => {
    expect(sshDiscoveryResultV1.safeParse({ outcome: 'error', message: '' }).success).toBe(false);
  });
});

describe('sshDiscoveryRequest / sshDiscoveryResponse (the top-level wire messages)', () => {
  it('sshDiscoveryRequest carries only clear routing metadata (nodeId+requestId), addressed directly by nodeId like provision_target_request — there is no targetId, since choosing one is the whole point', () => {
    const message = {
      type: 'ssh_discovery_request' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
    };
    const result = sshDiscoveryRequest.safeParse(message);
    expect(result.success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['nodeId', 'protocolVersion', 'requestId', 'type'].sort(),
    );
  });

  it('rejects a request missing nodeId/requestId', () => {
    expect(
      sshDiscoveryRequest.safeParse({
        type: 'ssh_discovery_request',
        protocolVersion: 1,
        nodeId: '',
        requestId: 'req_1',
      }).success,
    ).toBe(false);
    expect(
      sshDiscoveryRequest.safeParse({
        type: 'ssh_discovery_request',
        protocolVersion: 1,
        nodeId: 'node_1',
      }).success,
    ).toBe(false);
  });

  it('sshDiscoveryResponse carries requestId/nodeId plus the discriminated result, never an encryptedEnvelope', () => {
    const message = {
      type: 'ssh_discovery_response' as const,
      protocolVersion: 1 as const,
      requestId: 'req_1',
      nodeId: 'node_1',
      result: {
        outcome: 'ok' as const,
        candidates: [],
        agent: { available: false, identities: [] },
        requiresManualEntry: true,
      },
    };
    const result = sshDiscoveryResponse.safeParse(message);
    expect(result.success).toBe(true);
    expect(result.success && 'envelope' in result.data).toBe(false);
  });

  it('is additive/version-safe: an extra unknown field is ignored by parse, never leaked into the parsed result', () => {
    const result = sshDiscoveryRequest.safeParse({
      type: 'ssh_discovery_request',
      protocolVersion: 1,
      requestId: 'req_1',
      nodeId: 'node_1',
      configPath: '/etc/ssh_config', // must never be a real field this schema reads
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('configPath' in result.data).toBe(false);
    }
  });
});
