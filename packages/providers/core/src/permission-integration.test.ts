import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
import type { PendingPermissionRequest } from './permission-queue';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'permission-acp-agent.mjs',
);

let activeClient: AcpClient | undefined;

function makeClient(): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH] });
  activeClient = client;
  return client;
}

afterEach(() => {
  activeClient?.close();
  activeClient = undefined;
});

describe('AcpClient <-> real agent session/request_permission round trip (issue #178)', () => {
  it('enqueues the incoming request with its raw toolCall/options, then replies once resolved', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-permission-test');

    const seen: PendingPermissionRequest[] = [];
    client.on('permission_request', (request: PendingPermissionRequest) => seen.push(request));

    const promptPromise = client.prompt(sessionId, 'request-permission');

    await waitUntil(() => seen.length === 1);
    const request = seen[0]!;
    expect(request.sessionId).toBe(sessionId);
    expect(request.toolCall).toMatchObject({ id: 'tc1', title: 'Edit file', toolKind: 'edit' });
    expect(request.options).toEqual([
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]);
    expect(client.permissions.isActionable(request.requestId)).toBe(true);

    const updates: unknown[] = [];
    client.on('update', (update: unknown) => updates.push(update));

    client.permissions.resolve(request.requestId, { outcome: 'selected', optionId: 'allow' });

    await promptPromise;

    // The fixture echoes back what it received as the chosen outcome, proving the
    // response actually reached the agent over the wire (not just resolved locally).
    expect(updates.at(-1)).toMatchObject({ text: 'chose:allow' });
    expect(client.permissions.list(sessionId)).toEqual([]);
  });

  it('a stale resolve against an already-resolved request id is reported, not silently accepted', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-permission-test');

    const seen: PendingPermissionRequest[] = [];
    client.on('permission_request', (request: PendingPermissionRequest) => seen.push(request));
    const promptPromise = client.prompt(sessionId, 'request-permission');
    await waitUntil(() => seen.length === 1);

    const first = client.permissions.resolve(seen[0]!.requestId, {
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(first.status).toBe('resolved');

    const second = client.permissions.resolve(seen[0]!.requestId, {
      outcome: 'selected',
      optionId: 'deny',
    });
    expect(second).toEqual({ status: 'stale', requestId: seen[0]!.requestId });

    await promptPromise;
  });

  it('two requests from the same turn queue FIFO; resolving one leaves the other queued and actionable only after', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-permission-test');

    const seen: PendingPermissionRequest[] = [];
    client.on('permission_request', (request: PendingPermissionRequest) => seen.push(request));

    const promptPromise = client.prompt(sessionId, 'request-permission-multi');
    await waitUntil(() => seen.length === 2);

    const [first, second] = seen as [PendingPermissionRequest, PendingPermissionRequest];
    expect(client.permissions.list(sessionId).map((r) => r.requestId)).toEqual([
      first.requestId,
      second.requestId,
    ]);
    expect(client.permissions.isActionable(first.requestId)).toBe(true);
    expect(client.permissions.isActionable(second.requestId)).toBe(false);

    // Deny the first: the second sibling stays queued, unresolved, in order.
    client.permissions.resolve(first.requestId, { outcome: 'selected', optionId: 'deny' });
    expect(client.permissions.list(sessionId).map((r) => r.requestId)).toEqual([second.requestId]);
    expect(client.permissions.isActionable(second.requestId)).toBe(true);

    client.permissions.resolve(second.requestId, { outcome: 'selected', optionId: 'allow' });
    await promptPromise;

    expect(client.permissions.list(sessionId)).toEqual([]);
  });
});

/** Polls a synchronous condition until it's true (or times out), for waiting on the async fixture round trip. */
function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitUntil: timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}
