import { z } from 'zod';
import { connectedAccount } from './connected-accounts';
import { PROTOCOL_V1 } from './handshake';

/**
 * The connect/disconnect/pin wire surface for SPEC §7.26's connected-
 * accounts registry (issue #230) — the client-facing counterpart to
 * `packages/node/src/github-connect.ts`, `jira-connect.ts`, and
 * `account-pin.ts`/`account-pin-store.ts`, none of which had a way to be
 * driven from the PWA before this file existed.
 *
 * Every request below is nodeId-scoped and routed directly by the relay
 * (mirrors `ssh-discovery.ts`/`provisioning.ts`: there is no existing
 * session, and often no existing target/project record either, to fan a
 * reply through — connecting an account, or pinning one to a project, can
 * both happen before any session on that project exists). Plain fields
 * only, no `encryptedEnvelope`: nothing here is session content, and
 * `connected-accounts.ts`'s own doc comment already draws this exact
 * "account-scoped metadata, not conversation content" line for the
 * `ConnectedAccount` row itself — a device/user code, a pin's tri-state
 * value, and a resolution error's shape are the same class of fact.
 *
 * Every outcome-varying reply below nests its `z.discriminatedUnion` under
 * a `result`/`response` field rather than splicing the union straight into
 * `wireMessageV1`: a discriminated-union member must be a plain `ZodObject`
 * exposing `.shape` for the discriminant lookup, which a nested
 * `ZodDiscriminatedUnion` isn't — the same split `ssh-discovery.ts` draws
 * between `sshDiscoveryResponse` (the wire message) and
 * `sshDiscoveryResultV1` (its `outcome`-discriminated payload).
 *
 * **What never crosses this file**: a GitHub access token, a Jira
 * `{email, apiToken}` pair, or any other credential. The GitHub device
 * flow's `userCode`/`verificationUri` are meant to be shown to the
 * operator, not secret. The Jira connect request necessarily carries the
 * API token the operator just typed (there is no other way to hand it to
 * the node that will store it), but the node never echoes it back — see
 * `jiraConnectResponse`'s doc comment.
 */

// ---------------------------------------------------------------------
// GitHub — device authorization grant (issue #222's flow, reachable here)
// ---------------------------------------------------------------------

