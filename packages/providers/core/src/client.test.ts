import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, mapAvailableCommands, mapConfigOptions, mapToTranscriptUpdate } from './client';
import {
  createTranscriptState,
  reduceTranscript,
  type TranscriptMessageItem,
  type TranscriptState,
} from './transcript';
import type { AcpMessageChunkKind, AcpUpdate } from './types';

/** Narrows a `TranscriptState.items` entry to its message-item variant with a given chunk kind — plain equality can't narrow past the `TranscriptItem` union, so `.find` needs a real type predicate to make `.text` accessible afterwards. */
function findMessageItem(
  items: readonly TranscriptState['items'][number][],
  kind: AcpMessageChunkKind,
): TranscriptMessageItem | undefined {
  return items.find(
    (item): item is TranscriptMessageItem => item.type === 'message' && item.kind === kind,
  );
}

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

// Issue #660: the realistic-timing fixture, used specifically by the
// growth-while-open test below — see that file's own doc comment for why
// it exists alongside echo-acp-agent.mjs rather than replacing it outright.
const STREAMING_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'streaming-acp-agent.mjs',
);

let activeClient: AcpClient | undefined;

function makeClient(fixture = FIXTURE_PATH): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [fixture] });
  activeClient = client;
  return client;
}

afterEach(() => {
  activeClient?.close();
  activeClient = undefined;
});

describe('AcpClient', () => {
  it('performs the handshake, opens a session, and reduces streamed message chunks', async () => {
    const client = makeClient();
    const updates: AcpUpdate[] = [];
    const turnEnds: unknown[] = [];
    client.on('update', (update: AcpUpdate) => updates.push(update));
    client.on('turn_end', (payload: unknown) => turnEnds.push(payload));

    const initResult = await client.initialize();
    expect(initResult.protocolVersion).toBe(1);
    expect(initResult.agentInfo?.name).toBe('echo-acp-agent');

    const sessionId = await client.newSession('/tmp/loombox-test');
    expect(sessionId).toMatch(/^sess_test_/);

    await client.prompt(sessionId, 'hi there');

    expect(updates).toEqual([
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello' },
      { kind: 'agent_message_chunk', messageId: 'msg_agent_1', text: 'Hello world' },
    ]);
    expect(turnEnds).toEqual([{ messageId: 'msg_agent_1', stopReason: 'end_turn' }]);
  });

  it('grows the transcript while the turn is still open, not only once it closes (issue #660)', async () => {
    const client = makeClient(STREAMING_FIXTURE_PATH);
    // Every prior test in this file only ever inspects the FINAL state
    // (the exact shape issue #660 calls out as the gap: "every test
    // claiming to cover streaming really covers two chunks in one tick").
    // Recording every intermediate `TranscriptState` snapshot as it
    // naturally arrives — via the event listener itself, no polling — is
    // what lets this test assert on the *mid-turn* shape instead.
    const snapshots: Array<{ state: TranscriptState; t: number }> = [];
    const t0 = Date.now();
    client.on('transcript_update', (payload: { state: TranscriptState }) => {
      snapshots.push({ state: payload.state, t: Date.now() - t0 });
    });

    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-test');
    // `client.prompt()` itself only resolves once the agent's terminal
    // `stopReason` response arrives — every `transcript_update` for this
    // turn is necessarily recorded above (via the synchronous listener)
    // strictly before this resolves, so `snapshots` already holds the
    // full mid-turn history by the time control returns here.
    await client.prompt(sessionId, 'go');

    const thoughtLengths = snapshots.map(
      (s) => findMessageItem(s.state.items, 'agent_thought_chunk')?.text.length ?? 0,
    );
    const messageLengths = snapshots.map(
      (s) => findMessageItem(s.state.items, 'agent_message_chunk')?.text.length ?? 0,
    );

    // A batch-until-turn-end regression would collapse this to one
    // snapshot per kind (0 -> final); the realistic fixture's 7 thought +
    // 11 message chunks means a correctly-streaming pipeline observes far
    // more distinct intermediate lengths than that.
    expect(new Set(thoughtLengths).size).toBeGreaterThan(3);
    expect(new Set(messageLengths).size).toBeGreaterThan(3);

    // Both grow monotonically (the reducer only ever appends) and the
    // thought item is fully settled before the message item starts, since
    // the fixture streams thinking first, then the answer.
    for (let i = 1; i < snapshots.length; i++) {
      expect(thoughtLengths[i]!).toBeGreaterThanOrEqual(thoughtLengths[i - 1]!);
      expect(messageLengths[i]!).toBeGreaterThanOrEqual(messageLengths[i - 1]!);
    }

    // Real, spread-out wall-clock arrival — not every snapshot landing in
    // the same tick (echo-acp-agent.mjs's old zero-delay shape would fail
    // this the same way it would fail the two checks above).
    expect(snapshots.at(-1)!.t - snapshots[0]!.t).toBeGreaterThan(50);

    const finalItems = snapshots.at(-1)!.state.items;
    expect(findMessageItem(finalItems, 'agent_thought_chunk')).toMatchObject({
      text: 'Thinking step by step about this request.',
    });
    expect(findMessageItem(finalItems, 'agent_message_chunk')).toMatchObject({
      text: 'The answer unfolds gradually across several words to prove real streaming.',
    });
  });

  it('emits exit when the underlying agent process terminates', async () => {
    const client = makeClient();
    await client.initialize();

    const exitCode = await new Promise<number | null>((resolve) => {
      client.on('exit', (code: number | null) => resolve(code));
      client.close();
    });

    expect(exitCode === null || typeof exitCode === 'number').toBe(true);
  });
});

