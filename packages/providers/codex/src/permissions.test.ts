import type { AcpPermissionOption } from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { mapCodexPermissionOptions } from './permissions';

describe('mapCodexPermissionOptions', () => {
  it('maps Codex three-verb option text onto the three distinct verbs', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
      { optionId: 'yes-for-session', name: 'Yes, for this session', kind: 'allow_always' },
      {
        optionId: 'stop-and-explain',
        name: 'Stop, and explain what to do differently',
        kind: 'reject_once',
      },
    ];

    const buttons = mapCodexPermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual(['yes', 'yes_for_session', 'stop_and_explain']);
    // Order and the agent's own labels are preserved verbatim.
    expect(buttons.map((b) => b.label)).toEqual([
      'Yes',
      'Yes, for this session',
      'Stop, and explain what to do differently',
    ]);
    expect(buttons.map((b) => b.optionId)).toEqual(options.map((o) => o.optionId));
  });

  it('models Codex reject options as an abort, never a plain deny', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'opt-1', name: 'Cancel', kind: 'reject_always' },
    ];
    expect(mapCodexPermissionOptions(options)[0]?.verb).toBe('stop_and_explain');
  });

  it('falls back to the raw ACP kind for an unrecognized optionId/name', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'opt-1', name: 'Proceed', kind: 'allow_once' },
      { optionId: 'opt-2', name: 'Always proceed', kind: 'allow_always' },
    ];

    const buttons = mapCodexPermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual(['yes', 'yes_for_session']);
  });

  it('prioritizes stop/explain text over the more general "session" pattern', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'x', name: 'Stop and explain for this session', kind: 'allow_always' },
    ];
    expect(mapCodexPermissionOptions(options)[0]?.verb).toBe('stop_and_explain');
  });

  it('returns an empty array for an empty options list', () => {
    expect(mapCodexPermissionOptions([])).toEqual([]);
  });
});
