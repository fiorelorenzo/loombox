/* ---------------------------------------------------------------------
 * The Jira `TrackerBackend` — live tracker slices 1 + 2 + 3 (SPEC §7.10
 * "Jira, full feature set... two separate REST bases... Use `POST
 * /rest/api/3/search/jql`... comments and transition fields... are
 * Atlassian Document Format (ADF)... discover transitions via
 * `GET .../issue/{key}/transitions` before posting one... Sprints:
 * `GET /rest/agile/1.0/board/{id}/sprint` to list, `POST
 * /rest/agile/1.0/sprint/{sprintId}/issue {issues:[...]}` to move issues
 * into a sprint... For OAuth 3LO connections, every call — both REST
 * bases — is routed through `https://api.atlassian.com/ex/jira/{cloudId}/
 * rest/...`... for API-token connections, calls go straight to the site";
 * issues #214/#216/#217). Implements `@loombox/shared`'s `TrackerBackend`
 * extension point (#209) for `list`/`get`/`create`/`update`/`addComment`/
 * `listBindings` (slice 1, #214), `listTransitions`/`transition` (slice
 * 2, #216), and `listBoards`/`listSprints`/`moveToSprint` (slice 3,
 * #217) against a bound Jira Cloud project.
 *
 * **Clean room.** Designed from SPEC §7.10 and issues #214/#216/#217
 * only, plus the live public Jira Cloud REST v3 docs
 * (`developer.atlassian.com/cloud/jira/platform/rest/v3/...`), the live
 * public Jira Software Cloud Agile REST docs
 * (`developer.atlassian.com/cloud/jira/software/rest/api-group-board/`,
 * `.../rest/api-group-sprint/` — confirmed field-by-field: board list's
 * `{isLast, maxResults, startAt, total, values:[{id, name, self, type}]}`,
 * sprint's `{id, self, state, name, startDate, endDate, completeDate,
 * originBoardId, goal}`, "Move issues to sprint and rank"'s `{issues:
 * string[], rankAfterIssue?, rankBeforeIssue?, rankCustomFieldId?}`
 * capped at 50 issues/call, and "Partially update sprint"'s own
 * documented state-machine notes: `future`→`active` needs `startDate`/
 * `endDate` already set, `active`→`closed` sets `completeDate` itself,
 * no other state change is allowed), and Atlassian's own OAuth docs
 * (`developer.atlassian.com/cloud/oauth/getting-started/making-calls-to-api/`)
 * — never emdash's or HAPI's source (SPEC §13: HAPI is AGPL-3.0, never
 * cloned or copied into this build environment; emdash is design
 * inspiration only, per AGENTS.md).
 *
 * **Credentials only through `resolveCredential`**, mirroring
 * `./github-tracker-backend.ts`'s own boundary exactly: this module never
 * runs an OAuth or API-token connect flow and never imports
 * `./jira-connect.ts`/`./keyring.ts` directly. `#225`'s `JiraConnectService`
 * resolves a full `ConnectedAccount` to a `{baseUrl, authHeader}` pair (the
 * `baseUrl` already carries the OAuth-3LO-vs-API-token routing decision —
 * either `https://api.atlassian.com/ex/jira/{cloudId}` or the site's own
 * host — since that decision needs the account's `credentialSource`, which
 * this backend never sees); `{@link ResolveJiraCredential}` is the same
 * narrow, connectionId-keyed seam `ResolveGithubCredential` is for GitHub.
 * Whoever wires the real connected-accounts registry (account-pin
 * resolution, #227, composed with `JiraConnectService`) should satisfy
 * this type rather than this backend growing a second lookup path.
 * `jira-tracker-backend.test.ts` checks this both behaviorally (every
 * request's `authorization` header comes verbatim from the resolved
 * credential) and structurally (this file's own import specifiers never
 * include `./jira-connect` or `./keyring`).
 *
 * **Server-side only**, same rationale as `./github-tracker-backend.ts`:
 * lives in `@loombox/node`, which is not in `apps/web`'s dependency graph.
 *
 * **Real-world Jira behaviour handled here, each with its own test**
 * (issue #214's acceptance, plus #216's below):
 * - Search uses `POST /rest/api/3/search/jql` — the modern
 *   token-paginated (`nextPageToken`/`isLast`, no `total`) replacement for
 *   the deprecated `GET`/`POST /rest/api/3/search` — never the deprecated
 *   endpoint.
 * - Comment bodies and any `description` field in `create`/`update`'s
 *   `fields` bag are Atlassian Document Format, not markdown: a caller
 *   passes plain text, this backend builds the minimal
 *   `{type:'doc', version:1, content:[...]}` document (`textToAdf`) — the
 *   ADF boundary never leaks to a caller. Reading a `description` back out
 *   (`get`/`list`) does the inverse (`adfToPlainText`, a small clean-room
 *   ADF-to-text flattener, independently designed rather than adapted from
 *   any existing `flattenAdf`).
 * - Two REST bases: this backend only ever composes URLs from
 *   `credential.baseUrl` — it is host-agnostic by construction, so both
 *   `https://api.atlassian.com/ex/jira/{cloudId}` (OAuth 3LO) and a plain
 *   site host (API token) work identically for every call, including
 *   slice 2's `listTransitions`/`transition`. OAuth 3LO Jira connect
 *   (#226) does not exist yet (per #225), so the OAuth-base tests
 *   construct a `JiraCredential` with that host shape directly rather than
 *   going through a real connect flow — proving this backend's own
 *   routing is correct independent of #226 landing.
 * - `POST /rest/api/3/issue` (create) returns only `{id, key, self}`, and
 *   `PUT /rest/api/3/issue/{key}` (update) returns `204 No Content` —
 *   neither returns the full issue. Both `create` and `update` follow up
 *   with a `get` so callers always receive a canonical, fully-populated
 *   `TrackerItemLive` rather than an echo of what they just sent.
 * - A `404` is reported as `JiraTrackerAccessError`, never "gone" — Jira,
 *   like GitHub, does not distinguish "does not exist" from "you cannot
 *   see it".
 * - Jira's workflow is per-project/per-issue-type, unlike GitHub's fixed
 *   open/closed pair (#215): `listTransitions` always discovers the
 *   *actually available* moves from `GET .../issue/{key}/transitions`
 *   rather than assuming any hardcoded set, and `transition` posts the
 *   chosen `id` back via `POST .../issue/{key}/transitions`. A transition
 *   that requires fields Jira's own workflow screen would otherwise
 *   collect (most commonly `resolution` on a "Done"-category move) is a
 *   real, common case, not an edge case: `listTransitions` reports it via
 *   `TrackerTransition.requiresFields` (read straight off Jira's own
 *   per-transition `fields` map, `required: true`), and `transition`
 *   accepts an optional fourth `options.fields`/`options.comment`
 *   parameter (the latter ADF-converted like every other comment body
 *   here) to satisfy it. If a caller posts a transition anyway without
 *   the fields Jira's workflow demands, Jira's own `400` validation
 *   response is surfaced as a typed `JiraTrackerTransitionValidationError`
 *   (carrying the per-field messages Jira returned) — never silently
 *   dropped, and never reported as success.
 * - Three DIFFERENT pagination shapes across this one backend, never
 *   confused for one another: `search/jql` (issue #214) is token-paginated
 *   (`nextPageToken`/`isLast`, no `total`); `project/search` (`listBindings`)
 *   is `startAt`/`isLast` with no `total`; the Agile REST base's `board`
 *   and `board/{id}/sprint` list endpoints (issue #217, this bullet) are
 *   `startAt`/`maxResults`/`isLast`/`total`/`values` — the same shape as
 *   each other, but distinct from both issue-API shapes above, and the
 *   reason boards/sprints could not simply reuse `listBindings`'s own
 *   pagination loop unchanged.
 * - Boards/sprints (issue #217) live on the Agile REST base
 *   (`/rest/agile/1.0/...`), never `/rest/api/3/...` — a genuinely
 *   different base path, confirmed against the live Agile REST docs (this
 *   file's own top comment). `listBoards` scopes to the bound project via
 *   `projectKeyOrId` (never returns every board the credential can see);
 *   `listSprints`/`moveToSprint`/`createSprint`/`startSprint`/
 *   `closeSprint` do not take a `TrackerBinding` at all — SPEC §7.10's own
 *   literal `TrackerBackend` block gives `listSprints(boardId)`/
 *   `moveToSprint(sprintId, externalIds)` no binding parameter, so the
 *   `connectionId` a later call needs to resolve credentials has nowhere
 *   to come from except the id itself. `encodeJiraCompositeId`/
 *   `decodeJiraCompositeId` fold `{connectionId, id}` into the opaque
 *   `TrackerBoard.id`/`TrackerSprint.id` string `listBoards`/`listSprints`
 *   hand back — a base64url JSON envelope, not a delimited string, since a
 *   real `connectionId` already contains colons (`jira:{host}:{accountId}`,
 *   `./jira-connect.ts`) and any single-character delimiter would be
 *   ambiguous to split back apart.
 * - Sprint STATE (`future`/`active`/`closed`) is carried on
 *   `TrackerSprint.state`, never flattened away: a board has no state of
 *   its own (`TrackerBoard` stays `{id, name}`), so a cockpit reading
 *   `listSprints` can tell a story sitting in the active sprint from one
 *   still in the backlog (a future sprint) or already shipped (closed) —
 *   the whole reason this is modelled as two separate methods/types
 *   rather than one combined board+sprint list.
 * - `createSprint`/`startSprint`/`closeSprint` are NOT part of
 *   `TrackerBackend` (SPEC's literal block has no such method — see
 *   above); they exist directly on `JiraTrackerBackend`, the same
 *   "structurally-compatible superset" precedent as `transition`'s own
 *   extra fourth `options` parameter, for issue #217's third acceptance
 *   line ("create/start/close... where the UI needs it"). `startSprint`/
 *   `closeSprint` use the *partial*-update endpoint (`POST
 *   /rest/agile/1.0/sprint/{sprintId}`), never the full-replace `PUT` —
 *   Jira's own docs: a `PUT` nulls out every field the request body
 *   omits, which would silently wipe `name`/`goal` on every start/close
 *   call; the partial `POST` updates only the fields given.
 * --------------------------------------------------------------------- */

