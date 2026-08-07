/* ---------------------------------------------------------------------
 * SPEC §7.26 / issue #223: import every host+account the operator's local
 * `gh` CLI already holds into the `ConnectedAccount` registry — a second
 * way onto the same registry `github-connect.ts`'s device flow builds
 * (`credentialSource: 'cli_import'`, already in `@loombox/protocol`'s
 * enum), for someone who already ran `gh auth login` and would rather not
 * repeat a device flow loombox's own OAuth App would just duplicate.
 *
 * Three boundaries this module exists to get right, each a real decision
 * rather than an accident (per issue #223's own framing):
 *
 * 1. **Where gh's token actually lives is gh's problem, not ours.** Since
 *    gh 2.24 (Feb 2023) a token may be OS-keyring-backed instead of
 *    plaintext in `hosts.yml`, and which one depends on the platform,
 *    whether a keyring service is even reachable (headless boxes often
 *    have none), and gh's own version/flags at login time. This module
 *    never reads `hosts.yml` and never touches a keyring directly — it
 *    shells out to `gh auth token --hostname <host> --user <login>`, the
 *    one gh-owned surface that already resolves across every storage
 *    backend gh supports, present and future.
 * 2. **Enumeration goes through `gh auth status --json hosts`** (requires
 *    gh >= 2.81.0, Sept 2025) rather than parsing the human-readable text
 *    `gh auth status` prints — that text is meant for a terminal, changes
 *    across gh versions, and is locale-dependent, none of which `--json`
 *    is. An older gh without `--json` support fails this module's own
 *    probe with a named, actionable reason (`'gh_unsupported'`) instead of
 *    trying to regex a format that was never a contract.
 * 3. **The token belongs to gh, not to us — it can go stale underneath.**
 *    A `gh auth logout`/`gh auth refresh` run after this import changes or
 *    revokes what gh holds without loombox ever hearing about it. This
 *    module takes a one-shot copy at import time (the same "does this node
 *    hold a local secret" question `account-presence.ts` already answers
 *    lazily, per credential, for every source) and never tracks gh's state
 *    going forward. A later 401 surfaces through the same generic "this
 *    account's stored token stopped working" path that device-flow-issued
 *    and pasted tokens already go through when GitHub revokes them —
 *    CLI-imported tokens are not treated as a live proxy for gh's own
 *    session, and re-importing (running this again) is how a caller picks
 *    up whatever gh currently holds.
 *
 * A fourth, narrower decision: **scope sufficiency is reported, never
 * silently discovered later.** SPEC §7.26's device flow requests four
 * scopes (`GITHUB_CONNECT_SCOPES`); a gh-issued token may carry fewer (gh
 * itself only asks for `repo`, `read:org`, `gist` by default) or, for a
 * fine-grained PAT/GitHub App token, none introspectable at all (GitHub
 * omits the `X-OAuth-Scopes` header entirely for those — see
 * `github-identity.ts`'s own top comment). Every `'imported'` entry below
 * carries `missingScopes` — the subset of those four this token doesn't
 * grant — so a caller can warn honestly at import time rather than the
 * account failing a tracker write months later with no explanation. This
 * never blocks the import itself: SPEC's CLI-import bullet is
 * unconditional ("one shot imports every host+account"), matching the
 * device flow's own behavior of connecting with whatever scopes GitHub
 * actually granted.
 * --------------------------------------------------------------------- */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  composeConnectedAccountId,
  connectedAccount,
  connectedAccountSecretRef,
  type ConnectedAccount,
} from '@loombox/protocol';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
  type ConnectedAccountKeyringOptions,
} from './connected-account-keyring';
import { deriveGithubCapabilities } from './github-connect';
import { GITHUB_CONNECT_SCOPES } from './github-device-flow';
import { githubApiBaseUrl, resolveGithubIdentity } from './github-identity';
import type { NodeKeyring } from './keyring';

const execFileAsync = promisify(execFile);

/** One completed `gh` invocation's result — argv-based (`child_process.execFile`-shaped), never a shell string, so no argument ever needs quoting. Mirrors `launchd-provisioning.ts`'s `LaunchctlResult`. */
export interface GhCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GithubCliImportOptions extends ConnectedAccountKeyringOptions {
  /**
   * Runs `gh` with `args` as argv. Injectable for tests — issue #223's
   * acceptance is explicit that the suite must never depend on a real `gh`
   * being installed: every unit test stubs this; a real-`gh` smoke test
   * probes for it first and `it.skipIf`s when absent. Defaults to actually
   * spawning `gh` off `PATH`.
   */
  runGh?: (args: string[]) => Promise<GhCommandResult>;
  /** See `GithubConnectServiceOptions.onCredentialChanged` — the same hook, fired once per host+account this import actually writes a token for. */
  onCredentialChanged?: (secretRef: string) => void;
}

