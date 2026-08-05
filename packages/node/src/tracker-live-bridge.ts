/* ---------------------------------------------------------------------
 * The live-mode half of the tracker bridge (SPEC §7.10; issue #631):
 * turns a resolved `TrackerBackend` call's `TrackerItemLive` result into
 * exactly the wire shape `NodeDaemon.readTrackerSnapshot`/
 * `applyTrackerWrite` already speak for a native-mode project
 * (`TrackerRecordV1`/`TrackerTypeDefinitionV1`, `tracker-records.ts`'s
 * own "native tracker's wire contract") — the Tracker page's kanban/list
 * views, `resolveRoleValue`, `resolveWorkflowCategory`, and
 * `WORKFLOW_CATEGORY_COLUMNS_V1` (issue #651) already work generically
 * off that role-driven shape, so reusing it here is what makes a live
 * project's board reachable at all, not a second wire contract or a
 * second rendering path bolted on beside it.
 *
 * **What is honestly synthesized versus real.** `title`/`workflowCategory`
 * (`github-tracker-backend.ts`'s/`jira-tracker-backend.ts`'s own #651
 * mapping) and `createdAt`/`updatedAt` (both backends' own ISO fields)
 * are real, provider-sourced data. Everything native-only that an
 * external issue has no analog for is a documented, neutral placeholder,
 * never a guess dressed up as data: `system.{linkedCommitSha,
 * linkedPullRequests,linkedSessionIds,activity,comments}` stay empty
 * (SPEC §7.10's "no local mirror" — there is nowhere on this node to
 * persist any of those for an item that lives on GitHub/Jira),
 * `system.authorId` is the connection id the item was read through (the
 * only account-shaped fact this bridge actually has, never a fabricated
 * user id), `archived` is always `false` (live mode has no archive
 * concept to read), and `issueNumber` is a display-only fallback
 * (`TrackerCard`'s `#N`) parsed from any digits in the external id,
 * never used to look anything up — unlike `NativeTrackerStore`'s own
 * real, indexed, never-reused issue numbers.
 *
 * **Only `title`/`workflowStatus` roles are mapped.** GitHub has no
 * `assignee`/`priority` field to map at all; Jira's `assignee` is an
 * object, not the plain string `TrackerCard`/`TrackerListView` already
 * guard for (`typeof assignee === 'string'`) — mapping either role would
 * silently render nothing, indistinguishable from "no assignee", so both
 * stay unmapped rather than pretending. A live-mode board renders the
 * two roles it can render honestly; assignee/priority for a live record
 * is a real, scoped follow-up, not a gap swallowed here.
 * --------------------------------------------------------------------- */

import type {
  TrackerBackendResolutionErrorV1,
  TrackerRecordV1,
  TrackerTypeDefinitionV1,
} from '@loombox/protocol';
import type { TrackerItemLive } from '@loombox/shared';

import type { TrackerBackendResolutionError } from './tracker-backend-composition';

/** `TrackerMode.provider`, the two live providers this bridge knows how to render. */
export type LiveTrackerProvider = 'github' | 'jira';

const LIVE_TYPE_LABEL: Record<LiveTrackerProvider, string> = {
  github: 'GitHub Issue',
  jira: 'Jira Issue',
};

/**
 * The one synthetic type a live-mode snapshot ever returns — `id` is the
 * provider name itself, which never collides with a native project's own
 * built-in/custom type ids (always user-chosen slugs like `task`/`bug`),
 * so `resolveRoleValue`/`resolveWorkflowCategory` work off it exactly
 * like any native type's own `roles` map.
 */
export function liveTrackerTypeDefinition(provider: LiveTrackerProvider): TrackerTypeDefinitionV1 {
  return {
    id: provider,
    label: LIVE_TYPE_LABEL[provider],
    builtin: true,
    roles: { title: 'title', workflowStatus: 'workflowCategory' },
  };
}