import type {
  TrackerBackend,
  TrackerBackendCapabilities,
  TrackerBinding,
  TrackerBoard,
  TrackerItemLive,
  TrackerListFilter,
  TrackerListPage,
  TrackerSprint,
  TrackerTransition,
} from '@loombox/shared';
import type { JiraTarget, WorkflowCategoryV1 } from '@loombox/protocol';

/** The one shape a resolved Jira credential needs (SPEC §7.10's `{token, cloudId}`, refined here — see this module's top comment — into the two things every REST call actually needs: an already-routed REST root and a ready-to-send auth header). */
export interface JiraCredential {
  /** The REST v3 root with NO trailing slash and NO `/rest/...` suffix — either `https://api.atlassian.com/ex/jira/{cloudId}` (OAuth 3LO) or `https://{site}.atlassian.net` (API token). This backend appends `/rest/api/3/...` itself. */
  readonly baseUrl: string;
  /** The complete `Authorization` header value, set verbatim (`Bearer <token>` for OAuth 3LO, `Basic <base64(email:apiToken)>` for API token) — this backend never constructs or decodes a credential itself. */
  readonly authHeader: string;
}

/**
 * Resolves the credential for a `TrackerBinding.connectionId`. The ONLY
 * source of Jira auth this backend ever consults — see this module's top
 * comment for why it is defined here rather than imported from
 * `./jira-connect.ts`.
 */
