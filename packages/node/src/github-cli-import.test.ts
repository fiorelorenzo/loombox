import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';
import { GithubCliImportService, type GhCommandResult } from './github-cli-import';

const execFileAsync = promisify(execFile);

/**
 * `GithubCliImportService` (SPEC §7.26, issue #223) against a fixture `gh`
 * (never a real one) for every branch below — the acceptance's "the test
 * suite must not depend on what is installed on this box" — plus one
 * `describe.skipIf` block at the bottom proving the same code path against
 * whatever real `gh` this devbox happens to have, without ever asserting
 * on the real token's value (only that a non-empty string landed in an
 * isolated, throwaway keyring).
 */

function jsonResponse(status: number, body: unknown, scopesHeader?: string): Response {
  const headers = new Headers();
  if (scopesHeader !== undefined) headers.set('x-oauth-scopes', scopesHeader);
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers } as Response;
}

/** A comma-joined X-OAuth-Scopes header carrying every scope `GITHUB_CONNECT_SCOPES` requests — the "sufficient" fixture case. */
const GRANTED_ALL = 'repo, read:user, read:org, read:project, gist';

/**
 * A `fetchImpl` that answers `GET <base>/user` keyed by the request's own
 * Bearer token (never by URL alone) — the shape that actually
 * distinguishes two accounts on the SAME host, which two different base
 * URLs cannot. `calls` (optional) collects every URL hit, so a test can
 * assert exactly which API base a given host resolved against (the GHES
 * acceptance below). Throws on any token it wasn't told about.
 */
function stubGithubFetch(
  usersByToken: Record<string, { id: number; login: string; scopesHeader?: string }>,
  calls: string[] = [],
): typeof fetch {
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    const user = usersByToken[token];
    if (!user) {
      throw new Error(`stubGithubFetch: no fixture identity for token used against ${url}`);
    }
    return jsonResponse(200, { id: user.id, login: user.login }, user.scopesHeader);
  };
  return impl;
}

