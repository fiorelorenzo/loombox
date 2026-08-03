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
 * --------------------------------------------------------------------- */

const GITHUB_USER_URL = 'https://api.github.com/user';

export interface GithubIdentity {
  /** The stable numeric id — the only field a `ConnectedAccount.providerAccountId` may ever be built from. */
  id: number;
  login: string;
  name: string | null;
  avatarUrl?: string;
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

  const response = await fetchImpl(GITHUB_USER_URL, {
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
  };
}
