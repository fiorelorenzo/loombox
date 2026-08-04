import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, mapToTranscriptUpdate } from './client';
import { createTranscriptState, reduceTranscript } from './transcript';
import type { AcpUpdate } from './types';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

let activeClient: AcpClient | undefined;

function makeClient(): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH] });
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
