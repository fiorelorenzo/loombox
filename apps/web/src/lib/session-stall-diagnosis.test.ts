import { describe, expect, it } from 'vitest';

import { diagnoseSessionStall, type StallDiagnosisInput } from './session-stall-diagnosis';

function input(overrides: Partial<StallDiagnosisInput> = {}): StallDiagnosisInput {
  return {
    status: 'working',
    statusReason: undefined,
    queueReason: undefined,
    targetUnreachable: undefined,
    targetHealthSampledAt: undefined,
    ...overrides,
  };
}

describe('diagnoseSessionStall (issue #271)', () => {
  it('reports "queued_at_capacity" for a queued session, using #255\'s own queue-position wording verbatim', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'queued', queueReason: 'position 2 of 3 waiting for a slot' }),
    );
    expect(diagnosis).toEqual({
      cause: 'queued_at_capacity',
      message: 'position 2 of 3 waiting for a slot',
    });
  });

  it('still names the cause for a queued session with no queueReason supplied (defensive fallback, never blank)', () => {
    const diagnosis = diagnoseSessionStall(input({ status: 'queued', queueReason: undefined }));
    expect(diagnosis.cause).toBe('queued_at_capacity');
    expect(diagnosis.message).toContain('queued');
  });

  it('reports "agent_unavailable" for an exited session, using the node-sent exit-code reason verbatim', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'exited', statusReason: 'agent process exited (exit code 1)' }),
    );
    expect(diagnosis).toEqual({
      cause: 'agent_unavailable',
      message: 'agent process exited (exit code 1)',
    });
  });

  it('reports "agent_unavailable" for an errored session, using the node-sent reason verbatim', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'error', statusReason: 'agent spawn did not complete within 120000ms' }),
    );
    expect(diagnosis).toEqual({
      cause: 'agent_unavailable',
      message: 'agent spawn did not complete within 120000ms',
    });
  });

  it('reports "agent_unavailable" for a disconnected session even with no node-sent reason (session-manager.ts already knows the agent process is gone)', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'disconnected', statusReason: undefined }),
    );
    expect(diagnosis.cause).toBe('agent_unavailable');
    expect(diagnosis.message).toMatch(/resume/i);
  });

  it('falls back to a generic-but-honest message for exited/error with no reason, rather than inventing a specific one', () => {
    const diagnosis = diagnoseSessionStall(input({ status: 'exited', statusReason: undefined }));
    expect(diagnosis.cause).toBe('agent_unavailable');
    expect(diagnosis.message).toBe(
      'the agent process is no longer running, with no further detail from the node',
    );
  });

  it('reports "target_unreachable" for a still-"working" session whose target has no live node connection', () => {
    const diagnosis = diagnoseSessionStall(
      input({
        status: 'working',
        targetUnreachable: true,
        targetHealthSampledAt: undefined,
      }),
    );
    expect(diagnosis.cause).toBe('target_unreachable');
    expect(diagnosis.message).toMatch(/no live connection/);
  });

  it('reports "target_unreachable" with an honest "last checked" time when a resource sample exists but came back unhealthy', () => {
    const now = 1_000_000;
    const diagnosis = diagnoseSessionStall(
      input({
        status: 'awaiting_input',
        targetUnreachable: true,
        targetHealthSampledAt: now - 45_000,
        now: () => now,
      }),
    );
    expect(diagnosis.cause).toBe('target_unreachable');
    expect(diagnosis.message).toBe('target unreachable — last checked 45s ago');
  });

  it('applies to every "still active" status, not only "working"', () => {
    for (const status of [
      'starting',
      'working',
      'awaiting_input',
      'permission_required',
    ] as const) {
      const diagnosis = diagnoseSessionStall(input({ status, targetUnreachable: true }));
      expect(diagnosis.cause).toBe('target_unreachable');
    }
  });

  it('reports "unknown" — never a confident guess of "thinking" or "wedged" — when the target is reachable/healthy and nothing else explains it', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'working', targetUnreachable: false, statusReason: undefined }),
    );
    expect(diagnosis.cause).toBe('unknown');
    // Honestly states the uncertainty itself ("can't tell") rather than
    // asserting either specific cause as if it were known.
    expect(diagnosis.message).toMatch(/can't tell/i);
    expect(diagnosis.message).not.toMatch(/^(the agent is|this session is)\s/i);
  });

  it('reports "unknown" when target reachability was never even observed yet (undefined must not read as "reachable")', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'working', targetUnreachable: undefined }),
    );
    expect(diagnosis.cause).toBe('unknown');
  });

  it("prioritizes queued over a simultaneously-unreachable target (the session's own status is the more specific, node-authoritative signal)", () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'queued', queueReason: 'waiting for a slot', targetUnreachable: true }),
    );
    expect(diagnosis.cause).toBe('queued_at_capacity');
  });

  it('prioritizes a confirmed agent exit over a target reachability reading (the process is gone regardless of what the target itself reports)', () => {
    const diagnosis = diagnoseSessionStall(
      input({ status: 'exited', statusReason: 'boom', targetUnreachable: false }),
    );
    expect(diagnosis.cause).toBe('agent_unavailable');
  });

  it('every distinguishable cause is reported distinctly for the same underlying "looks stalled" scenario', () => {
    const queued = diagnoseSessionStall(
      input({ status: 'queued', queueReason: 'waiting for a slot' }),
    );
    const unreachable = diagnoseSessionStall(input({ status: 'working', targetUnreachable: true }));
    const agentGone = diagnoseSessionStall(input({ status: 'exited', statusReason: 'crashed' }));
    const unknown = diagnoseSessionStall(input({ status: 'working', targetUnreachable: false }));

    const causes = [queued.cause, unreachable.cause, agentGone.cause, unknown.cause];
    expect(new Set(causes).size).toBe(4);
  });
});
