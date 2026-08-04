/* ---------------------------------------------------------------------
 * The tracker backend composition layer (SPEC §7.10, §7.26; issue #631):
 * the one seam between a project's `TrackerMode` and a working, callable
 * `TrackerBackend`. Neither live slice was actually reachable without
 * this file — `GithubTrackerBackend`/`JiraTrackerBackend` (#213/#214)
 * each take a narrow injected `resolveCredential(connectionId)`, and
 * every call site had to build one by hand; this module is that call
 * site, built once, correctly, and shared.
 *
 * Four things happen here, in this order, and none of them is optional:
 *
 * 1. `mode.connectionId` is looked up in the connected-account registry
 *    (`accounts`, the same relay-synced list `./account-pin.ts`'s own
 *    resolvers take as a parameter — this module performs no I/O of its
 *    own to obtain it, exactly like that module's own doc comment
 *    explains for the same reason).
 * 2. The project's per-capability pin (#227's `resolveAccountForRead`/
 *    `resolveAccountForWrite`, capability keyed on `mode.provider`) is
 *    applied, and every hard-fail case it can throw is mapped, never
 *    swallowed — see `accountResolutionErrorToTrackerError` below.
 * 3. The pin's own resolved account is checked against step 1's — see
 *    "Why both a registry lookup and a pin resolution" below for why a
 *    mismatch between them is a hard-fail case of its own
 *    (`connectionPinMismatch`), not a silent "pin wins" or "mode wins".
 * 4. Only once 1-3 all agree does this module ask this node's keyring
 *    (via `GithubConnectService.getAccessToken`/
 *    `JiraConnectService.getCredential` — never any other source) for
 *    the actual secret, and hand the backend a `resolveCredential`
 *    closure that re-asks the keyring on every call (so a revoked/
 *    rotated credential takes effect on the very next call, exactly
 *    like the backends' own doc comments already promise) and refuses
 *    to serve a `connectionId` other than the one this backend was
 *    composed for.
 *
 * **Why both a registry lookup and a pin resolution.** `mode.connectionId`
 * (chosen via #220's tracker-mode picker) and the capability pin (chosen
 * via #230's Settings pin picker) are two independently-editable settings
 * that name the SAME kind of fact — "which connected account acts on
 * this project's behalf" (SPEC §7.26) — through two different UIs. They
 * usually agree. When they don't (the pin was repointed after the
 * tracker mode was configured, or vice versa), silently trusting either
 * one alone is exactly the bug class SPEC §7.26 forbids ("falling back
 * to a different account for a write action is a correctness/security
 * bug"), so this module trusts neither alone: it resolves through the
 * pin (so every #227 hard-fail case still applies) and then requires the
 * pin's answer to equal `mode.connectionId` exactly, surfacing a
 * disagreement as `connectionPinMismatch` rather than picking a winner.
 * This is also the mechanism that makes one project's mode structurally
 * unable to resolve against a *different* project's pinned account:
 * `pins` is the caller's own project-scoped `AccountPinStore.get
 * (projectPath)` read, so a `pins` map belonging to the wrong project
 * either has no matching pin (`accountPinRequired`/`accountPinOptedOut`)
 * or names a different account than `mode.connectionId`
 * (`connectionPinMismatch`) — never silently accepted.
 *
 * **A `{kind:'native'}` mode is not this module's job.** `resolveTrackerBackend`
 * returns `{ok:false, error:{kind:'nativeMode'}}` for one rather than
 * inventing a backend for it — the caller (the bridge dispatch, issue
 * #631's follow-up) is the one that knows what a native-mode project
 * reads from (`NativeTrackerStore`), not this module.
 *
 * **The `jira-connect.ts`/`jira-tracker-backend.ts` credential-type
 * question, decided here per issue #631's own text**: the two
 * independently-declared `JiraCredential` interfaces (`{baseUrl,
 * authHeader}` in both) are left exactly as they are, not unified onto
 * one shared export. They are already structurally identical, so
 * TypeScript accepts `JiraConnectService.getCredential`'s return value
 * everywhere `JiraTrackerBackend`'s `ResolveJiraCredential` expects one
 * with zero conversion code below; introducing a third, shared
 * declaration would force `jira-connect.ts` and `jira-tracker-backend.ts`
 * to both import it, reopening exactly the "the backend never imports a
 * connect module" boundary their own tests guard, to save two five-line
 * interfaces that already cost nothing at the call site.
 * --------------------------------------------------------------------- */

