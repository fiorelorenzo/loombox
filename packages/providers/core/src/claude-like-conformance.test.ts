import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
import type { TranscriptToolCallItem } from './transcript';
import type { AcpPermissionOptionKind } from './types';

// Protocol-conformance coverage for issue #186: proves core's reducer and
// registry handle a Claude-shaped update stream (a tool_call with a diff, a
// session/request_permission round trip, and a ResourceLink content block)
// entirely generically, with no bespoke Claude code loaded — the same
// fixture packages/providers/claude's own conformance suite drives with its
// adapter module attached.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
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

async function spawnClient(): Promise<AcpClient> {
  workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-core-claudelike-'));
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
  activeClient = client;
  await client.initialize();
  return client;
}

describe('core reducer against a Claude-shaped update stream', () => {
  it('reduces a tool_call diff, drives a permission round trip, and updates status', async () => {
    const client = await spawnClient();
    const sessionId = await client.newSession(workDir!);

    const permission = new Promise<void>((resolve) => {
      client.on(
        'permission_request',
        (request: {
          requestId: string;
          options: { optionId: string; kind: AcpPermissionOptionKind }[];
        }) => {
          const chosen = request.options.find((o) => o.optionId === 'allow-all-edits')!;
          client.permissions.resolve(request.requestId, {
            outcome: 'selected',
            optionId: chosen.optionId,
          });
          resolve();
        },
      );
    });

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'edit-with-permission');
    await Promise.all([permission, turnEnd]);

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc1');
    expect(toolCall).toBeDefined();
    expect(toolCall).toMatchObject({
      status: 'completed',
      toolKind: 'edit',
      title: 'Edit',
      diff: { path: 'src/foo.ts', oldText: 'old\n', newText: 'new\n' },
      // v1's enrich() is a documented no-op (issue #184): the vendor `_meta`
      // Claude sent on the wire must not surface as parentToolCallId yet.
      parentToolCallId: undefined,
    });

    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'edited (chose allow-all-edits)' });
  });

  it('round-trips a ResourceLink content block with no bespoke handling', async () => {
    const client = await spawnClient();
    const sessionId = await client.newSession(workDir!);

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'resource-link');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find(
      (item) => item.type === 'tool_call' && item.id === 'tc-rl',
    ) as TranscriptToolCallItem | undefined;
    expect(toolCall).toBeDefined();
    expect(toolCall?.content).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///tmp/loombox-image-abc123/deadbeef.png',
        name: 'screenshot.png',
        mimeType: 'image/png',
      },
    ]);
  });
});
