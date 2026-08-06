import { AcpClient, ProviderRegistry } from '@loombox/providers-core';
import type { AcpPermissionOptionKind, AcpToolKind } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { codexProviderModule } from './provider';
import { buildCodexImageContentBlock } from './image';
import { mapCodexPermissionOptions } from './permissions';
import { hasCodexBespokeWidget } from './tool-widgets';

// Protocol-conformance suite for issue #186's Codex half: drives the
// Codex-shaped fixture (shared with packages/providers/core) through the
// real core AcpClient with codexProviderModule registered, proving the
// adapter's registry wiring, enrich() no-op, permission-verb mapping, and
// bespoke-widget suppression signal all work together against a live
// (fixture) session — not mocks of any of them.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
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

describe('codexProviderModule conformance', () => {
  it('registers under "codex" and drives a permission-gated tool call end to end', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);
    expect(registry.lookup('codex')).toBe(codexProviderModule);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    const initResult = await client.initialize();
    expect(initResult.agentCapabilities?.promptCapabilities?.image).toBe(true);
    // `requestPermission` was never a real ACP capability field (issue
    // #821) -- session/request_permission is answered unconditionally, not
    // gated by anything `initialize` advertises. What IS real and worth
    // asserting here: the fixture's negotiated, real-shaped
    // sessionCapabilities round-trip through initialize() intact.
    expect(initResult.agentCapabilities?.sessionCapabilities?.delete).toEqual({});

    const sessionId = await client.newSession(workDir);

    let mappedButtons: ReturnType<typeof mapCodexPermissionOptions> | undefined;
    let wasBespoke: boolean | undefined;

    client.on(
      'permission_request',
      (request: {
        requestId: string;
        toolCall: { title?: string; toolKind?: AcpToolKind };
        options: { optionId: string; name: string; kind: AcpPermissionOptionKind }[];
      }) => {
        // The Codex adapter's own permission-verb mapping, exercised against
        // the request the fixture actually sent over the wire.
        mappedButtons = mapCodexPermissionOptions(request.options);
        wasBespoke = hasCodexBespokeWidget(request.toolCall);

        const chosen = mappedButtons.find((b) => b.verb === 'yes_for_session')!;
        client.permissions.resolve(request.requestId, {
          outcome: 'selected',
          optionId: chosen.optionId,
        });
      },
    );

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'patch-with-permission');
    await turnEnd;

    // Codex's real three-verb set, mapped from the fixture's actual options[].
    expect(mappedButtons?.map((b) => b.verb)).toEqual([
      'yes',
      'yes_for_session',
      'stop_and_explain',
    ]);
    // The fixture's tool-call title ("Patch") is synthetic and, by design,
    // does not match real Codex's actual literal title ("Editing files") —
    // see this fixture's own header comment and
    // docs/research/codex-acp-completeness.md #3 (issue #819). Post-#819,
    // `hasCodexBespokeWidget` correctly falls through to the generic row
    // here; the real-shape proof against Codex's actual title lives in
    // codex-acp-capabilities.test.ts's real-shape conformance section.
    expect(wasBespoke).toBe(false);

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc1');
    expect(toolCall).toMatchObject({ status: 'completed', title: 'Patch', toolKind: 'edit' });

    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'patched (chose yes-for-session)' });
  });

  it('classifies the Bash bespoke tool call with no permission round trip', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);
    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'bash-tool');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc-bash');
    expect(toolCall).toMatchObject({ status: 'completed', title: 'Bash', toolKind: 'execute' });
    if (toolCall?.type !== 'tool_call') throw new Error('expected a tool_call item');
    // Passes for the right (structural) reason post-#819: toolKind alone
    // (`'execute'`) identifies a Codex bash call, so this holds regardless
    // of the fixture's synthetic "Bash" title text.
    expect(hasCodexBespokeWidget(toolCall)).toBe(true);
  });

  it('enrich() is a no-op: Codex has no confirmed parent-link signal in v1', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    client.on(
      'permission_request',
      (request: { requestId: string; options: { optionId: string }[] }) => {
        client.permissions.resolve(request.requestId, {
          outcome: 'selected',
          optionId: request.options[0]!.optionId,
        });
      },
    );

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'patch-with-permission');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc1');
    expect(toolCall).toMatchObject({ parentToolCallId: undefined });
  });

  it('registered module drives a plain (non-tool-call) turn unchanged', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);
    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'hello');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    expect(state.items.map((i) => (i.type === 'message' ? i.text : undefined))).toContain(
      'Hello world',
    );
  });

  it('an attached image reaches the Codex agent turn as an inline base64 content block (SPEC.md §7.25; issue #158)', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);
    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    const initResult = await client.initialize();
    expect(client.getFeatureFlags().supportsImages).toBe(true);
    const sessionId = await client.newSession(workDir);

    // A tiny real PNG (8-byte magic + a couple of IHDR-shaped bytes) run
    // through the exact same builder `@loombox/node`'s `deliverPrompt`
    // calls once an attachment resolves — this proves the payload it hands
    // to `AcpClient.prompt()` is exactly what the Codex-shaped fixture
    // receives over the real JSON-RPC wire, not just what the builder
    // produces in isolation (already covered by `image.test.ts`).
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const handoff = buildCodexImageContentBlock(pngBytes, {
      imageCapabilityNegotiated: initResult.agentCapabilities?.promptCapabilities?.image ?? false,
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) throw new Error('expected the image hand-off to succeed');

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'describe-image', [handoff.block]);
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const expectedBase64Length = Buffer.from(pngBytes).toString('base64').length;
    expect(state.items.map((i) => (i.type === 'message' ? i.text : undefined))).toContain(
      `received image: image/png ${expectedBase64Length}b64`,
    );
  });

  it('surfaces the agent declining an attached image as a rejected prompt (same JSON-RPC error path as any other declined turn)', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-codex-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(codexProviderModule);
    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'codex' },
    );
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const handoff = buildCodexImageContentBlock(pngBytes, { imageCapabilityNegotiated: true });
    if (!handoff.ok) throw new Error('expected the image hand-off to succeed');

    await expect(client.prompt(sessionId, 'reject-image', [handoff.block])).rejects.toThrow(
      /declined attached image/,
    );
  });
});