describe('AcpClient: usage_update (issue #248)', () => {
  it("tracks a real usage_update notification (ACP's `used`/`size`/`cost.amount` field names) into getHistory's v1 transcript record", async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-test');

    await client.prompt(sessionId, 'hi there');

    const usage = client.getHistory(sessionId).find((u) => u.kind === 'usage_update');
    expect(usage).toEqual({
      kind: 'usage_update',
      sessionId,
      tokensUsed: 1234,
      contextWindow: 200000,
      costUsd: 0.05,
    });
  });
});

describe('mapToTranscriptUpdate: usage_update wire mapping (issue #248)', () => {
  it("maps ACP's real `used`/`size`/`cost.amount` fields, not the invented `tokensUsed`/`contextWindow`/`costUsd` names", () => {
    const result = mapToTranscriptUpdate(
      'usage_update',
      'sess1',
      { used: 5000, size: 100000, cost: { amount: 0.42, currency: 'USD' } },
      't1',
    );
    expect(result).toEqual({
      kind: 'usage_update',
      sessionId: 'sess1',
      tokensUsed: 5000,
      contextWindow: 100000,
      costUsd: 0.42,
    });
  });

  it('does not mislabel a non-USD cost as dollars — costUsd stays undefined rather than a fabricated conversion', () => {
    const result = mapToTranscriptUpdate(
      'usage_update',
      'sess1',
      { used: 5000, size: 100000, cost: { amount: 0.42, currency: 'EUR' } },
      't1',
    );
    expect(result).toMatchObject({ costUsd: undefined });
  });

  it('handles a null cost (ACP documents `cost` as optional) without throwing, leaving costUsd undefined', () => {
    const result = mapToTranscriptUpdate(
      'usage_update',
      'sess1',
      { used: 5000, size: 100000, cost: null },
      't1',
    );
    expect(result).toMatchObject({ tokensUsed: 5000, contextWindow: 100000, costUsd: undefined });
  });
});

