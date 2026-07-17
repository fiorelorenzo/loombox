import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, McpServerSecretMissingError } from './client';
import type { AcpMcpServerConfig, AcpUpdate } from './types';

// Issue #190: proves the configured MCP server set passed to
// `AcpClient.newSession` actually rides the outgoing ACP `session/new` call
// (asserted via the mcp-acp-agent.mjs fixture echoing back what it received,
// not by inspecting AcpClient's private stdin traffic), that a server
// declaring an unresolved required secret fails session creation up front
// with a clear, actionable error rather than starting silently without it,
// and that two sessions on the same client with different MCP server sets
// don't affect each other.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'mcp-acp-agent.mjs',
);

let workDir: string | undefined;
let activeClient: AcpClient | undefined;

afterEach(async () => {
  activeClient?.close();
  activeClient = undefined;
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

async function spawnClient(): Promise<AcpClient> {
  workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-core-mcp-'));
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
  activeClient = client;
  await client.initialize();
  return client;
}

async function echoMcpServers(client: AcpClient, sessionId: string): Promise<unknown> {
  const updates: AcpUpdate[] = [];
  const handler = (update: AcpUpdate) => updates.push(update);
  client.on('update', handler);
  await client.prompt(sessionId, 'echo-mcp-servers');
  client.off('update', handler);
  return JSON.parse(updates.at(-1)?.text ?? '[]');
}

describe('AcpClient MCP server configuration (issue #190)', () => {
  it('passes a configured stdio MCP server into session/new', async () => {
    const client = await spawnClient();
    const mcpServers: AcpMcpServerConfig[] = [
      {
        name: 'filesystem',
        command: '/usr/bin/mcp-filesystem',
        args: ['--root', '/tmp'],
        env: [{ name: 'MCP_LOG_LEVEL', value: 'info' }],
      },
    ];

    const sessionId = await client.newSession(workDir!, { mcpServers });
    const echoed = await echoMcpServers(client, sessionId);

    expect(echoed).toEqual(mcpServers);
  });

  it('defaults to an empty MCP server list when none is configured', async () => {
    const client = await spawnClient();
    const sessionId = await client.newSession(workDir!);
    const echoed = await echoMcpServers(client, sessionId);
    expect(echoed).toEqual([]);
  });

  it('passes http and sse MCP server configs through unchanged', async () => {
    const client = await spawnClient();
    const mcpServers: AcpMcpServerConfig[] = [
      { type: 'http', name: 'tracker', url: 'https://tracker.example/mcp', headers: [] },
      { type: 'sse', name: 'events', url: 'https://events.example/mcp' },
    ];

    const sessionId = await client.newSession(workDir!, { mcpServers });
    const echoed = await echoMcpServers(client, sessionId);

    expect(echoed).toEqual(mcpServers);
  });

  it('fails session creation with a clear error when a required secret has no grant yet', async () => {
    const client = await spawnClient();
    const mcpServers: AcpMcpServerConfig[] = [
      {
        name: 'github',
        command: '/usr/bin/mcp-github',
        args: [],
        env: [{ name: 'GITHUB_TOKEN', value: undefined }],
      },
    ];

    await expect(client.newSession(workDir!, { mcpServers })).rejects.toThrow(
      McpServerSecretMissingError,
    );
    await expect(client.newSession(workDir!, { mcpServers })).rejects.toThrow(
      /"github".*"GITHUB_TOKEN"/,
    );

    // No session was actually created for either rejected attempt: the very
    // next successful newSession still gets the fixture's first sessionId.
    const sessionId = await client.newSession(workDir!);
    expect(sessionId).toBe('sess_mcp_1');
  });

  it('fails session creation when an http/sse server header has no grant yet', async () => {
    const client = await spawnClient();
    const mcpServers: AcpMcpServerConfig[] = [
      {
        type: 'http',
        name: 'tracker',
        url: 'https://tracker.example/mcp',
        headers: [{ name: 'Authorization', value: undefined }],
      },
    ];

    await expect(client.newSession(workDir!, { mcpServers })).rejects.toThrow(
      McpServerSecretMissingError,
    );
  });

  it('disabling/changing a server on one session does not affect another already-open session', async () => {
    const client = await spawnClient();

    const sessionA = await client.newSession(workDir!, {
      mcpServers: [{ name: 'server-a', command: '/bin/a', args: [] }],
    });
    const sessionB = await client.newSession(workDir!, {
      mcpServers: [{ name: 'server-b', command: '/bin/b', args: [] }],
    });

    const echoedA = await echoMcpServers(client, sessionA);
    const echoedB = await echoMcpServers(client, sessionB);

    expect(echoedA).toEqual([{ name: 'server-a', command: '/bin/a', args: [] }]);
    expect(echoedB).toEqual([{ name: 'server-b', command: '/bin/b', args: [] }]);
  });
});