/** Builds a `runGh` fixture: `auth status --json hosts` returns `statusJson` (or a raw error page via `statusStderr`/`statusExitCode`, simulating an old gh without `--json`); `auth token --hostname H --user U` returns `tokensByHostAndUser[H][U]`, or the forced exit code in `tokenExitCode['H:U']` when set. */
function fixtureRunGh(options: {
  statusJson?: unknown;
  statusExitCode?: number;
  statusStderr?: string;
  tokensByHostAndUser?: Record<string, Record<string, string>>;
  tokenExitCode?: Record<string, number>;
}): (args: string[]) => Promise<GhCommandResult> {
  return async (args: string[]) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return {
        stdout: options.statusJson !== undefined ? JSON.stringify(options.statusJson) : '',
        stderr: options.statusStderr ?? '',
        exitCode: options.statusExitCode ?? 0,
      };
    }
    if (args[0] === 'auth' && args[1] === 'token') {
      const host = args[args.indexOf('--hostname') + 1];
      const user = args[args.indexOf('--user') + 1];
      const forcedExit = options.tokenExitCode?.[`${host}:${user}`];
      if (forcedExit !== undefined) {
        return {
          stdout: '',
          stderr: `no oauth token found for ${host} account ${user}`,
          exitCode: forcedExit,
        };
      }
      const token = options.tokensByHostAndUser?.[host]?.[user];
      if (token === undefined) {
        return {
          stdout: '',
          stderr: `no oauth token found for ${host} account ${user}`,
          exitCode: 1,
        };
      }
      return { stdout: `${token}\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`fixtureRunGh: unexpected gh invocation: ${args.join(' ')}`);
  };
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-github-cli-import-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function service(runGh: (args: string[]) => Promise<GhCommandResult>): GithubCliImportService {
  return new GithubCliImportService({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
    runGh,
  });
}

describe('GithubCliImportService.import (SPEC §7.26, issue #223)', () => {
  it('imports one ConnectedAccount per host+account, including a GitHub Enterprise Server host kept as its own host — never coerced to github.com, resolved against its own API base', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
            'ghe.example.com': [
              { state: 'success', active: true, host: 'ghe.example.com', login: 'enterprise-user' },
            ],
          },
        },
        tokensByHostAndUser: {
          'github.com': { octocat: 'gho_fixture-token-com' },
          'ghe.example.com': { 'enterprise-user': 'ghp_fixture-token-ghe' },
        },
      }),
    );

    const calls: string[] = [];
    const result = await svc.import({
      fetchImpl: stubGithubFetch(
        {
          'gho_fixture-token-com': { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
          'ghp_fixture-token-ghe': {
            id: 2222,
            login: 'enterprise-user',
            scopesHeader: GRANTED_ALL,
          },
        },
        calls,
      ),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.entries).toHaveLength(2);

    const dotcom = result.entries.find(
      (e) => e.outcome === 'imported' && e.account.host === 'github.com',
    );
    const ghe = result.entries.find(
      (e) => e.outcome === 'imported' && e.account.host === 'ghe.example.com',
    );
    expect(dotcom).toMatchObject({
      outcome: 'imported',
      account: { id: 'github:github.com:1111' },
    });
    expect(ghe).toMatchObject({
      outcome: 'imported',
      account: { id: 'github:ghe.example.com:2222' },
    });

    // The GHES account resolved against ITS OWN api/v3 base, never api.github.com's.
    expect(calls).toContain('https://api.github.com/user');
    expect(calls).toContain('https://ghe.example.com/api/v3/user');
  });

  it('imports multiple accounts on the SAME host as distinct ConnectedAccount rows', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
              { state: 'success', active: false, host: 'github.com', login: 'octocat-work' },
            ],
          },
        },
        tokensByHostAndUser: {
          'github.com': { octocat: 'gho_personal', 'octocat-work': 'gho_work' },
        },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        gho_personal: { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
        gho_work: { id: 3333, login: 'octocat-work', scopesHeader: GRANTED_ALL },
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.entries).toHaveLength(2);
    const ids = result.entries
      .filter((e) => e.outcome === 'imported')
      .map((e) => (e.outcome === 'imported' ? e.account.id : undefined))
      .sort();
    expect(ids).toEqual(['github:github.com:1111', 'github:github.com:3333']);
  });

  it('reports insufficient scopes by name on the imported entry, rather than importing silently or failing outright', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_limited-scopes' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        'gho_limited-scopes': { id: 1111, login: 'octocat', scopesHeader: 'repo, read:user' },
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    const entry = result.entries[0];
    expect(entry.outcome).toBe('imported');
    if (entry.outcome !== 'imported') return;
    expect(entry.missingScopes.sort()).toEqual(['read:org', 'read:project']);
    // Still imported despite missing scopes — SPEC §7.26's CLI-import bullet
    // ("one shot imports every host+account") is unconditional.
    expect(entry.account.credentialSource).toBe('cli_import');
  });

  it('missingScopes is empty when the gh-issued token already covers every scope the device flow would request', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_full-scopes' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        'gho_full-scopes': { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    const entry = result.entries[0];
    expect(entry.outcome).toBe('imported');
    if (entry.outcome !== 'imported') return;
    expect(entry.missingScopes).toEqual([]);
  });

  it('reports all four scopes missing (never crashes) for a fine-grained-PAT-sourced gh session with no X-OAuth-Scopes header', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'github_pat_fine-grained' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        'github_pat_fine-grained': { id: 1111, login: 'octocat' }, // no scopesHeader
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    const entry = result.entries[0];
    expect(entry.outcome).toBe('imported');
    if (entry.outcome !== 'imported') return;
    expect(entry.missingScopes.sort()).toEqual(
      ['read:org', 'read:project', 'read:user', 'repo'].sort(),
    );
  });

  it("the imported token actually lands in this service's keyring, readable back through the same keyring binding, and never appears on the returned metadata row", async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_keyring-check-token' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        'gho_keyring-check-token': { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    const entry = result.entries[0];
    expect(entry.outcome).toBe('imported');
    if (entry.outcome !== 'imported') return;

    const keyring = createConnectedAccountKeyring({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
    });
    const stored = await keyring.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, entry.account.secretRef);
    expect(stored).toBe('gho_keyring-check-token');
    expect(JSON.stringify(entry.account)).not.toContain('gho_keyring-check-token');
  });

  it('fires onCredentialChanged once per imported account', async () => {
    const changed: string[] = [];
    const svc = new GithubCliImportService({
      stateDir,
      osKeyringBackendFactory: async () => undefined,
      onCredentialChanged: (secretRef) => changed.push(secretRef),
      runGh: fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_cred-changed-token' } },
      }),
    });

    await svc.import({
      fetchImpl: stubGithubFetch({
        'gho_cred-changed-token': { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
      }),
    });

    expect(changed).toEqual(['connected-account-token:github:github.com:1111']);
  });

  it('a host+account gh itself reports broken (state !== "success") becomes a named per-entry error — no ConnectedAccount, no network call, other entries unaffected', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              {
                state: 'error',
                active: true,
                host: 'github.com',
                login: 'broken-account',
                error: 'token revoked',
              },
              { state: 'success', active: false, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_still-fine' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: stubGithubFetch({
        'gho_still-fine': { id: 1111, login: 'octocat', scopesHeader: GRANTED_ALL },
      }),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.entries).toHaveLength(2);
    const broken = result.entries.find((e) => e.outcome === 'error');
    expect(broken).toMatchObject({
      outcome: 'error',
      host: 'github.com',
      login: 'broken-account',
      message: 'token revoked',
    });
    const ok = result.entries.find((e) => e.outcome === 'imported');
    expect(ok).toBeDefined();
  });

  it('"gh auth token" failing for one entry becomes a named per-entry error, never a thrown exception', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokenExitCode: { 'github.com:octocat': 1 },
      }),
    );

    const result = await svc.import();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.entries).toEqual([
      expect.objectContaining({ outcome: 'error', host: 'github.com', login: 'octocat' }),
    ]);
  });

  it('a GET /user rejection (bad identity) becomes a named per-entry error, not a thrown exception', async () => {
    const svc = service(
      fixtureRunGh({
        statusJson: {
          hosts: {
            'github.com': [
              { state: 'success', active: true, host: 'github.com', login: 'octocat' },
            ],
          },
        },
        tokensByHostAndUser: { 'github.com': { octocat: 'gho_bad-identity' } },
      }),
    );

    const result = await svc.import({
      fetchImpl: (async () => jsonResponse(200, { login: 'octocat' })) as typeof fetch, // no numeric id
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    const entry = result.entries[0];
    expect(entry.outcome).toBe('error');
    if (entry.outcome !== 'error') return;
    expect(entry.message).toMatch(/numeric "id"/);
  });

  it('fails with reason "gh_not_found" when gh cannot even be spawned (ENOENT-shaped)', async () => {
    const svc = service(async () => {
      const error = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const result = await svc.import();
    expect(result).toMatchObject({ outcome: 'failure', reason: 'gh_not_found' });
  });

  it('fails with reason "gh_unsupported" when gh runs but does not understand --json (old gh, cobra usage error)', async () => {
    const svc = service(async () => ({
      stdout: '',
      stderr: 'unknown flag: --json\n\nUsage:\n  gh auth status [flags]',
      exitCode: 1,
    }));

    const result = await svc.import();
    expect(result).toMatchObject({ outcome: 'failure', reason: 'gh_unsupported' });
  });

  it('fails with reason "gh_not_logged_in" when gh works but names no host at all', async () => {
    const svc = service(async () => ({
      stdout: JSON.stringify({ hosts: {} }),
      stderr: '',
      exitCode: 0,
    }));

    const result = await svc.import();
    expect(result).toMatchObject({ outcome: 'failure', reason: 'gh_not_logged_in' });
  });
});

// ---------------------------------------------------------------------
// Real `gh`, stubbed network — issue #223's acceptance: "proven end to
// end against a fixture (and against the real gh here, if you can do it
// without using my actual token in an assertion)". `fetchImpl` is always
// stubbed (never a real GitHub API call); only `gh auth token` genuinely
// runs, and its output is never compared against a captured literal —
// only checked for "some non-empty string landed in an isolated,
// throwaway keyring".
// ---------------------------------------------------------------------

async function probeRealGhLoggedIn(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'status', '--json', 'hosts']);
    const parsed = JSON.parse(stdout) as { hosts?: Record<string, unknown[]> };
    return Object.values(parsed.hosts ?? {}).some((entries) => entries.length > 0);
  } catch {
    return false;
  }
}

const realGhLoggedIn = await probeRealGhLoggedIn();

describe.skipIf(!realGhLoggedIn)(
  'GithubCliImportService against the real gh CLI (network stubbed, issue #223)',
  () => {
    it('walks the real gh auth status output and imports at least one account, storing a real (never asserted) token in an isolated keyring', async () => {
      const svc = new GithubCliImportService({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      });

      const smokeFetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (!auth?.startsWith('Bearer ') || auth === 'Bearer ') {
          throw new Error('expected a real bearer token to have been forwarded');
        }
        if (url.endsWith('/user')) {
          return jsonResponse(200, { id: 999999999, login: 'real-gh-smoke-test-user' });
        }
        throw new Error(`unexpected URL in real-gh smoke test: ${url}`);
      };

      const result = await svc.import({ fetchImpl: smokeFetchImpl });

      expect(result.outcome).toBe('success');
      if (result.outcome !== 'success') return;
      expect(result.entries.length).toBeGreaterThan(0);
      const oneImported = result.entries.find((e) => e.outcome === 'imported');
      expect(oneImported).toBeDefined();
      if (!oneImported || oneImported.outcome !== 'imported') return;
      expect(oneImported.account.credentialSource).toBe('cli_import');

      const keyring = createConnectedAccountKeyring({
        stateDir,
        osKeyringBackendFactory: async () => undefined,
      });
      const stored = await keyring.get(
        CONNECTED_ACCOUNT_KEYRING_SERVICE,
        oneImported.account.secretRef,
      );
      // Never compared to a captured real value — only that *something* landed.
      expect(typeof stored).toBe('string');
      expect(stored?.length).toBeGreaterThan(0);
    });
  },
);
