import { describe, expect, it } from 'vitest';
import {
  accountPinGetRequest,
  accountPinMapV1,
  accountPinResolveRequest,
  accountPinResolveResponse,
  accountPinResponse,
  accountPinSetRequest,
  accountPinUnsetRequest,
  connectedAccountDisconnectRequest,
  connectedAccountDisconnectResponse,
  githubConnectCancelRequest,
  githubConnectDeviceCode,
  githubConnectResult,
  githubConnectStartRequest,
  jiraConnectRequest,
  jiraConnectResponse,
} from './account-connect';
import type { ConnectedAccount } from './connected-accounts';
import { PROTOCOL_V1 } from './handshake';
import { wireMessageV1 } from './message';

function githubAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const base: ConnectedAccount = {
    id: 'github:github.com:1234567',
    provider: 'github',
    host: 'github.com',
    providerAccountId: '1234567',
    label: 'octocat',
    avatarUrl: 'https://example.com/a.png',
    credentialSource: 'device_flow',
    scopes: ['repo', 'read:user', 'read:org', 'read:project'],
    capabilities: ['repo', 'issues'],
    connectedAt: 1000,
    updatedAt: 1000,
    secretRef: 'connected-account-token:github:github.com:1234567',
  };
  return { ...base, ...overrides };
}

describe('githubConnectStartRequest / githubConnectCancelRequest', () => {
  it('parses a valid start request', () => {
    const message = {
      type: 'github_connect_start_request' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
    };
    expect(githubConnectStartRequest.parse(message)).toEqual(message);
  });

  it('parses a valid cancel request', () => {
    const message = {
      type: 'github_connect_cancel_request' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
    };
    expect(githubConnectCancelRequest.parse(message)).toEqual(message);
  });

  it('rejects an empty requestId', () => {
    expect(
      githubConnectStartRequest.safeParse({
        type: 'github_connect_start_request',
        protocolVersion: PROTOCOL_V1,
        requestId: '',
        nodeId: 'node-1',
      }).success,
    ).toBe(false);
  });
});

describe('githubConnectDeviceCode', () => {
  it('parses a valid device code, never carrying a token field', () => {
    const message = {
      type: 'github_connect_device_code' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-1234',
      expiresInSeconds: 900,
      intervalSeconds: 5,
    };
    const parsed = githubConnectDeviceCode.parse(message);
    expect(parsed).toEqual(message);
    expect(JSON.stringify(parsed)).not.toMatch(/token/i);
  });

  it('allows omitting verificationUriComplete', () => {
    expect(
      githubConnectDeviceCode.safeParse({
        type: 'github_connect_device_code',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresInSeconds: 900,
        intervalSeconds: 5,
      }).success,
    ).toBe(true);
  });
});

describe('githubConnectResult', () => {
  it('parses a success outcome carrying the connected account', () => {
    const account = githubAccount();
    const message = {
      type: 'github_connect_result' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      result: { outcome: 'success' as const, account },
    };
    expect(githubConnectResult.parse(message)).toEqual(message);
  });

  it('parses each named failure reason, including cancelled', () => {
    for (const reason of ['expired_token', 'access_denied', 'cancelled', 'error'] as const) {
      const message = {
        type: 'github_connect_result' as const,
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'failure' as const, reason, message: 'boom' },
      };
      expect(githubConnectResult.parse(message)).toEqual(message);
    }
  });

  it('rejects an unknown failure reason', () => {
    expect(
      githubConnectResult.safeParse({
        type: 'github_connect_result',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'failure', reason: 'not_a_real_reason', message: 'boom' },
      }).success,
    ).toBe(false);
  });

  it('is a plain object (not a nested discriminated union), so it slots into wireMessageV1', () => {
    const account = githubAccount();
    expect(() =>
      wireMessageV1.parse({
        type: 'github_connect_result',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'success', account },
      }),
    ).not.toThrow();
  });
});

describe('jiraConnectRequest / jiraConnectResponse', () => {
  it('parses a valid connect request', () => {
    const message = {
      type: 'jira_connect_request' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      siteUrl: 'myteam.atlassian.net',
      email: 'me@example.com',
      apiToken: 'tok_abc',
    };
    expect(jiraConnectRequest.parse(message)).toEqual(message);
  });

  it('parses a success response and a failure response', () => {
    const account = githubAccount({
      id: 'jira:myteam.atlassian.net:abc-123',
      provider: 'jira',
      host: 'myteam.atlassian.net',
      providerAccountId: 'abc-123',
      credentialSource: 'api_token',
      scopes: null,
      capabilities: ['comments', 'transitions', 'boards', 'sprints'],
      secretRef: 'connected-account-token:jira:myteam.atlassian.net:abc-123',
    });
    expect(
      jiraConnectResponse.parse({
        type: 'jira_connect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'success', account },
      }).result.outcome,
    ).toBe('success');
    expect(
      jiraConnectResponse.parse({
        type: 'jira_connect_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'failure', message: 'bad credentials' },
      }).result,
    ).toEqual({ outcome: 'failure', message: 'bad credentials' });
  });

  it('the request/response schemas have no field shaped like a bare token or secret', () => {
    // The request necessarily carries the operator-typed apiToken (there is
    // no other way to hand it to the node) — that's `apiToken` itself, by
    // design. The RESPONSE must never echo it or any other secret back.
    expect(Object.keys(jiraConnectResponse.shape)).not.toContain('apiToken');
    expect(Object.keys(jiraConnectResponse.shape)).not.toContain('token');
  });
});

