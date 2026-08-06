#!/usr/bin/env node
// Fixture ACP agent for issue #750 (D2-2): simulates a real agent's own MCP
// client rejecting `session/new` when one of the declared servers can't
// start — the exact shape verified against a real `omp acp` binary
// (`AcpClient: Internal error (code -32603): <name>: <detail>`, the error's
// `data.details` carrying `"<name>: <detail>"`), so `node-daemon.ts`'s
// `attributeMcpFailure` can be exercised deterministically without a real
// subprocess/network dependency.
//
// On `session/new`, checks `mcpServers` in order for the first entry named
// exactly `bad-binary` or `bad-handshake` and rejects on it (mirrors a real
// agent connecting to declared servers one at a time and failing fast on
// the first bad one); accepts otherwise, and — like mcp-acp-agent.mjs —
// echoes the received `mcpServers` back on the literal prompt
// "echo-mcp-servers", so a test can assert exactly which servers actually
// reached the agent once the fallback loop settles.
//
// Plain Node ESM (no TypeScript, no deps): spawned directly as a child
// process, not imported.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const FAILURE_DETAIL = {
  'bad-binary': 'Executable not found in $PATH: "this-binary-does-not-exist"',
  'bad-handshake': 'MCP error -32601: Unsupported server request: initialize',
};

let sessionCounter = 0;
/** @type {Map<string, unknown>} */
const mcpServersBySession = new Map();

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
        agentInfo: { name: 'mcp-failing-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    const servers = msg.params?.mcpServers ?? [];
    const bad = servers.find((server) => server.name in FAILURE_DETAIL);
    if (bad) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: { details: `${bad.name}: ${FAILURE_DETAIL[bad.name]}` },
        },
      });
      return;
    }
    sessionCounter += 1;
    const sessionId = `sess_mcp_fail_${sessionCounter}`;
    mcpServersBySession.set(sessionId, servers);
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text ?? '';
    const servers = mcpServersBySession.get(sessionId) ?? [];
    if (text === 'echo-mcp-servers') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_mcp_fail_echo',
            content: { type: 'text', text: JSON.stringify(servers) },
          },
        },
      });
    } else {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_mcp_fail_1',
            content: { type: 'text', text: 'Hello world' },
          },
        },
      });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
