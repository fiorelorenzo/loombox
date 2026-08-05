#!/usr/bin/env node
// Fixture ACP agent for the config-option state and capability-flag tests
// (issues #179/#180/#705; SPEC.md §7.24 "Model, mode & reasoning effort",
// §5.5 "Capability negotiation gates the UI"). Not a real agent.
//
// `initialize` advertises a full capability set and, per a real `omp acp`
// binary (verified directly, issue #705 — see
// `test/fixtures/omp-acp-session-new-response.json` for the full
// recording), NO `configOptions` at all: the catalog arrives on
// `session/new` instead. `session/new`'s result carries `configOptions`
// wire-shaped exactly like that recording (`{id, name, category, type,
// currentValue, options: [{value, name, description}]}` per category),
// trimmed to two choices per category for a readable fixture, plus a
// `modes` sub-object duplicating the `mode` category the same way the real
// binary does (so a test can assert the client folds the two rather than
// rendering two pickers). `session/prompt` with text "trigger-fallback"
// pushes an *unprompted* `config_option_update` notification (an
// automatic model fallback), same wire-shaped `configOptions` field, so a
// test can assert it lands in state flagged as unprompted; any other text
// streams a plain two-chunk "Hello world" turn.
//
// `session/set_config_option`'s request/response shape is a SEPARATE,
// still-open bug (verified against the real binary while working this
// issue: it rejects `{category, choiceId}` and actually wants
// `{configId, value, type}`, and its response field is `configOptions`
// wire-shaped, not `options` internal-shaped — filed as its own follow-up,
// out of scope for #705). This fixture still echoes the client's current
// (unfixed) `{category, choiceId}` request / `{options}` internal-shaped
// response expectation, off a separate in-memory catalog, purely so the
// pre-existing round-trip test keeps exercising that real code path
// end-to-end rather than silently going stale.
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

const MODE_OPTIONS = [
  { value: 'default', name: 'Default', description: 'Standard ACP headless mode' },
  {
    value: 'plan',
    name: 'Plan',
    description:
      'Read-only planning mode that drafts a plan to a markdown file before any code changes',
  },
];
const MODEL_OPTIONS = [
  {
    value: 'anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    description: 'anthropic/claude-sonnet-5',
  },
  {
    value: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    description: 'anthropic/claude-haiku-4-5',
  },
];
const THINKING_OPTIONS = [
  { value: 'off', name: 'Off' },
  { value: 'auto', name: 'Auto', description: 'Auto-detect per prompt' },
];

/** @type {Array<{id: string, name: string, category: string, type: string, currentValue: string, options: {value: string, name: string, description?: string}[]}>} */
let wireConfigOptions = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: MODE_OPTIONS,
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'anthropic/claude-sonnet-5',
    options: MODEL_OPTIONS,
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'auto',
    options: THINKING_OPTIONS,
  },
];
const wireModes = {
  availableModes: MODE_OPTIONS.map(({ value, name, description }) => ({
    id: value,
    name,
    description,
  })),
  currentModeId: 'default',
};

/** @type {Array<{category: string, current: string, choices: {id: string, name: string}[]}>} */
let internalConfigOptions = [
  {
    category: 'model',
    current: 'sonnet',
    choices: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku' },
    ],
  },
  {
    category: 'mode',
    current: 'default',
    choices: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
  },
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
        // No configOptions here on purpose — a real omp acp binary never
        // sends them at initialize either (issue #705).
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: `sess_config_${sessionCounter}`,
        configOptions: wireConfigOptions,
        modes: wireModes,
      },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    const { category, choiceId } = msg.params ?? {};
    internalConfigOptions = internalConfigOptions.map((option) =>
      option.category === category ? { ...option, current: choiceId } : option,
    );
    send({ jsonrpc: '2.0', id: msg.id, result: { options: internalConfigOptions } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;

    if (text === 'trigger-fallback') {
      wireConfigOptions = wireConfigOptions.map((option) =>
        option.category === 'model'
          ? { ...option, currentValue: 'anthropic/claude-haiku-4-5' }
          : option,
      );
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: wireConfigOptions },
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
