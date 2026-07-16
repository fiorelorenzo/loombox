#!/usr/bin/env node
// Minimal ACP-speaking fixture agent used only by the hermetic tests in
// packages/providers/core and packages/providers/claude (SPEC.md §16 grounds
// the wire shapes below in the real ACP v1 baseline: JSON-RPC 2.0 over
// newline-delimited JSON on stdio). It is NOT a real agent: it replies to
// `initialize` and `session/new`, and on `session/prompt` streams two
// `agent_message_chunk` `session/update` notifications (same messageId) for
// "Hello" then " world", replies with `stopReason: "end_turn"`, and then
// stays alive listening for more requests, exactly like a real long-lived
// ACP agent process would.
//
// Plain Node ESM (no TypeScript, no deps) because it is spawned directly as
// a child process by AcpClient, not imported.

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
        agentInfo: { name: 'echo-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess_test_${sessionCounter}` } });
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

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32601,
      message: `echo-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
