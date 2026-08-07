#!/usr/bin/env node
// Fixture ACP agent for the session-lifecycle tests (issue #176; SPEC.md
// §5.5 "session/new/session/resume + replay ... session/list, and
// cancellation"; §7.24 "The same reducer runs identically for a live
// stream and for replayed history on reconnect"). Not a real agent.
//
// `session/prompt` behaves like echo-acp-agent (two agent_message_chunk
// notifications then stopReason "end_turn") so a normal live turn still
// works on this fixture. `session/resume` is the interesting bit: it
// streams a small, deliberately-gapped history back as ordinary
// `session/update` notifications *before* responding — modeling how a real
// ACP agent's resume/loadSession replays a session's past over the exact
// same wire mechanism a live turn uses, rather than some separate "replay"
// RPC shape. The "gap" is the two `agent_message_chunk` notifications
// sharing one `messageId` with a `tool_call` notification sent in between:
// a resuming client must coalesce the two chunks into one item and must
// not duplicate or drop the tool call.
//
// `agentCapabilities.sessionCapabilities.resume`/`.list` are set because
// this fixture genuinely implements `session/resume`/`session/list` below
// (issue #843: `AcpClient.resumeSession` now branches on the real
// `sessionCapabilities.resume` field to decide whether to call
// `session/resume` at all vs. fall back to `session/load` — a fixture that
// claims only the older `loadSession` flag while actually answering
// `session/resume` would make that branch untestable here). No
// `loadSession` flag: this fixture doesn't implement `session/load`, so
// claiming it would be exactly the dishonest-capability-reporting bug
// issue #843 exists to fix. `session/list` returns a small canned roster.
// `session/cancel` (a notification, no response expected) is accepted and
// ignored.
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
        agentCapabilities: { sessionCapabilities: { resume: {}, list: {} } },
        agentInfo: { name: 'resumable-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess_resume_${sessionCounter}` } });
    return;
  }

  if (msg.method === 'session/resume') {
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

    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    return;
  }

  if (msg.method === 'session/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessions: [
          { sessionId: 'sess_list_1', cwd: '/tmp/loombox-a', title: 'Alpha' },
          { sessionId: 'sess_list_2', cwd: '/tmp/loombox-b' },
        ],
      },
    });
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
      message: `resumable-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