export type ResolveJiraCredential = (connectionId: string) => Promise<JiraCredential>;

/** Raised for a `404` (no access, not "gone"), a payload/binding that isn't Jira-shaped, or a `resolveCredential` result missing `baseUrl`/`authHeader`. */
export class JiraTrackerAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraTrackerAccessError';
  }
}

/** Raised for any other non-2xx Jira response. */
export class JiraTrackerRequestError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`jira tracker: HTTP ${status} from ${url}`);
    this.name = 'JiraTrackerRequestError';
    this.status = status;
  }
}

/** Raised when `POST .../issue/{key}/transitions` fails Jira's own workflow-screen field validation (HTTP `400` with an `errors` map) — most commonly a required `resolution` on a "Done"-category move that wasn't supplied via `transition`'s `options.fields`. Distinguished from the generic `JiraTrackerRequestError` so a caller can react to it specifically (e.g. re-prompt for the missing fields) rather than treating it as an outage; `errors`/`errorMessages` carry Jira's own per-field/general messages verbatim. Never silently swallowed — a transition that needed fields it didn't get always surfaces this, never a bare success. */
export class JiraTrackerTransitionValidationError extends Error {
  readonly errors: Readonly<Record<string, string>>;
  readonly errorMessages: readonly string[];
  constructor(transitionId: string, errors: Record<string, string>, errorMessages: string[]) {
    const details = [
      ...errorMessages,
      ...Object.entries(errors).map(([field, msg]) => `${field}: ${msg}`),
    ];
    super(
      `jira tracker: transition '${transitionId}' rejected by Jira's workflow validation` +
        (details.length > 0 ? ` — ${details.join('; ')}` : '') +
        ' (call listTransitions() to discover which fields this move needs, then pass options.fields/options.comment)',
    );
    this.name = 'JiraTrackerTransitionValidationError';
    this.errors = errors;
    this.errorMessages = errorMessages;
  }
}

/** A minimal Atlassian Document Format document — just enough of the schema for this backend's own write path (a single paragraph of plain text). */
interface AdfDocument {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: unknown[];
}

/** Builds the minimal ADF document SPEC §7.10 calls for — `{type:'doc', version:1, content:[...]}` — wrapping `text` as one paragraph. An empty string becomes an empty paragraph (valid ADF), not an omitted one, so `addComment(binding, id, '')` still posts a well-formed, if empty, comment rather than silently doing nothing. */
function textToAdf(text: string): AdfDocument {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: text.length > 0 ? [{ type: 'text', text }] : [],
      },
    ],
  };
}

/** Block-level ADF node types that end in a line break once flattened — enough for this backend's own read path (Jira's own commonly-populated description/comment nodes), not an exhaustive ADF schema implementation. */
const ADF_BLOCK_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'bulletList',
  'orderedList',
  'panel',
  'rule',
]);

function flattenAdfNode(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  if (obj.type === 'hardBreak') return '\n';
  const content = Array.isArray(obj.content) ? obj.content : [];
  const inner = content.map(flattenAdfNode).join('');
  return typeof obj.type === 'string' && ADF_BLOCK_NODE_TYPES.has(obj.type) ? `${inner}\n` : inner;
}

/** The inverse of `textToAdf` for reading `description`/comment bodies back out of a Jira payload — `null` (Jira's own "no description set" value) becomes `''`, not `'null'`. Trims exactly the trailing newline(s) `flattenAdfNode`'s block-node handling adds, never interior whitespace. */
function adfToPlainText(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  return flattenAdfNode(doc).replace(/\n+$/, '');
}

/** Escapes a JQL string literal's own delimiter and escape character — the only two characters that would otherwise break out of the surrounding `"..."` this backend wraps every filter value in. */
function escapeJqlStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Builds the `jql` this backend's `list()` sends to `search/jql` — always scoped to `binding.target.projectKey`, plus one `AND`-ed clause per populated `TrackerListFilter` field. `filter.query` maps to JQL's own free-text operator (`~`) rather than being left unused (contrast `./github-tracker-backend.ts`'s `issuesListUrl`, where GitHub's per-repo issues-list endpoint has no query parameter at all and a real Search API call would be a different, out-of-scope request shape) — Jira's query language already *is* JQL, so a search-scoped free-text clause is the direct, no-extra-request equivalent. */
function buildJql(target: JiraTarget, filter: TrackerListFilter): string {
  const clauses = [`project = "${escapeJqlStringLiteral(target.projectKey)}"`];
  if (filter.status) clauses.push(`status = "${escapeJqlStringLiteral(filter.status)}"`);
  if (filter.assignee) clauses.push(`assignee = "${escapeJqlStringLiteral(filter.assignee)}"`);
  if (filter.query) clauses.push(`text ~ "${escapeJqlStringLiteral(filter.query)}"`);
  return clauses.join(' AND ');
}

/** Clamps `TrackerListFilter.limit` into `search/jql`'s documented `1-100` range for `maxResults`, defaulting to 50 when absent — mirrors `./github-tracker-backend.ts`'s own `per_page` clamp. */
function clampMaxResults(limit: number | undefined): number {
  if (!limit) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

/** The exact field set this backend's `toTrackerItem` reads — passed explicitly to `search/jql` so a page of search results carries the same shape `get`'s single-issue fetch returns, rather than relying on whatever Jira's own default field set happens to be today. */
const SEARCH_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'assignee',
  'reporter',
  'labels',
  'priority',
  'created',
  'updated',
  'resolutiondate',
] as const;

/** Every field this backend reads off a Jira issue payload, whether from `GET /issue/{key}` or one entry of `search/jql`'s `issues[]` — both return the identical `{id, key, self, fields}` shape. */
interface JiraIssuePayload {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: unknown;
    status?: { name: string; statusCategory?: { key: string; name?: string } | null } | null;
    issuetype?: { name: string } | null;
    assignee?: unknown;
    reporter?: unknown;
    labels?: string[];
    priority?: { name: string } | null;
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
  };
}