/** Trailing digits from `externalId` — GitHub's is already purely numeric ("42"); Jira's issue key ("PROJ-123") still ends in one. A fallback, and honest about being one: never used to look a record up, only `TrackerCard`'s `#N` display default for the (practically unreachable, since `fields.title` is always set below) case where a title can't be resolved. */
function displayIssueNumber(externalId: string): number {
  const match = /(\d+)(?!.*\d)/.exec(externalId);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEpochMs(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `TrackerItemLive` -> `TrackerRecordV1`, the one conversion every live
 * read/write response goes through — see this module's top comment for
 * exactly what is real data versus a documented neutral placeholder.
 * `connectionId` is the mode's own `connectionId` (never the pinned
 * account's, which can legitimately differ before #631's
 * `connectionPinMismatch` check runs — by the time this function is
 * called, `resolveTrackerBackend` has already confirmed the two agree).
 */
export function liveItemToTrackerRecord(
  item: TrackerItemLive,
  provider: LiveTrackerProvider,
  connectionId: string,
  now: () => number = Date.now,
): TrackerRecordV1 {
  const nowMs = now();
  return {
    id: item.externalId,
    primaryType: provider,
    typeTags: [],
    issueNumber: displayIssueNumber(item.externalId),
    archived: false,
    createdAt: parseEpochMs(item.fields.createdAt, nowMs),
    updatedAt: parseEpochMs(item.fields.updatedAt, nowMs),
    fields: { ...item.fields, title: item.title, url: item.url },
    system: {
      authorId: connectionId,
      linkedCommitSha: [],
      linkedPullRequests: [],
      linkedSessionIds: [],
      activity: [],
      comments: [],
    },
  };
}

/** Human-readable text for every `TrackerBackendResolutionError` kind (SPEC §7.10's "explicit connectivity-error state") — carried as `tracker_snapshot_response`/`tracker_write_response`'s plain `message`, alongside the structured `reason` {@link trackerBackendResolutionErrorToWireV1} builds, so a client with no per-kind UI of its own still has real, specific text rather than a generic "failed to load". */
export function describeTrackerBackendResolutionError(
  error: TrackerBackendResolutionError,
): string {
  switch (error.kind) {
    case 'nativeMode':
      // Defensive only — the bridge dispatch never calls the resolver
      // for a native-mode project, so a caller should never actually
      // see this. See `trackerBackendResolutionErrorV1`'s own doc
      // comment for why the wire union still includes it.
      return 'This project is in native tracker mode.';
    case 'accountNotConnected':
      return "This project's tracker points at a connected account that no longer exists. Reconnect it, or change the tracker mode, in Settings.";
    case 'accountPinRequired':
      return `No connected account is pinned for "${error.capability}", and none can be chosen automatically. Pin one in Settings.`;
    case 'accountPinMalformed':
      return `The saved account pin for "${error.capability}" ("${error.pinnedAccountId}") isn't a valid account id. Fix it in Settings.`;
    case 'accountPinDangling':
      return `The account pinned for "${error.capability}" ("${error.pinnedAccountId}") no longer exists — it was probably disconnected. Pin a different account in Settings.`;
    case 'accountHostMismatch':
      return `The account pinned for "${error.capability}" is on ${error.actualHost}, but this project's tracker expects ${error.expectedHost}. Pin a matching account in Settings.`;
    case 'accountAmbiguous':
      return `Multiple connected accounts could act for "${error.capability}" and none is pinned. Pin one in Settings.`;
    case 'accountPinOptedOut':
      return `This project has explicitly opted out of using any connected account for "${error.capability}". Pin one in Settings to use the live tracker.`;
    case 'connectionPinMismatch':
      return "This project's tracker mode and its connected-account pin disagree. Update one in Settings so they match.";
    case 'credentialUnavailable':
      return "This project's tracker credential isn't available in this node's keyring. Reconnect the account in Settings.";
    case 'credentialSourceUnsupported':
      return `This account's credential source ("${error.credentialSource}") isn't supported for the live tracker yet.`;
  }
}

/** `TrackerBackendResolutionError` (this node's own TS-only union, `tracker-backend-composition.ts`) -> `TrackerBackendResolutionErrorV1` (the wire's zod-validated mirror, `@loombox/protocol`) — an explicit per-kind switch, never a blind cast, so a kind added to one union and not the other fails to compile here instead of silently mismatching on the wire. */
export function trackerBackendResolutionErrorToWireV1(
  error: TrackerBackendResolutionError,
): TrackerBackendResolutionErrorV1 {
  switch (error.kind) {
    case 'nativeMode':
      return { kind: 'nativeMode' };
    case 'accountNotConnected':
      return { kind: 'accountNotConnected', connectionId: error.connectionId };
    case 'accountPinRequired':
      return { kind: 'accountPinRequired', capability: error.capability };
    case 'accountPinMalformed':
      return {
        kind: 'accountPinMalformed',
        capability: error.capability,
        pinnedAccountId: error.pinnedAccountId,
      };
    case 'accountPinDangling':
      return {
        kind: 'accountPinDangling',
        capability: error.capability,
        pinnedAccountId: error.pinnedAccountId,
      };
    case 'accountHostMismatch':
      return {
        kind: 'accountHostMismatch',
        capability: error.capability,
        pinnedAccountId: error.pinnedAccountId,
        expectedHost: error.expectedHost,
        actualHost: error.actualHost,
      };
    case 'accountAmbiguous':
      return {
        kind: 'accountAmbiguous',
        capability: error.capability,
        candidateAccountIds: [...error.candidateAccountIds],
      };
    case 'accountPinOptedOut':
      return { kind: 'accountPinOptedOut', capability: error.capability };
    case 'connectionPinMismatch':
      return {
        kind: 'connectionPinMismatch',
        connectionId: error.connectionId,
        pinnedAccountId: error.pinnedAccountId,
      };
    case 'credentialUnavailable':
      return { kind: 'credentialUnavailable', connectionId: error.connectionId };
    case 'credentialSourceUnsupported':
      return {
        kind: 'credentialSourceUnsupported',
        connectionId: error.connectionId,
        credentialSource: error.credentialSource,
      };
  }
}

/** The shared `{outcome:'error', message, reason}` shape both `trackerSnapshotErrorV1` and `trackerWriteErrorV1` accept for a `resolveTrackerBackend` failure (SPEC §7.10; issue #631) — one place building it keeps the two bridge paths' error responses from drifting in shape, exactly like `NodeDaemon`'s own shared `resolveTrackerDispatch` keeps them from drifting in resolution. */
export function trackerResolutionErrorPayload(error: TrackerBackendResolutionError): {
  outcome: 'error';
  message: string;
  reason: TrackerBackendResolutionErrorV1;
} {
  return {
    outcome: 'error',
    message: describeTrackerBackendResolutionError(error),
    reason: trackerBackendResolutionErrorToWireV1(error),
  };
}
