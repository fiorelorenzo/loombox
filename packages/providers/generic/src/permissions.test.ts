import type { AcpPermissionOption } from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { mapGenericPermissionOptions } from './permissions';

describe('mapGenericPermissionOptions', () => {
  it('maps all four ACP permission kinds onto Allow/Deny(+always)', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'b', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'c', name: 'Deny', kind: 'reject_once' },
      { optionId: 'd', name: 'Always deny', kind: 'reject_always' },
    ];

    expect(mapGenericPermissionOptions(options)).toEqual([
      { optionId: 'a', label: 'Allow', verb: 'allow' },
      { optionId: 'b', label: 'Always allow', verb: 'allow_always' },
      { optionId: 'c', label: 'Deny', verb: 'deny' },
      { optionId: 'd', label: 'Always deny', verb: 'deny_always' },
    ]);
  });

  it('handles an options[] set that omits an "always" variant, without synthesizing one', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ];

    const buttons = mapGenericPermissionOptions(options);
    expect(buttons).toEqual([
      { optionId: 'allow', label: 'Allow', verb: 'allow' },
      { optionId: 'deny', label: 'Deny', verb: 'deny' },
    ]);
    expect(buttons.some((b) => b.verb === 'allow_always' || b.verb === 'deny_always')).toBe(false);
  });

  it('is blind to optionId/name text — classification is kind-only', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'bypass-everything', name: 'Bypass everything', kind: 'allow_once' },
    ];
    // Unlike the Claude tier, "bypass" text must NOT be specially recognized here.
    expect(mapGenericPermissionOptions(options)[0]?.verb).toBe('allow');
  });

  it('returns an empty array for an empty options list', () => {
    expect(mapGenericPermissionOptions([])).toEqual([]);
  });
});
