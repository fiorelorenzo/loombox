import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * The provider-agnostic connected-account data model (SPEC §7.26, issue
 * #221) — a user can link multiple GitHub/Jira/etc. identities and pick,
 * per project and per capability, which one acts on its behalf (§7.10's
 * tracker sync, live write-back). This is a distinct, more-privileged
 * credential from loombox's own login (§8's OAuth-for-identity-only Better
 * Auth session) and from an agent's own remote-MCP OAuth session (§7.7) —
 * neither of those is a `ConnectedAccount`.
 *
 * **The security property this whole file exists to enforce structurally,
 * not just document: the synced row carries no secret.** `secretRef` names
 * a keyring entry (the same node-local OS-keyring class of secret as SSH
 * keys and MCP secrets — `packages/node/src/keyring.ts`'s
 * `NodeKeyring`/`FileKeyringBackend`/`OsKeyringBackend`, issue #118); the
 * actual token is resolved locally on whichever node holds it and never
 * appears in this type, in any wire message built around it, or in the
 * relay's storage. There is deliberately no field here shaped like a token
 * for a future edit to accidentally populate.
 *
 * **Why this row is relay-readable plaintext, not wrapped in an
 * `encryptedEnvelope` the way `sessions.ts`'s `title`/`projectPath` are.**
 * SPEC §8's "blind router" rule is scoped to session/resource CONTENT — the
 * spec's own bridge bullet already carves out an identical, deliberate
 * exception for "account-scoped metadata" (session existence/provider/
 * timestamps, the device registry's label, and the Better Auth `user` row
 * itself, all plaintext in the relay's Postgres) precisely so a picker can
 * render from any device without that device first unlocking the AMK. A
 * `ConnectedAccount` is the same shape of fact: `label`/`avatarUrl`/`host`/
 * `scopes`/`capabilities` are metadata about a link, not conversation
 * content, and §7.26's own code block has no paired private envelope for
 * this type (unlike `SessionWithPrivateEnvelope`). `store.ts`'s existing
 * `DeviceTokenRecord.label` is the same kind of plaintext, account-scoped,
 * no-secret field already living in this relay's Postgres today. If a
 * future edit wants stronger confidentiality for `label`/`avatarUrl`
 * specifically, that is a real, well-defined change (split this type the way
 * `sessions.ts` splits `SessionMetaPublic`/`SessionPrivateMetaV1`) — not
 * something to fall into silently.
 */

/** How the credential behind a `ConnectedAccount` was obtained (SPEC §7.26). GitHub-style: `device_flow` (#222), `cli_import` (#223), `oauth_broker`. Jira-style: `oauth_3lo` (#226), `api_token` (#225). Either provider: `fine_grained_pat` (#224), a manual fallback. */
export const connectedAccountCredentialSource = z.enum([
  'device_flow',
  'cli_import',
  'oauth_broker',
  'oauth_3lo',
  'api_token',
  'fine_grained_pat',
]);
export type ConnectedAccountCredentialSource = z.infer<typeof connectedAccountCredentialSource>;

/**
 * A conservative, generically-detectable email shape — deliberately not a
 * full RFC 5322 validator. Good enough to structurally reject the one login
 * surrogate that is unambiguous regardless of provider: an address always
 * contains an `@` followed by a dotted domain. See `connectedAccount`'s
 * `providerAccountId` refinement for why the OTHER half of "never a login"
 * is enforced procedurally instead (identity resolution, not string shape).
 */
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The three parts a `ConnectedAccount.id` composes from (SPEC §7.26). */
export interface ConnectedAccountIdParts {
  provider: string;
  host: string;
  providerAccountId: string;
}

/**
 * Composes the derived `${provider}:${host-or-site}:${providerAccountId}`
 * id (SPEC §7.26) — the `id` field is never free-form; it is always built
 * from these three. Never call with a `:`-bearing `provider` or
 * `providerAccountId`: `connectedAccount`'s own validation rejects both, so
 * that {@link parseConnectedAccountId}'s split stays unambiguous even when
 * `host` itself contains a colon (a self-hosted GitHub Enterprise Server or
 * Jira Data Center instance on a non-default port, e.g.
 * `github.mycorp.com:8443`).
 */
export function composeConnectedAccountId(parts: ConnectedAccountIdParts): string {
  return `${parts.provider}:${parts.host}:${parts.providerAccountId}`;
}

/**
 * Splits a composed `ConnectedAccount.id` back into its three parts, or
 * `undefined` if it isn't shaped like one. `host` is the one part allowed to
 * contain colons (see {@link composeConnectedAccountId}'s doc comment), so
 * this takes the FIRST colon as the `provider` boundary and the LAST as the
 * `providerAccountId` boundary, assigning everything in between to `host`.
 * That only round-trips because `provider`/`providerAccountId` are validated
 * (by `connectedAccount` below) to never contain a colon themselves — if
 * either did, a `host` containing a colon would make the split ambiguous.
 */
export function parseConnectedAccountId(id: string): ConnectedAccountIdParts | undefined {
  const first = id.indexOf(':');
  const last = id.lastIndexOf(':');
  if (first === -1 || last === -1 || first === last) return undefined;
  const provider = id.slice(0, first);
  const host = id.slice(first + 1, last);
  const providerAccountId = id.slice(last + 1);
  if (provider.length === 0 || host.length === 0 || providerAccountId.length === 0) {
    return undefined;
  }
  return { provider, host, providerAccountId };
}

/**
 * Names the OS-keyring entry a `ConnectedAccount`'s actual token lives
 * under (SPEC §7.26's own example: `` `connected-account-token:${id}` ``).
 * Centralized here so every connect-flow implementation (#222-#226) derives
 * the identical `secretRef` for the same account rather than each
 * inventing its own naming, and so it stays trivially re-derivable from
 * `id` alone rather than needing to be persisted separately anywhere
 * secret. This is a keyring lookup key, never the secret itself.
 */
export function connectedAccountSecretRef(id: string): string {
  return `connected-account-token:${id}`;
}

const connectedAccountObject = z.object({
  /** Derived, never free-form — see {@link composeConnectedAccountId}. */
  id: z.string().min(1),
  /** Extensible on purpose (SPEC §7.26: `'github' | 'jira' | string`) — future providers add a value here, not a new type. Never contains `:`: it is the `id`'s first-colon boundary. */
  provider: z
    .string()
    .min(1)
    .refine((value) => !value.includes(':'), {
      message: "provider must not contain ':' — it is the composed id's first separator",
    }),
  /** `github.com`, `github.mycorp.com`, `myteam.atlassian.net` — a GHES/Data Center host MAY include a `:port`; that is the one part of the composed id allowed to contain a colon. */
  host: z.string().min(1),
  /**
   * GitHub numeric user id, or Atlassian `accountId` — never a login or an
   * email (SPEC §7.26: both are mutable/SSO-reassignable). Never contains
   * `:`: it is the `id`'s last-colon boundary.
   *
   * Two enforcement layers, deliberately different in strength:
   * - **Structural, for every provider:** rejects anything shaped like an
   *   email address ({@link EMAIL_SHAPE_RE}) — the one login surrogate that
   *   is unambiguous regardless of provider.
   * - **Structural, GitHub-specific:** GitHub's own identity call (`GET
   *   /user`, keyed on the numeric `id` field per §7.26's connect-flow
   *   bullet) never returns anything but digits, so a non-numeric value is
   *   rejected below in `connectedAccount`'s object-level refinement.
   * A general "never a login" check beyond that is NOT enforced here on
   * string shape alone: a GitHub login and an Atlassian `accountId` are
   * both opaque strings with no reliable shape difference from a real id
   * (Jira Cloud's modern `accountId` format overlaps with what a
   * hand-typed string could look like), so false positives would be
   * unavoidable. The real guarantee is procedural instead: every connect
   * flow (#222-#226) is required to construct this field from a provider
   * identity call's stable id, never from free text a user typed, exactly
   * like the GitHub numeric-id check above enforces for GitHub already.
   */
  providerAccountId: z
    .string()
    .min(1)
    .refine((value) => !value.includes(':'), {
      message: "providerAccountId must not contain ':' — it is the composed id's last separator",
    })
    .refine((value) => !EMAIL_SHAPE_RE.test(value), {
      message:
        'providerAccountId must not look like an email address (SPEC §7.26: never login/email, both are mutable/SSO-reassignable)',
    }),
  /** Derived from an identity call, not free text (SPEC §7.26) — the connect flow that resolves `providerAccountId` sets this from the same response. */
  label: z.string().min(1),
  avatarUrl: z.string().min(1).optional(),
  credentialSource: connectedAccountCredentialSource,
  /** Introspectable for OAuth flows; `null` for Basic-auth tokens (Jira API-token connections have no scope introspection endpoint). */
  scopes: z.array(z.string()).nullable(),
  /** Gates UI features (comments/transitions/boards/sprints/...) — never gates which flows below can even be tried. */
  capabilities: z.array(z.string()),
  connectedAt: z.number(),
  updatedAt: z.number(),
  /** Names a keyring entry (see {@link connectedAccountSecretRef}) — NEVER the token itself. This is the field the whole module doc comment is about. */
  secretRef: z.string().min(1),
});

/**
 * `ConnectedAccount` (SPEC §7.26), field-for-field. Deliberately has no
 * `nodePresence` field: whether a given node holds this account's secret
 * locally is computed lazily, at the point of use (issue #228) — never
 * synced through the relay as a map that would need to be kept consistent
 * across every node. `connected-accounts.test.ts`'s "no nodePresence" test
 * asserts this structurally (a value carrying one is silently stripped by
 * parse, never round-tripped), not just by omission from the fields above.
 */
export const connectedAccount = connectedAccountObject
  .refine((value) => value.id === composeConnectedAccountId(value), {
    message:
      'id must equal the derived `${provider}:${host}:${providerAccountId}` composition (SPEC §7.26)',
    path: ['id'],
  })
  .refine((value) => value.provider !== 'github' || /^\d+$/.test(value.providerAccountId), {
    message:
      "a github providerAccountId must be the numeric id GitHub's `GET /user` returns, never a login",
    path: ['providerAccountId'],
  });
export type ConnectedAccount = z.infer<typeof connectedAccount>;

/** A node publishes (or re-publishes, e.g. after a label/avatar refresh on re-auth) one connected account's metadata to the relay (SPEC §7.26's "only the metadata row syncs"). Node-only: connect flows run on the node that holds the resulting secret, mirroring `target_announce`/`session_announce`. */
export const connectedAccountAnnounce = z.object({
  type: z.literal('connected_account_announce'),
  protocolVersion: z.literal(PROTOCOL_V1),
  account: connectedAccount,
});
export type ConnectedAccountAnnounce = z.infer<typeof connectedAccountAnnounce>;

/** A client asks the relay for its account-scoped connected-account list — the request half of "a picker renders from any device" (SPEC §7.26). */
export const connectedAccountListRequest = z.object({
  type: z.literal('connected_account_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
});
export type ConnectedAccountListRequest = z.infer<typeof connectedAccountListRequest>;

/** The relay's reply: every `ConnectedAccount` synced under the caller's account, across every node — never another account's rows, and never a token (only `secretRef`, which is not a secret). */
export const connectedAccountList = z.object({
  type: z.literal('connected_account_list'),
  protocolVersion: z.literal(PROTOCOL_V1),
  accounts: z.array(connectedAccount),
});
export type ConnectedAccountList = z.infer<typeof connectedAccountList>;