/** A client asks `nodeId` to start SPEC §7.26's GitHub device-flow connect. One `requestId` names the whole flow: the node's eventual `github_connect_device_code` (once GitHub issues the code) and terminal `github_connect_result` both echo it back, exactly like `provisionProgress`/`provisionTargetResult` share `provision_target_request`'s `requestId`. */
export const githubConnectStartRequest = z.object({
  type: z.literal('github_connect_start_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type GithubConnectStartRequest = z.infer<typeof githubConnectStartRequest>;

/** Cancels an in-flight `github_connect_start_request` — routed to the same `nodeId`, matched there by `requestId`. Fire-and-forget: the node's own `github_connect_result` (outcome `'failure'`, reason `'cancelled'`) is the acknowledgement, not a reply to this message itself. */
export const githubConnectCancelRequest = z.object({
  type: z.literal('github_connect_cancel_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type GithubConnectCancelRequest = z.infer<typeof githubConnectCancelRequest>;

/** The device/user code the operator must enter at `verificationUri` — never a secret, this is the whole point of the flow (mirrors `packages/node/src/github-device-flow.ts`'s `GithubDeviceCodeInfo`). Streamed once, ahead of the terminal `github_connect_result`, exactly like `provision_progress` precedes `provision_target_result`. */
export const githubConnectDeviceCode = z.object({
  type: z.literal('github_connect_device_code'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().min(1).optional(),
  expiresInSeconds: z.number().int().positive(),
  intervalSeconds: z.number().int().positive(),
});
export type GithubConnectDeviceCode = z.infer<typeof githubConnectDeviceCode>;

/** `githubConnectResult.result`'s own outcome — the newly-connected account's synced metadata (already announced separately via `connected_account_announce`, issue #221) on success, or one of `github-device-flow.ts`'s three named failure reasons (plus `'error'` for anything else, e.g. no client id configured on this node, or GitHub identity resolution failing). Never a token either way. */
export const githubConnectOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    account: connectedAccount,
  }),
  z.object({
    outcome: z.literal('failure'),
    reason: z.enum(['expired_token', 'access_denied', 'cancelled', 'error']),
    message: z.string().min(1),
  }),
]);
export type GithubConnectOutcome = z.infer<typeof githubConnectOutcome>;

/** The flow's terminal message — see {@link githubConnectOutcome}'s doc comment for what `result` carries. */
export const githubConnectResult = z.object({
  type: z.literal('github_connect_result'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: githubConnectOutcome,
});
export type GithubConnectResult = z.infer<typeof githubConnectResult>;

// ---------------------------------------------------------------------
// Jira — API-token connect (issue #225's flow, reachable here)
// ---------------------------------------------------------------------

/** A client asks `nodeId` to run SPEC §7.26's Jira API-token connect path against `{siteUrl, email, apiToken}` the operator just typed. One round trip (`GET /rest/api/3/myself` has no device-flow-style polling step) — unlike the GitHub pair above, this request's only reply is `jiraConnectResponse`. */
export const jiraConnectRequest = z.object({
  type: z.literal('jira_connect_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  siteUrl: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().min(1),
});
export type JiraConnectRequest = z.infer<typeof jiraConnectRequest>;

/** `jiraConnectResponse.result`'s own outcome — the newly-connected account's synced metadata on success, or a failure message. `jira-connect.ts`'s own contract (`JiraConnectService.connect`'s doc comment) is that neither `email` nor `apiToken` is ever assigned anywhere but the one keyring write — this type structurally cannot carry either. */
export const jiraConnectOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    account: connectedAccount,
  }),
  z.object({
    outcome: z.literal('failure'),
    message: z.string().min(1),
  }),
]);
export type JiraConnectOutcome = z.infer<typeof jiraConnectOutcome>;

/** The connect attempt's terminal message — see {@link jiraConnectOutcome}'s doc comment for what `result` carries. */
export const jiraConnectResponse = z.object({
  type: z.literal('jira_connect_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: jiraConnectOutcome,
});
export type JiraConnectResponse = z.infer<typeof jiraConnectResponse>;

// ---------------------------------------------------------------------
// GitHub — `gh` CLI import (issue #223's flow, reachable here)
// ---------------------------------------------------------------------

/** A client asks `nodeId` to run SPEC §7.26's `gh` CLI import (issue #223) — a one-shot walk of every host+account the operator's local `gh` CLI already holds, including GitHub Enterprise Server hosts. No parameters: unlike the device-flow/Jira pairs above there is nothing the operator types, `gh` already holds everything this needs. One round trip, like `jiraConnectRequest` — but unlike either of those, a single reply can carry several imported accounts at once. */
export const githubCliImportRequest = z.object({
  type: z.literal('github_cli_import_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type GithubCliImportRequest = z.infer<typeof githubCliImportRequest>;

/** One host+account `gh auth status` reported, after this node tried to import it. `'imported'` always carries a newly-synced `ConnectedAccount` (SPEC §7.26's CLI-import bullet is unconditional: "one shot imports every host+account") plus `missingScopes` — the subset of the device-flow path's four requested scopes (`repo`, `read:user`, `read:org`, `read:project`) this gh-issued token does not grant, named up front rather than left to surface as a confusing failure the first time a tracker write needs one (issue #223's acceptance). `'error'` is this one host+account failing outright — gh itself reports its auth broken (expired/revoked), `GET /user` rejected the token, or gh returned no usable token — and carries no account; every other host+account in the same request is unaffected. */
export const githubCliImportEntryOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('imported'),
    account: connectedAccount,
    missingScopes: z.array(z.string().min(1)),
  }),
  z.object({
    outcome: z.literal('error'),
    host: z.string().min(1),
    login: z.string().min(1).optional(),
    message: z.string().min(1),
  }),
]);
export type GithubCliImportEntryOutcome = z.infer<typeof githubCliImportEntryOutcome>;

/** `githubCliImportResponse.result`'s own outcome. `'success'` means this node was able to run `gh` and enumerate its accounts at all — `entries` (possibly a mix of `'imported'`/`'error'`, possibly empty) is the per-account detail above. `'failure'` means the import could not even start: `'gh_not_found'` (no `gh` on this node's `PATH`), `'gh_unsupported'` (a `gh` too old for `auth status --json`, which this module requires rather than parsing gh's human-readable text output), `'gh_not_logged_in'` (gh works but `gh auth status` names no host at all), or `'error'` for anything else. Never a token either way. */
export const githubCliImportOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    entries: z.array(githubCliImportEntryOutcome),
  }),
  z.object({
    outcome: z.literal('failure'),
    reason: z.enum(['gh_not_found', 'gh_unsupported', 'gh_not_logged_in', 'error']),
    message: z.string().min(1),
  }),
]);
export type GithubCliImportOutcome = z.infer<typeof githubCliImportOutcome>;