describe('mapToTranscriptUpdate: tool_call/tool_call_update wire mapping (issue #623)', () => {
  it("reads ACP's real `kind`/`toolCallId` fields, not the invented `toolKind`/`id` names, against a payload shaped like ACP's own tool-calls doc example (agentclientprotocol.com/protocol/v1/tool-calls)", () => {
    const result = mapToTranscriptUpdate(
      'tool_call',
      'sess1',
      {
        toolCallId: 'call_001',
        title: 'Reading configuration file',
        kind: 'read',
        status: 'pending',
      },
      't1',
    );
    expect(result).toEqual({
      kind: 'tool_call',
      id: 'call_001',
      turnId: 't1',
      title: 'Reading configuration file',
      toolKind: 'read',
      status: 'pending',
      diff: undefined,
      rawInput: undefined,
      content: undefined,
      parentToolCallId: undefined,
      locations: undefined,
    });
  });

  it("derives `diff` from the real ACP shape — a `{type: 'diff', path, oldText, newText}` entry inside `content` — never a top-level `diff` field, since no real agent sends one (agentclientprotocol.com/protocol/v1/tool-calls#diffs)", () => {
    const result = mapToTranscriptUpdate(
      'tool_call_update',
      'sess1',
      {
        toolCallId: 'call_001',
        content: [
          { type: 'diff', path: '/repo/src/config.json', oldText: '{}', newText: '{"debug":true}' },
        ],
      },
      't1',
    );
    expect(result).toMatchObject({
      diff: { path: '/repo/src/config.json', oldText: '{}', newText: '{"debug":true}' },
    });
  });

  it('has no diff to find when `content` carries no diff-type entry (e.g. a plain text result) — `diff` stays undefined rather than throwing', () => {
    const result = mapToTranscriptUpdate(
      'tool_call_update',
      'sess1',
      {
        toolCallId: 'call_001',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
      't1',
    );
    expect(result).toMatchObject({ diff: undefined });
  });
});

describe('mapToTranscriptUpdate: plan wire mapping (issue #623)', () => {
  it("reads ACP's real `'plan'` sessionUpdate discriminant, not the invented `'plan_update'` (agentclientprotocol.com/protocol/v1/agent-plan) — untested until #623, since no fixture or hand-written payload ever sent a real plan notification before", () => {
    const result = mapToTranscriptUpdate(
      'plan',
      'sess1',
      { entries: [{ content: 'Analyze the codebase', priority: 'high', status: 'pending' }] },
      't1',
    );
    expect(result).toEqual({
      kind: 'plan_update',
      entries: [{ content: 'Analyze the codebase', priority: 'high', status: 'pending' }],
    });
  });

  it("does not match `'plan_update'` itself — that string is this client's own internal `AcpPlanUpdate.kind`, never a value the wire actually sends", () => {
    const result = mapToTranscriptUpdate('plan_update', 'sess1', { entries: [] }, 't1');
    expect(result).toBeUndefined();
  });
});

describe('reducer end-to-end: a real ACP tool_call reaches its bespoke widget, not the generic fallback (issue #623)', () => {
  it("kind: 'execute' reduces into a TranscriptToolCallItem `apps/web/src/lib/tool-widgets.ts`'s `resolveToolWidgetKind` routes to the 'bash' widget (`item.toolKind === 'execute'`)", () => {
    const update = mapToTranscriptUpdate(
      'tool_call',
      'sess1',
      {
        toolCallId: 'call_001',
        title: 'Running tests',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
      },
      't1',
    );
    const state = reduceTranscript(createTranscriptState(), update!);
    const item = state.items.find((i) => i.type === 'tool_call');
    expect(item).toMatchObject({ type: 'tool_call', toolKind: 'execute' });
  });

  it("kind: 'edit' with a real content-embedded diff reduces into a TranscriptToolCallItem `resolveToolWidgetKind` routes to the 'edit-write' widget (`item.toolKind === 'edit' && item.diff !== undefined`)", () => {
    const update = mapToTranscriptUpdate(
      'tool_call',
      'sess1',
      {
        toolCallId: 'call_002',
        title: 'Reading configuration file',
        kind: 'edit',
        status: 'completed',
        content: [
          { type: 'diff', path: '/repo/src/config.json', oldText: '{}', newText: '{"debug":true}' },
        ],
      },
      't1',
    );
    const state = reduceTranscript(createTranscriptState(), update!);
    const item = state.items.find((i) => i.type === 'tool_call');
    expect(item).toMatchObject({
      type: 'tool_call',
      toolKind: 'edit',
      diff: { path: '/repo/src/config.json', oldText: '{}', newText: '{"debug":true}' },
    });
  });
});

/**
 * `mapConfigOptions` wire-mapping tests (issue #705), same convention as
 * `mapToTranscriptUpdate`'s tests above: driven directly off a captured
 * real response rather than a fixture we invented, since a fixture that
 * mirrors our own assumption is exactly what let this sit unnoticed. The
 * recording (`test/fixtures/omp-acp-session-new-response.json`) was taken
 * by spawning the real `omp acp` binary installed on this box and sending
 * it a plain `initialize` followed by `session/new` over stdio — nothing
 * hand-written. It carries no credentials: a model catalog, a mode list,
 * and a thinking-effort list, all public capability metadata.
 */
describe('mapConfigOptions: real omp acp session/new wire mapping (issue #705)', () => {
  const RECORDED_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'omp-acp-session-new-response.json',
  );
  interface RecordedConfigOption {
    id: string;
    name: string;
    category: string;
    type: string;
    currentValue: string;
    options: { value: string; name: string; description?: string }[];
  }
  const recorded = JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as {
    initResult: { configOptions?: RecordedConfigOption[] };
    sessionNewResult: {
      configOptions: RecordedConfigOption[];
      modes: {
        availableModes: { id: string; name: string; description?: string }[];
        currentModeId: string;
      };
    };
  };

  it('a real omp acp initialize response carries no configOptions at all: mapConfigOptions of it is empty (session/new is where they arrive, not initialize)', () => {
    expect(recorded.initResult.configOptions).toBeUndefined();
    expect(mapConfigOptions(recorded.initResult)).toEqual([]);
  });

  it("maps a real session/new response's three-category catalog (model/mode/thinking) onto the internal AcpConfigOption shape, category-keyed rather than id-keyed", () => {
    const options = mapConfigOptions(recorded.sessionNewResult);

    const mode = options.find((o) => o.category === 'mode');
    expect(mode?.current).toBe('default');
    expect(mode?.choices).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ]);

    const model = options.find((o) => o.category === 'model');
    expect(model?.current).toBe('anthropic/claude-opus-5');
    expect(model?.choices).toHaveLength(26);
    expect(model?.choices[0]).toEqual({
      id: 'anthropic/claude-3-5-sonnet-20240620',
      name: 'Claude Sonnet 3.5',
    });

    // The wire entry's own `id` is "thinking", but its `category` is
    // "thought_level" — proof `category`, not `id`, is the mapping target
    // for the internal `category` field (a real agent's two legitimately
    // differ; ConfigOptionStore groups on `category`).
    const thinking = options.find((o) => o.category === 'thought_level');
    expect(thinking).toBeDefined();
    expect(options.find((o) => o.category === 'thinking')).toBeUndefined();
    expect(thinking?.current).toBe('high');
    expect(thinking?.choices).toEqual([
      { id: 'off', name: 'Off' },
      { id: 'auto', name: 'Auto' },
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
      { id: 'xhigh', name: 'xhigh' },
      { id: 'max', name: 'max' },
    ]);

    expect(options).toHaveLength(3);
  });

  it("does not duplicate the 'mode' category from the real response's separate modes object: configOptions already has one", () => {
    const options = mapConfigOptions(recorded.sessionNewResult);
    expect(options.filter((o) => o.category === 'mode')).toHaveLength(1);
  });

  it("falls back to the modes object to synthesize a 'mode' category when configOptions has none at all", () => {
    const withoutModeCategory = {
      configOptions: recorded.sessionNewResult.configOptions.filter((o) => o.category !== 'mode'),
      modes: recorded.sessionNewResult.modes,
    };
    const options = mapConfigOptions(withoutModeCategory);
    expect(options.find((o) => o.category === 'mode')).toEqual({
      category: 'mode',
      current: 'default',
      id: 'mode',
      type: 'select',
      choices: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    });
  });

  it('preserves an unrecognized/future category rather than dropping it (issue #179 passthrough, carried through the wire mapping)', () => {
    const options = mapConfigOptions({
      configOptions: [
        {
          id: 'reasoning_style_v3',
          name: 'Reasoning style',
          category: 'reasoning_style_v3',
          type: 'select',
          currentValue: 'balanced',
          options: [{ value: 'balanced', name: 'Balanced' }],
        },
      ],
    });
    expect(options).toEqual([
      {
        category: 'reasoning_style_v3',
        current: 'balanced',
        id: 'reasoning_style_v3',
        type: 'select',
        choices: [{ id: 'balanced', name: 'Balanced' }],
      },
    ]);
  });
});

