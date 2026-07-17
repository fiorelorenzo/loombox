import type { AcpPermissionOption } from '@loombox/providers-core';

/**
 * The generic ACP fallback tier's permission mapping (issue #183; SPEC.md
 * §7.24: "the generic ACP tier maps the protocol's own `options[]`/`kind`
 * vocabulary (`allow_once`/`allow_always`/`reject_once`/`reject_always`)
 * onto a plain Allow/Deny (+ 'always') pair"). Unlike the Claude adapter's
 * five-verb mapping (`@loombox/providers-claude`'s
 * `mapClaudePermissionOptions`), this reads *only* the protocol's own
 * `kind` field — never `optionId`/`name` text — since a zero-code fallback
 * tier has no bespoke-agent vocabulary to recognize.
 */
export type GenericPermissionVerb = 'allow' | 'allow_always' | 'deny' | 'deny_always';

export interface GenericPermissionButton {
  optionId: string;
  label: string;
  verb: GenericPermissionVerb;
}

function verbForKind(kind: AcpPermissionOption['kind']): GenericPermissionVerb {
  switch (kind) {
    case 'allow_once':
      return 'allow';
    case 'allow_always':
      return 'allow_always';
    case 'reject_once':
      return 'deny';
    case 'reject_always':
      return 'deny_always';
  }
}

/**
 * Maps any `session/request_permission` request's `options[]` onto the
 * generic Allow/Deny(+always) button set, correctly for any subset of the
 * four ACP kinds — including one that omits an "always" variant entirely
 * (issue #183's acceptance), in which case the output simply has no
 * `allow_always`/`deny_always` entry, rather than synthesizing one. Order
 * is preserved (same `1`..`n` keyboard-shortcut rule as the Claude tier,
 * SPEC.md §7.24).
 */
export function mapGenericPermissionOptions(
  options: readonly AcpPermissionOption[],
): GenericPermissionButton[] {
  return options.map((option) => ({
    optionId: option.optionId,
    label: option.name,
    verb: verbForKind(option.kind),
  }));
}
