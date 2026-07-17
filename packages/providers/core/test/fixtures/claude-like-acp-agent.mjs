#!/usr/bin/env node
// Fixture ACP agent shaped like Claude Code's real ACP bridge, used by the
// conformance suites in packages/providers/core and packages/providers/claude
// (issue #186; SPEC.md §7.24/§7.25). Not a real agent, and NOT a claim about
// claude-code-acp's exact wire text — the option ids/tool titles below are
// modeled on SPEC.md §7.24's "Claude's Allow-once / Allow-all-edits /
// Bypass-everything / Allow-for-session / Deny" and §12's "Edit/Write/Bash/
// TodoWrite" bespoke-widget tool names, to be confirmed against the real
// binary in issue #54 (human-gated).
//
// On `session/prompt`:
//  - text "edit-with-permission" streams a `tool_call` (kind edit, an "Edit"
//    title, a diff), fires ONE `session/request_permission` with Claude's
//    five-verb option set, applies the tool_call_update once resolved, and
//    finishes with a summary message chunk.
//  - text "resource-link" streams a `tool_call` whose `content` carries an
//    ACP `resource_link` content block (a file/image reference), with no
//    permission request, proving a `ResourceLink` round-trips with zero
//    bespoke handling (issue #183).
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
let agentRequestCounter = 80000;

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
        agentInfo: { name: 'claude-like-acp-agent', version: '0.0.0' },
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
      result: { sessionId: `sess_claudelike_${sessionCounter}` },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;

    if (text === 'edit-with-permission') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            id: 'tc1',
            title: 'Edit',
            toolKind: 'edit',
            status: 'pending',
            diff: { path: 'src/foo.ts', oldText: 'old\n', newText: 'new\n' },
            rawInput: { path: 'src/foo.ts' },
            content: [],
            // Real Claude Code's vendor `_meta` shape (SPEC.md §7.24); v1's
            // enrich() is a documented no-op, so this must NOT surface as
            // `parentToolCallId` on the reduced item yet (that's v2, #184).
            _meta: { claudeCode: { parentToolUseId: 'root-agent-call' } },
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
            title: 'Edit',
            toolKind: 'edit',
            status: 'pending',
            diff: { path: 'src/foo.ts', oldText: 'old\n', newText: 'new\n' },
            rawInput: { path: 'src/foo.ts' },
            content: [],
            locations: [{ path: 'src/foo.ts' }],
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-all-edits', name: 'Allow all edits', kind: 'allow_always' },
            { optionId: 'bypass-permissions', name: 'Bypass everything', kind: 'allow_always' },
            { optionId: 'allow-for-session', name: 'Allow for this session', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
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
              content: { type: 'text', text: `edited (chose ${chosen})` },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

    if (text === 'resource-link') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            id: 'tc-rl',
            title: 'Read',
            toolKind: 'read',
            status: 'completed',
            content: [
              {
                type: 'resource_link',
                uri: 'file:///tmp/loombox-image-abc123/deadbeef.png',
                name: 'screenshot.png',
                mimeType: 'image/png',
              },
            ],
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
      message: `claude-like-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
