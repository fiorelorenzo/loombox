import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';

// Protocol-conformance coverage for issue #844: proves core's generic
// config-option mapping/`setConfigOption` machinery handles Gemini's real,
// vendor-only `models` axis (`session/new`'s `models` sub-object, paired
// with the separate `unstable_setSessionModel`/`session/set_model` wire
// method) entirely generically — the `'model'` category this produces
// flows through the exact same `ConfigOptionStore`/`ConfigBar` popover
// every other category already uses (issue #711), with no bespoke Gemini
// UI. See `test/fixtures/gemini-like-acp-agent.mjs`'s own header for the
// full citation trail behind the wire shapes this fixture sends.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'gemini-like-acp-agent.mjs',
);

// Reused as-is for issue #844's "unaffected agent" proof: its `session/new`
// result is `{sessionId}` only — no `configOptions`, no `modes`, no
// `models` — the most minimal case an agent lacking Gemini's vendor
// extension can send.
const NO_MODELS_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'codex-like-acp-agent.mjs',
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

async function spawnClient(fixturePath: string, prefix: string): Promise<AcpClient> {
  workDir = await mkdtemp(path.join(tmpdir(), prefix));
  const client = new AcpClient({ command: process.execPath, args: [fixturePath], cwd: workDir });
  activeClient = client;
  await client.initialize();
  return client;
}

describe('core config-option state against a Gemini-shaped `models` vendor axis (issue #844)', () => {
  it("seeds a new session's catalogue with a `model` category folded from session/new's real vendor `models` field, alongside the ordinary `mode` category folded from `modes` — both present, neither duplicated", async () => {
    const client = await spawnClient(FIXTURE_PATH, 'loombox-providers-core-geminilike-');
    const sessionId = await client.newSession(workDir!);

    const options = client.configOptions.get(sessionId);
    const model = options.find((option) => option.category === 'model');
    expect(model?.current).toBe('auto');
    expect(model?.choices).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
    ]);
    expect(options.filter((option) => option.category === 'model')).toHaveLength(1);

    const mode = options.find((option) => option.category === 'mode');
    expect(mode?.current).toBe('default');
    expect(options.filter((option) => option.category === 'mode')).toHaveLength(1);
  });

  it("routes a `model` change through the real unstable_setSessionModel/session/set_model wire request and reaches the fixture agent — proven by a second, independent round trip reading the value back, not by trusting the client's own optimistic update", async () => {
    const client = await spawnClient(FIXTURE_PATH, 'loombox-providers-core-geminilike-');
    const sessionId = await client.newSession(workDir!);

    const options = await client.setConfigOption(sessionId, 'model', 'gemini-2.5-flash');
    expect(options.find((option) => option.category === 'model')?.current).toBe('gemini-2.5-flash');

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'which-model');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'gemini-2.5-flash' });
  });

  it('rejects an unsupported modelId rather than silently applying it, leaving the stored selection untouched — the same reject-not-swallow contract the ordinary session/set_config_option path already has', async () => {
    const client = await spawnClient(FIXTURE_PATH, 'loombox-providers-core-geminilike-');
    const sessionId = await client.newSession(workDir!);

    await expect(client.setConfigOption(sessionId, 'model', 'not-a-real-model')).rejects.toThrow(
      /Invalid params/,
    );

    const options = client.configOptions.get(sessionId);
    expect(options.find((option) => option.category === 'model')?.current).toBe('auto');
  });
});

describe('core config-option state stays unaffected for an agent that never advertises the vendor `models` axis (issue #844)', () => {
  it('leaves the catalogue empty rather than inventing a `model` category from nothing, and `setConfigOption` still throws its ordinary "no catalogue entry" error for it — the vendor fold introduces no new failure mode', async () => {
    const client = await spawnClient(
      NO_MODELS_FIXTURE_PATH,
      'loombox-providers-core-geminilike-unaffected-',
    );
    const sessionId = await client.newSession(workDir!);

    expect(client.configOptions.get(sessionId)).toEqual([]);

    await expect(client.setConfigOption(sessionId, 'model', 'x')).rejects.toThrow(
      /no catalogue entry for category "model"/,
    );
  });
});
