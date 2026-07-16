import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
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