export interface GithubCliImportRunOptions {
  /** Injectable for tests; defaults to the global `fetch`. Issue #223's acceptance mirrors #222's: never hit the real GitHub API from a test — stub this, or (for the real-`gh` smoke test) stub it anyway and only let the real `gh auth token` call through. */
  fetchImpl?: typeof fetch;
}

export interface GithubCliImportEntryImported {
  outcome: 'imported';
  account: ConnectedAccount;
  /** The subset of `GITHUB_CONNECT_SCOPES` this gh-issued token does not grant — empty when it already covers everything the device-flow path would have requested. See this module's own top comment for why this is never a reason to skip the import. */
  missingScopes: string[];
}

export interface GithubCliImportEntryError {
  outcome: 'error';
  host: string;
  login?: string;
  message: string;
}

export type GithubCliImportEntry = GithubCliImportEntryImported | GithubCliImportEntryError;

export type GithubCliImportFailureReason =
  'gh_not_found' | 'gh_unsupported' | 'gh_not_logged_in' | 'error';

export interface GithubCliImportSuccess {
  outcome: 'success';
  entries: GithubCliImportEntry[];
}

export interface GithubCliImportFailure {
  outcome: 'failure';
  reason: GithubCliImportFailureReason;
  message: string;
}

export type GithubCliImportResult = GithubCliImportSuccess | GithubCliImportFailure;

/** One host+account as `gh auth status --json hosts` reports it — the subset of gh's own JSON shape this module actually reads. `scopes` is deliberately not read here: this module derives scopes from its own `GET /user` call (`github-identity.ts`'s `X-OAuth-Scopes` parsing) instead of trusting gh's own (separately network-derived) `scopes` string, so the whole scope-sufficiency check is provable against a stubbed `fetchImpl` alone, with no dependency on gh's own scope-formatting. */
interface GhAuthStatusEntry {
  state: 'success' | 'timeout' | 'error';
  host: string;
  login: string;
  error?: string;
}

interface GhAuthStatusJson {
  hosts: Record<string, GhAuthStatusEntry[]>;
}

/** Parses `gh auth status --json hosts`'s stdout, or `undefined` if it isn't that shape at all — the signal this module uses to tell "gh ran and reported no hosts" (valid `{hosts: {}}`) apart from "gh doesn't understand `--json`" (a cobra usage error on stderr, no valid JSON on stdout; gh < 2.81.0). Deliberately light-touch: this is local `gh`-owned output, not a hostile input, so it is trusted once it parses as an object with a `hosts` object — the same trust level `launchd-provisioning.ts`'s `launchctl` result handling gives its own subprocess output. */
function parseGhAuthStatusJson(stdout: string): GhAuthStatusJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('hosts' in parsed)) return undefined;
  const { hosts } = parsed;
  if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) return undefined;
  return parsed as GhAuthStatusJson;
}

/**
 * The real {@link GithubCliImportOptions.runGh}: a genuine `gh` child
 * process. `execFileAsync` rejects both for a non-zero exit AND for the
 * binary itself failing to spawn (e.g. `gh` not on `PATH`) — only the
 * former has a numeric `.code` (the exit status); anything else is
 * re-thrown rather than pretending it's some exit code (mirrors
 * `launchd-provisioning.ts`'s `createNodeLaunchdIo().launchctl`).
 * {@link GithubCliImportService.import} turns a re-thrown error here into
 * this module's own `'gh_not_found'` failure reason.
 */
async function defaultRunGh(args: string[]): Promise<GhCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typeof execError.code !== 'number') {
      throw error;
    }
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      exitCode: execError.code,
    };
  }
}

/**
 * Runs SPEC §7.26's `gh` CLI import (issue #223): one call enumerates and
 * imports every host+account the local `gh` CLI holds, each landing in
 * this service's keyring under its own `secretRef` — exactly like a batch
 * of {@link GithubConnectService.connect} calls, just without a separate
 * device flow per account. See this module's own top comment for the
 * storage/enumeration/staleness boundaries this class embodies.
 */
export class GithubCliImportService {
  private readonly keyring: NodeKeyring;
  private readonly onCredentialChanged: ((secretRef: string) => void) | undefined;
  private readonly runGh: (args: string[]) => Promise<GhCommandResult>;