/**
 * Jira's `status.statusCategory.key` IS the workflow category (issue
 * #651, v7 decision F4-2) — `new`/`indeterminate`/`done`, the exact
 * three ids `@loombox/protocol`'s `WorkflowCategoryV1` uses, so this is
 * a validated widen, never a label-matching guess the way a project's
 * own arbitrary status *names* ("To Do", "In Progress", a custom Kanban
 * scheme's own words) would require. Jira always populates
 * `statusCategory` alongside `status` on a real issue; the fallback only
 * matters for a malformed/partial payload, and defaults to the same
 * `new` bucket an unset local status falls into.
 */
export function deriveJiraWorkflowCategory(key: string | null | undefined): WorkflowCategoryV1 {
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : 'new';
}

/** `credential.baseUrl`'s own shape for an OAuth-3LO-routed connection (SPEC §7.10) — the cloudId is the one path segment after `/ex/jira/`. */
const OAUTH_ROUTED_BASE = /^https:\/\/api\.atlassian\.com\/ex\/jira\/([^/]+)/;

/** A browsable issue URL, best-effort. For a direct-site `baseUrl` (API token) this is exactly `{site}/browse/{key}`. For an OAuth-3LO `baseUrl` (`api.atlassian.com/ex/jira/{cloudId}`), that host is never itself browsable and the real site hostname isn't recoverable from a bare `cloudId` without another `accessible-resources` round trip (#226's job, not this backend's) — falls back to the issue's own `self` API link rather than fabricating a wrong browse URL. Called out rather than silently glossed over, same spirit as `./github-tracker-backend.ts`'s own documented gaps. */
function issueBrowseUrl(baseUrl: string, key: string, self: string): string {
  if (OAUTH_ROUTED_BASE.test(baseUrl)) return self;
  return `${baseUrl}/browse/${encodeURIComponent(key)}`;
}

function toTrackerItem(raw: JiraIssuePayload, baseUrl: string): TrackerItemLive {
  return {
    externalId: raw.key,
    title: raw.fields.summary,
    url: issueBrowseUrl(baseUrl, raw.key, raw.self),
    fields: {
      status: raw.fields.status?.name ?? null,
      workflowCategory: deriveJiraWorkflowCategory(raw.fields.status?.statusCategory?.key),
      issueType: raw.fields.issuetype?.name ?? null,
      description: adfToPlainText(raw.fields.description),
      assignee: raw.fields.assignee ?? null,
      reporter: raw.fields.reporter ?? null,
      labels: raw.fields.labels ?? [],
      priority: raw.fields.priority?.name ?? null,
      createdAt: raw.fields.created ?? null,
      updatedAt: raw.fields.updated ?? null,
      resolvedAt: raw.fields.resolutiondate ?? null,
    },
  };
}

/** The Jira issue-write fields this backend forwards from `create`/`update`'s untyped `fields` bag — everything else is silently dropped rather than sent as an unrecognised key Jira would reject (mirrors `./github-tracker-backend.ts`'s `ISSUE_WRITE_FIELDS`). `description` gets the plain-text-to-ADF treatment; every other field is forwarded exactly as the caller shaped it (e.g. `assignee: {accountId}`, `issuetype: {name}` or `{id}`) — this backend performs the ADF conversion `description` specifically needs, not a general Jira-field-shape translation layer. */
const ISSUE_WRITE_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'labels',
  'assignee',
  'priority',
] as const;

function pickIssueWriteFields(fields: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ISSUE_WRITE_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    picked[key] = key === 'description' && typeof value === 'string' ? textToAdf(value) : value;
  }
  return picked;
}

function requireJiraTarget(target: TrackerBinding['target']): JiraTarget {
  if (
    typeof target !== 'object' ||
    target === null ||
    !('cloudId' in target) ||
    !('projectKey' in target)
  ) {
    throw new JiraTrackerAccessError(
      'jira tracker: binding.target is not a JiraTarget (expected {cloudId, projectKey}) — this backend only binds to Jira projects',
    );
  }
  return target as JiraTarget;
}

function issueApiUrl(baseUrl: string, externalId: string): string {
  return `${baseUrl}/rest/api/3/issue/${encodeURIComponent(externalId)}`;
}

function transitionsApiUrl(baseUrl: string, externalId: string): string {
  return `${issueApiUrl(baseUrl, externalId)}/transitions`;
}

/** The fields this backend reads off each transition Jira's discovery endpoint returns — `fields`, when present, is Jira's own workflow-screen field map (`{fieldKey: {required, ...}}`); `to.statusCategory.key` (issue #696) is the ONE other field read out of `to` (`hasScreen`, `isGlobal`, ... stay UI chrome this backend has no use for) — the same `new`/`indeterminate`/`done` vocabulary `deriveJiraWorkflowCategory` already derives for a read, letting `listTransitions` report which workflow CATEGORY each transition lands on, not only its raw Jira status name. */
interface JiraTransitionPayload {
  id: string;
  name: string;
  fields?: Record<string, { required?: boolean }>;
  to?: { statusCategory?: { key?: string | null } | null } | null;
}

/** True when Jira's own per-transition `fields` map marks at least one field `required: true` — the signal `listTransitions` surfaces as `TrackerTransition.requiresFields` so a caller knows to pass `transition`'s `options.fields` (e.g. `{resolution: {name: 'Done'}}`) before posting, rather than discovering it only after a `400`. */
function transitionRequiresFields(fields: JiraTransitionPayload['fields']): boolean {
  if (!fields) return false;
  return Object.values(fields).some((field) => field?.required === true);
}

