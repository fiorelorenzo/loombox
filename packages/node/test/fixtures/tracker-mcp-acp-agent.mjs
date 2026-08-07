#!/usr/bin/env node
// Fixture ACP agent for issue #627's node-daemon integration coverage
// (node-daemon-tracker-mcp.test.ts). Unlike packages/providers/core's own
// mcp-acp-agent.mjs (which only ECHOES the `mcpServers` array `session/new`
// carried, proving config delivery), this fixture is a genuine MCP CLIENT:
// prompted with `tracker-tool-call:<jsonRpcParams>`, it finds the
// `loombox-tracker` entry in the `mcpServers` this session actually
// received, opens a REAL @modelcontextprotocol/sdk Client over
// StreamableHTTPClientTransport against it, calls `tools/call` for real,
// and echoes the raw CallToolResult back — proving a connected agent can
// really reach and use the tools TrackerMcpHost serves, not just that the
// server config reached the agent. `tracker-tool-list` does the same for
// `tools/list`.
//
// Needs @modelcontextprotocol/sdk (a real @loombox/node dependency, issue
// #627) — unlike most fixtures in this repo, this one is NOT dependency-free
// on purpose: proving real MCP wire interop is the whole point.

import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let sessionCounter = 0;
/** @type {Map<string, unknown[]>} */
const mcpServersBySession = new Map();

/** @param {unknown[]} mcpServers */
function trackerServerUrl(mcpServers) {
  const entry = mcpServers.find(
    (server) => typeof server === 'object' && server !== null && server.name === 'loombox-tracker',
  );
  if (!entry || entry.type !== 'http') return undefined;
  return entry.url;
}

/** @param {string} url */
async function callTrackerTool(url, name, args) {
  const client = new Client({ name: 'tracker-fixture-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** @param {string} url */
async function listTrackerTools(url) {
  const client = new Client({ name: 'tracker-fixture-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await client.listTools();
  } finally {
    await client.close();
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.id === undefined) return; // ignore notifications sent to us, if any

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: 'tracker-mcp-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    const sessionId = `sess_tracker_mcp_${sessionCounter}`;
    mcpServersBySession.set(sessionId, msg.params?.mcpServers ?? []);
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text ?? '';
    const mcpServers = mcpServersBySession.get(sessionId) ?? [];
    process.stderr.write(`DEBUG mcpServers: ${JSON.stringify(mcpServers)}\n`);
    const url = trackerServerUrl(mcpServers);
    process.stderr.write(`DEBUG resolved url: ${url}\n`);

    const sendChunk = (payload) => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_tracker_tool',
            content: { type: 'text', text: JSON.stringify(payload) },
          },
        },
      });
    };

    if (text === 'tracker-tool-list') {
      (url
        ? listTrackerTools(url)
        : Promise.resolve({ error: 'no loombox-tracker server in mcpServers' })
      )
        .then((result) => sendChunk(result))
        .catch((error) => {
          process.stderr.write(`DEBUG list error: ${error?.stack ?? error}\n`);
          sendChunk({ error: String(error?.message ?? error) });
        })
        .finally(() => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
      return;
    }

    const callMatch = /^tracker-tool-call:(.+)$/s.exec(text);
    if (callMatch) {
      const { name, arguments: args } = JSON.parse(callMatch[1]);
      (url
        ? callTrackerTool(url, name, args)
        : Promise.resolve({ error: 'no loombox-tracker server in mcpServers' })
      )
        .then((result) => sendChunk(result))
        .catch((error) => {
          process.stderr.write(`DEBUG call error: ${error?.stack ?? error}\n`);
          sendChunk({ error: String(error?.message ?? error) });
        })
        .finally(() => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
      return;
    }

    sendChunk({ error: `unrecognized prompt: ${text}` });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32601,
      message: `tracker-mcp-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
