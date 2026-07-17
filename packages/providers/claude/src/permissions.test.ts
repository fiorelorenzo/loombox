import type { AcpPermissionOption } from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { mapClaudePermissionOptions } from './permissions';

describe('mapClaudePermissionOptions', () => {
  it('maps Claude Code five-verb option text onto the five distinct verbs', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-all-edits', name: 'Allow all edits', kind: 'allow_always' },
      { optionId: 'bypass-permissions', name: 'Bypass everything', kind: 'allow_always' },
      { optionId: 'allow-for-session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
    ];

    const buttons = mapClaudePermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual([
      'allow_once',
      'allow_all_edits',
      'bypass_everything',
      'allow_for_session',
      'deny',
    ]);
    // Order and the agent's own labels are preserved verbatim.
    expect(buttons.map((b) => b.label)).toEqual([
      'Allow once',
      'Allow all edits',
      'Bypass everything',
      'Allow for this session',
      'Deny',
    ]);
    expect(buttons.map((b) => b.optionId)).toEqual(options.map((o) => o.optionId));
  });

  it('falls back to the raw ACP kind for an unrecognized optionId/name', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'opt-1', name: 'Proceed', kind: 'allow_once' },
      { optionId: 'opt-2', name: 'Always proceed', kind: 'allow_always' },
      { optionId: 'opt-3', name: 'Stop', kind: 'reject_always' },
    ];

    const buttons = mapClaudePermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual(['allow_once', 'allow_all_edits', 'deny']);
  });

  it('prioritizes bypass/session text over the more general "all edits" pattern', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'x', name: 'Bypass everything for this session', kind: 'allow_always' },
    ];
    expect(mapClaudePermissionOptions(options)[0]?.verb).toBe('bypass_everything');
  });

  it('returns an empty array for an empty options list', () => {
    expect(mapClaudePermissionOptions([])).toEqual([]);
  });
});
