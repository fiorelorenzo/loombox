/* ---------------------------------------------------------------------
 * Jira identity resolution (SPEC §7.26, issue #225): `GET
 * /rest/api/3/myself` over Basic auth (`base64(email:apiToken)`), keyed on
 * the response's stable `accountId` field — never `email`, which Atlassian
 * treats as mutable/SSO-reassignable, the same rule `github-identity.ts`
 * enforces for GitHub's numeric `id` over `login`. Scoped to the API-token
 * connect path only (`jira-connect.ts`'s `JiraConnectService`); OAuth
 * 3LO's own identity resolution (issue #226) is a separate call shape
 * (`GET /me` against `api.atlassian.com`, no site-scoped Basic auth) and
 * does not belong here.
 * --------------------------------------------------------------------- */

const MYSELF_PATH = '/rest/api/3/myself';

export interface JiraIdentity {
  /** The stable Atlassian `accountId` — the only field a `ConnectedAccount.providerAccountId` may ever be built from for a Jira connection. */
  readonly accountId: string;
  readonly displayName: string;
  readonly emailAddress?: string;
  readonly avatarUrl?: string;
}

/** Raised when Jira's `GET /rest/api/3/myself` response can't be trusted as an identity — an HTTP error, or a body carrying no usable `accountId`. Never includes `email`/`apiToken` in its message. */
export class JiraIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraIdentityError';
  }
}

export interface ResolveJiraIdentityOptions {
  /** Injectable for tests; defaults to the global `fetch`. Must never be pointed at a real Jira site from a test (this module's own tests: stub only). */
  fetchImpl?: typeof fetch;
}

/**
 * Calls `GET {baseUrl}/rest/api/3/myself` with Basic auth
 * (`base64(email:apiToken)`) and resolves the caller's Jira identity.
 * Rejects outright — never falls back to `emailAddress` or `displayName`
 * — when the response has no `accountId`: SPEC §7.26 requires
 * `ConnectedAccount.providerAccountId` to come from that field
 * specifically, and `@loombox/protocol`'s own `connectedAccount` schema
 * additionally rejects anything shaped like an email address at the type
 * boundary.
 *
 * `email`/`apiToken` are sent only in this one request's `Authorization`
 * header; neither is ever logged or included in any error this throws.
 */
export async function resolveJiraIdentity(
  baseUrl: string,
  email: string,
  apiToken: string,
  options: ResolveJiraIdentityOptions = {},
): Promise<JiraIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}${MYSELF_PATH}`;
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  const response = await fetchImpl(url, {
    headers: {
      authorization: authHeader,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new JiraIdentityError(
      `jira identity: GET /rest/api/3/myself responded with HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const accountId = body.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new JiraIdentityError(
      'jira identity: GET /rest/api/3/myself response has no "accountId" field — refusing to key a ConnectedAccount on anything else (never email)',
    );
  }
  const displayName = body.displayName;
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new JiraIdentityError(
      'jira identity: GET /rest/api/3/myself response has no "displayName" field',
    );
  }

  let avatarUrl: string | undefined;
  const avatarUrls = body.avatarUrls;
  if (avatarUrls !== null && typeof avatarUrls === 'object') {
    const candidate = (avatarUrls as Record<string, unknown>)['48x48'];
    if (typeof candidate === 'string' && candidate.length > 0) avatarUrl = candidate;
  }

  return {
    accountId,
    displayName,
    emailAddress: typeof body.emailAddress === 'string' ? body.emailAddress : undefined,
    avatarUrl,
  };
}
