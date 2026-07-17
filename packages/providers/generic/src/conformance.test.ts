import { AcpClient, ProviderRegistry } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyGenericToolKind } from './tool-kind';
import { mapGenericPermissionOptions } from './permissions';
import { createGenericProvider } from './provider';

// Protocol-conformance suite for issue #186/#183: proves any ACP-speaking
// agent, registered with no bespoke adapter module at all, drives a working
// session through core alone plus this package's pure helpers — no mocks of
// AcpClient/ProviderRegistry/the transcript reducer.
const CORE_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'test',
  'fixtures',
);
const ECHO_FIXTURE = path.join(CORE_FIXTURES, 'echo-acp-agent.mjs');
const PERMISSION_FIXTURE = path.join(CORE_FIXTURES, 'permission-acp-agent.mjs');
const CLAUDE_LIKE_FIXTURE = path.join(CORE_FIXTURES, 'claude-like-acp-agent.mjs');

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

describe('generic fallback tier conformance', () => {
  it('a bare ACP agent registered under a new id with no adapter module produces a working session', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-generic-conformance-'));

    const registry = new ProviderRegistry();
    // Deliberately register NOTHING under 'some-random-agent' — proving the
    // "no bespoke module needed" claim, rather than registering
    // createGenericProvider's own module (exercised separately below).
    const client = new AcpClient(
      { command: process.execPath, args: [ECHO_FIXTURE], cwd: workDir },
      { registry, providerId: 'some-random-agent' },
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

  it('createGenericProvider computes the real spawn command and registers cleanly', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-generic-conformance-'));

    const registry = new ProviderRegistry();
    const provider = createGenericProvider('some-random-agent', {
      command: process.execPath,
      args: [ECHO_FIXTURE],
    });
    registry.register(provider);

    const spawnConfig = provider.spawnConfig({ cwd: workDir });
    const client = new AcpClient(spawnConfig, { registry, providerId: 'some-random-agent' });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);
    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'hello');
    await turnEnd;

    expect(client.getTranscriptState(sessionId).items.length).toBeGreaterThan(0);
  });

  it('maps a real permission request onto Allow/Deny with no "always" variant present', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-generic-conformance-'));
    const client = new AcpClient({
      command: process.execPath,
      args: [PERMISSION_FIXTURE],
      cwd: workDir,
    });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    let mapped: ReturnType<typeof mapGenericPermissionOptions> | undefined;
    client.on(
      'permission_request',
      (request: {
        requestId: string;
        options: {
          optionId: string;
          name: string;
          kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
        }[];
      }) => {
        mapped = mapGenericPermissionOptions(request.options);
        const allow = mapped.find((b) => b.verb === 'allow')!;
        client.permissions.resolve(request.requestId, {
          outcome: 'selected',
          optionId: allow.optionId,
        });
      },
    );

    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'request-permission');
    await turnEnd;

    expect(mapped).toEqual([
      { optionId: 'allow', label: 'Allow', verb: 'allow' },
      { optionId: 'deny', label: 'Deny', verb: 'deny' },
    ]);
  });

  it('classifies a tool call generically and round-trips a ResourceLink content block', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-generic-conformance-'));
    const client = new AcpClient({
      command: process.execPath,
      args: [CLAUDE_LIKE_FIXTURE],
      cwd: workDir,
    });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);
    const turnEnd = new Promise<void>((resolve) => client.once('turn_end', () => resolve()));
    await client.prompt(sessionId, 'resource-link');
    await turnEnd;

    const state = client.getTranscriptState(sessionId);
    const toolCall = state.items.find((item) => item.type === 'tool_call' && item.id === 'tc-rl');
    expect(toolCall).toBeDefined();
    if (toolCall?.type !== 'tool_call') throw new Error('expected a tool_call item');

    expect(classifyGenericToolKind(toolCall)).toBe('read');
    expect(toolCall.content).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///tmp/loombox-image-abc123/deadbeef.png',
        name: 'screenshot.png',
        mimeType: 'image/png',
      },
    ]);
  });
});
