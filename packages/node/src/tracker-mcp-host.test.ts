import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { NativeTrackerStore } from './native-tracker-store';
import {
  TrackerMcpHost,
  TRACKER_MCP_SERVER_NAME,
  type TrackerWritePermissionResult,
} from './tracker-mcp-host';

/**
 * Proves the real MCP wire protocol, not just `createTrackerMcpTools`'s own
 * `execute()` seam (that's `tracker-mcp-tools.test.ts`'s job): a genuine
 * `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`
 * — the exact client-side machinery a real ACP agent's own MCP connection
 * uses — talks real HTTP to `TrackerMcpHost`'s loopback listener and gets
 * real `tools/list`/`tools/call` results back. `node-daemon-tracker-mcp.
 * test.ts` covers the `NodeDaemon` wiring (which projects get the server at
 * all, the live permission-queue gate); this file is the host in isolation.
 */

const PROJECT_A = '/home/dev/projects/loombox-demo';

let stateDir: string;
let store: NativeTrackerStore;
let host: TrackerMcpHost;
const clients: Client[] = [];

function allowAllPermission(): Promise<TrackerWritePermissionResult> {
  return Promise.resolve({ allowed: true });
}

async function connectClient(config: { url: string }): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(config.url));
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-tracker-mcp-host-test-'));
  store = new NativeTrackerStore({ stateDir });
  host = new TrackerMcpHost();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await host.close();
  await rm(stateDir, { recursive: true, force: true });
});

describe('TrackerMcpHost.register', () => {
  it('returns an http AcpMcpServerConfig naming this server, bound to loopback', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    expect(config).toMatchObject({ name: TRACKER_MCP_SERVER_NAME, type: 'http', headers: [] });
    if (config.type !== 'http') throw new Error('expected an http config');
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/tracker\/[\w-]+$/);
  });

  it('starts the loopback listener lazily — not listening until the first register() call', async () => {
    expect(host.isListening).toBe(false);
    await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    expect(host.isListening).toBe(true);
  });
});

