import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Opening a pull request from a session's own pushed branch (SPEC §7.14;
 * issue #238) — the tail of the Zed-parity epic's "PR & CI lifecycle"
 * work. Three wave-scoped decisions this file encodes, all narrower than
 * the original issue text:
 *
 * 1. **No AI-drafted body here.** The issue's own acceptance line ("PR
 *    description is AI-drafted from the branch's commits/diff") is
 *    explicitly out of scope for this change — that is issue #233. `title`/
 *    `body` below are whatever the operator typed into the client's own
 *    form; nothing here ever calls an agent to fill them in.
 * 2. **`gh` runs on the session's own execution target, authenticated by
 *    THAT target's own `gh` session — never SPEC §7.26's connected-account
 *    registry (`GithubConnectService`, issue #222/#230).** That registry's
 *    token lives in the *node's* OS keyring, one node, never synced to a
 *    remote `ssh:` target it might not even be running on
 *    (`account-presence.ts`'s own doc comment: "a second node ... still
 *    not be able to use it"); bridging it there would mean putting a
 *    bearer token into `ExecutionTarget.exec`'s `env` override, which
 *    `packages/node/src/target.ts`'s own `ExecOptions.env` doc comment
 *    states plainly is "Local only" — structurally unavailable for the
 *    one target kind (`ssh:`) that would need it shipped across a
 *    boundary at all. A `local` target already runs literally on this
 *    node, so there is no boundary to cross for it either. The session's
 *    branch was already pushable to that target's own remote before this
 *    feature existed (git push credentials already live there); `gh`
 *    piggybacks on that exact same already-present, already-scoped-right
 *    credential rather than inventing a second, redundant path for
 *    exactly the case it can't reach. See `packages/node/src/pr-open.ts`'s
 *    own doc comment for the mechanics.
 * 3. **Preview, then an explicit confirm.** Pushing a branch and opening a
 *    PR are real, visible side effects on someone's actual repository —
 *    `pr_open_preview_request`/`_result` compute and show exactly what
 *    `pr_open_request` would do (which branch, into which base, how many
 *    commits) without ever touching git or GitHub's write path; only the
 *    latter, sent after an operator reviews that preview and fills in
 *    title/body, ever pushes or creates anything.
 *
 * `PrOpenFailureCategory` is a fixed, closed vocabulary (mirrors
 * `@loombox/providers-core`'s `AcpMcpServerFailureCategory`, issue #750's
 * D2-2 "a distinct, visible reason" bar) rather than one collapsed
 * `'error'` string — a client can show "no commits to open a PR for"
 * distinctly from "gh isn't installed on that target" distinctly from
 * "gh is installed but not logged in there" instead of one generic
 * failure banner for all three.
 *
 * Two request/reply pairs, addressed by `sessionId` and envelope-sealed on
 * every leg that carries real content — mirrors `test-runner-config.ts`'s
 * "session-routed, envelope-sealed because the content is project-private"
 * convention exactly, rather than inventing a third shape:
 * - `pr_open_preview_request` / `pr_open_preview_result` — read-only.  No
 *   envelope on the request (asking "what would opening a PR from this
 *   session look like" carries nothing to hide, same reasoning as
 *   `testRunnerConfigDetect`); the result IS project content, so it is
 *   sealed.
 * - `pr_open_request` / `pr_open_result` — the confirmed, side-effecting
 *   action. Both directions sealed: the request carries the operator's
 *   own title/body text, the result carries the created PR's URL.
 */

export const prOpenFailureCategory = z.enum([
  /** `resolveSessionBranch` (issue #738) found nothing pushable — a detached HEAD, or `worktreePath` isn't a git repo at all. */
  'no_branch',
  /** The session's branch has zero commits ahead of the repo's default branch — nothing for a PR to contain. */
  'no_commits',
  /** `gh` is not on the execution target's own `PATH`. */
  'gh_missing',
  /** `gh` is installed on the target but `gh auth status` fails there. */
  'gh_unauthenticated',
  /** `gh` is installed and authenticated, but resolving the repo's default branch (`gh repo view`) or the commit count ahead of it (`git fetch`/`git rev-list`) failed — no GitHub remote, a network failure, or similar. */
  'repo_lookup_failed',
  /** `git push` exited non-zero. */
  'push_failed',
  /** `gh pr create` exited non-zero, or produced no parseable pull request URL. */
  'create_failed',
]);
export type PrOpenFailureCategory = z.infer<typeof prOpenFailureCategory>;

/** One `pr_open_preview_request`/`pr_open_request` failure — the category (see {@link prOpenFailureCategory}) plus the real underlying detail (e.g. `gh`'s own stderr), never a secret since a credential failure surfaces as `gh_unauthenticated` before anything ever runs with one. */
export const prOpenFailure = z.object({
  outcome: z.literal('failure'),
  category: prOpenFailureCategory,
  reason: z.string().min(1),
});
export type PrOpenFailure = z.infer<typeof prOpenFailure>;

/** `pr_open_preview_result`'s own outcome — what opening a PR from this session would actually do, or why it can't. */
export const prOpenPreviewOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    /** The session's own branch (`resolveSessionBranch`), e.g. `loombox/session-<id>`. */
    branch: z.string().min(1),
    /** The repository's default branch, resolved via `gh repo view` — what `pr_open_request` will target with `--base` and what the commit count below is measured against. */
    base: z.string().min(1),
    /** Commits on `branch` not on `base` — always >= 1 for an `ok` outcome (a count of 0 is `no_commits`, a `failure` instead). */
    commitCount: z.number().int().positive(),
  }),
  prOpenFailure,
]);
export type PrOpenPreviewOutcome = z.infer<typeof prOpenPreviewOutcome>;

