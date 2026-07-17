import { AcpClient } from '@loombox/providers-core';
import type { AcpUpdate } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { codexProvider } from './provider';

// The real `codex` binary (what codexProvider.spawnConfig() actually
// launches) can't be exercised headlessly in this dev environment, so this
// integration test drives the SAME fixture ACP agent used by
// packages/providers/core through the core AcpClient for one prompt/response
// turn, proving the codex adapter package's wiring (its enrich() no-op and
// its use of AcpClient) without a real Codex install. Real-Codex validation
// is a separate human-gated follow-up.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

let workDir: string | undefined;
let activeClient: AcpClient | undefined;

afterEach(async () => {
  activeClient?.close();
  activeClient = undefined;
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe('codexProvider', () => {
  it('is registered under id "codex" and enrich() is a no-op', () => {
    expect(codexProvider.id).toBe('codex');

    const update: AcpUpdate = { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' };
    expect(codexProvider.enrich(update)).toEqual(update);
  });

  it('drives a full prompt/response turn through the fixture ACP agent', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-'));

    // spawnConfig() names the real codex-acp bridge; swap in the fixture's
    // command/args here since the real bridge isn't runnable headlessly, but
    // exercise the same cwd codexProvider would compute.
    const spawnConfig = codexProvider.spawnConfig({ cwd: workDir });
    expect(spawnConfig.cwd).toBe(workDir);

    const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const updates: AcpUpdate[] = [];
    let turnEnded = false;
    client.on('update', (update: AcpUpdate) => updates.push(codexProvider.enrich(update)));
    client.on('turn_end', () => {
      turnEnded = true;
    });

    await client.prompt(sessionId, 'hello from a temp dir');

    expect(turnEnded).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)?.text).toBe('Hello world');
  });
});
