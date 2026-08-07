import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  computeToolCallNesting,
  createTranscriptState,
  reduceTranscript,
} from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { codexProviderModule } from './provider';

/**
 * Build-time verification spike for issue #199 (epic #12): does Codex's ACP
 * bridge expose an equivalent to Claude Code's `_meta.claudeCode.
 * parentToolUseId` (the signal issue #200's subagent/nested-tool-call tree
 * rendering keys on)? Full writeup, with a citation per claim, lives in
 * `docs/research/codex-parent-tool-call-signal.md` — this suite is that
 * doc's "executable check" half.
 *
 * Same method issue #182 established (`docs/research/
 * codex-acp-completeness.md`, this package's `codex-acp-capabilities.test.ts`):
 * read the REAL, installed `@agentclientprotocol/codex-acp` package — a
 * pinned `devDependency` of this package since #182, never a runtime one —
 * directly out of `node_modules`, rather than trusting a doc comment or a
 * hand-copied snippet. `dist/index.js` is an esbuild bundle that keeps the
 * original `src/*.ts` path comments and every identifier/string verbatim
 * (confirmed by reading it), so a source-text assertion against it is a
 * faithful, reproducible proxy for the real TypeScript source, and a
 * `file:line` citation against it is real, not paraphrased.
 *
 * The version pin below is intentionally exact, matching
 * `codex-acp-capabilities.test.ts`'s own pin: bump it to pick up a newer
 * `codex-acp` release, and if that release adds a real per-tool-call parent
 * link (or removes/renames one of the shapes this suite depends on), the
 * relevant assertion here goes red instead of this finding silently going
 * stale.
 */
const VERIFIED_CODEX_ACP_VERSION = '1.1.10';

const require = createRequire(import.meta.url);
const codexAcpPackageJsonPath = require.resolve('@agentclientprotocol/codex-acp/package.json');
const codexAcpPackageDir = path.dirname(codexAcpPackageJsonPath);
const codexAcpPackageJson = JSON.parse(readFileSync(codexAcpPackageJsonPath, 'utf8')) as {
  version?: string;
};
const codexAcpSource = readFileSync(path.join(codexAcpPackageDir, 'dist', 'index.js'), 'utf8');

