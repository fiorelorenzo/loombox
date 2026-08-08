import type { GitHubTarget, JiraTarget, WorkflowCategoryV1 } from '@loombox/protocol';

/**
 * The pluggable `TrackerBackend` extension point every live tracker
 * integration (#213 GitHub, #214 Jira, and any future provider) and the
 * tracker UI (#212, #220) build against (SPEC §7.10, "Pluggable
 * `TrackerBackend` interface"; issue #209). This is a plain TypeScript
 * interface, not a runtime schema — unlike `@loombox/protocol`'s wire
 * messages, a `TrackerBackend` never crosses the wire itself (SPEC §7.10:
 * "a `TrackerBackend` runs server-side, in the node/supervisor, never in a
 * client, since it holds bearer tokens"), so there is nothing here for Zod
 * to validate; only the `GitHubTarget`/`JiraTarget`/`TrackerMode` config
 * values a client picks and hands to a backend are wire data, and those
 * live in `@loombox/protocol`'s `v1/tracker.ts`.
 *
 * **Gap in the spec block, called out rather than silently invented.**
 * SPEC §7.10's literal `TrackerBackend` code block (lines 448-462)
 * references `TrackerBinding`, `TrackerListFilter`, `TrackerListPage`,
 * `TrackerItemLive`, `TrackerTransition`, `TrackerBoard`, and
 * `TrackerSprint` as method parameter/return types, but never declares any
 * of their shapes anywhere in SPEC.md — a repo-wide search for each name
 * only turns up this one block. `TrackerBackend` cannot be typed at all
 * without giving those seven names *some* shape, so the interfaces below
 * are minimal, reasonable placeholders inferred from the surrounding prose
 * (e.g. "GitHub REST for issues/comments/labels/milestones/assignees",
 * "Jira... two separate REST bases", the `externalId`/`fields` vocabulary
 * `TrackerBackend`'s own methods already use). They are deliberately not
 * spec-locked the way `TrackerMode`/`GitHubTarget`/`JiraTarget` are: issue
 * #209's non-goals exclude building #213/#214's concrete GitHub/Jira
 * backends, so whichever of those lands first should feel free to refine
 * these placeholder shapes to whatever the real GitHub/Jira REST payloads
 * actually need, as long as `TrackerBackend`'s own method signatures below
 * (the part SPEC §7.10 does spell out exactly) stay unchanged.
 */

/** One external target a `TrackerBackend` can list/get/create/update against — the connected account plus the GitHub repo or Jira project it is pinned to (mirrors `TrackerMode`'s own `connectionId`/`target` pair, SPEC §7.10). */
export interface TrackerBinding {
  readonly connectionId: string;
  readonly target: GitHubTarget | JiraTarget;
}