  constructor(options: GithubCliImportOptions = {}) {
    this.keyring = createConnectedAccountKeyring(options);
    this.onCredentialChanged = options.onCredentialChanged;
    this.runGh = options.runGh ?? defaultRunGh;
  }

  async import(options: GithubCliImportRunOptions = {}): Promise<GithubCliImportResult> {
    const fetchImpl = options.fetchImpl ?? fetch;

    let statusResult: GhCommandResult;
    try {
      statusResult = await this.runGh(['auth', 'status', '--json', 'hosts']);
    } catch (error) {
      return {
        outcome: 'failure',
        reason: 'gh_not_found',
        message: `gh CLI import: could not run "gh" — is it installed and on PATH? (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    }

    const parsed = parseGhAuthStatusJson(statusResult.stdout);
    if (!parsed) {
      return {
        outcome: 'failure',
        reason: 'gh_unsupported',
        message:
          'gh CLI import: "gh auth status --json hosts" did not return the expected JSON — ' +
          'this requires gh >= 2.81.0 (Sept 2025). Upgrade gh and try again.' +
          (statusResult.stderr.trim() ? ` (gh said: ${statusResult.stderr.trim()})` : ''),
      };
    }

    const hostEntries = Object.values(parsed.hosts).flat();
    if (hostEntries.length === 0) {
      return {
        outcome: 'failure',
        reason: 'gh_not_logged_in',
        message:
          'gh CLI import: gh is installed but not logged into any GitHub host — run "gh auth login" first.',
      };
    }

    const entries: GithubCliImportEntry[] = [];
    for (const entry of hostEntries) {
      entries.push(await this.importEntry(entry, fetchImpl));
    }
    return { outcome: 'success', entries };
  }

  private async importEntry(
    entry: GhAuthStatusEntry,
    fetchImpl: typeof fetch,
  ): Promise<GithubCliImportEntry> {
    if (entry.state !== 'success') {
      return {
        outcome: 'error',
        host: entry.host,
        login: entry.login || undefined,
        message: entry.error?.trim() || `gh reports this account's auth state as "${entry.state}"`,
      };
    }

    let token: string;
    try {
      const tokenResult = await this.runGh([
        'auth',
        'token',
        '--hostname',
        entry.host,
        '--user',
        entry.login,
      ]);
      if (tokenResult.exitCode !== 0) {
        return {
          outcome: 'error',
          host: entry.host,
          login: entry.login,
          message: `"gh auth token" failed (exit ${tokenResult.exitCode}): ${tokenResult.stderr.trim()}`,
        };
      }
      token = tokenResult.stdout.trim();
    } catch (error) {
      return {
        outcome: 'error',
        host: entry.host,
        login: entry.login,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (token.length === 0) {
      return {
        outcome: 'error',
        host: entry.host,
        login: entry.login,
        message: '"gh auth token" returned an empty token',
      };
    }

    let identity;
    try {
      identity = await resolveGithubIdentity(token, {
        fetchImpl,
        apiBaseUrl: githubApiBaseUrl(entry.host),
      });
    } catch (error) {
      return {
        outcome: 'error',
        host: entry.host,
        login: entry.login,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const id = composeConnectedAccountId({
      provider: 'github',
      host: entry.host,
      providerAccountId: String(identity.id),
    });
    const secretRef = connectedAccountSecretRef(id);

    // The token touches this one keyring write and nothing else — it is
    // never assigned to any field of the ConnectedAccount built below
    // (same contract as GithubConnectService.connect).
    await this.keyring.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, token);
    this.onCredentialChanged?.(secretRef);

    const missingScopes = GITHUB_CONNECT_SCOPES.filter((scope) => !identity.scopes.includes(scope));
    const now = Date.now();

    // `connectedAccount.parse` re-enforces `@loombox/protocol`'s
    // numeric-providerAccountId / derived-id structural rules — a bug
    // upstream in identity resolution fails loudly here rather than
    // silently syncing a malformed row, same as the device flow.
    const account = connectedAccount.parse({
      id,
      provider: 'github',
      host: entry.host,
      providerAccountId: String(identity.id),
      label: identity.login,
      avatarUrl: identity.avatarUrl,
      credentialSource: 'cli_import',
      scopes: identity.scopes,
      capabilities: deriveGithubCapabilities(identity.scopes),
      connectedAt: now,
      updatedAt: now,
      secretRef,
    });

    return { outcome: 'imported', account, missingScopes };
  }
}