describe('connectedAccountDisconnectRequest / connectedAccountDisconnectResponse', () => {
  it('parses a valid request and both outcomes', () => {
    const request = {
      type: 'connected_account_disconnect_request' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      accountId: 'github:github.com:1234567',
    };
    expect(connectedAccountDisconnectRequest.parse(request)).toEqual(request);

    const ok = {
      type: 'connected_account_disconnect_response' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      accountId: 'github:github.com:1234567',
      outcome: 'ok' as const,
    };
    expect(connectedAccountDisconnectResponse.parse(ok)).toEqual(ok);

    const error = { ...ok, outcome: 'error' as const, message: 'no local secret' };
    expect(connectedAccountDisconnectResponse.parse(error)).toEqual(error);
  });
});

describe('accountPinMapV1 / account_pin_get/set/unset requests / accountPinResponse', () => {
  it('parses the tri-state map: absent, null, and a pinned string', () => {
    const map = accountPinMapV1.parse({ github: 'github:github.com:1', jira: null });
    expect(map).toEqual({ github: 'github:github.com:1', jira: null });
    expect('other' in map).toBe(false);
  });

  it('parses get/set/unset requests', () => {
    expect(
      accountPinGetRequest.parse({
        type: 'account_pin_get_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        projectPath: '/home/dev/proj',
      }).projectPath,
    ).toBe('/home/dev/proj');

    expect(
      accountPinSetRequest.parse({
        type: 'account_pin_set_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        projectPath: '/home/dev/proj',
        capability: 'github',
        accountId: null,
      }).accountId,
    ).toBeNull();

    expect(
      accountPinUnsetRequest.parse({
        type: 'account_pin_unset_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        projectPath: '/home/dev/proj',
        capability: 'github',
      }).capability,
    ).toBe('github');
  });

  it('parses the shared response, carrying the resulting pins map', () => {
    const message = {
      type: 'account_pin_response' as const,
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-1',
      nodeId: 'node-1',
      projectPath: '/home/dev/proj',
      pins: { github: 'github:github.com:1', jira: null },
    };
    expect(accountPinResponse.parse(message)).toEqual(message);
  });
});

describe('accountPinResolveRequest / accountPinResolveResponse', () => {
  const account = githubAccount();

  it('parses a valid resolve request in both modes', () => {
    for (const mode of ['read', 'write'] as const) {
      const message = {
        type: 'account_pin_resolve_request' as const,
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        projectPath: '/home/dev/proj',
        capability: 'github',
        mode,
        target: { provider: 'github', host: 'github.com' },
        accounts: [account],
      };
      expect(accountPinResolveRequest.parse(message)).toEqual(message);
    }
  });

  it('parses a resolved outcome, a none outcome, and every named error type', () => {
    expect(
      accountPinResolveResponse.parse({
        type: 'account_pin_resolve_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'resolved', account },
      }).result.outcome,
    ).toBe('resolved');

    expect(
      accountPinResolveResponse.parse({
        type: 'account_pin_resolve_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: { outcome: 'none' },
      }).result,
    ).toEqual({ outcome: 'none' });

    const errorTypes = [
      'AccountPinRequiredError',
      'AccountPinMalformedError',
      'AccountHostMismatchError',
      'AccountPinDanglingError',
      'AmbiguousAccountError',
    ] as const;
    for (const errorType of errorTypes) {
      const message = {
        type: 'account_pin_resolve_response' as const,
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: {
          outcome: 'error' as const,
          errorType,
          message: 'boom',
          capability: 'github',
        },
      };
      expect(accountPinResolveResponse.parse(message).result).toEqual(message.result);
    }
  });

  it('rejects an unknown errorType', () => {
    expect(
      accountPinResolveResponse.safeParse({
        type: 'account_pin_resolve_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        nodeId: 'node-1',
        result: {
          outcome: 'error',
          errorType: 'NotARealError',
          message: 'boom',
          capability: 'github',
        },
      }).success,
    ).toBe(false);
  });
});
