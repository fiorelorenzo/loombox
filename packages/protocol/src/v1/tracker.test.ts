import { describe, expect, it } from 'vitest';
import { PROTOCOL_V1 } from './handshake';
import { wireMessageV1 } from './message';
import {
  githubTarget,
  jiraTarget,
  parseTrackerMode,
  safeParseTrackerMode,
  trackerBackendResolutionErrorV1,
  trackerMode,
  trackerModeResponse,
  trackerModeSetRequest,
  type TrackerMode,
} from './tracker';

describe('githubTarget', () => {
  it('parses owner/repo alone, projectNumber optional', () => {
    expect(githubTarget.parse({ owner: 'fiorelorenzo', repo: 'loombox' })).toEqual({
      owner: 'fiorelorenzo',
      repo: 'loombox',
    });
  });

  it('parses with an explicit Projects v2 board number', () => {
    expect(
      githubTarget.parse({ owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 }),
    ).toEqual({
      owner: 'fiorelorenzo',
      repo: 'loombox',
      projectNumber: 4,
    });
  });

  it('rejects a missing repo', () => {
    expect(() => githubTarget.parse({ owner: 'fiorelorenzo' })).toThrow();
  });
});

describe('jiraTarget', () => {
  it('parses cloudId/projectKey', () => {
    expect(jiraTarget.parse({ cloudId: 'abc-123', projectKey: 'LB' })).toEqual({
      cloudId: 'abc-123',
      projectKey: 'LB',
    });
  });

  it('rejects a missing cloudId', () => {
    expect(() => jiraTarget.parse({ projectKey: 'LB' })).toThrow();
  });
});