/** Optional extras `transition` forwards on top of the chosen `transitionId` (issue #216). Neither is validated here — Jira's own `400` response is what surfaces a still-missing required field, as `JiraTrackerTransitionValidationError`. */
export interface JiraTransitionOptions {
  /** Extra Jira `fields` to submit with the transition, forwarded exactly as given — e.g. `{resolution: {name: 'Done'}}`. Unlike `description` in `pickIssueWriteFields`, no ADF conversion happens here: a transition's required fields (resolution, custom fields, ...) are never a plain-text/ADF shape the way `description`/comment bodies are. */
  readonly fields?: Record<string, unknown>;
  /** A plain-text comment to attach as part of the transition, converted to ADF the same way `addComment`'s `body` is (`textToAdf`) and sent as Jira's own `update.comment: [{add: {body}}]` shape — the transition-time equivalent of a separate `addComment` call. */
  readonly comment?: string;
}

function buildTransitionRequestBody(
  transitionId: string,
  options: JiraTransitionOptions | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { transition: { id: transitionId } };
  if (options?.fields) body.fields = options.fields;
  if (options?.comment !== undefined) {
    body.update = { comment: [{ add: { body: textToAdf(options.comment) } }] };
  }
  return body;
}

/**
 * Folds `{connectionId, id}` into the single opaque string
 * `TrackerBoard.id`/`TrackerSprint.id` hand back (issue #217 — see this
 * module's top comment for why: `TrackerBackend.listSprints`/
 * `moveToSprint` take a bare `boardId`/`sprintId`, never a
 * `TrackerBinding`). Base64url JSON, not a delimited string — a real
 * `connectionId` already contains colons (`jira:{host}:{accountId}`,
 * `./jira-connect.ts`), so a single-character delimiter would be
 * ambiguous to split back apart.
 */
function encodeJiraCompositeId(connectionId: string, id: string): string {
  return Buffer.from(JSON.stringify({ connectionId, id }), 'utf8').toString('base64url');
}

/** The inverse of {@link encodeJiraCompositeId}. `kind` is only used to name the id flavour in a thrown `JiraTrackerAccessError` — this backend never accepts a sprint id where a board id was expected or vice versa, but both fail the same way (a caller-facing string that did not round-trip through `listBoards`/`listSprints`), so this never needs to distinguish the two beyond that message. */
function decodeJiraCompositeId(
  composite: string,
  kind: 'board' | 'sprint',
): { connectionId: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(composite, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('connectionId' in parsed) ||
    !('id' in parsed) ||
    typeof parsed.connectionId !== 'string' ||
    typeof parsed.id !== 'string'
  ) {
    throw new JiraTrackerAccessError(
      `jira tracker: '${composite}' is not a ${kind} id this backend issued (expected the opaque id from a prior listBoards/listSprints call)`,
    );
  }
  return { connectionId: parsed.connectionId, id: parsed.id };
}

/**
 * Jira Agile REST's own `{isLast, maxResults, startAt, total, values}`
 * pagination shape — `GET /rest/agile/1.0/board` and `GET
 * /rest/agile/1.0/board/{id}/sprint` both use it (confirmed against the
 * live docs, this module's top comment). Distinct from BOTH issue-API
 * pagination shapes already in this file: `search/jql`'s token-paginated
 * `{nextPageToken, isLast}` and `project/search`'s `{startAt, isLast}`
 * (no `total`/`values` typed for that one, `listBindings` never needs
 * them) — three shapes, never conflated.
 */
interface JiraAgilePage<T> {
  readonly values: T[];
  readonly isLast: boolean;
}

/** `GET /rest/agile/1.0/board`'s per-board shape — only `id`/`name` are read; `self`/`type` (scrum vs kanban) are Jira's own extras `TrackerBoard` (SPEC §7.10's placeholder shape) has no field for yet. */
interface JiraBoardPayload {
  readonly id: number;
  readonly name: string;
}

/** `GET /rest/agile/1.0/board/{id}/sprint`'s (and `POST`/`POST .../sprint/{id}`'s create/start/close responses') per-sprint shape — confirmed against the live docs (this module's top comment). `completeDate` is read-only (Jira sets it itself on `active`→`closed`) and never sent back on a write. */
interface JiraSprintPayload {
  readonly id: number;
  readonly name: string;
  readonly state: 'future' | 'active' | 'closed';
  readonly originBoardId?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly goal?: string;
}

/** Maps a raw Agile REST sprint payload to `TrackerSprint`, folding `connectionId` into both `id` and `boardId` via {@link encodeJiraCompositeId} — shared by `listSprints`, `createSprint`, `startSprint`, and `closeSprint` so all four hand back an identically-shaped, identically-opaque `TrackerSprint`. */
function toTrackerSprint(raw: JiraSprintPayload, connectionId: string): TrackerSprint {
  return {
    id: encodeJiraCompositeId(connectionId, String(raw.id)),
    name: raw.name,
    state: raw.state,
    boardId:
      raw.originBoardId === undefined
        ? undefined
        : encodeJiraCompositeId(connectionId, String(raw.originBoardId)),
    startDate: raw.startDate,
    endDate: raw.endDate,
    goal: raw.goal,
  };
}

/** Jira's own documented cap on "Move issues to sprint and rank" (`POST /rest/agile/1.0/sprint/{sprintId}/issue`): at most 50 issue keys per call. `moveToSprint` chunks a larger caller-supplied batch into multiple calls rather than failing outright — the same accommodation `clampMaxResults` makes for `search/jql`'s own documented range, just chunked instead of clamped since every issue in the batch still needs to move, not just the first 100. */
const JIRA_MOVE_TO_SPRINT_MAX_ISSUES = 50;