import type { ConnectedAccount, TrackerMode } from '@loombox/protocol';
import type { TrackerBackend } from '@loombox/shared';

import {
  AccountHostMismatchError,
  AccountPinDanglingError,
  AccountPinMalformedError,
  AccountPinRequiredError,
  AmbiguousAccountError,
  resolveAccountForRead,
  resolveAccountForWrite,
  type AccountPinMap,
  type AccountResolutionParams,
  type AccountResolutionTarget,
} from './account-pin';
import type { GithubConnectService } from './github-connect';
import { GithubTrackerBackend } from './github-tracker-backend';
import type { JiraConnectService } from './jira-connect';
import { JiraTrackerBackend } from './jira-tracker-backend';

/**
 * Which #227 resolver `resolveTrackerBackend` applies: `resolveAccountForRead`
 * (may default to an unambiguous single candidate) for a read,
 * `resolveAccountForWrite` (never defaults) for a write-back action
 * (comment, transition, status change). Selecting the wrong one is the
 * exact bug SPEC §7.26 calls out — a live-mode project's read path and
 * write path (issue #631's own follow-up: `readTrackerSnapshotForBridge`/
 * `applyTrackerWriteForBridge`) each call `resolveTrackerBackend` with
 * their own intent; neither shares the other's resolution.
 */
export type TrackerBackendIntent = 'read' | 'write';

/**
 * Every way `resolveTrackerBackend` can fail to hand back a working
 * `TrackerBackend`, exhaustively — the Tracker page (issue #631's
 * follow-up) switches on `kind` to render one of these, never a bare
 * string. The first five mirror `./account-pin.ts`'s own
 * `AccountResolutionError` subclasses field-for-field (see
 * `accountResolutionErrorToTrackerError` below); the rest are specific
 * to composing a *tracker* backend from a *mode*, not to pin resolution
 * generally.
 */
export type TrackerBackendResolutionError =
  | { readonly kind: 'nativeMode' }
  | { readonly kind: 'accountNotConnected'; readonly connectionId: string }
  | { readonly kind: 'accountPinRequired'; readonly capability: string }
  | {
      readonly kind: 'accountPinMalformed';
      readonly capability: string;
      readonly pinnedAccountId: string;
    }
  | {
      readonly kind: 'accountPinDangling';
      readonly capability: string;
      readonly pinnedAccountId: string;
    }
  | {
      readonly kind: 'accountHostMismatch';
      readonly capability: string;
      readonly pinnedAccountId: string;
      readonly expectedHost: string;
      readonly actualHost: string;
    }
  | {
      readonly kind: 'accountAmbiguous';
      readonly capability: string;
      readonly candidateAccountIds: readonly string[];
    }
  | { readonly kind: 'accountPinOptedOut'; readonly capability: string }
  | {
      readonly kind: 'connectionPinMismatch';
      readonly connectionId: string;
      readonly pinnedAccountId: string;
    }
  | { readonly kind: 'credentialUnavailable'; readonly connectionId: string }
  | {
      readonly kind: 'credentialSourceUnsupported';
      readonly connectionId: string;
      readonly credentialSource: string;
    };

/**
 * `resolveTrackerBackend`'s result: `Result`-shaped (mirrors
 * `./verify-and-persist.ts`'s/`./supervisor-artifact.ts`'s own
 * `{ok:true}|{ok:false,...}` convention already used across this
 * package) rather than a thrown exception — a live-mode project failing
 * to resolve is an expected, renderable state (SPEC §7.10's "explicit
 * connectivity-error state"), never a bug.
 */
export type TrackerBackendResolution =
  | { readonly ok: true; readonly backend: TrackerBackend }
  | { readonly ok: false; readonly error: TrackerBackendResolutionError };

