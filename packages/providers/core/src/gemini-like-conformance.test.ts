import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';

// Protocol-conformance coverage for issue #843: proves core's `session/load`
// fallback against a fixture shaped like Gemini CLI's real, live-recorded
// ACP handshake (docs/research/gemini-acp-completeness.md;
// packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json) — an
// agent that advertises `loadSession: true` and NO `sessionCapabilities` at
// all, so it implements exactly one session-lifecycle method
// (`session/load`) and none of ACP v1's newer ones (`session/resume`/
// `list`/`close`/`delete`, all genuinely unimplemented on the real binary,
// -32601 "Method not found" — same code as a deliberately bogus method
// name). No bespoke Gemini adapter code is loaded here: SPEC.md §5.5
// registers Gemini through the generic tier, so this fallback has to live
// and work at the core level, exactly like `claude-like-conformance.test.ts`
// / `codex-like-conformance.test.ts` prove the full-lifecycle path with no
// bespoke code loaded either.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'gemini-like-acp-agent.mjs',
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

function makeClient(): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH] });
  activeClient = client;
  return client;
}

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

async function spawnClient(fixturePath: string, prefix: string): Promise<AcpClient> {
  workDir = await mkdtemp(path.join(tmpdir(), prefix));
  const client = new AcpClient({ command: process.execPath, args: [fixturePath], cwd: workDir });
  activeClient = client;
  await client.initialize();
  return client;
}

async function spawnInitializedClient(): Promise<AcpClient> {
  workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-core-geminilike-'));
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
  activeClient = client;
  await client.initialize();
  return client;
}

describe('core capability reporting against a Gemini-shaped handshake (issue #843)', () => {
  it('advertises loadSession: true with no sessionCapabilities at all, matching the real recorded probe', async () => {
    const client = makeClient();
    const result = await client.initialize();
    expect(result.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
    });
  });

  it('[capability reporting says what is genuinely available] reports supportsResume: true, since AcpClient.resumeSession can actually resume this session via the session/load fallback', async () => {
    const client = makeClient();
    await client.initialize();
    expect(client.getFeatureFlags()).toEqual({
      supportsImages: true,
      supportsAudio: true,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: false,
    });
  });
});

describe('AcpClient.resumeSession: session/load fallback for a loadSession-only agent (issue #843)', () => {
  it('gets a working, resumed session: rounds-trips the replayed history with no duplicated or dropped items, exactly like a real session/resume would', async () => {
    const client = await spawnInitializedClient();

    const sessionId = await client.resumeSession('sess_gemini_prior', '/tmp/loombox-gemini-resume');

    // If AcpClient had wrongly sent `session/resume` instead of falling
    // back, the fixture (which only implements session/load) would answer
    // -32601 and this call would have rejected -- reaching this point at
    // all already proves the fallback fired. The replayed history itself
    // proves it did so correctly, coalescing the same intentional gap
    // session-lifecycle.test.ts's session/resume suite proves for a
    // full-lifecycle agent.
    const history = client.getHistory(sessionId);
    expect(history).toHaveLength(3);
    expect(history.filter((u) => u.kind === 'tool_call')).toHaveLength(1);
    expect(history.filter((u) => u.kind === 'agent_message_chunk')).toHaveLength(2);

    const state = client.getTranscriptState(sessionId);
    expect(state.items).toHaveLength(2); // one coalesced message + one tool call

    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'before-gap after-gap' });
  });

  it('a live prompt turn still works after the session/load fallback -- the resumed session is genuinely usable, not just resumable', async () => {
    const client = await spawnInitializedClient();
    const sessionId = await client.resumeSession('sess_gemini_prior', '/tmp/loombox-gemini-resume');

    const turnEnds: unknown[] = [];
    client.on('turn_end', (payload: unknown) => turnEnds.push(payload));
    await client.prompt(sessionId, 'hello again');

    expect(turnEnds).toEqual([{ messageId: 'msg_agent_1', stopReason: 'end_turn' }]);
    const state = client.getTranscriptState(sessionId);
    const messages = state.items.filter((item) => item.type === 'message');
    // The replayed "before-gap after-gap" message plus this turn's own "Hello world".
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ text: 'Hello world' });
  });

  it('session/resume, session/list, session/close, session/delete all still answer -32601 on this fixture, same as the real gemini-cli binary', async () => {
    const client = await spawnInitializedClient();
    await expect(client.listSessions()).rejects.toThrow(/Method not found.*session\/list/);
  });
});

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
