import { describe, expect, it } from 'vitest';
import {
  parseTerminalClosedPayloadV1,
  parseTerminalDataPayloadV1,
  parseTerminalOpenPayloadV1,
  parseTerminalOpenResultPayloadV1,
  parseTerminalResizePayloadV1,
  safeParseTerminalOpenPayloadV1,
  terminalClose,
  terminalClosed,
  terminalData,
  terminalInput,
  terminalOpen,
  terminalOpened,
  terminalOutput,
  terminalResize,
} from './terminal';

const envelope = {
  resourceId: 'session-1',
  iv: 'AAAA',
  ciphertext: 'AAAA',
  alg: 'AES-256-GCM' as const,
};

describe('terminalOpenPayloadV1', () => {
  it('accepts positive integer cols/rows', () => {
    expect(() => parseTerminalOpenPayloadV1({ cols: 80, rows: 24 })).not.toThrow();
  });

  it('rejects zero/negative/non-integer cols or rows', () => {
    expect(safeParseTerminalOpenPayloadV1({ cols: 0, rows: 24 }).success).toBe(false);
    expect(safeParseTerminalOpenPayloadV1({ cols: 80, rows: -1 }).success).toBe(false);
    expect(safeParseTerminalOpenPayloadV1({ cols: 80.5, rows: 24 }).success).toBe(false);
  });
});

describe('terminalOpenResultPayloadV1', () => {
  it('parses the ok outcome', () => {
    expect(parseTerminalOpenResultPayloadV1({ outcome: 'ok' }).outcome).toBe('ok');
  });

  it('parses the error outcome with a message', () => {
    const result = parseTerminalOpenResultPayloadV1({ outcome: 'error', message: 'no shell' });
    expect(result.outcome).toBe('error');
  });

  it('rejects an unknown outcome', () => {
    expect(() => parseTerminalOpenResultPayloadV1({ outcome: 'pending' })).toThrow();
  });
});

describe('terminalDataPayloadV1', () => {
  it('accepts a base64 data field (used both for stdin and stdout/stderr)', () => {
    expect(() => parseTerminalDataPayloadV1({ data: 'aGVsbG8=' })).not.toThrow();
  });

  it('rejects a non-base64 data field', () => {
    expect(() => parseTerminalDataPayloadV1({ data: 'not base64!!' })).toThrow();
  });
});

describe('terminalResizePayloadV1', () => {
  it('accepts positive integer cols/rows', () => {
    expect(() => parseTerminalResizePayloadV1({ cols: 120, rows: 40 })).not.toThrow();
  });

  it('rejects non-positive cols/rows', () => {
    expect(() => parseTerminalResizePayloadV1({ cols: 0, rows: 40 })).toThrow();
  });
});

describe('terminalClosedPayloadV1', () => {
  it('accepts each known reason', () => {
    for (const reason of ['closed_by_client', 'exited', 'error'] as const) {
      expect(() => parseTerminalClosedPayloadV1({ reason })).not.toThrow();
    }
  });

  it('accepts optional exitCode/signal/message', () => {
    expect(() =>
      parseTerminalClosedPayloadV1({ reason: 'exited', exitCode: 0, signal: 'SIGHUP' }),
    ).not.toThrow();
  });

  it('rejects an unknown reason', () => {
    expect(() => parseTerminalClosedPayloadV1({ reason: 'vanished' })).toThrow();
  });
});

describe('terminal wire messages carry only clear routing metadata plus the opaque envelope', () => {
  it('terminalOpen: sessionId/targetId/terminalId/requestId + envelope, never plaintext cols/rows', () => {
    const message = {
      type: 'terminal_open' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      targetId: 'local',
      terminalId: 'term-1',
      requestId: 'req-1',
      envelope,
    };
    expect(terminalOpen.safeParse(message).success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      [
        'envelope',
        'protocolVersion',
        'requestId',
        'sessionId',
        'targetId',
        'terminalId',
        'type',
      ].sort(),
    );
  });

  it('rejects terminalOpen missing terminalId', () => {
    expect(
      terminalOpen.safeParse({
        type: 'terminal_open',
        protocolVersion: 1,
        sessionId: 'session-1',
        targetId: 'local',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('terminalOpened: sessionId/terminalId/requestId + envelope', () => {
    expect(
      terminalOpened.safeParse({
        type: 'terminal_opened',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        requestId: 'req-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('terminalInput: sessionId/terminalId + envelope, no requestId/targetId', () => {
    const message = {
      type: 'terminal_input' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      terminalId: 'term-1',
      envelope,
    };
    expect(terminalInput.safeParse(message).success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );
  });

  it('terminalOutput: same shape as terminalInput, distinct type', () => {
    expect(
      terminalOutput.safeParse({
        type: 'terminal_output',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('terminalData is a discriminated union of terminal_input/terminal_output', () => {
    expect(
      terminalData.safeParse({
        type: 'terminal_input',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      terminalData.safeParse({
        type: 'terminal_output',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(true);
    expect(
      terminalData.safeParse({
        type: 'terminal_resize',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(false);
  });

  it('terminalResize: sessionId/terminalId + envelope (cols/rows travel inside it)', () => {
    expect(
      terminalResize.safeParse({
        type: 'terminal_resize',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('terminalClose: sessionId/terminalId only, no envelope required', () => {
    const message = {
      type: 'terminal_close' as const,
      protocolVersion: 1 as const,
      sessionId: 'session-1',
      terminalId: 'term-1',
    };
    expect(terminalClose.safeParse(message).success).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
    );
  });

  it('terminalClosed: sessionId/terminalId + envelope (reason/exitCode/signal travel inside it)', () => {
    expect(
      terminalClosed.safeParse({
        type: 'terminal_closed',
        protocolVersion: 1,
        sessionId: 'session-1',
        terminalId: 'term-1',
        envelope,
      }).success,
    ).toBe(true);
  });

  it('is additive/version-safe: an extra unknown field never leaks raw bytes/cols/rows in the clear', () => {
    const result = terminalOpen.safeParse({
      type: 'terminal_open',
      protocolVersion: 1,
      sessionId: 'session-1',
      targetId: 'local',
      terminalId: 'term-1',
      requestId: 'req-1',
      envelope,
      cols: 80, // must never be a real field this schema reads
      rows: 24,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('cols' in result.data).toBe(false);
      expect('rows' in result.data).toBe(false);
    }
  });
});
