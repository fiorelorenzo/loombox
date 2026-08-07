/* ---------------------------------------------------------------------
 * Issue #241 (SPEC §7.14, epic #24): when a session opens a pull request
 * (issue #238's `pr_open_request` / `pr-open.ts#openPr`) for work tracked
 * by a *native* `TrackerRecord`, write that linkage back onto the
 * record's own `system.linkedPullRequests` — the same field
 * `tracker_get`/`tracker_list`/the kanban board already read, so the
 * link shows up with no separate sync step.
 *
 * **Finding the record.** There is no `sessionId -> TrackerRecord` index
 * anywhere (the only session-facing link is the reverse one,
 * `system.linkedSessionIds`, written by `tracker_link_session` —
 * `tracker-mcp-tools.ts`); a session that was never explicitly linked to
 * a native tracker item has none, and that is the common case, not an
 * error. {@link findNativeTrackerRecordForSession} scans a project's
 * records for the one whose `linkedSessionIds` names the session, and
 * {@link linkOpenedPullRequestToNativeTracker} is a deliberate, honest
 * no-op (`undefined`, no store write at all) when it finds none, rather
 * than fabricating a link or throwing.
 *
 * **Live-tracker projects are out of scope for this module entirely** —
 * issue #242 writes the same event back through that project's own
 * `TrackerBackend` instead (GitHub's own issue-closing keywords; an
 * explicit Jira `addComment`/`update`). The caller (`NodeDaemon`, see
 * `node-daemon.ts`'s own PR-open handling) is the one place that knows a
 * project's `TrackerMode` and is expected to only reach this module for
 * a `'native'` one.
 *
 * **Re-opening or replacing a PR never duplicates the link** — that
 * invariant lives on `NativeTrackerStore.linkPullRequest` itself (via
 * `upsertPullRequestRef`, `native-tracker-store.ts`), not here, since any
 * caller of that store method gets it, not just this one.
 * --------------------------------------------------------------------- */

import type { TrackerRecord } from '@loombox/shared';

import type { NativeTrackerStore } from './native-tracker-store';

/** The GitHub PR identity `pr-open.ts#OpenPrResult` resolves once `gh pr create` succeeds, plus the `owner`/`repo` `ci-check-watcher.ts#parseGithubPullRequestUrl` parses out of its `url` — everything {@link formatPullRequestRef} needs, structured rather than a pre-formatted string, so this module (not its caller) owns the on-disk ref format. */
export interface OpenedPullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** The on-disk `system.linkedPullRequests` ref format, matching this store's existing convention (`native-tracker-store.test.ts`'s `'fiorelorenzo/loombox#42'`). */
export function formatPullRequestRef(ref: OpenedPullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * `projectPath`'s native tracker record whose `system.linkedSessionIds`
 * names `sessionId`, or `undefined` if none does (including a session
 * never linked to any record at all — the common case). Archived records
 * are searched too: a session's work landing a PR after its tracked item
 * was archived mid-flight is still worth recording, not silently
 * dropped.
 */
export function findNativeTrackerRecordForSession(
  store: NativeTrackerStore,
  projectPath: string,
  sessionId: string,
): TrackerRecord | undefined {
  return store
    .list(projectPath, { includeArchived: true })
    .find((record) => record.system.linkedSessionIds.includes(sessionId));
}

/**
 * Writes `ref` onto the native tracker record `sessionId` is linked to in
 * `projectPath`, if any. Returns the updated record, or `undefined` — a
 * deliberate, honest skip, not an error — when `sessionId` names no
 * tracked record at all ({@link findNativeTrackerRecordForSession}). Safe
 * to call for the same opened PR more than once (e.g. a retried
 * `pr_open_request`) or for a PR that supersedes an earlier one on the
 * same record: `NativeTrackerStore.linkPullRequest`'s own upsert
 * semantics make both idempotent rather than duplicating the link.
 */
export function linkOpenedPullRequestToNativeTracker(
  store: NativeTrackerStore,
  projectPath: string,
  sessionId: string,
  ref: OpenedPullRequestRef,
): TrackerRecord | undefined {
  const record = findNativeTrackerRecordForSession(store, projectPath, sessionId);
  if (!record) return undefined;
  return store.linkPullRequest(projectPath, record.id, formatPullRequestRef(ref));
}
