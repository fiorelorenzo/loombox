import { AcpClient, ProviderRegistry } from '@loombox/providers-core';
import type { AcpPermissionOptionKind } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeProviderModule } from './provider';
import { mapClaudePermissionOptions } from './permissions';
import { hasClaudeBespokeWidget } from './tool-widgets';

// Protocol-conformance suite for issue #186: drives the Claude-shaped fixture
// (shared with packages/providers/core) through the real core AcpClient with
// claudeProviderModule registered, proving the adapter's registry wiring,
// enrich() no-op, permission-verb mapping, and bespoke-widget suppression
// signal all work together against a live (fixture) session — not mocks of
// any of them.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'test',
  'fixtures',
  'claude-like-acp-agent.mjs',
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

describe('claudeProviderModule conformance', () => {
  it('registers under "claude" and drives a permission-gated tool call end to end', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-claude-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(claudeProviderModule);
    expect(registry.lookup('claude')).toBe(claudeProviderModule);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'claude' },
    );
    activeClient = client;

    const initResult = await client.initialize();
    expect(initResult.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(initResult.agentCapabilities?.requestPermission).toBe(true);

    const sessionId = await client.newSession(workDir);

    let mappedButtons: ReturnType<typeof mapClaudePermissionOptions> | undefined;
    let wasBespoke: boolean | undefined;

    client.on(
      'permission_request',
      (request: {
        requestId: string;
        toolCall: { title?: string };
        options: { optionId: string; name: string; kind: AcpPermissionOptionKind }[];
      }) => {
        // The Claude adapter's own permission-verb mapping, exercised
        // against the request the fixture actually sent over the wire.
        mappedButtons = mapClaudePermissionOptions(request.options);
        wasBespoke = hasClaudeBespokeWidget(request.toolCall);

        const chosen = mappedButtons.find((b) => b.verb === 'allow_all_edits')!;
        client.permissions.resolve(request.requestId, {
          outcome: 'selected',
          optionId: chosen.optionId,
        });
      },
    );

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'edit-with-permission');
    await turnEnd;

    // Claude's real five-verb set, mapped from the fixture's actual options[].
    expect(mappedButtons?.map((b) => b.verb)).toEqual([
      'allow_once',
      'allow_all_edits',
      'bypass_everything',
      'allow_for_session',
      'deny',
    ]);
    // The "Edit" tool call routes to a bespoke widget, not the generic row.
    expect(wasBespoke).toBe(true);

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc1');
    expect(toolCall).toMatchObject({ status: 'completed', title: 'Edit', toolKind: 'edit' });

    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'edited (chose allow-all-edits)' });
  });

  it('enrich() is a no-op: a vendor _meta.claudeCode.parentToolUseId is not promoted in v1', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-claude-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(claudeProviderModule);

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'claude' },
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
    await client.prompt(sessionId, 'edit-with-permission');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc1');
    // The fixture sent `_meta.claudeCode.parentToolUseId` on the wire (see
    // claude-like-acp-agent.mjs); enrich() being a documented no-op means it
    // must NOT surface here yet.
    expect(toolCall).toMatchObject({ parentToolCallId: undefined });
  });

  it('registered module drives a plain (non-tool-call) turn unchanged', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-claude-conformance-'));

    const registry = new ProviderRegistry();
    registry.register(claudeProviderModule);
    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH], cwd: workDir },
      { registry, providerId: 'claude' },
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
});
