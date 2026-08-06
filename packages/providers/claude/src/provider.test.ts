import { AcpClient } from '@loombox/providers-core';
import type { AcpUpdate } from '@loombox/providers-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeParentToolCallId, claudeProvider, claudeProviderModule } from './provider';

// The real `claude` binary (what claudeProvider.spawnConfig() actually
// launches) can't be exercised headlessly in this dev environment, so this
// integration test drives the SAME fixture ACP agent used by
// packages/providers/core through the core AcpClient for one prompt/response
// turn, proving the claude adapter package's wiring (its enrich() no-op and
// its use of AcpClient) without a real Claude Code install. Real-Claude
// validation happens later, in issue #54 (human-gated).
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

describe('claudeProvider', () => {
  it('is registered under id "claude" and enrich() is a no-op', () => {
    expect(claudeProvider.id).toBe('claude');

    const update: AcpUpdate = { kind: 'agent_message_chunk', messageId: 'm1', text: 'hi' };
    expect(claudeProvider.enrich(update)).toEqual(update);
  });

  // Regression guard for issue #382: the predecessor package
  // (`@zed-industries/claude-code-acp`) is deprecated and now prints a
  // startup notice pointing at this maintained successor. Both the v0
  // `claudeProvider` and v1 `claudeProviderModule` spawn configs must name
  // it, via the same `npx -y <package>` launch pattern.
  it('spawnConfig() launches the maintained @agentclientprotocol/claude-agent-acp bridge via npx', () => {
    const spawnConfig = claudeProvider.spawnConfig({ cwd: '/tmp/example' });
    expect(spawnConfig.command).toBe('npx');
    expect(spawnConfig.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp']);

    const moduleSpawnConfig = claudeProviderModule.spawnConfig({ cwd: '/tmp/example' });
    expect(moduleSpawnConfig.command).toBe('npx');
    expect(moduleSpawnConfig.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp']);
  });

  // requiredCommand is the field the design spec's per-TARGET availability
  // probe reads (issue coverage for that new AcpProviderModule field): it
  // must name the vendor CLI the npx bridge wraps, never the npx launcher
  // itself, or a target with claude-agent-acp cached but no real `claude`
  // binary would be advertised as able to run Claude Code.
  it('requiredCommand names the vendor CLI (claude), never the npx launcher', () => {
    expect(claudeProviderModule.requiredCommand).toBe('claude');
    expect(claudeProviderModule.requiredCommand).not.toBe('npx');
  });

  it('drives a full prompt/response turn through the fixture ACP agent', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'loombox-providers-claude-'));

    // spawnConfig() names the real claude-agent-acp bridge; swap in the
    // fixture's command/args here since the real bridge isn't runnable
    // headlessly, but exercise the same cwd claudeProvider would compute.
    const spawnConfig = claudeProvider.spawnConfig({ cwd: workDir });
    expect(spawnConfig.cwd).toBe(workDir);

    const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH], cwd: workDir });
    activeClient = client;

    await client.initialize();
    const sessionId = await client.newSession(workDir);

    const updates: AcpUpdate[] = [];
    let turnEnded = false;
    client.on('update', (update: AcpUpdate) => updates.push(claudeProvider.enrich(update)));
    client.on('turn_end', () => {
      turnEnded = true;
    });

    await client.prompt(sessionId, 'hello from a temp dir');

    expect(turnEnded).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)?.text).toBe('Hello world');
  });
});

describe('claudeParentToolCallId (issue #199/#200)', () => {
  it('reads _meta.claudeCode.parentToolUseId off a raw wire update', () => {
    const raw = { _meta: { claudeCode: { parentToolUseId: 'toolu_root' } } };
    expect(claudeParentToolCallId(raw)).toBe('toolu_root');
  });

  it('returns undefined for a raw update with no _meta at all', () => {
    expect(claudeParentToolCallId({ sessionUpdate: 'tool_call' })).toBeUndefined();
  });

  it('returns undefined for _meta from a different vendor namespace (e.g. Codex)', () => {
    expect(
      claudeParentToolCallId({ _meta: { codex: { subagent: { threadId: 't1' } } } }),
    ).toBeUndefined();
  });

  it('never throws on a malformed/non-object raw payload', () => {
    expect(claudeParentToolCallId(undefined)).toBeUndefined();
    expect(claudeParentToolCallId(null)).toBeUndefined();
    expect(claudeParentToolCallId('a string')).toBeUndefined();
    expect(claudeParentToolCallId(42)).toBeUndefined();
    expect(claudeParentToolCallId({ _meta: null })).toBeUndefined();
    expect(claudeParentToolCallId({ _meta: { claudeCode: null } })).toBeUndefined();
    expect(
      claudeParentToolCallId({ _meta: { claudeCode: { parentToolUseId: 42 } } }),
    ).toBeUndefined();
    expect(
      claudeParentToolCallId({ _meta: { claudeCode: { parentToolUseId: '' } } }),
    ).toBeUndefined();
  });
});

describe('claudeProviderModule.enrich (issue #200)', () => {
  it('leaves a message-chunk update untouched — no parentToolCallId field exists on that shape', () => {
    const update = {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'hi',
    } as const;
    const raw = { _meta: { claudeCode: { parentToolUseId: 'toolu_root' } } };
    expect(claudeProviderModule.enrich!(update, raw)).toBe(update);
  });

  it('never clobbers a parentToolCallId the update already carries', () => {
    const update = {
      kind: 'tool_call' as const,
      id: 'tc1',
      parentToolCallId: 'already-set',
    };
    const raw = { _meta: { claudeCode: { parentToolUseId: 'toolu_root' } } };
    expect(claudeProviderModule.enrich!(update, raw)).toBe(update);
  });

  it('promotes parentToolCallId from raw _meta onto a bare tool_call update', () => {
    const update = { kind: 'tool_call' as const, id: 'tc1' };
    const raw = { _meta: { claudeCode: { parentToolUseId: 'toolu_root' } } };
    expect(claudeProviderModule.enrich!(update, raw)).toEqual({
      ...update,
      parentToolCallId: 'toolu_root',
    });
  });

  it('passes a tool_call update through unchanged when raw carries no Claude _meta', () => {
    const update = { kind: 'tool_call' as const, id: 'tc1' };
    expect(claudeProviderModule.enrich!(update, undefined)).toBe(update);
  });
});
