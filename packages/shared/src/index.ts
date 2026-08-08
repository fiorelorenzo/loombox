export const PACKAGE_NAME = '@loombox/shared';

export type {
  TrackerBackend,
  TrackerBackendCapabilities,
  TrackerBinding,
  TrackerBoard,
  TrackerBoardColumn,
  TrackerBoardIteration,
  TrackerBoardIterationField,
  TrackerBoardStatusField,
  TrackerItemLive,
  TrackerListFilter,
  TrackerListPage,
  TrackerSprint,
  TrackerTransition,
} from './tracker-backend';

// v1: loombox's own local ticketing data model — the `native` TrackerMode
// storage shape (SPEC §7.10 "Native mode"; issue #210) — plus the
// role-driven query helpers a kanban board/priority sort/assignee filter
// all share, and the in-memory secondary-index shape a non-SQL store
// (`@loombox/node`'s `NativeTrackerStore`) rebuilds on every read.
export type {
  TrackerActivityEntry,
  TrackerComment,
  TrackerIndex,
  TrackerRecord,
  TrackerRole,
  TrackerSystem,
  TrackerTypeDefinition,
  TrackerTypeRegistry,
} from './tracker-record';
export {
  BUG_TRACKER_TYPE,
  BUILTIN_TRACKER_TYPES,
  buildTrackerIndex,
  buildTrackerTypeRegistry,
  EPIC_TRACKER_TYPE,
  filterByAssignee,
  groupByWorkflowStatus,
  resolveRoleValue,
  sortByPriority,
  TASK_TRACKER_TYPE,
  TRACKER_ROLES,
  UNRESOLVED_WORKFLOW_STATUS,
} from './tracker-record';

// Pure per-project/per-provider spend rollup (SPEC §7.9; issue #249) —
// shared between `@loombox/node` (filtering a `spend_report_request`
// before sealing the reply) and `@loombox/web` (aggregating the
// decrypted response into the spend-over-time view). See
// `spend-aggregation.ts`'s own doc comment.
export type { SpendAggregationRow, SpendLedgerFilter, SpendAggregateV1 } from './spend-aggregation';
export { filterSpendLedgerRows, aggregateSpendLedgerRows } from './spend-aggregation';

// Pure GitHub check-run conclusion judgment (SPEC §7.14; issues #239/#243)
// — shared between `@loombox/node` (`ci-check-watcher.ts`'s own aggregate
// `state`, and `NodeDaemon.handleCiCheckFailure`'s auto-iterate hook) and
// `@loombox/web` (`RelayClient`'s `'ci_failure'` attention-inbox item), so
// both name the exact same check runs as failing. See `ci-check.ts`'s own
// doc comment.
export { isFailingCiConclusion } from './ci-check';

// Pure test/lint/build run-outcome judgment (SPEC §7.14/§7.15; issue
// #247) — shared between `@loombox/node` (`RunStatusTracker`'s own
// aggregate `state`, and `NodeDaemon`'s auto-iterate hook) and
// `@loombox/web` (`RelayClient`'s `'run_failure'` attention-inbox item),
// so both name the exact same runs as failing. See `run-status.ts`'s own
// doc comment.
export { isFailingRunOutcome } from './run-status';
