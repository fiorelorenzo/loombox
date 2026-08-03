import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, mapToTranscriptUpdate } from './client';
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
