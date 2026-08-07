import type { AcpPermissionOption } from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { mapCodexPermissionOptions } from './permissions';

describe('mapCodexPermissionOptions', () => {
  it('maps real Codex button text onto the three verbs, via the text rule itself (issue #820)', () => {
    // Real shapes from `@agentclientprotocol/codex-acp@1.1.10`'s
    // `CodexApprovalHandler` (docs/research/codex-acp-completeness.md §4),
    // not the fictional "Yes"/"Stop, and explain" text SPEC.md previously
    // assumed. Unlike that fictional text, these real labels DO match the
    // classifier's text patterns, so this proves the primary (text-based)
    // path, not just the kind-based fallback.
    const options: AcpPermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow for Session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];

    const buttons = mapCodexPermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual(['allow_once', 'allow_for_session', 'reject']);
    // Order and the agent's own labels are preserved verbatim.
    expect(buttons.map((b) => b.label)).toEqual(['Allow Once', 'Allow for Session', 'Reject']);
    expect(buttons.map((b) => b.optionId)).toEqual(options.map((o) => o.optionId));
  });

  it('recognizes the Host/Root for-session label variants (issue #820)', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'allow_always', name: 'Allow Host for Session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Allow Root for Session', kind: 'allow_always' },
    ];
    expect(mapCodexPermissionOptions(options).map((b) => b.verb)).toEqual([
      'allow_for_session',
      'allow_for_session',
    ]);
  });

  it('models a reject option as an ordinary reject, never a special abort/explain verb', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'opt-1', name: 'Reject', kind: 'reject_always' },
    ];
    expect(mapCodexPermissionOptions(options)[0]?.verb).toBe('reject');
  });

  it('falls back to the raw ACP kind for an unrecognized optionId/name', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'opt-1', name: 'Proceed', kind: 'allow_once' },
      { optionId: 'opt-2', name: 'Always proceed', kind: 'allow_always' },
    ];

    const buttons = mapCodexPermissionOptions(options);

    expect(buttons.map((b) => b.verb)).toEqual(['allow_once', 'allow_for_session']);
  });

  it('falls back to the raw ACP kind, not a bare "allow" text match, for an execpolicy/network-policy amendment option', () => {
    // Real amendment shapes (docs/research/codex-acp-completeness.md §4):
    // both say "Allow" but grant a persistent, session-scoped policy
    // change (kind `allow_always`), not a one-time yes — neither contains
    // "session" in its own text, so a bare `/allow/i` text match would
    // wrongly resolve these to `allow_once` instead of deferring to kind.
    const options: AcpPermissionOption[] = [
      {
        optionId: 'accept_execpolicy_amendment',
        name: 'Allow Commands Starting With `git ...`',
        kind: 'allow_always',
      },
      {
        optionId: 'apply_network_policy_amendment:0',
        name: 'Allow example.com in the Future',
        kind: 'allow_always',
      },
      {
        optionId: 'apply_network_policy_amendment:1',
        name: 'Block example.com in the Future',
        kind: 'reject_always',
      },
    ];

    expect(mapCodexPermissionOptions(options).map((b) => b.verb)).toEqual([
      'allow_for_session',
      'allow_for_session',
      'reject',
    ]);
  });

  it('prioritizes the "session" text over the narrower "allow once" pattern', () => {
    // A hypothetical variant carrying both words: "session" must win, since
    // it signals the persistent grant "allow once" alone does not.
    const options: AcpPermissionOption[] = [
      { optionId: 'x', name: 'Allow Once for Session', kind: 'allow_always' },
    ];
    expect(mapCodexPermissionOptions(options)[0]?.verb).toBe('allow_for_session');
  });

  it('returns an empty array for an empty options list', () => {
    expect(mapCodexPermissionOptions([])).toEqual([]);
  });
});
