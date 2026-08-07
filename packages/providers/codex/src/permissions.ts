import type { AcpPermissionOption } from '@loombox/providers-core';

/**
 * Codex's real permission verb set. As opposed to Claude's five-verb set
 * (`@loombox/providers-claude`'s `mapClaudePermissionOptions`) or the
 * generic tier's plain Allow/Deny(+always) pair, Codex collapses onto
 * three: the same four ACP `PermissionOptionKind` values Claude and the
 * generic tier read (`allow_once`/`allow_always`/`reject_once`/
 * `reject_always`) mean *kind* alone can distinguish a one-time allow from
 * a for-session one, but both reject kinds collapse onto a single `reject`
 * verb — Codex never offers a separate "reject forever" button.
 *
 * SPEC.md §7.24 used to describe this set as "Yes / Yes-for-session /
 * Stop-and-explain (an abort, not a deny)". Issue #820 (spike #182, against
 * `@agentclientprotocol/codex-acp@1.1.10`'s real source — see
 * `docs/research/codex-acp-completeness.md` §4) found neither claim true:
 * the real `CodexApprovalHandler` labels its buttons "Allow Once" / "Allow
 * for Session" (or "Allow Host/Root for Session") / "Reject", and nothing
 * in that source distinguishes a reject from a plain deny — Codex's reject
 * option is exactly as ordinary as Claude's or the generic tier's. The
 * verb names below and the text patterns that classify them were corrected
 * to match; only the shape (three verbs, kind-based fallback for anything
 * the text doesn't recognize, e.g. an execpolicy/network-policy amendment
 * option) carries over.
 *
 * Classification below reads the agent's own `optionId`/`name` text first,
 * matched against the real label vocabulary the citation above found, and
 * only falls back to the raw `kind` when nothing recognizable matches, same
 * rule as Claude's mapper, so an unrecognized/future Codex option still
 * renders as *something* sane rather than being dropped.
 */
export type CodexPermissionVerb = 'allow_once' | 'allow_for_session' | 'reject';

export interface CodexPermissionButton {
  optionId: string;
  /** The agent's own label, rendered as-is (never re-worded client-side). */
  label: string;
  verb: CodexPermissionVerb;
}

/**
 * Matched against real Codex button text only ("Reject", "Allow for
 * Session"/"Allow Host for Session"/"Allow Root for Session", "Allow
 * Once") — deliberately narrower than a bare `/allow/i`, which would also
 * catch an execpolicy amendment's "Allow Commands Starting With `git
 * ...`" or a network-policy amendment's "Allow <host> in the Future" text
 * and misclassify a persistent (`allow_always`-kind) grant as a one-time
 * `allow_once`; those fall through to the kind-based fallback instead,
 * same as any other unrecognized option. Ordered most-specific-first:
 * "session" is checked before the bare "allow once" pattern, or e.g. a
 * hypothetical "Allow Once for Session" would misclassify as
 * `allow_once`.
 */
const OPTION_TEXT_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, CodexPermissionVerb]> = [
  [/reject/i, 'reject'],
  [/session/i, 'allow_for_session'],
  [/allow once/i, 'allow_once'],
];

function classify(option: AcpPermissionOption): CodexPermissionVerb {
  for (const [pattern, verb] of OPTION_TEXT_VERB_PATTERNS) {
    if (pattern.test(option.optionId) || pattern.test(option.name)) return verb;
  }
  // No recognizable Codex-specific text (e.g. an execpolicy/network-policy
  // amendment option, or a future/unrecognized Codex option): fall back to
  // the raw ACP kind, same rule the Claude/generic tiers use, so nothing is
  // ever left unclassified.
  switch (option.kind) {
    case 'allow_once':
      return 'allow_once';
    case 'allow_always':
      return 'allow_for_session';
    case 'reject_once':
    case 'reject_always':
      return 'reject';
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
