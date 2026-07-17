#!/usr/bin/env node
// Fixture ACP agent for the session/request_permission FIFO queue tests
// (issue #178; SPEC.md §7.24 "Tool-call permissions"). Not a real agent.
//
// On `session/prompt`:
//  - text "request-permission" sends ONE agent -> client
//    `session/request_permission` request and awaits the client's response
//    before finishing the turn (echoing what was chosen as the final
//    message chunk, so a test can also assert on the observed outcome).
//  - text "request-permission-multi" sends TWO `session/request_permission`
//    requests back-to-back, without waiting in between, then awaits both
//    responses before finishing the turn — modeling two tool calls from the
//    same turn both needing approval, arriving close together.
//  - anything else streams a plain two-chunk "Hello world" turn, like
//    echo-acp-agent.
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
let agentRequestCounter = 90000;

/** @type {Map<number, (msg: any) => void>} */
const pendingOurRequests = new Map();

/** @param {number} id */
function waitForClientResponse(id) {
  return new Promise((resolve) => {
    pendingOurRequests.set(id, resolve);
  });
}

/**
 * @param {string} sessionId
 * @param {string} toolCallId
 * @param {string} title
 */
function requestPermission(sessionId, toolCallId, title) {
  const id = agentRequestCounter++;
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        id: toolCallId,
        title,
        toolKind: 'edit',
        status: 'pending',
        rawInput: { path: `${toolCallId}.ts` },
        content: [],
        locations: [{ path: `${toolCallId}.ts` }],
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    },
  });
  return waitForClientResponse(id);
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

  // A response to one of *our own* outgoing requests (session/request_permission).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const resolver = pendingOurRequests.get(msg.id);
    if (resolver) {
      pendingOurRequests.delete(msg.id);
      resolver(msg);
    }
    return;
  }

  if (msg.id === undefined) return; // a notification sent to us: ignore

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { requestPermission: true },
        agentInfo: { name: 'permission-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess_perm_${sessionCounter}` } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;

    if (text === 'request-permission') {
      requestPermission(sessionId, 'tc1', 'Edit file').then((response) => {
        const outcome = response.result?.outcome;
        const resultText =
          outcome?.outcome === 'selected' ? `chose:${outcome.optionId}` : 'cancelled';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'm1',
              content: { type: 'text', text: resultText },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

    if (text === 'request-permission-multi') {
      const first = requestPermission(sessionId, 'tc-a', 'Edit file A');
      const second = requestPermission(sessionId, 'tc-b', 'Edit file B');
      Promise.all([first, second]).then(() => {
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

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
      message: `permission-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