describe('a real MCP client over the real wire protocol', () => {
  it('tools/list returns exactly the five tracker_* tools, each with a real JSON Schema input', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'tracker_list',
      'tracker_get',
      'tracker_create',
      'tracker_update',
      'tracker_link_session',
    ]);
    const createTool = tools.find((tool) => tool.name === 'tracker_create');
    expect(createTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { primaryType: { type: 'string' }, fields: expect.any(Object) },
      required: ['primaryType', 'fields'],
      additionalProperties: false,
    });
  });

  it('tools/call tracker_list returns a real, empty result against a brand-new project — no permission prompt needed for a read', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: () => {
        throw new Error('requestWritePermission must never be called for a read');
      },
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    const result = await client.callTool({ name: 'tracker_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(JSON.parse(text ?? '{}')).toEqual({ records: [] });
  });

  it('tools/call tracker_create is gated: an approved write actually lands in NativeTrackerStore and comes back as a real record', async () => {
    let calledWith: { toolName: string; rawInput: unknown } | undefined;
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'agent-author',
      sessionId: 'session-1',
      requestWritePermission: (toolName, rawInput) => {
        calledWith = { toolName, rawInput };
        return Promise.resolve({ allowed: true });
      },
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    const result = await client.callTool({
      name: 'tracker_create',
      arguments: { primaryType: 'task', fields: { title: 'Ship it' } },
    });

    expect(calledWith).toEqual({
      toolName: 'tracker_create',
      rawInput: { primaryType: 'task', fields: { title: 'Ship it' } },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '{}';
    const { record } = JSON.parse(text) as { record: { id: string; system: { authorId: string } } };
    expect(record.system.authorId).toBe('agent-author');
    expect(store.get(PROJECT_A, record.id)?.fields).toEqual({ title: 'Ship it' });
  });

  it('tools/call tracker_create refused by requestWritePermission never reaches the store, and returns isError with the given reason', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'agent-author',
      sessionId: 'session-1',
      requestWritePermission: () =>
        Promise.resolve({ allowed: false, reason: 'blocked by profile "Reviewer"' }),
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    const result = await client.callTool({
      name: 'tracker_create',
      arguments: { primaryType: 'task', fields: { title: 'Should not be created' } },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('blocked by profile "Reviewer"');
    expect(store.list(PROJECT_A)).toEqual([]);
  });

  it('tools/call tracker_update and tracker_link_session are also gated (the full write set, not just create)', async () => {
    const record = store.create(PROJECT_A, {
      primaryType: 'task',
      fields: { title: 'Existing' },
      authorId: 'human',
    });
    const gatedToolNames: string[] = [];
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'agent-author',
      sessionId: 'session-1',
      requestWritePermission: (toolName) => {
        gatedToolNames.push(toolName);
        return Promise.resolve({ allowed: true });
      },
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    await client.callTool({
      name: 'tracker_update',
      arguments: { id: record.id, fields: { title: 'Updated' } },
    });
    await client.callTool({ name: 'tracker_link_session', arguments: { id: record.id } });

    expect(gatedToolNames).toEqual(['tracker_update', 'tracker_link_session']);
    expect(store.get(PROJECT_A, record.id)?.fields).toEqual({ title: 'Updated' });
    expect(store.get(PROJECT_A, record.id)?.system.linkedSessionIds).toEqual(['session-1']);
  });

  it('a malformed tool call (fails the tool\u2019s own zod schema) surfaces as isError, never an uncaught exception', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');
    const client = await connectClient(config);

    const result = await client.callTool({ name: 'tracker_get', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/exactly one of "id" or "issueNumber"/);
  });
});

describe('register/unregister lifecycle', () => {
  it('two sessions get two independent, differently-tokened endpoints on the same shared listener', async () => {
    const configA = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-a',
      requestWritePermission: allowAllPermission,
    });
    const configB = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-b',
      requestWritePermission: allowAllPermission,
    });
    if (configA.type !== 'http' || configB.type !== 'http')
      throw new Error('expected http configs');
    expect(configA.url).not.toBe(configB.url);
    expect(new URL(configA.url).port).toBe(new URL(configB.url).port);
  });

  it('unregister makes the session\u2019s endpoint answer 404, and is a safe no-op the second time', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');

    host.unregister('session-1');
    expect(() => host.unregister('session-1')).not.toThrow();

    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('an unknown token gets 404, never a crash or a leaked session', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');

    const unknownTokenUrl = config.url.replace(/\/tracker\/.+$/, '/tracker/not-a-real-token');
    const response = await fetch(unknownTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('a second, independent MCP client connecting fresh to the same still-registered endpoint succeeds — nothing in the MCP spec (or a real agent\u2019s own client library) guarantees one connection lives for a whole Loombox session, and the SDK\u2019s StreamableHTTPServerTransport is a single-MCP-session object, so this host must open a fresh one per connection rather than reuse a single fixed transport for the token\u2019s whole lifetime (regression: a prior version of this host failed a second connection with "Server already initialized")', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');

    const first = await connectClient(config);
    const firstResult = await first.listTools();
    expect(firstResult.tools.map((tool) => tool.name)).toContain('tracker_list');
    await first.close();

    // A brand-new Client + transport — no Mcp-Session-Id carried over —
    // against the exact same URL the first one used.
    const second = await connectClient(config);
    const secondResult = await second.listTools();
    expect(secondResult.tools.map((tool) => tool.name)).toContain('tracker_list');
  });

  it('two live, concurrently-open MCP connections against the same token both work independently, and unregister tears both down', async () => {
    const config = await host.register({
      store,
      projectPath: PROJECT_A,
      authorId: 'author-1',
      sessionId: 'session-1',
      requestWritePermission: allowAllPermission,
    });
    if (config.type !== 'http') throw new Error('expected an http config');

    const clientA = await connectClient(config);
    const clientB = await connectClient(config);

    const [resultA, resultB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    expect(resultA.tools.map((tool) => tool.name)).toContain('tracker_list');
    expect(resultB.tools.map((tool) => tool.name)).toContain('tracker_list');

    host.unregister('session-1');
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });
});
