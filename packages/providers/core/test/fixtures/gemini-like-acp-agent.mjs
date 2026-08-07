#!/usr/bin/env node
// Fixture ACP agent shaped like Gemini CLI's real ACP handshake (issue #843;
// docs/research/gemini-acp-completeness.md's live probe against the real,
// published `npx -y @google/gemini-cli@0.54.0 --acp`, recorded byte-for-byte
// in packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json).
// Not a real agent.
//
// The `initialize` response's `agentCapabilities` below is the exact real
// shape that recording captured: `loadSession: true`, `promptCapabilities`/
// `mcpCapabilities` both fully on, and — the actual gap this fixture exists
// to exercise — NO `sessionCapabilities` key at all. `session/resume`/
// `session/list`/`session/close`/`session/delete` are therefore left
// unimplemented here too, on purpose: they fall through to the same
// `-32601 "Method not found"` catch-all every genuinely-unimplemented
// method gets, matching the real binary's own live-verified behavior
// exactly (the gemini-acp-completeness spike's whole point: those four
// return the identical JSON-RPC code as a deliberately bogus method name).
//
// `session/load` (real ACP v1's older, still-live method, gated by the
// `loadSession` flag — not `session/resume`, gated by the separate, absent
// `sessionCapabilities.resume`) IS implemented: it streams the same kind of
// small, deliberately-gapped history `resumable-acp-agent.mjs` uses back as
// ordinary `session/update` notifications before responding, proving a
// client's fallback resume path is a genuinely working session, not just an
// RPC that happens to succeed. Its response carries no `sessionId` (real
// ACP v1's `LoadSessionResponse` never has one — only optional
// `configOptions`/`modes`), matching `agentclientprotocol.com/protocol/v1/
// schema`.
//
// `session/prompt` behaves like echo-acp-agent (two agent_message_chunk
// notifications then stopReason "end_turn") so a live turn after a
// session/load-resumed session proves the resumed session is actually
// usable, not just resumable.
//
// Plain Node ESM (no TypeScript, no deps): spawned directly as a child
// process, not imported.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let sessionCounter = 0;

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

  if (msg.id === undefined) return; // a notification sent to us (e.g. session/cancel): accept and ignore

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        // Byte-shaped after the real, live-recorded response
        // (gemini-acp-live-probe.json's `initializeResult.agentCapabilities`):
        // loadSession true, no sessionCapabilities key whatsoever.
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'gemini-like-acp-agent', title: 'Gemini CLI', version: '0.54.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess_gemini_${sessionCounter}` } });
    return;
  }

  if (msg.method === 'session/load') {
    const sessionId = msg.params?.sessionId;

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'before-gap ' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          title: 'Search',
          kind: 'search',
          status: 'completed',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'after-gap' },
        },
      },
    });

    // Real LoadSessionResponse never carries sessionId back (only optional
    // configOptions/modes) -- this fixture sends neither, same as the real
    // recorded probe never observed a successful session/load response.
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const messageId = 'msg_agent_1';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: 'Hello' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: ' world' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  // session/resume, session/list, session/close, session/delete, and
  // anything else: genuinely unimplemented, same -32601 code the real
  // gemini-cli binary returns for these exact methods (live-verified,
  // docs/research/gemini-acp-completeness.md).
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32601,
      message: `"Method not found": ${String(msg.method)}`,
    },
  });
});
