#!/usr/bin/env node
// Minimal ACP-speaking fixture agent used by the hermetic tests across
// packages/providers/core, packages/providers/claude, packages/providers/
// codex and packages/node (SPEC.md §16 grounds the wire shapes below in the
// real ACP v1 baseline: JSON-RPC 2.0 over newline-delimited JSON on stdio).
// It is NOT a real agent: it replies to `initialize` and `session/new`, and
// on `session/prompt` streams two `agent_message_chunk` `session/update`
// notifications (same messageId) for "Hello" then " world" — each after a
// real `CHUNK_DELAY_MS` gap, not synchronously in the same tick — then one
// `usage_update` notification (real ACP field names — `used`/`size`/`cost`,
// issue #248), replies with `stopReason: "end_turn"`, and then stays alive
// listening for more requests, exactly like a real long-lived ACP agent
// process would.
//
// The delay (issue #660) is deliberate: every test in this repo that spawns
// this fixture used to get its whole reply delivered synchronously, zero
// delay, in one microtask — which is exactly the shape that let a
// hypothetical "batch and flush on turn end" regression pass every existing
// "streaming" test undetected. A real ACP agent never delivers two chunks
// in the same tick; this fixture doesn't either, now. `streaming-acp-agent
// .mjs` (this same directory) is the sibling fixture for a test that
// specifically needs many chunks over a longer, more realistic spread
// (thinking included) — this one stays a minimal two-chunk "Hello world"
// so the dozens of tests using it for unrelated coverage (permission
// policy, ssh, mcp resolution, ...) keep their existing exact-content
// assertions, only losing the zero-delay shortcut.
//
// Plain Node ESM (no TypeScript, no deps) because it is spawned directly as
// a child process by AcpClient, not imported.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHUNK_DELAY_MS = Number(process.env.LOOMBOX_TEST_CHUNK_DELAY_MS ?? 20);

let sessionCounter = 0;

rl.on('line', async (line) => {
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
    await sleep(CHUNK_DELAY_MS);
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
    await sleep(CHUNK_DELAY_MS);
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
    // Real ACP wire shape (issue #248): `used`/`size`/`cost.amount`, NOT
    // `tokensUsed`/`contextWindow`/`costUsd` — see client.ts's
    // `RawSessionUpdate`/`mapToTranscriptUpdate` for the field names this
    // guards against silently regressing back to.
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 1234,
          size: 200000,
          cost: { amount: 0.05, currency: 'USD' },
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