async function jiraRequest(
  fetchImpl: typeof fetch,
  credential: JiraCredential,
  url: string,
  init: RequestInit = {},
  skipStatuses: readonly number[] = [],
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: credential.authHeader,
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  // A caller that needs to inspect a specific non-2xx status itself (e.g.
  // `transition`'s own `400` field-validation body) opts out of the
  // generic handling below for just that status, via `skipStatuses`.
  if (skipStatuses.includes(response.status)) return response;

  // Jira, like GitHub, returns 404 rather than 403 when the authenticated
  // credential has no access to a project/issue — it never confirms the
  // resource exists to a caller it won't show it to.
  if (response.status === 404) {
    throw new JiraTrackerAccessError(
      `jira tracker: 404 from ${url} — either nothing exists at this URL, or this credential has no access to it (Jira does not distinguish the two)`,
    );
  }

  if (!response.ok) {
    throw new JiraTrackerRequestError(response.status, url);
  }
  return response;
}

export interface JiraTrackerBackendOptions {
  /** The only source of Jira credentials — see this module's top comment. */
  resolveCredential: ResolveJiraCredential;
  /** Injectable for tests; defaults to the global `fetch`. Issue #214's acceptance: tests must stub this, never hit the real Jira API. */
  fetchImpl?: typeof fetch;
}

/** The Jira `TrackerBackend` (SPEC §7.10, issues #214/#216/#217). One instance is reusable across every bound project — `resolveCredential` is re-invoked per call rather than cached on the instance, same rationale as `GithubTrackerBackend`. */
export class JiraTrackerBackend implements TrackerBackend {
  readonly id = 'jira' as const;

  /**
   * Slices 1+2+3 (issues #214/#216/#217): issues, comments, discovered
   * workflow transitions, and now boards/sprints via the Agile REST base
   * (`listBoards`/`listSprints`/`moveToSprint`, plus the Jira-only
   * `createSprint`/`startSprint`/`closeSprint` extras — see this file's
   * top comment). `milestones` stays `false`: Jira's nearest analogue,
   * `fixVersions`, isn't read or written by this slice. `customFields`
   * stays `false` too — `TrackerItemLive.fields` only ever carries the
   * fixed set `toTrackerItem` maps, and `pickIssueWriteFields` only ever
   * forwards `ISSUE_WRITE_FIELDS`, so an arbitrary `customfield_XXXXX`
   * key is neither read nor writable yet, unlike GitHub where
   * `customFields: false` is permanent (no analogue at all).
   */
  readonly capabilities: TrackerBackendCapabilities = {
    comments: true,
    transitions: true,
    boards: true,
    sprints: true,
    labels: true,
    milestones: false,
    customFields: false,
  };

