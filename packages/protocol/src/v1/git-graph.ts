import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The commit graph / branch tree viewer (SPEC §7.6; issue #231) —
 * `git_graph_request`/`git_graph_response`, one page of one ref's own
 * commit history at a time, shaped like `git-diff.ts`'s pair but
 * enveloped (like `git-branch.ts`'s `git_branch_create_request`) since
 * this request carries a real caller-chosen filter (`ref`) and paging
 * state (`limit`/`offset`), not merely "ask" the way `git_diff_request`
 * does.
 *
 * PAGING, DECIDED AND MEASURED (this pair's own reason to exist): a real
 * repo can carry tens of thousands of commits, and the client is a PWA
 * that also runs on a phone — the whole graph is never a valid response
 * size. `@loombox/node`'s `git-diff.ts` (`computeCommitGraph`) pages with
 * plain `git log --skip=<offset> --max-count=<limit>` against ONE
 * resolved ref at a time (`ref` defaults to `HEAD`), returning
 * `nextOffset` for the next page.
 *
 * A sha-keyed "resume from the last commit I saw" cursor was the first
 * design considered — no `--skip` walk-and-discard cost at all, since
 * `git log <sha> --skip=1` starts ITS OWN walk directly at `<sha>`. It
 * was rejected: that resumes into `<sha>`'s own ancestry only, and for
 * any ref whose history contains a merge commit, "everything `<ref>`
 * would eventually show" is NOT the same set as "everything `<sha>`'s
 * OWN ancestry shows" — a commit reachable through `<ref>`'s OTHER merge
 * parent, still due on a later page, has no ancestry relationship to
 * `<sha>` at all and would be silently dropped. Exactly the shape this
 * issue's own acceptance repo carries (a merge commit, two diverged
 * branches), so the sha-cursor's incorrectness was not a corner case
 * here — it would have failed the acceptance repo outright.
 *
 * Measured instead (`packages/node/src/git-diff.test.ts`'s own
 * "paging cost" describe block re-derives these numbers against a real
 * repo on every CI run): a 120,000-commit synthetic history (`git
 * fast-import`, single linear branch), `git log --pretty=format:...`
 * with no `-p`/`--stat` (this pair never asks git to compute a diff, only
 * seven fixed fields per commit):
 *   - page one (`--skip=0 --max-count=51`): ~55ms.
 *   - `--skip=59900` (halfway): ~290ms.
 *   - `--skip=119900` (the worst case this repo can produce — 99.9% of
 *     the way to the root): ~630ms.
 * Cost scales with `offset`, not with total repo size, and even the
 * worst case on a 120k-commit history is well inside an interactive
 * budget — while the overwhelming common case (recent history, small
 * `offset`) is flat at ~55ms regardless of how large the repo is behind
 * it. A correct O(depth) `--skip` beats an O(1) but silently-wrong
 * sha-cursor.
 *
 * `GIT_GRAPH_DEFAULT_LIMIT` (50) keeps one page small on a phone
 * connection: measured payload for a 51-commit page (author name/email/
 * ISO date/subject/decoration, no diff content) is ~10.7KB of raw
 * `git log` stdout — the encrypted envelope adds AES-GCM/base64 overhead
 * on top, but the underlying JSON stays in the same order of magnitude.
 * `GIT_GRAPH_MAX_LIMIT` (200) is this pair's own bound on a caller-chosen
 * `limit`, the same "one response never grows unbounded" reasoning
 * `MAX_GIT_DIFF_TEXT_BYTES` already applies to a single file's diff text.
 */

export const GIT_GRAPH_DEFAULT_LIMIT = 50;
export const GIT_GRAPH_MAX_LIMIT = 200;

/** Where a commit's `refs` entry points from — `%D`'s own three vocabularies (a local branch, a remote-tracking branch, or an annotated/lightweight tag), parsed apart so a client can render each with its own badge rather than one generic pill. */
export const gitGraphRefKindV1 = z.enum(['branch', 'remoteBranch', 'tag']);
export type GitGraphRefKindV1 = z.infer<typeof gitGraphRefKindV1>;

/** One ref (branch/remote-branch/tag) decorating a commit — `GitBranchSummaryV1`'s own `name` plus a `kind` tag, since a commit's decorations mix all three vocabularies at once (unlike `listBranches`, which only ever lists local branches). */
export const gitGraphRefV1 = z.object({
  name: z.string().min(1),
  kind: gitGraphRefKindV1,
});
export type GitGraphRefV1 = z.infer<typeof gitGraphRefV1>;

/**
 * One commit, parsed from `git log --pretty=format:`'s explicit fields —
 * never `--graph`'s ASCII art, which is rendered text, not a data
 * structure (this pair's own reason `computeCommitGraph` parses fields
 * instead). `parents` is every parent sha in git's own listed order
 * (`[]` for a root commit, 2+ for a merge — the DAG's own shape, the
 * client draws the graph from this, never a server-side layout). `refs`
 * lists every branch/remote-branch/tag whose tip is exactly this commit;
 * `isHead` is true exactly for the one commit `HEAD` currently resolves
 * to, whether or not `HEAD` is itself attached to a branch (a detached
 * `HEAD` still marks its own commit `isHead: true`, with no branch entry
 * in `refs` for it — real `git log --decorate`'s own bare `HEAD` token,
 * as opposed to `HEAD -> <branch>` for an attached one).
 */
export const gitGraphCommitV1 = z.object({
  sha: z.string().min(1),
  parents: z.array(z.string().min(1)),
  authorName: z.string(),
  authorEmail: z.string(),
  /** `%aI`'s own strict ISO 8601 (author date, not committer date — the moment the change was authored, matching `git log`'s own default display). */
  authorDateIso: z.string().min(1),
  subject: z.string(),
  refs: z.array(gitGraphRefV1),
  isHead: z.boolean(),
});
export type GitGraphCommitV1 = z.infer<typeof gitGraphCommitV1>;

/**
 * The plaintext a `git_graph_request` envelope decrypts to: which ref's
 * history to walk (`ref` defaults to `HEAD` server-side when omitted —
 * "the session's own repo, right now", the same default scope
 * `WorktreeDiffViewer`/`WorktreeStatusEntry` already assume), how many
 * commits (`limit`, clamped to {@link GIT_GRAPH_MAX_LIMIT}), and how far
 * in (`offset` — `0`/omitted for page one, else the previous page's own
 * `nextOffset`).
 */
export const gitGraphRequestPayloadV1 = z.object({
  ref: z.string().min(1).optional(),
  limit: z.number().int().positive().max(GIT_GRAPH_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type GitGraphRequestPayloadV1 = z.infer<typeof gitGraphRequestPayloadV1>;

export function parseGitGraphRequestPayloadV1(data: unknown): GitGraphRequestPayloadV1 {
  return gitGraphRequestPayloadV1.parse(data);
}

export function safeParseGitGraphRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitGraphRequestPayloadV1> {
  return gitGraphRequestPayloadV1.safeParse(data);
}

/** The successful outcome: this page's commits, oldest-to-newest exactly as `git log` ordered them, plus `nextOffset` (the `offset` value that continues where this page left off) — `null` once a page comes back shorter than `limit`, meaning the walk reached the root. `[]`/`nextOffset: null` for `ref: 'HEAD'` (default or explicit) on a repo with no commits yet — an unborn `HEAD` is an empty graph, never an error, mirroring `listBranches`'s identical "no branches yet" contract. */
const gitGraphResultV1 = z.object({
  outcome: z.literal('ok'),
  commits: z.array(gitGraphCommitV1),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** A failed graph fetch: no `git` on the target, the worktree isn't a git repository, or `ref` names no real commit. */
const gitGraphErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string(),
});

/** The plaintext a `git_graph_response` envelope decrypts to. */
export const gitGraphResponsePayloadV1 = z.discriminatedUnion('outcome', [
  gitGraphResultV1,
  gitGraphErrorV1,
]);
export type GitGraphResponsePayloadV1 = z.infer<typeof gitGraphResponsePayloadV1>;

export function parseGitGraphResponsePayloadV1(data: unknown): GitGraphResponsePayloadV1 {
  return gitGraphResponsePayloadV1.parse(data);
}

export function safeParseGitGraphResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, GitGraphResponsePayloadV1> {
  return gitGraphResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node for one page of one session's commit graph. Fresh every call (like `git_diff_request`'s own `readFile`-style contract) — no persistent subscription; a caller re-sends (a fresh `requestId`, `offset: 0`) to refresh page one, or a higher `offset` to page further in. */
export const gitGraphRequest = z.object({
  type: z.literal('git_graph_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitGraphRequest = z.infer<typeof gitGraphRequest>;

/** The owning node's reply. Fanned out to a session's subscribed clients exactly like `git_diff_response`/`fs_list_response` — a requesting client filters on `requestId` to match its own pending request; any other subscribed client simply has no pending request with that id and ignores it. */
export const gitGraphResponse = z.object({
  type: z.literal('git_graph_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type GitGraphResponse = z.infer<typeof gitGraphResponse>;
