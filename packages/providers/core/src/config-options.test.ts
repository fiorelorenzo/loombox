import { describe, expect, it } from 'vitest';

import { ConfigOptionStore } from './config-options';
import type { ConfigOptionChangeEvent } from './config-options';
import type { AcpConfigOption } from './types';

const INITIAL: AcpConfigOption[] = [
  {
    category: 'model',
    current: 'sonnet',
    choices: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ],
  },
  { category: 'mode', current: 'default', choices: [{ id: 'default', name: 'Default' }] },
];

describe('ConfigOptionStore: get/setAll', () => {
  it('is empty for a session that was never seeded', () => {
    const store = new ConfigOptionStore();
    expect(store.get('s1')).toEqual([]);
  });

  it('exposes the full option list as one object per session', () => {
    const store = new ConfigOptionStore();
    store.setAll('s1', INITIAL, { unprompted: false });
    expect(store.get('s1')).toEqual(INITIAL);
  });

  it('replaces the entire list wholesale rather than patching one category', () => {
    const store = new ConfigOptionStore();
    store.setAll('s1', INITIAL, { unprompted: false });

    const replacement: AcpConfigOption[] = [
      { category: 'model', current: 'opus', choices: INITIAL[0]!.choices },
    ];
    store.setAll('s1', replacement, { unprompted: false });

    // The old 'mode' category is gone: a wholesale replace, not a merge.
    expect(store.get('s1')).toEqual(replacement);
  });

  it('keeps each session independent', () => {
    const store = new ConfigOptionStore();
    store.setAll('sA', INITIAL, { unprompted: false });
    expect(store.get('sB')).toEqual([]);
  });

  it('preserves an unrecognized/future category name rather than dropping it', () => {
    const store = new ConfigOptionStore();
    const withUnknown: AcpConfigOption[] = [
      ...INITIAL,
      {
        category: 'reasoning_style_v3',
        current: 'balanced',
        choices: [{ id: 'balanced', name: 'Balanced' }],
      },
    ];
    store.setAll('s1', withUnknown, { unprompted: false });

    expect(store.get('s1')).toEqual(withUnknown);
    expect(store.current('s1', 'reasoning_style_v3')).toBe('balanced');
  });

  it('current() reads the selection for one category', () => {
    const store = new ConfigOptionStore();
    store.setAll('s1', INITIAL, { unprompted: false });
    expect(store.current('s1', 'model')).toBe('sonnet');
    expect(store.current('s1', 'nonexistent')).toBeUndefined();
  });
});

describe('ConfigOptionStore: change events', () => {
  it('flags a user-driven ack as not unprompted', () => {
    const store = new ConfigOptionStore();
    const events: ConfigOptionChangeEvent[] = [];
    store.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    store.setAll('s1', INITIAL, { unprompted: false });

    expect(events).toHaveLength(1);
    expect(events[0]?.unprompted).toBe(false);
  });

  it('flags an agent-initiated config_option_update as unprompted, attention-worthy data', () => {
    const store = new ConfigOptionStore();
    const events: ConfigOptionChangeEvent[] = [];
    store.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    const fallback: AcpConfigOption[] = [
      { category: 'model', current: 'haiku', choices: INITIAL[0]!.choices },
    ];
    store.setAll('s1', fallback, { unprompted: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: 's1', options: fallback, unprompted: true });
  });
});

describe('ConfigOptionStore: mutation isolation', () => {
  it('does not let a caller mutate stored state through a returned array', () => {
    const store = new ConfigOptionStore();
    store.setAll('s1', INITIAL, { unprompted: false });

    const got = store.get('s1');
    got[0]!.current = 'tampered';
    got[0]!.choices.push({ id: 'hacked', name: 'Hacked' });

    expect(store.get('s1')[0]!.current).toBe('sonnet');
    expect(store.get('s1')[0]!.choices).toHaveLength(2);
  });
});
