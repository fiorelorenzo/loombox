/* ---------------------------------------------------------------------
 * PR-linkage write-back for a live-mode (GitHub/Jira) tracker project
 * (SPEC §7.14 lines 526-530; issue #242) — the live-tracker sibling of
 * issue #241's native `system.linkedPullRequests` write, and the write-
 * side counterpart to `./tracker-connectivity.ts`'s read-side classifier
 * (issue #219). A live tracker has no local mirror to record a link
 * into (issue #219's "no local mirror"), so "write the linkage back"
 * means calling straight through to the project's own `TrackerBackend`
 * the moment a PR opens — `./node-daemon.ts`'s `handlePrOpenRequest`
 * (issue #238) is this module's one caller, invoking it the same
 * best-effort way it already invokes `registerCiCheckWatch` (issue
 * #239): a write-back failure never turns an otherwise-successful
 * `pr_open_request` into a reported one.
 *
 * SPEC's own text is asymmetric across the two providers, and this
 * module keeps that asymmetry rather than flattening it into one
 * "always call addComment" path:
 *
 * - **GitHub**: "a GitHub PR auto-links via its own issue-closing
 *   keywords" — GitHub parses `Closes #123`/`Fixes #123`/etc. out of a
 *   PR's own description and links (and, on merge, closes) the
 *   referenced issue itself, with no API call from anyone. Issue #242's
 *   own acceptance line is explicit that a *separate* API call here
 *   would be the wrong design, not a missing one — {@link
 *   writeLiveTrackerPrLinkage} makes zero backend calls whenever
 *   `backend.id === 'github'`.
 * - **Jira**: Jira has no closing-keyword convention at all, so the
 *   write-back is a real `TrackerBackend.addComment` call against
 *   whichever Jira issue key this PR's own title/body names (parsed by
 *   {@link extractJiraIssueKey}, scoped to the bound project's own
 *   `projectKey` so a stray uppercase-word-then-number in freeform PR
 *   text — or a key belonging to some OTHER Jira project — is never
 *   mistaken for a reference into this binding's project). No key found
 *   in the title or body -> `{outcome: 'noIssueReference'}`, never a
 *   guess.
 *
 * **Idempotency** (issue #242's own acceptance bar) has nothing to
 * check against on the remote side — `addComment` has no dedup built
 * in, and live mode's "no local mirror" rule (issue #219) rules out a
 * persisted write-log to consult instead. {@link LiveTrackerPrLinkageWriter}
 * keeps its own tiny in-memory `Set` (never written to disk; empty
 * again after every process restart — this is NOT the "local-snapshot
 * table" issue #219's acceptance forbids, since it records nothing
 * about the tracker item's own content, only "have I already commented
 * about this exact PR"), keyed on `connectionId:externalId:prUrl`: a
 * second call for the identical (Jira issue, PR) pair short-circuits to
 * `{outcome: 'alreadyLinked'}` without a second `addComment`.
 *
 * **Failure classification** reuses `./tracker-connectivity.ts`'s own
 * `classifyTrackerConnectivityError` (issue #219's three-state
 * vocabulary: `reachable`/`unreachable`/`authFailed`) rather than
 * inventing a fourth state for a write failure specifically — a write
 * that can't reach Jira and a read that can't reach Jira are the same
 * underlying "is this backend up, and are we allowed in" question.
 * `unreachable`/`authFailed` are surfaced distinctly here (never
 * collapsed into one swallowed `catch`) precisely so
 * `NodeDaemon.writeLiveTrackerPrLinkage` can log which one happened.
 * --------------------------------------------------------------------- */

import type { JiraTarget } from '@loombox/protocol';
import type { TrackerBackend, TrackerBinding } from '@loombox/shared';
import { classifyTrackerConnectivityError } from './tracker-connectivity';

function isJiraTarget(target: TrackerBinding['target']): target is JiraTarget {
  return typeof target === 'object' && target !== null && 'projectKey' in target;
}

/**
 * Finds `target`'s own issue key (e.g. `PROJ-123` for a `projectKey` of
 * `PROJ`) in `text` — scoped to the bound project's own key
 * specifically, never a bare `[A-Z]+-\d+` pattern, so a PR description
 * mentioning a DIFFERENT Jira project's issue (or an unrelated all-caps
 * acronym followed by a number) is never mistaken for a reference into
 * this binding's own project. Returns the first match, case-sensitive
 * (Jira issue keys are always upper-case); `undefined` if the key never
 * appears. `target.projectKey` is user-configured free text (SPEC
 * §7.10's per-project live-target picker), not a literal this module
 * controls — escaped before interpolation into the regex.
 */
