#!/usr/bin/env node
// Fixture ACP agent shaped like Codex's real ACP bridge, used by the
// conformance suites in packages/providers/core and packages/providers/codex
// (issue #186; SPEC.md §7.24/§7.25). Not a real agent, and NOT a claim about
// codex-acp's exact wire text — the option ids/tool titles below are modeled
// on SPEC.md §7.24's "Codex's Yes / Yes-for-session / Stop-and-explain (an
// abort, not a deny)" and its "Codex's patch/diff/bash" bespoke-widget tool
// names, to be confirmed against the real binary in a future human-gated
// build-time verification spike (the dependency #186's Codex half lists).
//
// On `session/prompt`:
//  - text "patch-with-permission" streams a `tool_call` (kind edit, a
//    "Patch" title, a diff), fires ONE `session/request_permission` with
//    Codex's three-verb option set, applies the tool_call_update once
//    resolved, and finishes with a summary message chunk. Deliberately
//    sends NO vendor `_meta` at all (unlike the claude-like fixture's
//    `_meta.claudeCode.parentToolUseId`) — SPEC.md §7.24: "Codex until an
//    equivalent signal is confirmed" has no parent-link signal, so a
//    Codex-shaped session must degrade to a flat list automatically.
//  - text "bash-tool" streams a completed `tool_call` (kind execute, a
//    "Bash" title) with no permission round trip, proving a tool call
//    completes and classifies correctly with zero bespoke handling from
//    core.
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
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpServerPicker: false,
          additionalDirectories: false,
          sessionDelete: false,
          requestPermission: true,
          plans: true,
        },
        agentInfo: { name: 'codex-like-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: `sess_codexlike_${sessionCounter}` },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;

    if (text === 'patch-with-permission') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            id: 'tc1',
            title: 'Patch',
            toolKind: 'edit',
            status: 'pending',
            diff: { path: 'src/foo.ts', oldText: 'old\n', newText: 'new\n' },
            rawInput: { path: 'src/foo.ts' },
            content: [],
            // Deliberately no `_meta`: Codex has no confirmed parent-link
            // signal yet (SPEC.md §7.24), unlike claude-like-acp-agent.mjs.
          },
        },
      });

      const permissionRequestId = agentRequestCounter++;
      send({
        jsonrpc: '2.0',
        id: permissionRequestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            id: 'tc1',
            title: 'Patch',
            toolKind: 'edit',
            status: 'pending',
            diff: { path: 'src/foo.ts', oldText: 'old\n', newText: 'new\n' },
            rawInput: { path: 'src/foo.ts' },
            content: [],
            locations: [{ path: 'src/foo.ts' }],
          },
          options: [
            { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
            { optionId: 'yes-for-session', name: 'Yes, for this session', kind: 'allow_always' },
            {
              optionId: 'stop-and-explain',
              name: 'Stop, and explain what to do differently',
              kind: 'reject_once',
            },
          ],
        },
      });

      waitForClientResponse(permissionRequestId).then((response) => {
        const outcome = response.result?.outcome;
        const chosen = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              id: 'tc1',
              status: chosen === 'cancelled' ? 'failed' : 'completed',
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
              content: { type: 'text', text: `patched (chose ${chosen})` },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

    if (text === 'bash-tool') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            id: 'tc-bash',
            title: 'Bash',
            toolKind: 'execute',
            status: 'completed',
            rawInput: { command: 'pnpm test' },
            content: [{ type: 'text', text: 'ok' }],
          },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
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
      message: `codex-like-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