/**
 * `mapAvailableCommands` wire-mapping tests (issue #741), same convention
 * as `mapConfigOptions` above: driven off a captured real response
 * (`test/fixtures/omp-acp-available-commands-update.json`, taken by
 * spawning the real `omp acp` binary over stdio — `initialize` ->
 * `session/new` -> `session/prompt`, trimmed to five representative
 * commands) rather than a fixture that mirrors this client's own
 * assumption of the shape.
 */
describe('mapAvailableCommands: real omp acp available_commands_update wire mapping (issue #741)', () => {
  const RECORDED_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'omp-acp-available-commands-update.json',
  );
  interface RecordedAvailableCommand {
    name: string;
    description: string;
    input?: { hint: string };
    [key: string]: unknown;
  }
  const recorded = JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as {
    availableCommandsUpdate: { availableCommands: RecordedAvailableCommand[] };
  };

  it("maps a real available_commands_update's command list onto the internal AcpAvailableCommand shape, both with and without an input hint", () => {
    const commands = mapAvailableCommands(recorded.availableCommandsUpdate.availableCommands);
    expect(commands).toHaveLength(5);

    const model = commands.find((c) => c.name === 'model');
    expect(model?.description).toBe('Show current model selection');
    expect(model?.input).toBeUndefined();

    const fast = commands.find((c) => c.name === 'fast');
    expect(fast?.input).toEqual({ hint: '[on|off|status]' });
  });

  it('an agent that declares no commands at all maps to an empty list, not an error (issue #741 acceptance)', () => {
    expect(mapAvailableCommands(undefined)).toEqual([]);
    expect(mapAvailableCommands([])).toEqual([]);
  });

  it('drops an entry with no name — there is nothing to key it by', () => {
    expect(mapAvailableCommands([{ description: 'no name' }])).toEqual([]);
  });

  it('preserves an unrecognized/future field on a command rather than dropping it (issue #741)', () => {
    const commands = mapAvailableCommands([
      { name: 'security', description: 'Run a scan', icon: 'shield', deprecated: false },
    ]);
    expect(commands).toEqual([
      {
        name: 'security',
        description: 'Run a scan',
        input: undefined,
        icon: 'shield',
        deprecated: false,
      },
    ]);
  });

  it('preserves an unrecognized/future field nested inside input too', () => {
    const commands = mapAvailableCommands([
      {
        name: 'todo',
        description: 'Manage todos',
        input: { hint: '<subcommand>', multiline: true },
      },
    ]);
    expect(commands[0]?.input).toEqual({ hint: '<subcommand>', multiline: true });
  });
});