/** The plaintext a `pr_open_preview_result` envelope decrypts to. */
export const prOpenPreviewResultPayloadV1 = z.object({
  result: prOpenPreviewOutcome,
});
export type PrOpenPreviewResultPayloadV1 = z.infer<typeof prOpenPreviewResultPayloadV1>;

/** Parses and validates a decrypted `pr_open_preview_result` payload, throwing on an invalid one. */
export function parsePrOpenPreviewResultPayloadV1(data: unknown): PrOpenPreviewResultPayloadV1 {
  return prOpenPreviewResultPayloadV1.parse(data);
}

/** Same as {@link parsePrOpenPreviewResultPayloadV1} but never throws; returns zod's result. */
export function safeParsePrOpenPreviewResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PrOpenPreviewResultPayloadV1> {
  return prOpenPreviewResultPayloadV1.safeParse(data);
}

/** A client asks the owning node what opening a pull request from `sessionId`'s own branch would do — never pushes or creates anything itself. No envelope on the request, same reasoning as `test_runner_config_detect`. */
export const prOpenPreviewRequest = z.object({
  type: z.literal('pr_open_preview_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export type PrOpenPreviewRequest = z.infer<typeof prOpenPreviewRequest>;

/** The owning node's reply to `pr_open_preview_request`. Fanned out to a session's subscribed clients exactly like `test_runner_config_detected`. */
export const prOpenPreviewResult = z.object({
  type: z.literal('pr_open_preview_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PrOpenPreviewResult = z.infer<typeof prOpenPreviewResult>;

/** The plaintext a `pr_open_request` envelope decrypts to — the operator's own title/body, composed in the client's form (never agent-drafted; see this file's doc comment). */
export const prOpenRequestPayloadV1 = z.object({
  title: z.string().min(1),
  /** Free text; empty is a valid, deliberate choice (an operator who wants no body), unlike `title`. */
  body: z.string(),
});
export type PrOpenRequestPayloadV1 = z.infer<typeof prOpenRequestPayloadV1>;

/** Parses and validates a decrypted `pr_open_request` payload, throwing on an invalid one. */
export function parsePrOpenRequestPayloadV1(data: unknown): PrOpenRequestPayloadV1 {
  return prOpenRequestPayloadV1.parse(data);
}

/** Same as {@link parsePrOpenRequestPayloadV1} but never throws; returns zod's result. */
export function safeParsePrOpenRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PrOpenRequestPayloadV1> {
  return prOpenRequestPayloadV1.safeParse(data);
}

/** A client asks the owning node to push `sessionId`'s branch and open a pull request against it — the one message in this file with a real side effect on the operator's actual repository. Sent only after the client has shown the operator a `pr_open_preview_result` and the operator explicitly confirmed (SPEC §7.14's "shows what will be pushed" bar) — the node itself re-verifies the same preview fresh right before acting (`packages/node/src/pr-open.ts`'s `openPr`), never trusting a client-held one as current. */
export const prOpenRequest = z.object({
  type: z.literal('pr_open_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PrOpenRequest = z.infer<typeof prOpenRequest>;

/** `pr_open_result`'s own outcome — the created PR's URL/number on success, or one of {@link prOpenFailureCategory}'s named reasons. */
export const prOpenOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    url: z.string().min(1),
    number: z.number().int().positive(),
  }),
  prOpenFailure,
]);
export type PrOpenOutcome = z.infer<typeof prOpenOutcome>;

/** The plaintext a `pr_open_result` envelope decrypts to. */
export const prOpenResultPayloadV1 = z.object({
  result: prOpenOutcome,
});
export type PrOpenResultPayloadV1 = z.infer<typeof prOpenResultPayloadV1>;

/** Parses and validates a decrypted `pr_open_result` payload, throwing on an invalid one. */
export function parsePrOpenResultPayloadV1(data: unknown): PrOpenResultPayloadV1 {
  return prOpenResultPayloadV1.parse(data);
}

/** Same as {@link parsePrOpenResultPayloadV1} but never throws; returns zod's result. */
export function safeParsePrOpenResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, PrOpenResultPayloadV1> {
  return prOpenResultPayloadV1.safeParse(data);
}

/** The owning node's reply to `pr_open_request`. Fanned out to a session's subscribed clients exactly like `pr_open_preview_result`. */
export const prOpenResult = z.object({
  type: z.literal('pr_open_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type PrOpenResult = z.infer<typeof prOpenResult>;
