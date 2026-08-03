/* ---------------------------------------------------------------------
 * Per-project, per-capability connected-account pin resolution (SPEC
 * §7.26 "Per-project binding, one pinned account per capability"; issue
 * #227). Generalizes emdash's `ProjectSettings.githubAccountId` tri-state
 * field and its resolver (`project-github-auth-context-resolver.ts:51-102`)
 * into a per-capability map, keeping its exact tri-state semantics:
 *
 * - an absent key means "unconfigured" — nobody has chosen for this
 *   project/capability yet;
 * - an explicit `null` means "opted out" — the user picked "none" on
 *   purpose, a different fact from "hasn't decided";
 * - a `string` is a pinned `ConnectedAccount.id` (SPEC §7.26).
 *
 * Two structural rules this module exists to enforce, not just document:
 *
 * 1. **Hard-fail on a host/site mismatch, never a silent fallback.**
 *    Mirrors emdash's `githubApiAccountHostMismatch` guard
 *    (`github-api-auth-service.ts:40-67`): a pin whose id decodes (via
 *    `@loombox/protocol`'s `parseConnectedAccountId` — never by
 *    string-slicing the id here) to a different host/site than the
 *    project's configured target throws {@link AccountHostMismatchError}.
 *    Falling back to a different account for a write action is a
 *    correctness/security bug (SPEC §7.26), not a UX nicety to smooth over.
 * 2. **The read/write distinction is part of this module's API, not a
 *    caller-supplied flag.** {@link resolveAccountForWrite} never defaults
 *    silently — an absent or explicit-`null` pin is always
 *    {@link AccountPinRequiredError}. {@link resolveAccountForRead} may
 *    default only when exactly one candidate account exists for the
 *    target provider/host; two or more is {@link AmbiguousAccountError}.
 *    Two distinctly named functions, rather than one function plus a
 *    boolean, so a caller cannot forget which rule its action needs.
 *
 * This module is deliberately I/O-free and does not itself decide *where*
 * `AccountPinMap` values are persisted (see `account-pin-store.ts`) or
 * which node holds a resolved account's secret (issue #228's node-presence
 * check, out of scope here) — it only decides, given a pin map and the
 * known connected accounts, which single account (if any) a read or write
 * action may use.
 * --------------------------------------------------------------------- */

import { parseConnectedAccountId, type ConnectedAccount } from '@loombox/protocol';

/**
 * Per-project, per-capability pin map (SPEC §7.26). `github`/`jira` are
 * named because they are today's two providers; the index signature is
 * what makes this "per capability" rather than "per provider" — a future
 * capability that needs its own pin (e.g. a provider that splits "issues"
 * from "boards") adds a key here, not a new type. See this module's doc
 * comment for what each of the three states means — preserving the
 * distinction between an absent key and an explicit `null` through
 * storage/serialization is the entire point (see `account-pin-store.ts`).
 */
export interface AccountPinMap {
  github?: string | null;
  jira?: string | null;
  [capability: string]: string | null | undefined;
}

/** Base class for every error this module's resolvers throw — never returns a partial or best-guess account instead of one of these. */
export abstract class AccountResolutionError extends Error {}

/** A write-back action (comment, transition, status change — SPEC §7.26) was attempted with no explicit pin for `capability`. Read-only actions may fall back to an unambiguous default; a write never does. */
export class AccountPinRequiredError extends AccountResolutionError {
  constructor(public readonly capability: string) {
    super(
      `account pin required: "${capability}" has no explicit pin, and a write-back action never uses a silent default (SPEC §7.26)`,
    );
    this.name = 'AccountPinRequiredError';
  }
}

/** `capability`'s pin does not parse as a connected-account id ({@link parseConnectedAccountId} returned `undefined`) — cannot even be checked for a host/site match. */
export class AccountPinMalformedError extends AccountResolutionError {
  constructor(
    public readonly capability: string,
    public readonly pinnedAccountId: string,
  ) {
    super(
      `account pin malformed: "${capability}" is pinned to "${pinnedAccountId}", which does not parse as a connected-account id`,
    );
    this.name = 'AccountPinMalformedError';
  }
}

/** The pinned account's provider/host does not match the project's configured target — never silently falls back to a different account (mirrors emdash's `githubApiAccountHostMismatch` guard, SPEC §7.26). */
export class AccountHostMismatchError extends AccountResolutionError {
  constructor(
    public readonly capability: string,
    public readonly pinnedAccountId: string,
    public readonly expectedHost: string,
    public readonly actualHost: string,
  ) {
    super(
      `account pin mismatch: "${capability}" is pinned to "${pinnedAccountId}" (host "${actualHost}"), but this project is configured for "${expectedHost}" — refusing to use a different host's credentials`,
    );
    this.name = 'AccountHostMismatchError';
  }
}

