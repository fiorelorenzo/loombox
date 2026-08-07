import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_V1, type GithubCliImportResponse, type WireMessageV1 } from '@loombox/protocol';

import { GithubCliImportService, type GhCommandResult } from './github-cli-import';
import { NodeDaemon } from './node-daemon';

/**
 * `NodeDaemon`'s `github_cli_import_request` wiring (SPEC §7.26, issue
 * #223) — same convention `node-daemon-account-connect.test.ts`'s own top
 * comment establishes for `github_connect_start_request`/
 * `jira_connect_request`: `handleGithubCliImportRequest` calls
 * `GithubCliImportService.import()` with no way to inject a stub
 * `fetchImpl` (a per-call option the service takes, not something
 * `NodeDaemonOptions` exposes), so this file deliberately never drives the
 * network-touching `'imported'` branch through `NodeDaemon` — that's
 * `github-cli-import.test.ts`'s job. What this file proves instead: the
 * request reaches the real service (via an injected `runGh` fixture, the
 * service's own constructor-level seam), the reply comes back on the
 * right `requestId`/`nodeId`, and — since every branch exercised here
 * never imports an account — no `connected_account_announce` ever fires.
 */

const AMK = new Uint8Array(32);
const ACCOUNT_ID = 'acct-cli-import';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-github-cli-import-daemon-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function bareDaemon(runGh: (args: string[]) => Promise<GhCommandResult>): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-cli-import',
    deviceId: 'device-cli-import',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    githubCliImportService: new GithubCliImportService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      runGh,
    }),
  });
}

/** This suite's only seam into the daemon's private wire dispatch/relay send — TS `private` is compile-time only (mirrors `node-daemon-ci-auto-iterate.test.ts`'s identical `DaemonInternals` convention). */
interface DaemonInternals {
  handleInbound(message: unknown): void;
  relay: { send(message: WireMessageV1): void };
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

function isGithubCliImportResponse(m: WireMessageV1): m is GithubCliImportResponse {
  return m.type === 'github_cli_import_response';
}

describe('github_cli_import_request (SPEC §7.26, issue #223)', () => {
  it('routes to GithubCliImportService.import() and replies with the right requestId/nodeId — gh_not_logged_in failure, no accounts to announce', async () => {
    const node = bareDaemon(async () => ({
      stdout: JSON.stringify({ hosts: {} }),
      stderr: '',
      exitCode: 0,
    }));
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    internals(node).handleInbound({
      type: 'github_cli_import_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-cli-import-1',
      nodeId: 'node-cli-import',
    });
    await vi.waitFor(() => {
      expect(sendSpy.mock.calls.some((call) => isGithubCliImportResponse(call[0]))).toBe(true);
    });

    const response = sendSpy.mock.calls.map((call) => call[0]).find(isGithubCliImportResponse);
    expect(response).toMatchObject({
      requestId: 'req-cli-import-1',
      nodeId: 'node-cli-import',
      result: { outcome: 'failure', reason: 'gh_not_logged_in' },
    });
    expect(sendSpy.mock.calls.some((call) => call[0].type === 'connected_account_announce')).toBe(
      false,
    );
  });

  it('a per-entry gh-reported auth error surfaces on the response without ever announcing an account', async () => {
    const node = bareDaemon(async (args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return {
          stdout: JSON.stringify({
            hosts: {
              'github.com': [
                {
                  state: 'error',
                  active: true,
                  host: 'github.com',
                  login: 'broken-account',
                  error: 'token revoked',
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected gh invocation in this test: ${args.join(' ')}`);
    });
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    internals(node).handleInbound({
      type: 'github_cli_import_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-cli-import-2',
      nodeId: 'node-cli-import',
    });
    await vi.waitFor(() => {
      expect(sendSpy.mock.calls.some((call) => isGithubCliImportResponse(call[0]))).toBe(true);
    });

    const response = sendSpy.mock.calls.map((call) => call[0]).find(isGithubCliImportResponse);
    expect(response?.result).toMatchObject({
      outcome: 'success',
      entries: [{ outcome: 'error', host: 'github.com', login: 'broken-account' }],
    });
    expect(sendSpy.mock.calls.some((call) => call[0].type === 'connected_account_announce')).toBe(
      false,
    );
  });

  it('a spawn failure (gh not on PATH) surfaces as a named failure reason, never an unhandled rejection', async () => {
    const node = bareDaemon(async () => {
      const error = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    const sendSpy = vi.spyOn(internals(node).relay, 'send');

    internals(node).handleInbound({
      type: 'github_cli_import_request',
      protocolVersion: PROTOCOL_V1,
      requestId: 'req-cli-import-3',
      nodeId: 'node-cli-import',
    });
    await vi.waitFor(() => {
      expect(sendSpy.mock.calls.some((call) => isGithubCliImportResponse(call[0]))).toBe(true);
    });

    const response = sendSpy.mock.calls.map((call) => call[0]).find(isGithubCliImportResponse);
    expect(response?.result).toMatchObject({ outcome: 'failure', reason: 'gh_not_found' });
  });
});