  private readonly resolveCredential: ResolveJiraCredential;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JiraTrackerBackendOptions) {
    this.resolveCredential = options.resolveCredential;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async credential(connectionId: string): Promise<JiraCredential> {
    const credential = await this.resolveCredential(connectionId);
    if (!credential.baseUrl || !credential.authHeader) {
      throw new JiraTrackerAccessError(
        `jira tracker: resolveCredential('${connectionId}') returned no usable baseUrl/authHeader`,
      );
    }
    return credential;
  }

  /** The cloudId for `credential.baseUrl`'s site — read straight out of an OAuth-3LO base (it's already the URL's own path segment), or discovered for a direct-site base via `_edge/tenant_info`, the same unauthenticated, undocumented-but-stable lookup Atlassian's own web app and support docs (`support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id`) point operators to — there is no documented REST v3 endpoint for this. Only `listBindings` needs a cloudId at all; every CRUD/search/comment call below routes purely through `credential.baseUrl` and never looks this up. */
  private async resolveCloudId(credential: JiraCredential): Promise<string> {
    const oauthMatch = OAUTH_ROUTED_BASE.exec(credential.baseUrl);
    if (oauthMatch) return oauthMatch[1];
    const url = `${credential.baseUrl}/_edge/tenant_info`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new JiraTrackerRequestError(response.status, url);
    }
    const body = (await response.json()) as { cloudId: string };
    return body.cloudId;
  }

  /**
   * Every project this connection's credential can see, packaged as
   * bindings — `GET /rest/api/3/project/search`, paginated via
   * `startAt`/`isLast` (the v3 project-search shape; unrelated to
   * `search/jql`'s token pagination). The cloudId needed for each
   * binding's `JiraTarget` is resolved once per call, not per project.
   */
  async listBindings(connectionId: string): Promise<TrackerBinding[]> {
    const credential = await this.credential(connectionId);
    const cloudId = await this.resolveCloudId(credential);
    const bindings: TrackerBinding[] = [];
    let startAt = 0;
    for (;;) {
      const url = new URL(`${credential.baseUrl}/rest/api/3/project/search`);
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', '50');
      const response = await jiraRequest(this.fetchImpl, credential, url.toString());
      const body = (await response.json()) as { values: Array<{ key: string }>; isLast: boolean };
      for (const project of body.values) {
        bindings.push({ connectionId, target: { cloudId, projectKey: project.key } });
      }
      if (body.isLast || body.values.length === 0) break;
      startAt += body.values.length;
    }
    return bindings;
  }

  async list(binding: TrackerBinding, filter: TrackerListFilter): Promise<TrackerListPage> {
    const target = requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    const requestBody: Record<string, unknown> = {
      jql: buildJql(target, filter),
      maxResults: clampMaxResults(filter.limit),
      fields: SEARCH_FIELDS,
      nextPageToken: filter.cursor ?? null,
    };
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      `${credential.baseUrl}/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );
    const parsed = (await response.json()) as {
      issues: JiraIssuePayload[];
      nextPageToken?: string;
      isLast: boolean;
    };
    return {
      items: parsed.issues.map((raw) => toTrackerItem(raw, credential.baseUrl)),
      nextCursor: parsed.isLast ? undefined : parsed.nextPageToken,
    };
  }

  async get(binding: TrackerBinding, externalId: string): Promise<TrackerItemLive> {
    requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      issueApiUrl(credential.baseUrl, externalId),
    );
    const raw = (await response.json()) as JiraIssuePayload;
    return toTrackerItem(raw, credential.baseUrl);
  }

  async create(binding: TrackerBinding, fields: Record<string, unknown>): Promise<TrackerItemLive> {
    const target = requireJiraTarget(binding.target);
    const summary = fields.summary;
    if (typeof summary !== 'string' || summary.length === 0) {
      throw new JiraTrackerAccessError(
        'jira tracker: create() requires a non-empty string "summary" field',
      );
    }
    const credential = await this.credential(binding.connectionId);
    const requestBody = {
      fields: {
        project: { key: target.projectKey },
        ...pickIssueWriteFields({ ...fields, summary }),
      },
    };
    // Jira's create response is minimal ({id, key, self} — no `fields` at
    // all), so this can't map straight to a `TrackerItemLive` the way
    // GitHub's create response can; a follow-up `get` returns the
    // canonical, fully-populated item instead (see this module's top
    // comment).
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      `${credential.baseUrl}/rest/api/3/issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );
    const created = (await response.json()) as { key: string };
    return this.get(binding, created.key);
  }

  async update(
    binding: TrackerBinding,
    externalId: string,
    fields: Record<string, unknown>,
  ): Promise<TrackerItemLive> {
    requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    // Jira's update response is `204 No Content` (no body at all — see
    // this module's top comment), so this can't map to a `TrackerItemLive`
    // the way GitHub's PATCH response can; a follow-up `get` returns the
    // canonical, fully-populated item instead.
    await jiraRequest(this.fetchImpl, credential, issueApiUrl(credential.baseUrl, externalId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: pickIssueWriteFields(fields) }),
    });
    return this.get(binding, externalId);
  }

  async addComment(binding: TrackerBinding, externalId: string, body: string): Promise<void> {
    requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    await jiraRequest(
      this.fetchImpl,
      credential,
      `${issueApiUrl(credential.baseUrl, externalId)}/comment`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: textToAdf(body) }),
      },
    );
  }

  /**
   * The moves actually available from this issue's *current* status
   * (SPEC §7.10, issue #216) — discovered via `GET .../issue/{key}/
   * transitions`, Jira's own reflection of its per-project/per-issue-type
   * workflow, never a hardcoded set (contrast GitHub's fixed two-state
   * pair, `./github-tracker-backend.ts`). `requiresFields` surfaces
   * whether Jira's own workflow screen would otherwise collect required
   * fields for this move (most commonly `resolution`) — this backend
   * skips no such transition and drops no such requirement; a caller
   * that ignores the flag simply gets `transition`'s own
   * `JiraTrackerTransitionValidationError` when it posts.
   */
  async listTransitions(binding: TrackerBinding, externalId: string): Promise<TrackerTransition[]> {
    requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      transitionsApiUrl(credential.baseUrl, externalId),
    );
    const body = (await response.json()) as { transitions: JiraTransitionPayload[] };
    return body.transitions.map((raw) => ({
      id: raw.id,
      name: raw.name,
      requiresFields: transitionRequiresFields(raw.fields),
      targetCategory: deriveJiraWorkflowCategory(raw.to?.statusCategory?.key),
    }));
  }

  /**
   * Posts the discovered `transitionId` back via `POST .../issue/{key}/
   * transitions` (SPEC §7.10, issue #216). Accepts one optional fourth
   * argument beyond `TrackerBackend.transition`'s own three-parameter
   * shape — structurally still satisfies that interface (a trailing
   * optional parameter is compatible with callers that only ever pass
   * three arguments) while letting a Jira-aware caller supply what a
   * field-requiring move needs: `options.fields` forwarded verbatim
   * (e.g. `{resolution: {name: 'Done'}}`), `options.comment` converted to
   * ADF and sent as `update.comment` the same shape `addComment` uses. If
   * Jira's own workflow validation still rejects the request (a required
   * field genuinely missing), that surfaces as
   * `JiraTrackerTransitionValidationError` carrying Jira's per-field
   * messages — never silently dropped, and never reported as a success.
   */
  async transition(
    binding: TrackerBinding,
    externalId: string,
    transitionId: string,
    options?: JiraTransitionOptions,
  ): Promise<void> {
    requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      transitionsApiUrl(credential.baseUrl, externalId),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTransitionRequestBody(transitionId, options)),
      },
      [400],
    );
    if (response.status === 400) {
      const body = (await response.json()) as {
        errors?: Record<string, string>;
        errorMessages?: string[];
      };
      throw new JiraTrackerTransitionValidationError(
        transitionId,
        body.errors ?? {},
        body.errorMessages ?? [],
      );
    }
  }

  /**
   * Every Agile board for the bound project (issue #217) — `GET
   * /rest/agile/1.0/board`, scoped via `projectKeyOrId` so this never
   * returns every board the credential can see, paginated via Jira
   * Agile's own `startAt`/`isLast`/`values` shape (`JiraAgilePage`,
   * distinct from `listBindings`'s `project/search` shape and `list`'s
   * `search/jql` shape — this file's top comment). `TrackerBoard.id` is
   * this backend's own opaque `{connectionId, boardId}` envelope
   * (`encodeJiraCompositeId`): `listSprints`/`moveToSprint`/
   * `createSprint` take a bare id with no `TrackerBinding`, so the
   * `connectionId` a later call needs has to travel inside it.
   */
  async listBoards(binding: TrackerBinding): Promise<TrackerBoard[]> {
    const target = requireJiraTarget(binding.target);
    const credential = await this.credential(binding.connectionId);
    const boards: TrackerBoard[] = [];
    let startAt = 0;
    for (;;) {
      const url = new URL(`${credential.baseUrl}/rest/agile/1.0/board`);
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', '50');
      url.searchParams.set('projectKeyOrId', target.projectKey);
      const response = await jiraRequest(this.fetchImpl, credential, url.toString());
      const body = (await response.json()) as JiraAgilePage<JiraBoardPayload>;
      for (const board of body.values) {
        boards.push({
          id: encodeJiraCompositeId(binding.connectionId, String(board.id)),
          name: board.name,
        });
      }
      if (body.isLast || body.values.length === 0) break;
      startAt += body.values.length;
    }
    return boards;
  }

  /**
   * Every sprint on a board (issue #217) — `GET
   * /rest/agile/1.0/board/{boardId}/sprint`, `boardId` decoded from the
   * opaque id `listBoards` handed out. Returns EVERY state
   * (`future`/`active`/`closed`) in one list, `TrackerSprint.state`
   * carrying the distinction — never filtered down to just `active` here,
   * since a caller (a cockpit deciding what to show) is the one who knows
   * which states it cares about, not this backend.
   */
  async listSprints(boardId: string): Promise<TrackerSprint[]> {
    const { connectionId, id: rawBoardId } = decodeJiraCompositeId(boardId, 'board');
    const credential = await this.credential(connectionId);
    const sprints: TrackerSprint[] = [];
    let startAt = 0;
    for (;;) {
      const url = new URL(
        `${credential.baseUrl}/rest/agile/1.0/board/${encodeURIComponent(rawBoardId)}/sprint`,
      );
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', '50');
      const response = await jiraRequest(this.fetchImpl, credential, url.toString());
      const body = (await response.json()) as JiraAgilePage<JiraSprintPayload>;
      for (const sprint of body.values) {
        sprints.push(toTrackerSprint(sprint, connectionId));
      }
      if (body.isLast || body.values.length === 0) break;
      startAt += body.values.length;
    }
    return sprints;
  }

  /**
   * Moves issues into a sprint (issue #217) — `POST
   * /rest/agile/1.0/sprint/{sprintId}/issue {issues:[...]}`, `sprintId`
   * decoded from the opaque id `listSprints` handed out. Jira caps this
   * endpoint at 50 issue keys per call (this module's top comment); a
   * larger `externalIds` batch is chunked into multiple calls rather than
   * rejected outright. A no-op (no request sent) for an empty
   * `externalIds`, mirroring `addComment`-style writes that only ever act
   * when there is something to act on.
   */
  async moveToSprint(sprintId: string, externalIds: string[]): Promise<void> {
    const { connectionId, id: rawSprintId } = decodeJiraCompositeId(sprintId, 'sprint');
    const credential = await this.credential(connectionId);
    for (let i = 0; i < externalIds.length; i += JIRA_MOVE_TO_SPRINT_MAX_ISSUES) {
      const chunk = externalIds.slice(i, i + JIRA_MOVE_TO_SPRINT_MAX_ISSUES);
      await jiraRequest(
        this.fetchImpl,
        credential,
        `${credential.baseUrl}/rest/agile/1.0/sprint/${encodeURIComponent(rawSprintId)}/issue`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ issues: chunk }),
        },
      );
    }
  }

  /**
   * Creates a future sprint on a board (issue #217's third acceptance
   * line) — `POST /rest/agile/1.0/sprint {name, originBoardId, ...}`.
   * NOT part of `TrackerBackend` (this file's top comment: SPEC's literal
   * block has no create-sprint method); callers reach this directly on
   * `JiraTrackerBackend`, the same precedent as `transition`'s own extra
   * `options` parameter.
   */
  async createSprint(
    boardId: string,
    params: { name: string; startDate?: string; endDate?: string; goal?: string },
  ): Promise<TrackerSprint> {
    const { connectionId, id: rawBoardId } = decodeJiraCompositeId(boardId, 'board');
    const credential = await this.credential(connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      `${credential.baseUrl}/rest/agile/1.0/sprint`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: params.name,
          originBoardId: Number(rawBoardId),
          startDate: params.startDate,
          endDate: params.endDate,
          goal: params.goal,
        }),
      },
    );
    const raw = (await response.json()) as JiraSprintPayload;
    return toTrackerSprint(raw, connectionId);
  }

  /**
   * Starts a `future` sprint (issue #217's third acceptance line) —
   * Jira's own state machine requires `startDate`/`endDate` already set
   * before `future`→`active` is allowed, so this backend does not invent
   * defaults; a caller must supply both. Uses the PARTIAL update endpoint
   * (`POST /rest/agile/1.0/sprint/{sprintId}`, not the full-replace
   * `PUT`) so fields this call doesn't touch (`name`, `goal`, ...) are
   * left alone rather than nulled out (this file's top comment). NOT part
   * of `TrackerBackend`, same rationale as `createSprint`.
   */
  async startSprint(
    sprintId: string,
    params: { startDate: string; endDate: string },
  ): Promise<TrackerSprint> {
    const { connectionId, id: rawSprintId } = decodeJiraCompositeId(sprintId, 'sprint');
    const credential = await this.credential(connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      `${credential.baseUrl}/rest/agile/1.0/sprint/${encodeURIComponent(rawSprintId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: 'active',
          startDate: params.startDate,
          endDate: params.endDate,
        }),
      },
    );
    const raw = (await response.json()) as JiraSprintPayload;
    return toTrackerSprint(raw, connectionId);
  }

  /**
   * Completes an `active` sprint (issue #217's third acceptance line) —
   * Jira sets `completeDate` itself; this backend never sends one (this
   * file's top comment). Same PARTIAL-update rationale as `startSprint`.
   * NOT part of `TrackerBackend`, same rationale as `createSprint`.
   */
  async closeSprint(sprintId: string): Promise<TrackerSprint> {
    const { connectionId, id: rawSprintId } = decodeJiraCompositeId(sprintId, 'sprint');
    const credential = await this.credential(connectionId);
    const response = await jiraRequest(
      this.fetchImpl,
      credential,
      `${credential.baseUrl}/rest/agile/1.0/sprint/${encodeURIComponent(rawSprintId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      },
    );
    const raw = (await response.json()) as JiraSprintPayload;
    return toTrackerSprint(raw, connectionId);
  }
}
