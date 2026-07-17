import { describe, expect, it } from 'vitest';
import {
  configOptionsEventV1,
  configOptionUpdateEventV1,
  parseSessionLifecycleEventV1,
  safeParseSessionLifecycleEventV1,
  sessionStatusEventV1,
  turnEndedEventV1,
  turnStartedEventV1,
} from './session-events';

describe('sessionStatusEventV1', () => {
  it('accepts every reconciled AttentionStatus value', () => {
    for (const status of [
      'working',
      'awaiting_input',
      'permission_required',
      'error',
      'exited',
    ] as const) {
      const result = sessionStatusEventV1.safeParse({
        kind: 'session_status',
        status,
        updatedAt: '2026-07-16T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
    }
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
  it('parses every one of the five kinds', () => {
    const samples: unknown[] = [
      { kind: 'session_status', status: 'working', updatedAt: 't' },
      { kind: 'config_options', options: [] },
      { kind: 'config_option_update', options: [] },
      { kind: 'turn_started', turnId: 'turn:1' },
      { kind: 'turn_ended', stopReason: 'end_turn' },
    ];
    for (const sample of samples) {
      expect(() => parseSessionLifecycleEventV1(sample)).not.toThrow();
    }
  });

  it('rejects a payload whose kind is not one of the five', () => {
    const result = safeParseSessionLifecycleEventV1({ kind: 'agent_message_chunk' });
    expect(result.success).toBe(false);
  });

  it('safeParse never throws on garbage input', () => {
    expect(safeParseSessionLifecycleEventV1(null).success).toBe(false);
    expect(safeParseSessionLifecycleEventV1('nope').success).toBe(false);
  });
});
