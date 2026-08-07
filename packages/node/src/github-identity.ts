/* ---------------------------------------------------------------------
 * GitHub identity resolution (SPEC §7.26, issue #222): `GET /user`, keyed
 * on the numeric `id` field — never `login`, which is mutable and
 * SSO-reassignable (`@loombox/protocol`'s `connected-accounts.ts` enforces
 * the same rule structurally on the `ConnectedAccount` this feeds). Shared
 * by every GitHub connect path (#222 device flow, #223 `gh` CLI import,
 * #224 fine-grained PAT paste) per SPEC §7.26's "Identity resolution for
 * all three paths is `GET /user`... never `login`" — this module is that
 * one call, so a future path reuses it rather than re-deriving its own
 * numeric-id rule.
 *
 * Two additions beyond the plain id/login/name/avatarUrl device-flow
 * (#222) originally needed, both added for #223's `gh` CLI import:
 *
 * - {@link githubApiBaseUrl} — the device flow only ever talks to
 *   `github.com` (loombox's own OAuth App isn't registered anywhere
 *   else), but `gh` CLI import explicitly must also import GitHub
 *   Enterprise Server accounts (SPEC §7.26), whose REST API lives at
 *   `https://<host>/api/v3`, not `api.github.com`. Centralized here
 *   rather than in `github-cli-import.ts` so #224's fine-grained-PAT
 *   paste (which will need the same GHES-vs-`github.com` split) reuses
 *   it instead of re-deriving it.
 * - `GithubIdentity.scopes` — parsed from this same `GET /user`
 *   response's `X-OAuth-Scopes` header, empty when the header is absent
 *   (a fine-grained PAT or GitHub App token, neither of which carries
 *   classic OAuth scopes at all — GitHub simply omits the header rather
 *   than sending an empty one). The device flow ignores this field (it
 *   already has the token endpoint's own `grantedScope`); `gh` CLI
 *   import is the one consumer, since gh hands over a token it obtained
 *   some other way with no equivalent response to read scopes from.
 * --------------------------------------------------------------------- */

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

/** The REST API base URL for `host` — `https://api.github.com` for `github.com` itself, `https://<host>/api/v3` for a GitHub Enterprise Server host (GitHub's own documented convention). Shared by every path that needs to talk to a GHES host, starting with #223's `gh` CLI import. */
export function githubApiBaseUrl(host: string): string {
  return host === 'github.com' ? DEFAULT_GITHUB_API_BASE_URL : `https://${host}/api/v3`;
}

export interface GithubIdentity {
  /** The stable numeric id — the only field a `ConnectedAccount.providerAccountId` may ever be built from. */
  id: number;
  login: string;
  name: string | null;
  avatarUrl?: string;
  /** Parsed from `GET /user`'s `X-OAuth-Scopes` response header; empty when the header is absent (see this module's own top comment). */
  scopes: string[];
}

/** Raised when GitHub's `GET /user` response can't be trusted as an identity — an HTTP error, or (the case issue #222's acceptance calls out explicitly) a body carrying only a `login`-shaped identity with no usable numeric `id`. Never includes the access token used to make the call. */
export class GithubIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubIdentityError';
  }
}

export interface ResolveGithubIdentityOptions {
  /** Injectable for tests; defaults to the global `fetch`. Must never be pointed at a real GitHub endpoint from a test (issue #222's acceptance: stub only). */
  fetchImpl?: typeof fetch;
  /** Overrides where `GET /user` is sent — see {@link githubApiBaseUrl}. Defaults to `https://api.github.com` (the device flow's only host); `gh` CLI import passes `githubApiBaseUrl(host)` explicitly so a GitHub Enterprise Server account resolves against its own API, never `github.com`'s. */
  apiBaseUrl?: string;
}

/** Parses `GET /user`'s `X-OAuth-Scopes` response header into a trimmed, non-empty scope list. `response.headers` is read defensively (`?.get?.`) so a minimal test double that stubs only `ok`/`status`/`json` — every existing device-flow test fixture — still resolves to an empty list rather than throwing. */
function parseScopesHeader(response: Response): string[] {
  const header = response.headers?.get?.('x-oauth-scopes') ?? '';
  if (header.length === 0) return [];
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Calls `GET /user` with `accessToken` and resolves the caller's GitHub
 * identity. Rejects outright — never falls back to `login` or anything else
 * shaped like a display name — when the response has no numeric `id`: SPEC
 * §7.26 requires `ConnectedAccount.providerAccountId` to come from that
 * field specifically, and `@loombox/protocol`'s own `connectedAccount`
 * schema re-enforces the same rule at the type boundary (issue #222's
 * acceptance: "fails loudly rather than silently").
 *
 * The bearer is sent only in this one request's `Authorization` header;
 * never logged, and never included in any error this throws.
 */
export async function resolveGithubIdentity(
  accessToken: string,
  options: ResolveGithubIdentityOptions = {},
): Promise<GithubIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;

  const response = await fetchImpl(`${apiBaseUrl}/user`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'loombox',
    },
  });
  if (!response.ok) {
    throw new GithubIdentityError(
      `github identity: GET /user responded with HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new GithubIdentityError(
      'github identity: GET /user response has no numeric "id" field — refusing to key a ConnectedAccount on anything else (never "login")',
    );
  }
  const login = body.login;
  if (typeof login !== 'string' || login.length === 0) {
    throw new GithubIdentityError('github identity: GET /user response has no "login" field');
  }

  return {
    id,
    login,
    name: typeof body.name === 'string' ? body.name : null,
    avatarUrl:
      typeof body.avatar_url === 'string' && body.avatar_url.length > 0
        ? body.avatar_url
        : undefined,
    scopes: parseScopesHeader(response),
  };
}
