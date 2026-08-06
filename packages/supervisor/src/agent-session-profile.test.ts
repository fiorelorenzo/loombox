import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AcpProvider, PendingPermissionRequest } from '@loombox/providers-core';

import { AgentSession, type ToolProfileDenial } from './agent-session';
import type { AttentionState } from './transcript-store';

/**
 * D3-4's per-call enforcement chokepoint (issue #752): `AgentSession`'s
 * `evaluateToolProfile` gate over a REAL `session/request_permission`
 * round trip, using `@loombox/providers-core`'s own
 * `permission-acp-agent.mjs` fixture — the identical fixture and
 * assertion style `permission-integration.test.ts` already established
 * for the ungated case, so this suite proves the gate on top of infra
 * already known to work, not a second bespoke harness. Waits on the real
 * `'enqueued'` event the permission queue already emits rather than
 * polling, so there is nothing timer-based to flake under load.
 */
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'providers',
  'core',
  'test',
  'fixtures',
  'permission-acp-agent.mjs',
);

function permissionProvider(): AcpProvider {
  return {
    id: 'test-permission',
    spawnConfig: () => ({ command: process.execPath, args: [FIXTURE_PATH] }),
    enrich: (update) => update,
  };
}

let activeSession: AgentSession | undefined;

afterEach(() => {
  activeSession?.close();
  activeSession = undefined;
});

describe('AgentSession profile gate over a real session/request_permission (issue #752)', () => {
  it('a toolKind denial auto-rejects before the request ever queues, and the agent really receives the reply', async () => {
    const denial: ToolProfileDenial = {
      profileId: 'prof_ask',
      profileName: 'Ask First',
      matchedBy: 'tool-kind',
      rule: 'edit',
    };
    const session = await AgentSession.spawn(
      permissionProvider(),
      { command: process.execPath, args: [FIXTURE_PATH] },
      '/tmp/loombox-profile-test',
      { evaluateToolProfile: () => denial },
    );
    activeSession = session;

    const refusals: unknown[] = [];
    session.on('tool_profile_refusal', (payload: unknown) => refusals.push(payload));
    const attentionStates: AttentionState[] = [];
    session.on('attention', (state: AttentionState) => attentionStates.push(state));

    const updates: unknown[] = [];
    session.on('update', (update: unknown) => updates.push(update));

    await session.prompt('request-permission');

    // The fixture echoes what it received as the chosen outcome — proving
    // the auto-reject really reached the agent over the wire, not just
    // resolved some local-only bookkeeping.
    expect(updates.at(-1)).toMatchObject({ text: 'chose:deny' });

    // Never became a human-visible 'permission_required' — the whole point
    // of the gate is that a profile-denied call never reaches a human.
    expect(attentionStates.some((state) => state.status === 'permission_required')).toBe(false);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      toolCall: { title: 'Edit file', toolKind: 'edit' },
      denial,
    });

    // Nothing left pending on the queue either — resolved, not left dangling.
    expect(session.permissions.list(session.id)).toEqual([]);
  });

  it('a tool-name pattern denial matches on title the same way', async () => {
    const denial: ToolProfileDenial = {
      profileId: 'prof_min',
      profileName: 'Minimal',
      matchedBy: 'tool-name',
      rule: 'Edit *',
    };
    const session = await AgentSession.spawn(
      permissionProvider(),
      { command: process.execPath, args: [FIXTURE_PATH] },
      '/tmp/loombox-profile-test',
      { evaluateToolProfile: () => denial },
    );
    activeSession = session;

    const updates: unknown[] = [];
    session.on('update', (update: unknown) => updates.push(update));

    await session.prompt('request-permission');

    expect(updates.at(-1)).toMatchObject({ text: 'chose:deny' });
  });

  it('no active profile (evaluateToolProfile omitted) leaves the existing human-approval flow untouched', async () => {
    const session = await AgentSession.spawn(
      permissionProvider(),
      { command: process.execPath, args: [FIXTURE_PATH] },
      '/tmp/loombox-profile-test',
    );
    activeSession = session;

    const attentionStates: AttentionState[] = [];
    session.on('attention', (state: AttentionState) => attentionStates.push(state));

    const promptPromise = session.prompt('request-permission');
    const [pending] = (await once(session.permissions, 'enqueued')) as [PendingPermissionRequest];

    expect(attentionStates.some((state) => state.status === 'permission_required')).toBe(true);

    session.permissions.resolve(pending.requestId, { outcome: 'selected', optionId: 'allow' });
    await promptPromise;
  });

  it('switching mid-session applies from the very next call — the resolver is read fresh, never cached', async () => {
    const active: { denial?: ToolProfileDenial } = {};
    const session = await AgentSession.spawn(
      permissionProvider(),
      { command: process.execPath, args: [FIXTURE_PATH] },
      '/tmp/loombox-profile-test',
      { evaluateToolProfile: () => active.denial },
    );
    activeSession = session;

    // First call: no profile active yet — falls through to the normal FIFO
    // queue, same as the "no active profile" case above.
    const firstPromptPromise = session.prompt('request-permission');
    const [pending] = (await once(session.permissions, 'enqueued')) as [PendingPermissionRequest];
    session.permissions.resolve(pending.requestId, { outcome: 'selected', optionId: 'allow' });
    await firstPromptPromise;

    // Switch the profile "mid-session" (exactly what NodeDaemon's
    // `agent_profile_session_set` handler does to this same closure).
    active.denial = {
      profileId: 'prof_ask',
      profileName: 'Ask First',
      matchedBy: 'tool-kind',
      rule: 'edit',
    };

    const updates: unknown[] = [];
    session.on('update', (update: unknown) => updates.push(update));

    // Second call, same session, no restart: now denied. The fixture
    // reuses the same `messageId` for every "request-permission" prompt,
    // and the v0 `agent_message_chunk` reducer accumulates by messageId
    // across the whole session (`AgentSession`'s own `session.buffers`
    // cache) — so the received text is the full running buffer, not just
    // this turn's delta; asserting it ends with this turn's own outcome
    // is what actually proves this second call.
    await session.prompt('request-permission');
    const last = updates.at(-1) as { text?: string };
    expect(last.text?.endsWith('chose:deny')).toBe(true);
  });
});
