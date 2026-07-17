import type { AcpPermissionOption } from '@loombox/providers-core';

/**
 * Codex's real permission verb set (SPEC.md §7.24: "Codex's Yes / Yes-for-
 * session / Stop-and-explain (an abort, not a deny)"), as opposed to Claude's
 * five-verb set (`@loombox/providers-claude`'s `mapClaudePermissionOptions`)
 * or the generic tier's plain Allow/Deny(+always) pair. Three verbs from the
 * same four ACP `PermissionOptionKind` values Claude and the generic tier
 * read (`allow_once`/`allow_always`/`reject_once`/`reject_always`) means the
 * *kind* alone can distinguish "Yes" from "Yes, for this session", but both
 * `reject_once` and `reject_always` collapse onto the single
 * `stop_and_explain` verb — classification below reads the agent's own
 * `optionId`/`name` text first and only falls back to the raw `kind` when
 * nothing recognizable matches, same rule as Claude's mapper, so an
 * unrecognized/future Codex option still renders as *something* sane rather
 * than being dropped.
 */
export type CodexPermissionVerb = 'yes' | 'yes_for_session' | 'stop_and_explain';

export interface CodexPermissionButton {
  optionId: string;
  /** The agent's own label, rendered as-is (never re-worded client-side). */
  label: string;
  verb: CodexPermissionVerb;
}

/**
 * Ordered most-specific-first: "stop"/"explain" must be checked before the
 * more general "session" pattern, or e.g. "Stop and explain for this
 * session" would misclassify as `yes_for_session`.
 */
const OPTION_TEXT_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, CodexPermissionVerb]> = [
  [/stop|explain|abort|cancel/i, 'stop_and_explain'],
  [/session/i, 'yes_for_session'],
  [/yes|allow|approve/i, 'yes'],
];

function classify(option: AcpPermissionOption): CodexPermissionVerb {
  for (const [pattern, verb] of OPTION_TEXT_VERB_PATTERNS) {
    if (pattern.test(option.optionId) || pattern.test(option.name)) return verb;
  }
  // No recognizable Codex-specific text: fall back to the raw ACP kind, same
  // rule the Claude/generic tiers use, so nothing is ever left unclassified.
  // Both reject kinds map onto the single abort verb — Codex's own
  // Stop-and-explain is not a plain deny (SPEC.md §7.24).
  switch (option.kind) {
    case 'allow_once':
      return 'yes';
    case 'allow_always':
      return 'yes_for_session';
    case 'reject_once':
    case 'reject_always':
      return 'stop_and_explain';
  }
}

/**
 * Maps a `session/request_permission` request's raw `options[]` onto
 * Codex's three-verb button set (issue #186's Codex half). Order is
 * preserved so a caller can bind `1`..`n` keyboard shortcuts to it
 * positionally, per SPEC.md §7.24's "focused permission card binds digit
 * keys `1`..`n` to the request's own `options[]` in order".
 */
export function mapCodexPermissionOptions(
  options: readonly AcpPermissionOption[],
): CodexPermissionButton[] {
  return options.map((option) => ({
    optionId: option.optionId,
    label: option.name,
    verb: classify(option),
  }));
}
