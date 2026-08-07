#!/usr/bin/env node
// Fixture ACP agent shaped like Gemini CLI's real ACP bridge, used by the
// conformance suite in packages/providers/core (issue #844; `docs/research/
// gemini-acp-completeness.md` finding 7). Not a real agent, and — unlike
// `test/fixtures/gemini-acp-live-probe.json`'s `initialize`/method-probe
// data, which IS a byte-exact live recording — this fixture's `session/new`
// result is source-reconstructed, not live-recorded: a real end-to-end
// `session/new` needs a configured Gemini API key this box has none of (the
// live probe's own `session/new` attempt got `-32000 "Gemini API key is
// missing or not configured."`, confirmed in that fixture). What IS a
// verified claim, cross-checked at two independent layers (both cited in
// `docs/research/gemini-acp-completeness.md` finding 7 and
// `packages/providers/core/src/client.ts`'s `RawSessionModels` doc
// comment): the STRUCTURAL shape below — `session/new` returning exactly
// `{sessionId, modes, models}` with no `configOptions` key at all, and
// `models` being `{availableModels: [{modelId, name, description?}],
// currentModelId}` — matches (1) `acpSessionManager.ts`'s `newSession`/
// `buildAvailableModels` (`acpUtils.ts`) source at commit
// `a74b483d14a93159fa36e7ee9e32cf44bda594df` (the exact commit GitHub's
// `v0.54.0` tag resolves to, the version `agent-catalogue.ts`'s
// `gemini-cli` entry targets), and (2) the real `@agentclientprotocol/
// sdk@0.16.1` package gemini-cli 0.54.0 actually depends on
// (`packages/cli/package.json`), whose own generated zod schema declares
// the identical `SessionModelState`/`ModelInfo` shape independently. The
// specific `modelId`/`name` values below (`gemini-2.5-pro` etc.) are
// illustrative real Gemini model family names, not a claim about exactly
// what a specific account/entitlement combination would return — the
// verified claim is the STRUCTURE, same distinction `claude-like-acp-
// agent.mjs`'s own header draws for its option ids/tool titles.
//
// `unstable_setSessionModel` (wire method `session/set_model`, confirmed
// against the same `@agentclientprotocol/sdk@0.16.1` schema:
// `AGENT_METHODS.session_set_model === 'session/set_model'`, params
// `{sessionId, modelId}`, response just `{}`/`{_meta}` — no catalog echoed
// back, unlike `session/set_config_option`) is real and source-verified
// too: `GeminiAgent.unstable_setSessionModel` (`acpRpcDispatcher.ts`) calls
// `session.setModel(modelId)` (`acpSession.ts`), which sets the model and
// returns `{}` literally. This fixture mirrors that: a known `modelId`
// mutates `currentModelId` and echoes `{}`; an unknown one is rejected —
// NOT a verified real Gemini error shape (validation happens inside
// `gemini-cli-core`'s own `config.setModel`, outside this citation trail),
// modeled generically as a `-32602 "Invalid params"` JSON-RPC error only to
// prove the client-side reject-not-swallow contract. Deliberately does NOT
// implement `session/set_config_option` at all: the real `GeminiAgent`
// class has no such method either (confirmed in `acpRpcDispatcher.ts`
// source — it implements exactly `initialize`/`authenticate`/`newSession`/
// `loadSession`/`cancel`/`prompt`/`setSessionMode`/`unstable_setSessionModel`),
// so a caller that tried to set the `mode` category here would get the same
// generic "method not implemented" fallback a real Gemini binary's own
// `-32601 Method not found` would produce — out of this issue's scope
// (filed as its own gap, not #844), so this fixture leaves it unimplemented
// rather than faking support Gemini doesn't have.
//
// On `session/prompt`, text "which-model" streams back the fixture's OWN
// current `currentModelId` as a message chunk — the only way a test can
// prove an earlier `session/set_model` call actually reached and mutated
// this process's state, over the real JSON-RPC wire, rather than trusting
// the calling client's own optimistic local update. Anything else streams
// a plain two-chunk "Hello world" turn, like echo-acp-agent.
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

/** @type {Array<{modelId: string, name: string, description?: string}>} */
const AVAILABLE_MODELS = [
  {
    modelId: 'auto',
    name: 'Auto',
    description: 'Automatically selects the best model for the request',
  },
  { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { modelId: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
];

const AVAILABLE_MODES = [
  { id: 'default', name: 'Default', description: 'Prompts for approval' },
  { id: 'auto-edit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
  { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
  { id: 'plan', name: 'Plan', description: 'Read-only mode' },
];

// Per-session mutable state, keyed by sessionId — `session/set_model`
// mutates this, and "which-model" reads it back, so the two are only ever
// connected through the real wire, never a shortcut inside this process.
/** @type {Map<string, { currentModelId: string, currentModeId: string }>} */
const sessions = new Map();

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
          // Real Gemini CLI shape (docs/research/gemini-acp-completeness.md
          // finding 1, live-verified): audio true (Gemini is the first real
          // cataloged agent to set it), and NO sessionCapabilities key at
          // all despite loadSession: true (finding 2/#843 — out of this
          // issue's scope, left as-is here to keep this fixture honest).
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'gemini-like-acp-agent', version: '0.0.0' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionCounter += 1;
    const sessionId = `sess_geminilike_${sessionCounter}`;
    sessions.set(sessionId, { currentModelId: 'auto', currentModeId: 'default' });
    const state = sessions.get(sessionId);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      // Deliberately no `configOptions` key at all — a real Gemini
      // `session/new` result is exactly `{sessionId, modes, models}`
      // (`acpSessionManager.ts`'s `newSession`, source-verified, see this
      // file's own header).
      result: {
        sessionId,
        modes: { availableModes: AVAILABLE_MODES, currentModeId: state.currentModeId },
        models: { availableModels: AVAILABLE_MODELS, currentModelId: state.currentModelId },
      },
    });
    return;
  }

  if (msg.method === 'session/set_model') {
    const { sessionId, modelId } = msg.params ?? {};
    const state = sessions.get(sessionId);
    const known = AVAILABLE_MODELS.some((model) => model.modelId === modelId);
    if (!state || !known) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: `Invalid params: unknown modelId "${String(modelId)}"` },
      });
      return;
    }
    state.currentModelId = modelId;
    // Real `session.setModel` (`acpSession.ts`) returns `{}` literally —
    // no catalog echoed back, unlike `session/set_config_option`.
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const text = msg.params?.prompt?.[0]?.text;
    const state = sessions.get(sessionId);

    if (text === 'which-model') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_which_model',
            content: { type: 'text', text: state?.currentModelId ?? 'unknown' },
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
      message: `gemini-like-acp-agent: method not implemented: ${String(msg.method)}`,
    },
  });
});