/** The import's terminal (and only) message — see {@link githubCliImportOutcome}'s doc comment for what `result` carries. */
export const githubCliImportResponse = z.object({
  type: z.literal('github_cli_import_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: githubCliImportOutcome,
});
export type GithubCliImportResponse = z.infer<typeof githubCliImportResponse>;

// ---------------------------------------------------------------------
// GitHub — fine-grained PAT paste (issue #224's flow, reachable here)
// ---------------------------------------------------------------------

/** A client asks `nodeId` to run SPEC §7.26's fine-grained PAT paste path (issue #224) against `token` the operator just typed — the fallback for orgs that enable OAuth App access restrictions (real, enabled-by-default per GitHub's own docs) and can block `githubConnectStartRequest`'s device flow outright. `host` defaults to `github.com` on the node side when omitted; set it for a GitHub Enterprise Server token, the same per-host convention `github-identity.ts`'s `githubApiBaseUrl` already gives the `gh` CLI import path (#223). One round trip, like `jiraConnectRequest` — no device-flow-style polling step. */
export const githubPatConnectRequest = z.object({
  type: z.literal('github_pat_connect_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  token: z.string().min(1),
  host: z.string().min(1).optional(),
});
export type GithubPatConnectRequest = z.infer<typeof githubPatConnectRequest>;

/** `githubPatConnectResponse.result`'s own outcome. `'success'` carries the newly-synced `ConnectedAccount` (already announced separately via `connected_account_announce`, issue #221) plus `accessibleRepositories` — the first page (up to 100) of `owner/repo` names `GET /user/repos` returned for this token, the only signal GitHub's API offers for what a fine-grained PAT can actually reach (there is no scope-introspection endpoint for this token kind at all — see `github-identity.ts`'s own top comment on why `X-OAuth-Scopes` never applies here). `accessibleRepositoriesTruncated` is true when there were more than fit on that one page. `'failure'` never carries the token; `reason` is `'invalid_or_revoked'` (`GET /user` itself rejected the token — GitHub's API returns a bare 401 "Bad credentials" for an invalid, expired, AND revoked token alike, with no further distinction to report), `'insufficient_access'` (the token authenticates fine but `GET /user/repos` came back with no repositories at all — too narrow to connect), or `'error'` for anything else (a network failure, a malformed GitHub response). */
export const githubPatConnectOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('success'),
    account: connectedAccount,
    accessibleRepositories: z.array(z.string().min(1)),
    accessibleRepositoriesTruncated: z.boolean(),
  }),
  z.object({
    outcome: z.literal('failure'),
    reason: z.enum(['invalid_or_revoked', 'insufficient_access', 'error']),
    message: z.string().min(1),
  }),
]);
export type GithubPatConnectOutcome = z.infer<typeof githubPatConnectOutcome>;

