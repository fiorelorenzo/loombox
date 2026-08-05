#!/usr/bin/env node
// The realistic-timing streaming fixture (issue #660): unlike
// `echo-acp-agent.mjs`'s minimal two-chunk "Hello world", this one emits
// several `agent_thought_chunk` chunks (a "thinking" phase) followed by
// several `agent_message_chunk` chunks (the answer), each separated by a
// real `CHUNK_DELAY_MS` gap — the shape a real ACP agent actually produces:
// a burst of reasoning, then a burst of answer text, both arriving over
// real wall-clock time, never in one synchronous tick. Any test asserting
// the transcript grows *while the turn is open* (not merely correct once
// it closes) should drive it through this fixture, not echo-acp-agent.mjs.
//
// Replies to `initialize`/`session/new` exactly like echo-acp-agent.mjs.
// On `session/prompt`, streams THOUGHT_WORDS as `agent_thought_chunk`
// (same messageId, so the reducer coalesces them into one growing thought
// item), then MESSAGE_WORDS as `agent_message_chunk` (a second messageId),
// then a `usage_update` and `stopReason: "end_turn"`. `CHUNK_DELAY_MS`
// (env `LOOMBOX_TEST_CHUNK_DELAY_MS`, default 25) sets the gap between
// every chunk, so a test can dial it down for speed or up for a slow-motion
// manual check without editing this file.
//
// Plain Node ESM (no TypeScript, no deps): spawned directly as a child
// process by AcpClient, not imported.

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

const CHUNK_DELAY_MS = Number(process.env.LOOMBOX_TEST_CHUNK_DELAY_MS ?? 25);

const THOUGHT_WORDS = ['Thinking', ' step', ' by', ' step', ' about', ' this', ' request.'];
const MESSAGE_WORDS = [
  'The',
  ' answer',
  ' unfolds',
  ' gradually',
  ' across',
  ' several',
  ' words',
  ' to',
  ' prove',
  ' real',
  ' streaming.',
];

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
        agentInfo: { name: 'streaming-acp-agent', version: '0.0.0' },
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
    const thoughtId = 'msg_thought_1';
    const messageId = 'msg_agent_1';

    for (const word of THOUGHT_WORDS) {
      await sleep(CHUNK_DELAY_MS);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            messageId: thoughtId,
            content: { type: 'text', text: word },
          },
        },
      });
    }

    for (const word of MESSAGE_WORDS) {
      await sleep(CHUNK_DELAY_MS);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text: word },
          },
        },
      });
    }

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
      message: `streaming-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