/**
 * `mapConfigOptions` of a real `session/set_config_option` response (issue
 * #707), same recording convention as the suite above: spawning the real
 * `omp acp` binary over stdio (`initialize` -> `session/new` ->
 * `session/set_config_option`), nothing hand-written. The request in the
 * recording (`test/fixtures/omp-acp-set-config-option-response.json`) is
 * `{sessionId, configId: 'thinking', value: 'medium', type: 'select'}` —
 * `configId` is the `thinking` entry's own wire `id`, NOT its `category`
 * (`'thought_level'`); sending the category as `configId` is what the real
 * binary rejects (`"Unknown ACP config option: thought_level"`, see the
 * fixture-driven suite below). Built directly against pre-#707 `client.ts`
 * (`git stash` of this issue's fix) to confirm it fails there: the old
 * code read `result.options` (always `undefined` on a real response, whose
 * field is `configOptions`), so `setAll` was called with `[]` and the
 * whole catalogue silently vanished instead of reflecting the change.
 */
describe('mapConfigOptions: real omp acp session/set_config_option wire mapping (issue #707)', () => {
  const RECORDED_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'omp-acp-set-config-option-response.json',
  );
  interface RecordedConfigOption {
    id: string;
    name: string;
    category: string;
    type: string;
    currentValue: string;
    options: { value: string; name: string; description?: string }[];
  }
  const recorded = JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as {
    setConfigOptionRequest: { configId: string; value: string; type: string };
    setConfigOptionResult: { configOptions: RecordedConfigOption[] };
  };

  it("captured the real request as {configId, value, type}, configId sourced from the option's own id ('thinking'), not its category ('thought_level')", () => {
    expect(recorded.setConfigOptionRequest).toEqual({
      sessionId: expect.any(String),
      configId: 'thinking',
      value: 'medium',
      type: 'select',
    });
  });

  it('maps the real response (field `configOptions`, wire-shaped) onto the internal catalogue, reflecting the change and leaving untouched categories alone', () => {
    const options = mapConfigOptions(recorded.setConfigOptionResult);

    const thinking = options.find((o) => o.category === 'thought_level');
    expect(thinking?.current).toBe('medium'); // the change this request made
    expect(thinking?.id).toBe('thinking');
    expect(thinking?.type).toBe('select');

    // Wholesale-replaced, not per-category patched: the response carries
    // every category, and the ones this request didn't touch survive
    // unchanged.
    expect(options.find((o) => o.category === 'mode')?.current).toBe('default');
    expect(options.find((o) => o.category === 'model')?.current).toBe('anthropic/claude-opus-5');
    expect(options).toHaveLength(3);
  });
});