export function extractJiraIssueKey(target: JiraTarget, text: string): string | undefined {
  const escapedProjectKey = target.projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedProjectKey}-\\d+\\b`);
  return pattern.exec(text)?.[0];
}

export interface LiveTrackerPrLinkageInput {
  readonly backend: TrackerBackend;
  readonly binding: TrackerBinding;
  /** `OpenPrResult.url` (`./pr-open.ts`) — also this write-back's own idempotency key alongside the resolved issue, so re-running against the SAME already-open PR never double-comments. */
  readonly prUrl: string;
  /** The operator's own PR title, exactly as sent in `pr_open_request` (`PrOpenRequestPayloadV1.title`) — searched for a Jira issue key alongside `prBody`, never agent-drafted (see `@loombox/protocol`'s `pr.ts` top comment). */
  readonly prTitle: string;
  /** The operator's own PR body — see `prTitle`'s own doc comment. */
  readonly prBody: string;
}

/**
 * Every way {@link LiveTrackerPrLinkageWriter.writePrLinkage} can end,
 * exhaustively:
 * - `reliesOnKeywords` — `backend.id === 'github'`; nothing was called
 *   at all (see this module's own top comment).
 * - `noIssueReference` — `backend.id === 'jira'`, but neither `prTitle`
 *   nor `prBody` names an issue in the bound project.
 * - `linked` — a fresh `addComment` call against `externalId` succeeded.
 * - `alreadyLinked` — this exact `(externalId, prUrl)` pair was already
 *   linked by an earlier call on this same writer; no second
 *   `addComment` was sent.
 * - `unreachable`/`authFailed` — `addComment` itself threw, classified
 *   by `./tracker-connectivity.ts`'s `classifyTrackerConnectivityError`
 *   (issue #219's own two failure states) rather than swallowed.
 */
export type LiveTrackerPrLinkageOutcome =
  | { readonly outcome: 'reliesOnKeywords' }
  | { readonly outcome: 'noIssueReference' }
  | { readonly outcome: 'linked'; readonly externalId: string }
  | { readonly outcome: 'alreadyLinked'; readonly externalId: string }
  | { readonly outcome: 'unreachable'; readonly externalId: string }
  | { readonly outcome: 'authFailed'; readonly externalId: string };

/**
 * Writes a session's just-opened PR back through its project's live
 * `TrackerBackend` (SPEC §7.14, issue #242) — see this module's own top
 * comment for the full per-provider design and idempotency contract.
 * One instance is meant to live for the lifetime of the owning
 * `NodeDaemon` (mirrors `TrackerConnectivityWatcher`/`CiCheckWatcher`'s
 * own long-lived, in-memory-state convention), so its dedup `Set`
 * actually catches a duplicate call across separate `pr_open_request`s
 * for the same PR — never persisted, so a node restart forgets it (an
 * acceptable "at most one extra comment after a restart" tradeoff for
 * never introducing the write-queue/local-snapshot issue #219's own
 * acceptance forbids).
 */
export class LiveTrackerPrLinkageWriter {
  private readonly linked = new Set<string>();

  async writePrLinkage(input: LiveTrackerPrLinkageInput): Promise<LiveTrackerPrLinkageOutcome> {
    const { backend, binding, prUrl, prTitle, prBody } = input;

    if (backend.id === 'github') {
      return { outcome: 'reliesOnKeywords' };
    }

    // backend.id === 'jira' — `TrackerBackend.id` is `'github' | 'jira'`
    // (`@loombox/shared`'s own `TrackerBackend` interface), so this is
    // the only remaining case.
    if (!isJiraTarget(binding.target)) {
      // Defensive, should-never-happen: `resolveTrackerBackend` only
      // ever composes a `JiraTrackerBackend` (`backend.id === 'jira'`)
      // from a `TrackerMode` whose `target` already passed the
      // GitHub-vs-Jira cross-check in `@loombox/protocol`'s
      // `v1/tracker.ts` schema. A mismatch here means this module's
      // caller built a `{backend, binding}` pair from two different
      // projects' resolutions — the same class of bug
      // `tracker-backend-composition.ts`'s own `assertSameConnection`
      // guards against, not a reachable project state.
      throw new Error(
        'tracker-pr-linkage-live: a jira TrackerBackend was composed with a non-Jira binding.target',
      );
    }

    const externalId = extractJiraIssueKey(binding.target, `${prTitle}\n${prBody}`);
    if (!externalId) {
      return { outcome: 'noIssueReference' };
    }

    const dedupeKey = `${binding.connectionId}:${externalId}:${prUrl}`;
    if (this.linked.has(dedupeKey)) {
      return { outcome: 'alreadyLinked', externalId };
    }

    if (!backend.addComment) {
      // Defensive, should-never-happen: SPEC §7.10's slice-1 delivery
      // put `addComment` on every Jira backend from the start
      // (`JiraTrackerBackend.addComment`, issue #214). Reported as
      // `noIssueReference` would hide a real capability regression
      // behind a case that reads as "nothing to link" — this dedicated
      // throw keeps that failure loud instead.
      throw new Error(
        `tracker-pr-linkage-live: jira TrackerBackend for connection "${binding.connectionId}" has no addComment`,
      );
    }

    try {
      await backend.addComment(binding, externalId, `Pull request opened: ${prUrl}`);
    } catch (error) {
      const failure = classifyTrackerConnectivityError(error);
      return failure === 'authFailed'
        ? { outcome: 'authFailed', externalId }
        : { outcome: 'unreachable', externalId };
    }

    this.linked.add(dedupeKey);
    return { outcome: 'linked', externalId };
  }
}