describe('real @agentclientprotocol/codex-acp source — subagent parent-tool-call signal (issue #199 build-time verification spike)', () => {
  it('is pinned to the exact version this spike verified, so a version bump is a deliberate re-verification', () => {
    expect(codexAcpPackageJson.version).toBe(VERIFIED_CODEX_ACP_VERSION);
  });

  it('never emits a parentToolCallId/parentToolUseId-equivalent field anywhere in the bundle', () => {
    // The two spellings a client-side promotion would actually look for
    // (loombox's own field name, and Claude's vendor `_meta` name).
    expect(codexAcpSource).not.toContain('parentToolCallId');
    expect(codexAcpSource).not.toContain('parentToolUseId');
    // Belt-and-suspenders sweep of the WHOLE 31k-line bundle for ANY
    // differently-named camelCase "parent*Id" field — not just the two
    // known spellings above — so a future release inventing its own name
    // for the same concept still trips this.
    expect(codexAcpSource).not.toMatch(/parent[A-Za-z]*Id/);
  });

  it('represents a spawned subagent as exactly two item types, both thread-scoped, neither carrying a tool-call parent link (dist/index.js:23067-23143)', () => {
    // createCollabAgentToolCallMeta -- the ONE summarizing "spawn" tool
    // call's own _meta: a sender/receiver THREAD id pair, never a
    // toolCallId.
    expect(codexAcpSource).toContain(
      'function createCollabAgentToolCallMeta(item) {\n' +
        '  return {\n' +
        '    codex: {\n' +
        '      collaboration: {\n' +
        '        tool: item.tool,\n' +
        '        senderThreadId: item.senderThreadId,\n' +
        '        receiverThreadIds: item.receiverThreadIds\n' +
        '      }\n' +
        '    }\n' +
        '  };\n' +
        '}',
    );
    // createSubAgentActivityUpdate -- the "Start subagent X" / "Interact
    // with subagent X" / "Interrupt subagent X" activity marker's own
    // _meta: a threadId (the CHILD's own thread), never the spawning call's
    // toolCallId either.
    expect(codexAcpSource).toContain(
      '_meta: {\n' +
        '      codex: {\n' +
        '        subagent: {\n' +
        '          threadId: item.agentThreadId,\n' +
        '          path: item.agentPath,\n' +
        '          activity: item.kind\n' +
        '        }\n' +
        '      }\n' +
        '    }',
    );
  });

  it('the 18-member item-type union both item-lifecycle switches dispatch on is exactly this pinned set — a new member is exactly how a real per-child parent link would arrive one day, and must be reviewed, not silently pass (dist/index.js:23867-23910)', () => {
    const KNOWN_ITEM_TYPES = [
      'agentMessage',
      'collabAgentToolCall',
      'commandExecution',
      'contextCompaction',
      'dynamicToolCall',
      'enteredReviewMode',
      'exitedReviewMode',
      'fileChange',
      'hookPrompt',
      'imageGeneration',
      'imageView',
      'mcpToolCall',
      'plan',
      'reasoning',
      'sleep',
      'subAgentActivity',
      'userMessage',
      'webSearch',
    ].sort();

    const createItemEventStart = codexAcpSource.indexOf('async createItemEvent(event) {');
    const completeItemEventStart = codexAcpSource.indexOf('async completeItemEvent(event) {');
    // Sanity: both anchors must still exist before slicing between them --
    // an absent anchor would silently produce an empty (vacuously-passing)
    // slice otherwise.
    expect(createItemEventStart).toBeGreaterThan(-1);
    expect(completeItemEventStart).toBeGreaterThan(createItemEventStart);

    const createItemEventBody = codexAcpSource.slice(createItemEventStart, completeItemEventStart);
    const foundTypes = Array.from(
      new Set([...createItemEventBody.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1])),
    ).sort();
    expect(foundTypes).toEqual(KNOWN_ITEM_TYPES);
  });

  it("subscribes to only the ACP session's OWN thread id, never a spawned subagent's receiver thread — a second subscription call is exactly how per-child forwarding would start (dist/index.js:26765-26793,30204-30212)", () => {
    expect(codexAcpSource).toContain(
      'await this.codexAcpClient.subscribeToSessionEvents(\n        params.sessionId,',
    );
    // Exactly two occurrences in the whole bundle: the method's own
    // definition, and this one call site. A second call site subscribing
    // to a `receiverThreadIds` entry would be new evidence a child's own
    // tool calls might now reach this bridge.
    const occurrences = codexAcpSource.match(/subscribeToSessionEvents\(/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it('routes a notification by threadId to a single registered handler and silently drops it when no handler is registered for that thread — proves the single-subscription finding above is an active exclusion, not merely an unused capability (dist/index.js:31089-31101)', () => {
    expect(codexAcpSource).toContain(
      'notify(notification) {\n' +
        '    const threadId = extractThreadId(notification);\n' +
        '    if (threadId !== null) {\n' +
        '      const handler = this.notificationHandlers.get(threadId);\n' +
        '      if (handler) {\n' +
        '        handler(notification);\n' +
        '      }\n' +
        '      return;\n' +
        '    }',
    );
  });
});

describe('real-shape conformance: codexProviderModule.enrich() against real Codex subagent wire shapes (issue #199/#200)', () => {
  it("promotes nothing from a real collabAgentToolCall spawn payload's _meta — there is no tool-call-id-shaped field to promote (dist/index.js:23067-23076,23099-23108)", () => {
    const update = {
      kind: 'tool_call' as const,
      id: 'call-collab-1',
      title: 'Task',
      toolKind: 'other' as const,
      status: 'in_progress' as const,
    };
    // The real wire shape createCollabAgentToolCallUpdate/
    // createCollabAgentToolCallMeta actually emit for a spawn call.
    const raw = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-collab-1',
      kind: 'other',
      title: 'Task',
      status: 'in_progress',
      rawInput: {
        prompt: 'run pwd',
        senderThreadId: 'thread-parent',
        receiverThreadIds: ['thread-child'],
        agentsStates: {},
        model: 'gpt-5-codex',
        reasoningEffort: 'medium',
        status: 'in_progress',
      },
      _meta: {
        codex: {
          collaboration: {
            tool: 'Task',
            senderThreadId: 'thread-parent',
            receiverThreadIds: ['thread-child'],
          },
        },
      },
    };
    expect(codexProviderModule.enrich!(update, raw)).toBe(update);
  });

  it("promotes nothing from a real subAgentActivity payload either — its _meta.codex.subagent carries the CHILD's threadId, never the spawning call's toolCallId (dist/index.js:23110-23138)", () => {
    const update = {
      kind: 'tool_call' as const,
      id: 'call-activity-1',
      title: 'Start subagent worker',
      toolKind: 'other' as const,
      status: 'in_progress' as const,
    };
    const raw = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-activity-1',
      title: 'Start subagent worker',
      kind: 'other',
      status: 'in_progress',
      rawInput: {
        agentThreadId: 'thread-child',
        agentPath: '/root/worker',
        activityKind: 'started',
      },
      _meta: {
        codex: {
          subagent: {
            threadId: 'thread-child',
            path: '/root/worker',
            activity: 'started',
          },
        },
      },
    };
    expect(codexProviderModule.enrich!(update, raw)).toBe(update);
  });

  it("end-to-end through the real reducer: both real Codex subagent item shapes still render at depth 0 (flat) — issue #200's own explicit \"a session/provider without a parent link renders flat\" acceptance criterion, proven against Codex's actual wire shapes, not just Claude's absence of one", () => {
    const collabUpdate = {
      kind: 'tool_call' as const,
      id: 'call-collab-1',
      title: 'Task',
      toolKind: 'other' as const,
      status: 'completed' as const,
    };
    const collabRaw = {
      _meta: {
        codex: {
          collaboration: {
            tool: 'Task',
            senderThreadId: 'thread-parent',
            receiverThreadIds: ['thread-child'],
          },
        },
      },
    };
    const activityUpdate = {
      kind: 'tool_call' as const,
      id: 'call-activity-1',
      title: 'Start subagent worker',
      toolKind: 'other' as const,
      status: 'completed' as const,
    };
    const activityRaw = {
      _meta: {
        codex: {
          subagent: { threadId: 'thread-child', path: '/root/worker', activity: 'started' },
        },
      },
    };

    let state = createTranscriptState();
    state = reduceTranscript(state, codexProviderModule.enrich!(collabUpdate, collabRaw));
    state = reduceTranscript(state, codexProviderModule.enrich!(activityUpdate, activityRaw));

    const nesting = computeToolCallNesting(state.items);
    expect(nesting.get('call-collab-1')).toEqual({ depth: 0, parentTitle: undefined });
    expect(nesting.get('call-activity-1')).toEqual({ depth: 0, parentTitle: undefined });
  });
});