/** The connect attempt's terminal (and only) message — see {@link githubPatConnectOutcome}'s doc comment for what `result` carries. */
export const githubPatConnectResponse = z.object({
  type: z.literal('github_pat_connect_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: githubPatConnectOutcome,
});
export type GithubPatConnectResponse = z.infer<typeof githubPatConnectResponse>;

// ---------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------

/** A client asks `nodeId` (the node that holds this account's local secret) to disconnect `accountId` — deletes the local keyring entry and, on success, the relay forgets the synced metadata row too (SPEC §7.26's "the local half of disconnecting it (the metadata row itself is the caller's/relay's concern)", `github-connect.ts`/`jira-connect.ts`'s own `deleteAccessToken`/`deleteCredential` doc comments). Does not itself scan for, warn about, or unpin project pins referencing this account — {@link accountPinScanRequest} is the scan-and-warn step (issue #229), sent first and separately, so the client confirms with the operator using real project/capability names before ever sending this. Deliberately does not touch `AccountPinStore` either: a pin that named this account is left exactly as it was (orphaned, not cleared or blocked) — `account-pin.ts`'s `resolveAccountForRead`/`resolveAccountForWrite` already throw `AccountPinDanglingError` for a pin naming an account no longer in the connected-accounts list, which is the honest, real failure this account's own removal now produces on the next resolve, never a silent fallback to a different account. */
export const connectedAccountDisconnectRequest = z.object({
  type: z.literal('connected_account_disconnect_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  accountId: z.string().min(1),
});
export type ConnectedAccountDisconnectRequest = z.infer<typeof connectedAccountDisconnectRequest>;

export const connectedAccountDisconnectResponse = z.object({
  type: z.literal('connected_account_disconnect_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  accountId: z.string().min(1),
  outcome: z.enum(['ok', 'error']),
  message: z.string().min(1).optional(),
});
export type ConnectedAccountDisconnectResponse = z.infer<typeof connectedAccountDisconnectResponse>;

// ---------------------------------------------------------------------
// Per-project, per-capability pin (issue #227's `AccountPinStore`, reachable here)
// ---------------------------------------------------------------------

/** The tri-state pin map's wire shape — `account-pin.ts`'s `AccountPinMap`, field-for-field: an absent key is unconfigured (never present in this object at all, since `Object.entries` on parsed JSON only yields keys that were actually set — the same round-trip property `account-pin-store.ts`'s own doc comment relies on), `null` is an explicit opt-out, a string is the pinned `ConnectedAccount.id`. */
export const accountPinMapV1 = z.record(z.string(), z.union([z.string().min(1), z.null()]));
export type AccountPinMapV1 = z.infer<typeof accountPinMapV1>;

/** A client asks `nodeId` for `projectPath`'s full pin map. */
export const accountPinGetRequest = z.object({
  type: z.literal('account_pin_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
});
export type AccountPinGetRequest = z.infer<typeof accountPinGetRequest>;

/** Pins `capability` to `accountId` (a `ConnectedAccount.id`) or, when `accountId` is `null`, records an explicit opt-out — `AccountPinStore.setPin`'s own tri-state contract, never collapsed onto "unset" (see `accountPinUnsetRequest` for that, a genuinely different operation). */
export const accountPinSetRequest = z.object({
  type: z.literal('account_pin_set_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  capability: z.string().min(1),
  accountId: z.string().min(1).nullable(),
});
export type AccountPinSetRequest = z.infer<typeof accountPinSetRequest>;

/** Reverts `capability` to unconfigured (deletes the key entirely — `AccountPinStore.unsetPin`, distinct from `accountPinSetRequest`'s explicit-`null` opt-out). */
export const accountPinUnsetRequest = z.object({
  type: z.literal('account_pin_unset_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  capability: z.string().min(1),
});
export type AccountPinUnsetRequest = z.infer<typeof accountPinUnsetRequest>;

/** The reply to every one of the three requests above: `projectPath`'s resulting full pin map — a get returns it unchanged, a set/unset returns it post-mutation, so the client never needs a second round trip to see what it just wrote. */
export const accountPinResponse = z.object({
  type: z.literal('account_pin_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  pins: accountPinMapV1,
});
export type AccountPinResponse = z.infer<typeof accountPinResponse>;

/** Every named failure `account-pin.ts`'s resolvers can throw (`AccountResolutionError`'s five concrete subclasses), so `accountPinResolveResponse` can tell them apart without string-matching a message. */
export const accountPinErrorType = z.enum([
  'AccountPinRequiredError',
  'AccountPinMalformedError',
  'AccountHostMismatchError',
  'AccountPinDanglingError',
  'AmbiguousAccountError',
]);
export type AccountPinErrorType = z.infer<typeof accountPinErrorType>;

/**
 * A client asks `nodeId` to preview what `capability` currently resolves to
 * for `projectPath`, without performing a write-back action — the pin
 * picker's "show the hard-fail states, don't just store a string" surface
 * (issue #230's acceptance). `mode` selects `resolveAccountForRead` (an
 * unpinned, unambiguous single candidate resolves silently) or
 * `resolveAccountForWrite` (an absent/`null` pin always fails). `accounts`
 * is the client's own already-synced `connected_account_list` snapshot —
 * `account-pin.ts`'s own `AccountResolutionParams.accounts` doc comment
 * says to "pass the full set" the caller already has, and this node has no
 * independent copy of the relay's account-scoped list to consult instead.
 * `target` is the project's configured provider/host for this capability;
 * see this file's own doc comment on why the picker (not this node) is
 * responsible for supplying it, pending #631's full `TrackerMode`
 * composition.
 */
export const accountPinResolveRequest = z.object({
  type: z.literal('account_pin_resolve_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  capability: z.string().min(1),
  mode: z.enum(['read', 'write']),
  target: z.object({
    provider: z.string().min(1),
    host: z.string().min(1),
  }),
  accounts: z.array(connectedAccount),
});
export type AccountPinResolveRequest = z.infer<typeof accountPinResolveRequest>;

/** `accountPinResolveResponse.result`'s own outcome. `'none'` is a read that resolved to "nothing to use" (an explicit opt-out, or no pin and no candidate account) — not an error. `'error'` carries whichever of {@link accountPinErrorType}'s fields that error type actually has (mirrors each `AccountResolutionError` subclass's own constructor fields one-for-one). */
export const accountPinResolveOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('resolved'),
    account: connectedAccount,
  }),
  z.object({
    outcome: z.literal('none'),
  }),
  z.object({
    outcome: z.literal('error'),
    errorType: accountPinErrorType,
    message: z.string().min(1),
    capability: z.string().min(1),
    pinnedAccountId: z.string().min(1).optional(),
    expectedHost: z.string().min(1).optional(),
    actualHost: z.string().min(1).optional(),
    candidateAccountIds: z.array(z.string().min(1)).optional(),
  }),
]);
export type AccountPinResolveOutcome = z.infer<typeof accountPinResolveOutcome>;

export const accountPinResolveResponse = z.object({
  type: z.literal('account_pin_resolve_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  result: accountPinResolveOutcome,
});
export type AccountPinResolveResponse = z.infer<typeof accountPinResolveResponse>;

// ---------------------------------------------------------------------
// Pre-disconnect scan (issue #229's "scan all project settings and warn"
// — SPEC §7.26 — `account-pin.ts`'s pure `scanPinsForAccount`, reachable
// here)
// ---------------------------------------------------------------------

/** One `{projectPath, capability}` hit — `account-pin.ts`'s pure `scanPinsForAccount`'s wire counterpart, one entry per project/capability pair whose `AccountPinStore` entry is still an explicit string pin equal to the scanned `accountId` (an explicit opt-out or an absent key is never a hit). */
export const accountPinScanHitV1 = z.object({
  projectPath: z.string().min(1),
  capability: z.string().min(1),
});
export type AccountPinScanHitV1 = z.infer<typeof accountPinScanHitV1>;

/**
 * A client asks `nodeId` to scan every project this node has ever recorded
 * an `AccountPinStore` entry for and report every `{projectPath,
 * capability}` still pinned to `accountId` (SPEC §7.26: "Before letting a
 * user disconnect an account still pinned somewhere, scan all project
 * settings and warn"; issue #229). Sent BEFORE {@link
 * connectedAccountDisconnectRequest}, not as part of it — the caller
 * decides whether to even show a confirmation step from the reply's
 * `affected` list (this issue's own acceptance: no pins, no extra
 * confirmation). Read-only: never mutates a pin, and disconnecting
 * afterward does not clear the ones it found either — see {@link
 * connectedAccountDisconnectRequest}'s doc comment for why a dangling pin
 * is the deliberate outcome, not a silently-cleared one.
 */
export const accountPinScanRequest = z.object({
  type: z.literal('account_pin_scan_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  accountId: z.string().min(1),
});
export type AccountPinScanRequest = z.infer<typeof accountPinScanRequest>;

/** {@link accountPinScanRequest}'s reply — `affected` is `[]` for an account nothing is pinned to (the common case: a client may disconnect immediately, no confirmation needed), or one entry per real project/capability hit otherwise, each carrying the actual `projectPath` so a confirmation can name it instead of a generic "some projects may be affected" warning. */
export const accountPinScanResponse = z.object({
  type: z.literal('account_pin_scan_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  accountId: z.string().min(1),
  affected: z.array(accountPinScanHitV1),
});
export type AccountPinScanResponse = z.infer<typeof accountPinScanResponse>;
