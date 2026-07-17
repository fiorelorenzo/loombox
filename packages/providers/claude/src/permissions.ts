import type { AcpPermissionOption } from '@loombox/providers-core';

/**
 * Claude Code's real permission verb set (SPEC.md §7.24: "Claude's
 * Allow-once / Allow-all-edits / Bypass-everything / Allow-for-session /
 * Deny"), as opposed to the generic tier's plain Allow/Deny(+always) pair
 * (`@loombox/providers-generic`'s `mapGenericPermissionOptions`). Five
 * verbs from only four ACP `PermissionOptionKind` values (`allow_once` /
 * `allow_always` / `reject_once` / `reject_always`) means the *kind* alone
 * can't distinguish Claude's three different `allow_always`-kind options
 * (all-edits vs. bypass-everything vs. for-this-session) — classification
 * below reads the agent's own `optionId`/`name` text first and only falls
 * back to the raw `kind` when nothing recognizable matches, so an
 * unrecognized/future Claude option still renders as *something* sane
 * rather than being dropped (issue #184's acceptance).
 */
export type ClaudePermissionVerb =
  'allow_once' | 'allow_all_edits' | 'bypass_everything' | 'allow_for_session' | 'deny';

export interface ClaudePermissionButton {
  optionId: string;
  /** The agent's own label, rendered as-is (never re-worded client-side). */
  label: string;
  verb: ClaudePermissionVerb;
}

/**
 * Ordered most-specific-first: "bypass" and "session" must be checked before
 * the more general "all edits"/"always" patterns, or e.g. "Bypass everything
 * for this session" would misclassify as `allow_for_session`.
 */
const OPTION_TEXT_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, ClaudePermissionVerb]> = [
  [/bypass/i, 'bypass_everything'],
  [/session/i, 'allow_for_session'],
  [/all[\s-]?edit/i, 'allow_all_edits'],
  [/reject|deny/i, 'deny'],
  [/allow|approve|yes/i, 'allow_once'],
];

function classify(option: AcpPermissionOption): ClaudePermissionVerb {
  for (const [pattern, verb] of OPTION_TEXT_VERB_PATTERNS) {
    if (pattern.test(option.optionId) || pattern.test(option.name)) return verb;
  }
  // No recognizable Claude-specific text: fall back to the raw ACP kind,
  // same rule the generic tier uses, so nothing is ever left unclassified.
  switch (option.kind) {
    case 'allow_once':
      return 'allow_once';
    case 'allow_always':
      return 'allow_all_edits';
    case 'reject_once':
    case 'reject_always':
      return 'deny';
  }
}

/**
 * Maps a `session/request_permission` request's raw `options[]` onto
 * Claude's five-verb button set (issue #184). Order is preserved so a
 * caller can bind `1`..`n` keyboard shortcuts to it positionally, per
 * SPEC.md §7.24's "focused permission card binds digit keys `1`..`n` to the
 * request's own `options[]` in order".
 */
export function mapClaudePermissionOptions(
  options: readonly AcpPermissionOption[],
): ClaudePermissionButton[] {
  return options.map((option) => ({
    optionId: option.optionId,
    label: option.name,
    verb: classify(option),
  }));
}
