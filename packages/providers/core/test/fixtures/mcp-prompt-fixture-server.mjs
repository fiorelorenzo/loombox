#!/usr/bin/env node
// Fixture MCP stdio server for issue #754 (D5-2)'s `mcp-prompt-client.ts`
// unit tests — a small, deterministic stand-in for a real prompt-declaring
// server so `fetchMcpServerPrompts`/`fetchMcpPromptText` can be exercised
// without a network/npx dependency in every CI run (the real
// `@modelcontextprotocol/server-everything` server backs a separate,
// `skipIf`-gated describe block in `mcp-prompt-client.test.ts` for actual
// real-server verification).
//
// Responds to `initialize`/`notifications/initialized`, then:
// - `prompts/list`: `[]` if `MCP_FIXTURE_NO_PROMPTS=1` is set (the "server
//   with no prompts" case); otherwise two prompts — `greet` (no
//   arguments) and `translate` (one required argument `text`, one
//   optional `tone`).
// - `prompts/get`: `greet` always renders a static message; `translate`
//   renders using its arguments and rejects (a real JSON-RPC error, MCP's
//   own `-32602 Invalid params` code) if `text` is missing — the same
//   "a missing required argument is the server's own rejection" shape
//   `@modelcontextprotocol/server-everything`'s real `args-prompt` uses
//   (verified directly against it, see this issue's PR).
//
// Plain Node ESM (no TypeScript, no deps): spawned directly as a child
// process, matching `mcp-failing-acp-agent.mjs`'s own convention.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const NO_PROMPTS = process.env.MCP_FIXTURE_NO_PROMPTS === '1';

const PROMPTS = NO_PROMPTS
  ? []
  : [
      { name: 'greet', description: 'A static greeting, no arguments' },
      {
        name: 'translate',
        description: 'Translate text into another tone/language',
        arguments: [
          { name: 'text', description: 'The text to translate', required: true },
          { name: 'tone', description: 'Optional target tone', required: false },
        ],
      },
    ];

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
  if (msg.id === undefined) return; // notification — no reply

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { prompts: {} },
        serverInfo: { name: 'mcp-prompt-fixture', version: '0.0.1' },
      },
    });
    return;
  }

  if (msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: PROMPTS } });
    return;
  }

  if (msg.method === 'prompts/get') {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === 'greet') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { messages: [{ role: 'user', content: { type: 'text', text: 'Hello there!' } }] },
      });
      return;
    }
    if (name === 'translate') {
      if (!args.text) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'Invalid params: missing required argument "text"' },
        });
        return;
      }
      const tone = args.tone ? ` in a ${args.tone} tone` : '';
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          messages: [
            { role: 'user', content: { type: 'text', text: `Translate "${args.text}"${tone}.` } },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32602, message: `Unknown prompt "${name}"` },
    });
    return;
  }

  // Any other request (e.g. a real server's `tools/list`) — plain empty
  // success, matching `mcp-failing-acp-agent.mjs`'s own fallback.
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