export interface ResolveTrackerBackendOptions {
  /** The project's saved tracker configuration. `{kind:'native'}` always resolves to `{ok:false, error:{kind:'nativeMode'}}`; composing a backend for native mode is never this module's job. */
  readonly mode: TrackerMode;
  /** The project this resolution is for. Threaded through into every error this module raises about a cross-connection mismatch so a caller logging a failure never has to guess which project it was resolving — never used to look anything up here (the caller already scoped `pins` to it; see this module's own top comment for why that split, not a `projectPath`-keyed internal store read, is what keeps one project's mode from resolving against a different project's pin). */
  readonly projectPath: string;
  /** Selects `resolveAccountForRead` or `resolveAccountForWrite` — see {@link TrackerBackendIntent}'s own doc comment. */
  readonly intent: TrackerBackendIntent;
  /** Every connected account visible to resolve against — same contract as `./account-pin.ts`'s own `AccountResolutionParams.accounts`: pass the full set, this module does its own candidacy/mismatch filtering. */
  readonly accounts: readonly ConnectedAccount[];
  /** This project's own per-capability pin map — the caller's `AccountPinStore.get(projectPath)` read, already scoped to `projectPath` above before this module ever sees it. */
  readonly pins: AccountPinMap;
  /** The only source of a GitHub bearer token this module ever consults (SPEC §7.26: node keyring only). Narrowed to the one method used, so a test double never has to implement the rest of `GithubConnectService`. */
  readonly githubConnectService: Pick<GithubConnectService, 'getAccessToken'>;
  /** The only source of a Jira credential this module ever consults. */
  readonly jiraConnectService: Pick<JiraConnectService, 'getCredential'>;
  /** Passed straight through to the composed `GithubTrackerBackend`/`JiraTrackerBackend`; injectable for tests, defaults to each backend's own default (the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Passed straight through to the composed `GithubTrackerBackend`'s rate-limit retry-after math; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Maps one of `./account-pin.ts`'s five `AccountResolutionError` subclasses onto this module's own typed union, field-for-field — mirrors `./node-daemon.ts`'s own `accountPinResolveErrorFromException`, which does the identical mapping onto the wire's `AccountPinResolveOutcome` instead. `undefined` for anything else: `account-pin.ts`'s own contract is that its resolvers never throw anything but one of these five, so a caller here treats that case as a defensive "should not happen" and rethrows rather than mislabeling it. */
function accountResolutionErrorToTrackerError(
  error: unknown,
): TrackerBackendResolutionError | undefined {
  if (error instanceof AccountPinRequiredError) {
    return { kind: 'accountPinRequired', capability: error.capability };
  }
  if (error instanceof AccountPinMalformedError) {
    return {
      kind: 'accountPinMalformed',
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
    };
  }
  if (error instanceof AccountHostMismatchError) {
    return {
      kind: 'accountHostMismatch',
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
      expectedHost: error.expectedHost,
      actualHost: error.actualHost,
    };
  }
  if (error instanceof AccountPinDanglingError) {
    return {
      kind: 'accountPinDangling',
      capability: error.capability,
      pinnedAccountId: error.pinnedAccountId,
    };
  }
  if (error instanceof AmbiguousAccountError) {
    return {
      kind: 'accountAmbiguous',
      capability: error.capability,
      candidateAccountIds: [...error.candidateAccountIds],
    };
  }
  return undefined;
}

/** Refuses to serve a `connectionId` other than the one this backend was composed for — the last line of defense against a composed backend (documented as "reusable across every bound repo/project" by both `GithubTrackerBackend`/`JiraTrackerBackend`) ever being reused for a different project's binding. Throws rather than returning a typed error: this is a `resolveCredential`-shape violation by *this module's own caller* (a `TrackerBinding` built from a different mode than the one this backend was composed for), not a resolvable project state. */
function assertSameConnection(
  requestedConnectionId: string,
  composedConnectionId: string,
  projectPath: string,
): void {
  if (requestedConnectionId !== composedConnectionId) {
    throw new Error(
      `tracker-backend-composition: resolveCredential called with connectionId "${requestedConnectionId}" for project "${projectPath}", but this backend was composed for connectionId "${composedConnectionId}" — refusing to serve another project's connected account`,
    );
  }
}

/**
 * The composition layer's one entry point (SPEC §7.10, §7.26; issue
 * #631): given a project's `TrackerMode` and everything the node already
 * knows about its connected accounts and pins, returns either a working
 * `TrackerBackend` or exactly why one could not be built. See this
 * module's own top comment for the four-step algorithm and the two
 * decisions ("why both a registry lookup and a pin resolution", the
 * `JiraCredential` convergence question) it exists to record.
 */
export async function resolveTrackerBackend(
  options: ResolveTrackerBackendOptions,
): Promise<TrackerBackendResolution> {
  const {
    mode,
    projectPath,
    intent,
    accounts,
    pins,
    githubConnectService,
    jiraConnectService,
    fetchImpl,
    now,
  } = options;

  if (mode.kind !== 'live') {
    return { ok: false, error: { kind: 'nativeMode' } };
  }
  // A separate `const` (not just the narrowed `mode`) so every closure
  // built below — which TypeScript's control-flow narrowing does not
  // reach into — sees the `live` variant's fields statically, not just
  // at this line.
  const liveMode = mode;

  // Step 1: liveMode.connectionId, looked up in the connected-account
  // registry — checking `provider` here too (not just `id`) is what
  // catches a connectionId that names a real account of the WRONG
  // provider, a shape `@loombox/protocol`'s schema cannot catch since it
  // never parses the opaque connectionId string.
  const namedAccount = accounts.find(
    (account) => account.id === liveMode.connectionId && account.provider === liveMode.provider,
  );
  if (!namedAccount) {
    return {
      ok: false,
      error: { kind: 'accountNotConnected', connectionId: liveMode.connectionId },
    };
  }

  // Step 2: the per-capability pin (#227), capability keyed on the
  // provider — every hard-fail case it can throw propagates below,
  // never swallowed.
  const target: AccountResolutionTarget = {
    provider: liveMode.provider,
    host: namedAccount.host,
  };
  const params: AccountResolutionParams = {
    pins,
    capability: liveMode.provider,
    accounts,
    target,
  };

  let pinnedAccount: ConnectedAccount | undefined;
  try {
    pinnedAccount =
      intent === 'write' ? resolveAccountForWrite(params) : resolveAccountForRead(params);
  } catch (error) {
    const mapped = accountResolutionErrorToTrackerError(error);
    if (!mapped) throw error;
    return { ok: false, error: mapped };
  }

  // Only reachable for a READ intent with an explicit opt-out
  // (`pins[capability] === null`) — `namedAccount` above is always at
  // least one candidate for `target`'s provider/host, so the "no
  // candidates" branch of `resolveAccountForRead` can never produce this
  // `undefined` on its own here.
  if (!pinnedAccount) {
    return { ok: false, error: { kind: 'accountPinOptedOut', capability: liveMode.provider } };
  }

  // Step 3: the pin's answer must be liveMode.connectionId's own
  // account — see this module's top comment for why a disagreement here
  // is a hard-fail, not a tiebreak.
  if (pinnedAccount.id !== namedAccount.id) {
    return {
      ok: false,
      error: {
        kind: 'connectionPinMismatch',
        connectionId: liveMode.connectionId,
        pinnedAccountId: pinnedAccount.id,
      },
    };
  }

  // Step 4: the node keyring, and only the node keyring.
  if (liveMode.provider === 'github') {
    const token = await githubConnectService.getAccessToken(namedAccount);
    if (token === undefined) {
      return {
        ok: false,
        error: { kind: 'credentialUnavailable', connectionId: liveMode.connectionId },
      };
    }
    const backend = new GithubTrackerBackend({
      resolveCredential: async (connectionId) => {
        assertSameConnection(connectionId, liveMode.connectionId, projectPath);
        const freshToken = await githubConnectService.getAccessToken(namedAccount);
        // An empty-string token (never fetched vs. revoked since
        // composition) is exactly what `GithubTrackerBackend`'s own
        // `token()` already treats as "no usable token"
        // (`GithubTrackerAccessError`) — reusing that existing, tested
        // check rather than inventing a second one here.
        return { token: freshToken ?? '' };
      },
      fetchImpl,
      now,
    });
    return { ok: true, backend };
  }

  // liveMode.provider === 'jira' — TrackerMode's own live variant is
  // `z.enum(['github', 'jira'])`; no third value ever type-checks here.
  if (namedAccount.credentialSource !== 'api_token') {
    return {
      ok: false,
      error: {
        kind: 'credentialSourceUnsupported',
        connectionId: liveMode.connectionId,
        credentialSource: namedAccount.credentialSource,
      },
    };
  }
  const credential = await jiraConnectService.getCredential(namedAccount);
  if (credential === undefined) {
    return {
      ok: false,
      error: { kind: 'credentialUnavailable', connectionId: liveMode.connectionId },
    };
  }
  const backend = new JiraTrackerBackend({
    resolveCredential: async (connectionId) => {
      assertSameConnection(connectionId, liveMode.connectionId, projectPath);
      const fresh = await jiraConnectService.getCredential(namedAccount);
      // Same "let the backend's own existing check surface it" reasoning
      // as the GitHub branch above — `JiraTrackerBackend.credential()`
      // already throws `JiraTrackerAccessError` on an empty baseUrl/
      // authHeader.
      return fresh ?? { baseUrl: '', authHeader: '' };
    },
    fetchImpl,
  });
  return { ok: true, backend };
}
