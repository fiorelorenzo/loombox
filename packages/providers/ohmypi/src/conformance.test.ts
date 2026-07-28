import { AcpClient, ProviderRegistry } from '@loombox/providers-core';
import type { AcpTranscriptUpdate } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ohmypiProviderModule } from './provider';

// Protocol-conformance suite mirroring packages/providers/codex's
// conformance.test.ts: drives the SAME shared fixture ACP agent
// (packages/providers/core/test/fixtures/echo-acp-agent.mjs — also used by
// packages/providers/claude and packages/providers/codex's own
// provider.test.ts) through the real core AcpClient with
// ohmypiProviderModule registered on a real ProviderRegistry, proving the
// module's registry wiring and its enrich() no-op work together against a
// live (fixture) session — not mocks of either. Unlike codex's conformance
// suite there is no permission-gated-tool-call / bespoke-widget coverage
// here: this package ships neither permissions.ts nor tool-widgets.ts (see
// index.ts's doc comment for why), so there is nothing of that shape to
// drive; the real omp binary's actual tool_call/permission behavior was
// verified separately by hand (see provider.ts's doc comment), not by this
// hermetic fixture.
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

describe('ohmypiProviderModule conformance', () => {
  it('registers under "ohmypi" in a real ProviderRegistry and drives a plain prompt/response turn end to end', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-ohmypi-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(ohmypiProviderModule);
    expect(registry.lookup('ohmypi')).toBe(ohmypiProviderModule);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'ohmypi' },
    );
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'hello');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    expect(state.items.map((item) => (item.type === 'message' ? item.text : undefined))).toContain(
      'Hello world',
    );
  });

  it('enrich() is a no-op: the registered module supplies no vendor _meta promotion, so a v1 update flows through unchanged', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-ohmypi-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(ohmypiProviderModule);

    const sampleUpdate: AcpTranscriptUpdate = {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'hi',
    };
    expect(registry.enrich('ohmypi', sampleUpdate, { anything: true })).toBe(sampleUpdate);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'ohmypi' },
    );
    activeClient = client;

    const v0Updates: unknown[] = [];
    client.on('update', (update: unknown) => v0Updates.push(update));

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'hello');
    await turnEnd;

    // v0 pipeline pass-through, exactly as every existing consumer expects.
    expect(v0Updates.at(-1)).toMatchObject({ text: 'Hello world' });
  });
});