/** Query params for `TrackerBackend.list` — every field optional, since a bare `list(binding, {})` (no filter at all) must still be a valid call. */
export interface TrackerListFilter {
  readonly query?: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** One tracker item as read live from the external system (never persisted locally — SPEC §7.10's "no local mirror"). `fields` is the provider's own field bag, deliberately untyped like `create`/`update`'s own `Record<string, unknown>` parameter. */
export interface TrackerItemLive {
  readonly externalId: string;
  readonly title: string;
  readonly url: string;
  readonly fields: Record<string, unknown>;
}

/** One page of `TrackerBackend.list` results; `nextCursor` absent means this is the last page. */
export interface TrackerListPage {
  readonly items: TrackerItemLive[];
  readonly nextCursor?: string;
}

/** One workflow transition `TrackerBackend.listTransitions` discovers and `TrackerBackend.transition` can then apply by `id` (GitHub: a fixed two-state set; Jira: the item's own discovered workflow, SPEC §7.10). `requiresFields` is optional and provider-specific — Jira sets it from its own per-transition workflow-screen field map (a "Done"-category move commonly requiring `resolution`); GitHub's fixed set never sets it, since GitHub has no such per-transition field requirement to discover. `targetCategory` (issue #696) is the {@link WorkflowCategoryV1} this transition lands on — GitHub derives it from the exact same `state`/`stateReason` pair `deriveGithubWorkflowCategory` already maps for a read; Jira derives it from the transition's own `to.statusCategory.key`, the identical field `deriveJiraWorkflowCategory` reads for a read. This is what lets a board move (`TrackerBoard`'s drag/"Move to", which only ever knows the target CATEGORY, never a provider-specific status id) pick the right transition without either backend inventing a second, hand-written category-to-transition table. */
export interface TrackerTransition {
  readonly id: string;
  readonly name: string;
  readonly requiresFields?: boolean;
  readonly targetCategory?: WorkflowCategoryV1;
}

/**
 * One column on a board's own discovered status field (issue #218) — a
 * GitHub Projects v2 single-select field option, or (future) a Jira
 * board column. `targetCategory` is always populated, never optional:
 * a column only ever exists inside a `TrackerBoardStatusField` that
 * `github-projects-v2.ts`'s `discoverGithubBoardFields` has *already*
 * confirmed every option maps onto a real {@link WorkflowCategoryV1} —
 * see that function's own doc comment for why a field with even one
 * unrecognized option is rejected outright rather than surfaced with a
 * partially-mapped column list.
 */
export interface TrackerBoardColumn {
  readonly id: string;
  readonly name: string;
  readonly targetCategory: WorkflowCategoryV1;
}

/**
 * A board's own discovered status field (issue #218) — GitHub Projects
 * v2 defines no built-in "Status" concept, only whatever single-select
 * field(s) a project's own author happened to create, so this is never
 * assumed to exist under a fixed name; it is the ONE single-select
 * field (if any) whose options all resolved to a {@link WorkflowCategoryV1}
 * (see `TrackerBoardColumn`'s own doc comment). `id`/`name` are that
 * field's own GraphQL node id/display name, not a loombox-invented one.
 */
export interface TrackerBoardStatusField {
  readonly id: string;
  readonly name: string;
  readonly columns: readonly TrackerBoardColumn[];
}

/** One iteration on a board's own discovered iteration field (issue #218) — a GitHub Projects v2 `ProjectV2IterationField` iteration, field-for-field off `ProjectV2IterationFieldIteration` (`docs.github.com/public/fpt/schema.docs.graphql`, line 42344). */
export interface TrackerBoardIteration {
  readonly id: string;
  readonly title: string;
  readonly startDate: string;
  readonly duration: number;
}

/** A board's own discovered iteration field (issue #218) — GitHub Projects v2's sprint analog. At most one per board today: `discoverGithubBoardFields` takes the first `ProjectV2IterationField` it finds, since a project defining more than one is not a shape this backend has a documented tie-break for yet (unlike the status field, where a same-named-"status" tie-break exists — see that function's own doc comment). */
export interface TrackerBoardIterationField {
  readonly id: string;
  readonly name: string;
  readonly iterations: readonly TrackerBoardIteration[];
}

/**
 * One board `TrackerBackend.listBoards` exposes (Jira agile board or a
 * GitHub Projects v2 board). `statusField`/`iterationField` are both
 * optional and independent — a board can have neither, either, or both.
 * `statusFieldUnavailableReason` is set (a concrete, board-specific
 * explanation) exactly when `statusField` is absent, so a caller asking
 * "why can't this board move by category" gets a real answer instead of
 * a bare `undefined` to guess at (issue #218's "degrade honestly rather
 * than inventing one" acceptance criterion).
 */
export interface TrackerBoard {
  readonly id: string;
  readonly name: string;
  readonly statusField?: TrackerBoardStatusField;
  readonly statusFieldUnavailableReason?: string;
  readonly iterationField?: TrackerBoardIterationField;
}

/**
 * One sprint `TrackerBackend.listSprints` exposes under a board. `state`
 * is the field that makes a sprint a genuinely different thing from a
 * board (issue #217): a `TrackerBoard` carries no state of its own, so a
 * cockpit reading a sprint's `future`/`active`/`closed` value is the only
 * way to tell a story sitting in the current sprint from one still in the
 * backlog or one already shipped — never flattened into one combined
 * board+sprint list. `boardId`/`startDate`/`endDate`/`goal` are optional:
 * a provider that only ever knows the required trio (`id`/`name`/`state`)
 * can still satisfy this shape.
 */
export interface TrackerSprint {
  readonly id: string;
  readonly name: string;
  readonly state: 'future' | 'active' | 'closed';
  readonly boardId?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly goal?: string;
}

/** Which optional `TrackerBackend` capability groups a given backend actually supports, so the UI can hide affordances a backend cannot serve (SPEC §7.10) — GitHub's flags mostly true minus `sprints`, Jira's mostly true including `sprints`, per SPEC §7.10's delivery-order notes. */
export interface TrackerBackendCapabilities {
  comments: boolean;
  transitions: boolean;
  boards: boolean;
  sprints: boolean;
  labels: boolean;
  milestones: boolean;
  customFields: boolean;
}

/**
 * The extension point itself, exactly as SPEC §7.10 specifies (lines
 * 448-462): `list`/`get`/`create`/`update` (plus `listBindings`) are
 * required — every backend can at minimum read and write items. Comments,
 * transitions, boards, and sprints are optional (`?` on the method itself,
 * not on a nullable field) because not every provider or delivery slice
 * supports them (SPEC §7.10's phased delivery: slice 1 ships issues +
 * comments, slice 2 adds transitions, slice 3 adds boards/sprints) — an
 * absent method, checked with `'addComment' in backend` or a plain
 * optional-call `backend.addComment?.(...)`, is how the UI and
 * `packages/shared/src/tracker-backend.test.ts`'s type-level check both
 * read "this backend does not support X" without a runtime capability
 * flag ever going out of sync with what the object actually implements.
 */
export interface TrackerBackend {
  readonly id: 'github' | 'jira';
  readonly capabilities: TrackerBackendCapabilities;
  listBindings(connectionId: string): Promise<TrackerBinding[]>;
  list(binding: TrackerBinding, filter: TrackerListFilter): Promise<TrackerListPage>;
  get(binding: TrackerBinding, externalId: string): Promise<TrackerItemLive>;
  create(binding: TrackerBinding, fields: Record<string, unknown>): Promise<TrackerItemLive>;
  update(
    binding: TrackerBinding,
    externalId: string,
    fields: Record<string, unknown>,
  ): Promise<TrackerItemLive>;
  addComment?(binding: TrackerBinding, externalId: string, body: string): Promise<void>;
  listTransitions?(binding: TrackerBinding, externalId: string): Promise<TrackerTransition[]>;
  transition?(binding: TrackerBinding, externalId: string, transitionId: string): Promise<void>;
  listBoards?(binding: TrackerBinding): Promise<TrackerBoard[]>;
  listSprints?(boardId: string): Promise<TrackerSprint[]>;
  moveToSprint?(sprintId: string, externalIds: string[]): Promise<void>;
}
