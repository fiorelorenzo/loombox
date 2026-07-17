#!/usr/bin/env node
// Fixture ACP agent for the config-option state and capability-flag tests
// (issues #179/#180; SPEC.md §7.24 "Model, mode & reasoning effort",
// §5.5 "Capability negotiation gates the UI"). Not a real agent.
//
// `initialize` advertises a full capability set plus a two-category
// config-option catalog (model, mode). `session/set_config_option` updates
// its in-memory catalog for the given category and echoes the whole list
// back (never a per-category patch). `session/prompt` with text
// "trigger-fallback" pushes an *unprompted* `config_option_update`
// notification (an automatic model fallback) before finishing the turn, so
// a test can assert it lands in state flagged as unprompted; any other text
// streams a plain two-chunk "Hello world" turn.
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

const MODEL_CHOICES = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];
const MODE_CHOICES = [
  { id: 'default', name: 'Default' },
  { id: 'plan', name: 'Plan' },
];

/** @type {Array<{category: string, current: string, choices: {id: string, name: string}[]}>} */
let configOptions = [
  { category: 'model', current: 'sonnet', choices: MODEL_CHOICES },
  { category: 'mode', current: 'default', choices: MODE_CHOICES },
];

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
          mcpServerPicker: true,
          additionalDirectories: false,
          sessionDelete: true,
          requestPermission: false,
          plans: true,
        },
        agentInfo: { name: 'config-acp-agent', version: '0.0.0' },
        authMethods: [],
        configOptions,
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess_config_${sessionCounter}` } });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    const { category, choiceId } = msg.params ?? {};
    configOptions = configOptions.map((option) =>
      option.category === category ? { ...option, current: choiceId } : option,
    );
    send({ jsonrpc: '2.0', id: msg.id, result: { options: configOptions } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;

    if (text === 'trigger-fallback') {
      configOptions = configOptions.map((option) =>
        option.category === 'model' ? { ...option, current: 'haiku' } : option,
      );
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'config_option_update', options: configOptions },
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
      message: `config-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
