import { AcpClient } from '@loombox/providers-core';
import type { AcpUpdate } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ohmypiProvider, ohmypiProviderModule } from './provider';

// The real `omp` binary (what ohmypiProvider.spawnConfig() actually
// launches) isn't spawned in this hermetic suite either — this integration
// test drives the SAME shared fixture ACP agent packages/providers/claude
// and packages/providers/codex already exercise their own equivalent tests
// against, through the core AcpClient, for one prompt/response turn. That
// proves this adapter package's wiring (its enrich() no-op and its use of
// AcpClient); the real omp binary's actual wire behavior was verified
// separately by hand (see provider.ts's doc comment), not by this test.
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

describe('ohmypiProvider', () => {
  it('is registered under id "ohmypi" and enrich() is a no-op', () => {
    expect(ohmypiProvider.id).toBe('ohmypi');

    const update: AcpUpdate = { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' };
    expect(ohmypiProvider.enrich(update)).toEqual(update);
  });

  // Unlike claude/codex, `omp acp` is a subcommand of the locally installed
  // `omp` binary, not an npx-resolved wrapper package — spawnConfig() must
  // name `omp` directly (never `npx`), and requiredCommand must name that
  // exact same binary, since there is no separate vendor CLI behind it to
  // distinguish it from.
  it('spawnConfig() launches the local omp binary directly, never through npx', () => {
    const spawnConfig = ohmypiProvider.spawnConfig({ cwd: '/tmp/example' });
    expect(spawnConfig.command).toBe('omp');
    expect(spawnConfig.args).toEqual(['acp']);

    const moduleSpawnConfig = ohmypiProviderModule.spawnConfig({ cwd: '/tmp/example' });
    expect(moduleSpawnConfig.command).toBe('omp');
    expect(moduleSpawnConfig.args).toEqual(['acp']);
  });

  it('requiredCommand names the real omp CLI, never npx', () => {
    expect(ohmypiProviderModule.requiredCommand).toBe('omp');
    expect(ohmypiProviderModule.requiredCommand).not.toBe('npx');
  });

  it('drives a full prompt/response turn through the fixture ACP agent', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-ohmypi-'));

    // spawnConfig() names the real omp binary; swap in the fixture's
    // command/args here since a real omp install isn't spawned in this
    // hermetic suite, but exercise the same cwd ohmypiProvider would compute.
    const spawnConfig = ohmypiProvider.spawnConfig({ cwd: workDir });
    expect(spawnConfig.cwd).toBe(workDir);

    const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const updates: AcpUpdate[] = [];
    let turnEnded = false;
    client.on('update', (update: AcpUpdate) => updates.push(ohmypiProvider.enrich(update)));
    client.on('turn_end', () => {
      turnEnded = true;
    });

    await client.prompt(sessionId, 'hello from a temp dir');

    expect(turnEnded).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)?.text).toBe('Hello world');
  });
});