/** `capability`'s pin names a `ConnectedAccount.id` that isn't among the known connected accounts — a dangling pin (e.g. the account was disconnected). Distinct from issue #228's node-presence check: this is "does the account exist at all", never "does this node hold its secret locally". */
export class AccountPinDanglingError extends AccountResolutionError {
  constructor(
    public readonly capability: string,
    public readonly pinnedAccountId: string,
  ) {
    super(
      `account pin dangling: "${capability}" is pinned to "${pinnedAccountId}", which is not a known connected account`,
    );
    this.name = 'AccountPinDanglingError';
  }
}

/** A read-only resolution with no pin found more than one candidate account for `capability` — the only case a read may default silently is exactly one candidate (SPEC §7.26); two or more is an error, never a coin flip. */
export class AmbiguousAccountError extends AccountResolutionError {
  constructor(
    public readonly capability: string,
    public readonly candidateAccountIds: readonly string[],
  ) {
    super(
      `ambiguous account: "${capability}" has no pin and ${candidateAccountIds.length} candidate accounts (${candidateAccountIds.join(', ')}) — pin one explicitly`,
    );
    this.name = 'AmbiguousAccountError';
  }
}

/** What a project has configured for `capability` — the provider and host/site {@link resolveAccountForRead}/{@link resolveAccountForWrite} check a resolved account against. */
export interface AccountResolutionTarget {
  /** e.g. `'github'`, `'jira'`. */
  provider: string;
  /** e.g. `'github.com'`, `'github.example.com:8443'` (GHES on a non-default port), `'myteam.atlassian.net'`. */
  host: string;
}

export interface AccountResolutionParams {
  pins: AccountPinMap;
  capability: string;
  /** Every connected account visible to resolve against (SPEC §7.26's relay-synced metadata list) — pass the full set; candidacy/mismatch filtering is this module's job, not the caller's. */
  accounts: readonly ConnectedAccount[];
  target: AccountResolutionTarget;
}

/** Decodes `pinnedId` and checks it against `target`, or throws — the one path both resolver functions below route an explicit string pin through. */
function resolvePinnedAccount(
  capability: string,
  pinnedId: string,
  accounts: readonly ConnectedAccount[],
  target: AccountResolutionTarget,
): ConnectedAccount {
  const parsed = parseConnectedAccountId(pinnedId);
  if (!parsed) throw new AccountPinMalformedError(capability, pinnedId);
  if (parsed.provider !== target.provider || parsed.host !== target.host) {
    throw new AccountHostMismatchError(capability, pinnedId, target.host, parsed.host);
  }
  const account = accounts.find((candidate) => candidate.id === pinnedId);
  if (!account) throw new AccountPinDanglingError(capability, pinnedId);
  return account;
}

/**
 * Resolves `params.capability`'s connected account for a READ-ONLY action.
 * Returns `undefined` when there is nothing to read with — an explicit
 * opt-out (`pins[capability] === null`), or no pin and no candidate
 * account — neither of which is an error. An explicit string pin is always
 * checked for a host/site match, exactly like a write. With no pin, an
 * unambiguous single candidate (matching `target.provider`/`target.host`)
 * resolves silently; two or more is {@link AmbiguousAccountError}.
 */
export function resolveAccountForRead(
  params: AccountResolutionParams,
): ConnectedAccount | undefined {
  const { pins, capability, accounts, target } = params;
  const pin = pins[capability];
  if (pin === null) return undefined;
  if (typeof pin === 'string') {
    return resolvePinnedAccount(capability, pin, accounts, target);
  }
  const candidates = accounts.filter(
    (account) => account.provider === target.provider && account.host === target.host,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  throw new AmbiguousAccountError(
    capability,
    candidates.map((account) => account.id),
  );
}

/**
 * Resolves `params.capability`'s connected account for a WRITE-BACK action
 * (comment, transition, status change — SPEC §7.26). Never defaults: an
 * absent or explicit-`null` pin is always {@link AccountPinRequiredError}.
 * An explicit string pin is checked for a host/site match exactly like
 * {@link resolveAccountForRead}.
 */
export function resolveAccountForWrite(params: AccountResolutionParams): ConnectedAccount {
  const { pins, capability, accounts, target } = params;
  const pin = pins[capability];
  if (pin === null || pin === undefined) {
    throw new AccountPinRequiredError(capability);
  }
  return resolvePinnedAccount(capability, pin, accounts, target);
}
