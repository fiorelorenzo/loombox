import { describe, expect, it } from 'vitest';

import { AvailableCommandsStore } from './available-commands';
import type { AvailableCommandsChangeEvent } from './available-commands';
import type { AcpAvailableCommand } from './types';

const INITIAL: AcpAvailableCommand[] = [
  { name: 'model', description: 'Show current model selection', input: undefined },
  { name: 'fast', description: 'Toggle fast mode', input: { hint: '[on|off|status]' } },
];

describe('AvailableCommandsStore: get/setAll', () => {
  it('is empty for a session that was never seeded — declaring none is an empty list, not an error (issue #741)', () => {
    const store = new AvailableCommandsStore();
    expect(store.get('s1')).toEqual([]);
  });

  it('exposes the full command list as one object per session', () => {
    const store = new AvailableCommandsStore();
    store.setAll('s1', INITIAL);
    expect(store.get('s1')).toEqual(INITIAL);
  });

  it('replaces the entire list wholesale rather than patching one command in place', () => {
    const store = new AvailableCommandsStore();
    store.setAll('s1', INITIAL);

    const replacement: AcpAvailableCommand[] = [
      { name: 'jobs', description: 'Show background jobs', input: undefined },
    ];
    store.setAll('s1', replacement);

    expect(store.get('s1')).toEqual(replacement);
  });

  it('keeps each session independent', () => {
    const store = new AvailableCommandsStore();
    store.setAll('s1', INITIAL);
    expect(store.get('s2')).toEqual([]);
  });

  it('preserves an unrecognized/future field on a command rather than dropping it (issue #741)', () => {
    const store = new AvailableCommandsStore();
    const withUnknownField: AcpAvailableCommand[] = [
      { name: 'security', description: 'Run a security scan', input: undefined, icon: 'shield' },
    ];
    store.setAll('s1', withUnknownField);
    expect(store.get('s1')[0]?.icon).toBe('shield');
  });

  it('clear() drops all tracked state for a session', () => {
    const store = new AvailableCommandsStore();
    store.setAll('s1', INITIAL);
    store.clear('s1');
    expect(store.get('s1')).toEqual([]);
  });
});

describe('AvailableCommandsStore: change events', () => {
  it('emits "changed" with the session id and the full replaced list', () => {
    const store = new AvailableCommandsStore();
    const events: AvailableCommandsChangeEvent[] = [];
    store.on('changed', (event: AvailableCommandsChangeEvent) => events.push(event));

    store.setAll('s1', INITIAL);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: 's1', commands: INITIAL });
  });
});

describe('AvailableCommandsStore: mutation isolation', () => {
  it('does not let a caller mutate stored state through a returned array', () => {
    const store = new AvailableCommandsStore();
    store.setAll('s1', INITIAL);

    const read = store.get('s1');
    read[0]!.description = 'tampered';

    expect(store.get('s1')[0]?.description).toBe('Show current model selection');
  });

  it('does not let a caller mutate stored state through the array passed into setAll', () => {
    const store = new AvailableCommandsStore();
    const source: AcpAvailableCommand[] = [
      { name: 'model', description: 'Show current model selection', input: undefined },
    ];
    store.setAll('s1', source);

    source[0]!.description = 'tampered';

    expect(store.get('s1')[0]?.description).toBe('Show current model selection');
  });
});