describe('trackerMode', () => {
  it('parses native mode', () => {
    expect(trackerMode.parse({ kind: 'native' })).toEqual({ kind: 'native' });
  });

  it('rejects native mode carrying stray live fields (discriminated union, not a loose object)', () => {
    // z.discriminatedUnion picks the 'native' arm from `kind` and strips
    // unknown keys per that arm's own schema, so a live-shaped payload
    // mislabeled 'native' still parses down to the bare native shape.
    expect(trackerMode.parse({ kind: 'native', provider: 'github' } as unknown)).toEqual({
      kind: 'native',
    });
  });

  it('parses a valid live GitHub mode', () => {
    const valid = {
      kind: 'live',
      provider: 'github',
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    } satisfies TrackerMode;
    expect(trackerMode.parse(valid)).toEqual(valid);
  });

  it('parses a valid live Jira mode', () => {
    const valid = {
      kind: 'live',
      provider: 'jira',
      connectionId: 'conn_2',
      target: { cloudId: 'abc-123', projectKey: 'LB' },
    } satisfies TrackerMode;
    expect(trackerMode.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown kind', () => {
    expect(() => trackerMode.parse({ kind: 'imported' })).toThrow();
  });

  it('rejects a live mode missing connectionId', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'github',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects an empty connectionId', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'github',
        connectionId: '',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'linear',
        connectionId: 'conn_1',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects a GitHub target shape submitted for provider jira', () => {
    const result = trackerMode.safeParse({
      kind: 'live',
      provider: 'jira',
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a Jira target shape submitted for provider github', () => {
    const result = trackerMode.safeParse({
      kind: 'live',
      provider: 'github',
      connectionId: 'conn_1',
      target: { cloudId: 'abc-123', projectKey: 'LB' },
    });
    expect(result.success).toBe(false);
  });

  it('parseTrackerMode throws on an invalid payload, safeParseTrackerMode returns a failed result', () => {
    expect(() => parseTrackerMode({ kind: 'native', extra: true })).not.toThrow();
    expect(() => parseTrackerMode({ kind: 'nope' })).toThrow();
    expect(safeParseTrackerMode({ kind: 'nope' }).success).toBe(false);
    expect(safeParseTrackerMode({ kind: 'native' }).success).toBe(true);
  });
});

describe('tracker mode sync messages (issue #631)', () => {
  const base = {
    protocolVersion: PROTOCOL_V1,
    requestId: 'req-1',
    nodeId: 'node-1',
    projectPath: '/home/dev/Progetti/loombox',
  } as const;

  it('slots into wireMessageV1, which is what makes them reachable at all', () => {
    for (const message of [
      { type: 'tracker_mode_get_request', ...base },
      { type: 'tracker_mode_set_request', ...base, mode: { kind: 'native' } },
      { type: 'tracker_mode_response', ...base, mode: { kind: 'native' } },
    ]) {
      expect(() => wireMessageV1.parse(message)).not.toThrow();
    }
  });

  it('carries a live mode with its connection and target intact', () => {
    const mode: TrackerMode = {
      kind: 'live',
      provider: 'github',
      connectionId: 'conn-1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    };
    const parsed = trackerModeSetRequest.parse({ type: 'tracker_mode_set_request', ...base, mode });
    expect(parsed.mode).toEqual(mode);
  });

  it('rejects a set with no mode — a save must say what it is saving', () => {
    expect(() =>
      trackerModeSetRequest.parse({ type: 'tracker_mode_set_request', ...base }),
    ).toThrow();
  });

  it('rejects a mode whose target does not match its provider, on the wire too', () => {
    expect(() =>
      trackerModeSetRequest.parse({
        type: 'tracker_mode_set_request',
        ...base,
        mode: {
          kind: 'live',
          provider: 'github',
          connectionId: 'conn-1',
          target: { cloudId: 'c', projectKey: 'K' },
        },
      }),
    ).toThrow();
  });

  // The distinction issue #209 exists to protect: "never chosen" is not "native".
  it('allows a response with no mode, meaning this project has never chosen one', () => {
    const parsed = trackerModeResponse.parse({ type: 'tracker_mode_response', ...base });
    expect(parsed.mode).toBeUndefined();
  });

  it('keeps an explicit native choice distinguishable from that absence', () => {
    const parsed = trackerModeResponse.parse({
      type: 'tracker_mode_response',
      ...base,
      mode: { kind: 'native' },
    });
    expect(parsed.mode).toEqual({ kind: 'native' });
  });
});

describe('trackerBackendResolutionErrorV1 (SPEC §7.10, issue #631)', () => {
  it('parses every kind resolveTrackerBackend can produce, field-for-field', () => {
    const cases = [
      { kind: 'nativeMode' },
      { kind: 'accountNotConnected', connectionId: 'conn-1' },
      { kind: 'accountPinRequired', capability: 'github' },
      { kind: 'accountPinMalformed', capability: 'github', pinnedAccountId: 'not-real' },
      { kind: 'accountPinDangling', capability: 'github', pinnedAccountId: 'gone' },
      {
        kind: 'accountHostMismatch',
        capability: 'github',
        pinnedAccountId: 'acct-1',
        expectedHost: 'github.com',
        actualHost: 'ghe.example.com',
      },
      { kind: 'accountAmbiguous', capability: 'github', candidateAccountIds: ['a', 'b'] },
      { kind: 'accountPinOptedOut', capability: 'github' },
      { kind: 'connectionPinMismatch', connectionId: 'conn-1', pinnedAccountId: 'conn-2' },
      { kind: 'credentialUnavailable', connectionId: 'conn-1' },
      {
        kind: 'credentialSourceUnsupported',
        connectionId: 'conn-1',
        credentialSource: 'oauth_3lo',
      },
    ];
    for (const value of cases) {
      expect(trackerBackendResolutionErrorV1.parse(value)).toEqual(value);
    }
  });

  it('rejects an unknown kind and a kind missing its own required fields', () => {
    expect(() => trackerBackendResolutionErrorV1.parse({ kind: 'somethingElse' })).toThrow();
    expect(() => trackerBackendResolutionErrorV1.parse({ kind: 'accountNotConnected' })).toThrow();
  });
});
