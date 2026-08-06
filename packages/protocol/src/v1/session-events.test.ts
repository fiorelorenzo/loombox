import { describe, expect, it } from 'vitest';
import {
  acpAvailableCommandV1,
  availableCommandsUpdateEventV1,
  configOptionsEventV1,
  configOptionUpdateEventV1,
  parseSessionLifecycleEventV1,
  safeParseSessionLifecycleEventV1,
  sessionStatusEventV1,
  turnEndedEventV1,
  turnStartedEventV1,
} from './session-events';

describe('sessionStatusEventV1', () => {
  it('accepts every valid session status value, including "queued" (issue #252), "starting" (issue #516), and "disconnected" (issue #702)', () => {
    for (const status of [
      'queued',
      'starting',
      'working',
      'awaiting_input',
      'permission_required',
      'error',
      'exited',
      'disconnected',
    ] as const) {
      const result = sessionStatusEventV1.safeParse({
        kind: 'session_status',
        status,
        updatedAt: '2026-07-16T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts an optional "reason" alongside "error" (issue #730)', () => {
    const result = sessionStatusEventV1.safeParse({
      kind: 'session_status',
      status: 'error',
      updatedAt: '2026-07-16T00:00:00.000Z',
      reason: 'agent spawn did not complete within 120000ms',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.reason).toBe(
      'agent spawn did not complete within 120000ms',
    );
  });

  it('parses fine with "reason" omitted (every status predating issue #730, and every non-error status)', () => {
    const result = sessionStatusEventV1.safeParse({
      kind: 'session_status',
      status: 'starting',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.reason).toBeUndefined();
  });

  it('rejects an empty "reason" string', () => {
    const result = sessionStatusEventV1.safeParse({
      kind: 'session_status',
      status: 'error',
      updatedAt: '2026-07-16T00:00:00.000Z',
      reason: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status value', () => {
    const result = sessionStatusEventV1.safeParse({
      kind: 'session_status',
      status: 'idle', // not part of the reconciled vocabulary (see doc comment)
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('configOptionsEventV1 / configOptionUpdateEventV1', () => {
  const options = [
    { category: 'model', current: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
    { category: 'thought_level', current: undefined, choices: [] },
  ];

  it('accepts a full config-option catalog, including an unrecognized category', () => {
    const withUnknownCategory = [
      ...options,
      { category: 'future_thing', current: 'x', choices: [{ id: 'x', name: 'X' }] },
    ];
    expect(
      configOptionsEventV1.safeParse({ kind: 'config_options', options: withUnknownCategory })
        .success,
    ).toBe(true);
  });

  it('accepts the unprompted variant with the same option shape', () => {
    expect(
      configOptionUpdateEventV1.safeParse({ kind: 'config_option_update', options }).success,
    ).toBe(true);
  });

  it('rejects a choice missing a name', () => {
    const result = configOptionsEventV1.safeParse({
      kind: 'config_options',
      options: [{ category: 'model', choices: [{ id: 'sonnet' }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe('acpAvailableCommandV1 / availableCommandsUpdateEventV1', () => {
  it('accepts a command with no input (a command that takes no arguments)', () => {
    expect(acpAvailableCommandV1.safeParse({ name: 'model' }).success).toBe(true);
  });

  it('accepts a command with an input hint', () => {
    expect(
      acpAvailableCommandV1.safeParse({
        name: 'fast',
        description: 'Toggle fast mode',
        input: { hint: '[on|off|status]' },
      }).success,
    ).toBe(true);
  });

  it('rejects a command missing a name', () => {
    expect(acpAvailableCommandV1.safeParse({ description: 'no name' }).success).toBe(false);
  });

  it('preserves an unrecognized/future field on a command rather than dropping it (issue #741 passthrough)', () => {
    const parsed = acpAvailableCommandV1.parse({
      name: 'security',
      description: 'Run a scan',
      icon: 'shield',
    });
    expect(parsed).toEqual({ name: 'security', description: 'Run a scan', icon: 'shield' });
  });

  it('preserves an unrecognized/future field nested inside input too', () => {
    const parsed = acpAvailableCommandV1.parse({
      name: 'todo',
      input: { hint: '<subcommand>', multiline: true },
    });
    expect(parsed.input).toEqual({ hint: '<subcommand>', multiline: true });
  });

  it('accepts a full command catalog, including an empty one (an agent that declares none)', () => {
    expect(
      availableCommandsUpdateEventV1.safeParse({ kind: 'available_commands_update', commands: [] })
        .success,
    ).toBe(true);
    expect(
      availableCommandsUpdateEventV1.safeParse({
        kind: 'available_commands_update',
        commands: [{ name: 'model' }],
      }).success,
    ).toBe(true);
  });
});

describe('turnStartedEventV1 / turnEndedEventV1', () => {
  it('requires a non-empty turnId on turn_started', () => {
    expect(turnStartedEventV1.safeParse({ kind: 'turn_started', turnId: 'turn:1' }).success).toBe(
      true,
    );
    expect(turnStartedEventV1.safeParse({ kind: 'turn_started', turnId: '' }).success).toBe(false);
  });

  it('accepts turn_ended with or without a stopReason/turnId (an agent may omit either)', () => {
    expect(
      turnEndedEventV1.safeParse({ kind: 'turn_ended', turnId: 'turn:1', stopReason: 'end_turn' })
        .success,
    ).toBe(true);
    expect(turnEndedEventV1.safeParse({ kind: 'turn_ended' }).success).toBe(true);
  });
});

describe('sessionLifecycleEventV1 (the discriminated union)', () => {
  it('parses every one of the six kinds', () => {
    const samples: unknown[] = [
      { kind: 'session_status', status: 'working', updatedAt: 't' },
      { kind: 'config_options', options: [] },
      { kind: 'config_option_update', options: [] },
      { kind: 'available_commands_update', commands: [] },
      { kind: 'turn_started', turnId: 'turn:1' },
      { kind: 'turn_ended', stopReason: 'end_turn' },
    ];
    for (const sample of samples) {
      expect(() => parseSessionLifecycleEventV1(sample)).not.toThrow();
    }
  });

  it('rejects a payload whose kind is not one of the six', () => {
    const result = safeParseSessionLifecycleEventV1({ kind: 'agent_message_chunk' });
    expect(result.success).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseSessionLifecycleEventV1(null).success).toBe(false);
    expect(safeParseSessionLifecycleEventV1('nope').success).toBe(false);
  });
});
