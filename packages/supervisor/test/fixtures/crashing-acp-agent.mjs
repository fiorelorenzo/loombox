#!/usr/bin/env node
// Minimal ACP-speaking fixture agent used only by packages/supervisor's
// hermetic tests (SPEC.md §16 grounds the wire shapes in the real ACP v1
// baseline: JSON-RPC 2.0 over newline-delimited JSON on stdio). It replies to
// `initialize` and `session/new` like a real agent, then exits unexpectedly
// (`process.exit(1)`) shortly after the session is established, simulating a
// child process that crashes mid-session rather than one that is closed
// deliberately by its owner. This is what proves AgentSupervisor surfaces a
// single terminal event instead of hanging when that happens.
//
// Plain Node ESM (no TypeScript, no deps) because it is spawned directly as
// a child process, not imported.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
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
        agentInfo: { name: 'crashing-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_crash_1' } });
    // Crash shortly after the session is established: an unexpected exit
    // mid-session, not the result of the client calling close().
    setTimeout(() => process.exit(1), 20);
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32601,
      message: `crashing-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
