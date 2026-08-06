#!/usr/bin/env node
// Fixture ACP agent for the spend-cap tests (SPEC.md §7.16; issue #251).
// Not a real agent — a scriptable one, driven entirely by the prompt text
// on `session/prompt`, same convention `permission-acp-agent.mjs` (this
// same directory) already documents for its own prompt-driven behavior:
//
//  - "usage:<amount>" sends ONE `usage_update` `session/update`
//    notification with `cost: {amount: <amount>, currency: 'USD'}`, then
//    finishes the turn.
//  - "usage:<a1>,<a2>,...,<an>" sends SEVERAL `usage_update` notifications
//    in sequence, each after a real delay (not synchronously in one
//    tick — same reasoning `echo-acp-agent.mjs` documents for its own
//    chunk delay), THEN finishes the turn — models a single turn whose
//    running cost crosses a cap partway through, before the turn itself
//    settles.
//  - "tokens-only" sends one `usage_update` with `used`/`size` but no
//    `cost` field at all (a provider that reports context usage without
//    ever billing a dollar figure), then finishes the turn.
//  - anything else (including "no-usage") sends NO `usage_update` at all
//    and just finishes the turn — the "this agent never reported a cost"
//    case.
//
// Every variant streams a plain one-chunk "ok" message first, so a test
// asserting on real transcript content (not just usage) has something to
// look for, mirroring echo-acp-agent's own "Hello world" shape.
//
// Plain Node ESM (no TypeScript, no deps): spawned directly as a child
// process, not imported.

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

const STEP_DELAY_MS = Number(process.env.LOOMBOX_TEST_CHUNK_DELAY_MS ?? 20);

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
        agentInfo: { name: 'spend-cap-acp-agent', version: '0.0.0' },
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
    const text = msg.params?.prompt?.[0]?.text ?? '';

    await sleep(STEP_DELAY_MS);
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_1',
          content: { type: 'text', text: 'ok' },
        },
      },
    });

    const usageMatch = /^usage:(.+)$/.exec(text);
    if (usageMatch) {
      const amounts = usageMatch[1].split(',').map((entry) => Number(entry.trim()));
      for (const amount of amounts) {
        await sleep(STEP_DELAY_MS);
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 1000,
              size: 200000,
              cost: { amount, currency: 'USD' },
            },
          },
        });
      }
    } else if (text === 'tokens-only') {
      await sleep(STEP_DELAY_MS);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 1000, size: 200000 },
        },
      });
    }
    // else: "no-usage" or anything unrecognized — no usage_update at all.

    await sleep(STEP_DELAY_MS);
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32601,
      message: `spend-cap-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
