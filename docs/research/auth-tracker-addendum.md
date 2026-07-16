# loombox spec addendum — account login, E2E reconciliation, connected accounts, tracker model

Source: four research findings (auth-login, e2e-login, multi-account, tracker-model),
each grounded against the cloned reference source (ACP, emdash, happy, hapi,
nimbalyst) and authoritative provider docs. This file is a set of ready-to-paste
patches against `/home/dev/Progetti/brainstorm/ideas/loombox/spec.md`. Each item
below states exactly which section it REVISES or which section it FOLLOWS (i.e.
where to insert it as new). Apply in order; later items reference identifiers
introduced by earlier ones (`ConnectedAccount`, `TrackerBackend`, `AMK`).

Note on fences below: blocks that themselves contain a nested ```ts snippet are
wrapped in **four**-backtick fences so the inner ```ts fence doesn't close the
outer one early when pasted through a plain markdown renderer.

---

## Item 1 — REVISES §8 (Security & trust model)

**Placement:** Replace the section's opening two bullets — "**Per-device
end-to-end encryption.**" and "**Device lifecycle (pairing, revocation,
recovery).**" — with the four bullets below (account identity, E2E encryption,
device lifecycle, the plaintext boundary). Everything else in §8 (SSH
credentials, self-owned push, guardrails, secrets-at-rest, provider
credentials, telemetry, abuse limits, public relay, transport-only fallback)
is unchanged and follows after. (A server-managed key-custody opt-out was
drafted for this slot and deliberately cut — see the new §14 bullet "Deferred:
server-managed key-custody opt-out" for why and for the design if it's ever
revisited.)

**Why:** today §8 conflates "prove who you are" with "hold the decryption key."
Research (`auth-login`, `e2e-login`) takes its cue from Nimbalyst's documented
JWT-scope model (`nimbalyst/docs/SYNC_JWT_MODEL.md:57-69`), but that precedent
is looser than it first looks: Nimbalyst's two axes are *which org you
authenticate as* (personal vs. team) and, *for team orgs only*, key custody
(`legacy-e2e` vs. `server-managed`) — Nimbalyst's personal lane is
unconditionally zero-knowledge and never faces this tension at all, so there is
no exact precedent there for loombox's actual problem (one person, several
devices, wants login without weakening E2E). What Nimbalyst does contribute is
the *shape* of an honest disclosure pattern (a status chip plus a required
acknowledgement before weakening a guarantee — see H2's migration UX), which
the rewrite below borrows as an adaptation, not as a problem already solved.
Adding OAuth login without an explicit key-custody redesign would either (a) do
nothing for the "see my sessions without a QR" complaint, or (b) accidentally
imply the relay can decrypt content, which contradicts the existing "relay only
ever sees ciphertext" claim. The rewrite below adds OAuth identity, keeps QR
pairing as one of two device-bootstrap paths, and states the one narrow,
deliberate exception to the ciphertext-only claim explicitly instead of leaving
it implicit.

```markdown
- **Account identity (OAuth login), separate from device key custody.** loombox
  runs **Better Auth** (MIT, self-hosted, embeddable TS library) mounted
  in-process on the relay's existing Fastify server at `/api/auth/*`, sharing
  the relay's own Postgres (adds `user`/`session`/`account`/`verification`
  tables alongside the relay's existing blob/metadata tables — no separate auth
  service to operate). Login is via **Google or GitHub OAuth**
  (`socialProviders.google`/`socialProviders.github`, Better Auth's
  `/api/auth/callback/:provider` convention). A browser session is an HttpOnly
  cookie by default; a non-cookie client (the relay's own WebSocket handshake,
  a future Capacitor mobile shell) authenticates via Better Auth's **Bearer
  plugin** — deliberately not the JWT plugin: Better Auth's own docs describe
  JWT as meant for handing a verifiable token to a separate/third-party
  service, not as a session-auth replacement, and say to use Bearer if you
  want header-based auth for your own services. Bearer converts an
  `Authorization: Bearer` header straight into an internal session
  (`plugins/bearer/index.ts`), which is exactly the shape the relay's WS
  handshake needs — riding in `handshake.auth` alongside, not instead of, the
  existing device-keypair signature. The `multiSession` plugin (multiple
  *different* loombox accounts in one browser) is deliberately not enabled in
  v1: §3 scopes loombox to a single self-hosting operator, so it adds an
  account-switcher UI with no v1 payoff.
  This is a **narrower login** than a self-hoster might expect: it registers
  loombox's own OAuth App/Client with Google/GitHub for identity only
  (`read:user user:email`-class scopes) — it is not the same credential as a
  *connected* GitHub/Jira account used for repo/tracker access (§7.26), which
  is a deliberately separate, more-privileged token, registered and stored
  independently.
  Per the Nimbalyst-derived rule above: **this OAuth session proves identity
  only. It must never by itself unlock content** — see the AMK model below.
- **Per-device end-to-end encryption, with an Account Master Key (AMK) for the
  solo-operator case.** Every node and client still has its own identity
  keypair (ECDH P-256); envelopes still bind ciphertext to its resource id (AAD)
  to prevent a swap/spoof hole; the relay still only ever sees ciphertext, in
  flight and at rest, **for session/resource content** — see the bridge bullet
  below for the one narrow, deliberate exception (account-scoped session
  metadata), so this bullet's "ciphertext only" claim should be read as scoped
  to content, not as covering everything the relay stores. What changes here is
  *how a device gets the key material it needs*. loombox's v1 shape is one
  human operating many devices (the same shape as Nimbalyst's *personal* lane,
  not its multi-human *team* lane), so instead of randomly generating a session
  key and ECDH-wrapping it per device (the team-lane shape, which
  re-introduces a "some other device must be online to hand you a wrapped
  copy" dependency), each account holds one 256-bit **Account Master Key
  (AMK)**, generated on first device setup, and every session/resource key is
  **derived from the AMK via an HMAC-SHA512 BIP32-style key tree** — Happy's
  actual construction (`deriveSecretKeyTreeRoot`/`deriveSecretKeyTreeChild`,
  `happy/packages/happy-app/sources/encryption/deriveKey.ts:8-30`, which derive
  each child as `hmac_sha512(chainCode, data)`; this is **not** RFC 5869 HKDF,
  it's Happy's own bespoke tree — adapted here from a login-secret to a
  key-custody-only secret). A device that holds the AMK can derive every past
  and future session key by itself, without any other device re-wrapping
  anything for it — this is the structural fix for "join without a live peer
  to scan from." Per-device ECDH wrap-fan-out is kept, but scoped to exactly
  one case: **revocation** (see below).
- **Device lifecycle — two AMK-bootstrap paths, QR kept as a fast path, not
  the only path.** (A third, code-free path via WebAuthn PRF was drafted and
  cut from this version — see the new §14 bullet "Deferred: WebAuthn PRF
  convenience unlock.")
  1. **QR/short-code pairing (fast path, unchanged mechanism).** When two
     devices are physically together, an already-trusted device still displays
     a QR/short-code that hands the new device a wrapped copy of the AMK
     directly — strictly better UX than typing a code, so it stays the
     recommended path whenever it's available (`happy/packages/happy-app/
     sources/hooks/useConnectAccount.ts:22-50` is the reference shape,
     reimplemented clean-room).
  2. **Recovery-code escrow (the new default for "no device to scan from").**
     At first-device setup, the client wraps the AMK (AES-256-GCM) under a key
     derived from a machine-generated, high-entropy **Recovery Code**,
     formatted for legibility exactly like a 1Password secret key (base32,
     dash-grouped — `happy/packages/happy-app/sources/auth/
     secretKeyBackup.ts:81-102`, `formatSecretKeyForBackup`), shown once with a
     mandatory "I saved this" confirmation. The wrapped-AMK blob is uploaded to
     the relay under the OAuth-authenticated account; per the ciphertext-only
     rule the relay only ever stores ciphertext of the AMK, never the AMK or
     the code itself. **New-device bootstrap:** OAuth login (proves identity,
     no QR, no other device involved) → client fetches its account's
     wrapped-AMK blob over that session → user enters the Recovery Code once →
     unwrap locally → device holds the AMK → generates its own device ECDH
     P-256 keypair and registers into the device registry below. No
     previously-trusted device needs to be online. Recovery-code loss is
     unrecoverable by design (the same tradeoff Happy's and Signal's
     zero-knowledge tiers both accept) and must be stated to the user as
     plainly as Happy's own restore-key UX implies.
  Both paths converge on the same **device registry** (id, public key,
  status, last-seen, now also `owner_account_id` — see below).
  **Revoking** a device removes it from the registry and rotates: the acting
  (already-unlocked, online) device mints a **new AMK epoch** from fresh random
  entropy (not derivable from the old AMK, so the revoked device cannot
  recompute it) and ECDH-wraps that new epoch for each other currently
  registered device's already-known public key, depositing the wrapped
  envelopes on the relay for those devices to fetch on next connect — this is
  the one legitimate use of per-device wrap-fan-out (mirrors Nimbalyst's
  `fetchAndUnwrapOrgKey`/key-envelope pattern,
  `nimbalyst/packages/electron/src/main/services/OrgKeyService.ts:776-789`).
  **Recovery:** a lost device re-bootstraps via path 2 above (not only
  "re-paired from another trusted device," since that device may not exist);
  if the relay is rebuilt, nodes/clients re-enroll from their existing
  keypairs plus a fresh AMK-escrow round trip. There is still no server-held
  plaintext of the AMK or content, by design.
- **The bridge, and the one narrow exception to "ciphertext only."** The
  device registry gains an `owner_account_id` column, populated once at
  pairing/bootstrap time from the logged-in Better Auth `user.id`. A
  `GET /api/devices` (or `/api/sessions`) call, authorized by the Better Auth
  cookie session or Bearer token, filters `WHERE owner_account_id =
  session.user.id` — this is
  what actually removes the "scan a QR every time" friction for the common
  case (glancing at what's running from a browser you've already logged into):
  **session existence/metadata** (names, project, provider, status,
  last-active) becomes account-scoped and visible on OAuth login alone,
  because it is gated by "prove you're the account owner," not "are you a
  paired device." This is a **deliberate, bounded exception**: session
  metadata, plus the Better Auth `user` table itself (email, display name,
  avatar), sits in the relay's Postgres in plaintext — narrower than a
  content-layer exception, but §8 should say so explicitly rather than leave
  it implicit. **Decrypting or steering a specific session's actual content on
  a device that has never held that session's key material still requires one
  of the two AMK-bootstrap paths above, exactly once for that device** —
  this is inherent to real E2E and is not promised away; what changes is
  frequency (a device that bootstraps once is not asked to redo it on every
  reopen), not the existence of the step.
```

---

## Item 1a — REVISES §5.3, the §5 architecture-diagram caption, and §9 (consistency patches following from Item 1)

**Placement:** Three small, one-line patches so §5.3/§5/§9 stay consistent
with Item 1's new "bounded plaintext-metadata exception" rather than
continuing to read as an absolute, unqualified claim.

**Why:** Item 1's bridge bullet discloses that account-scoped session metadata
and the Better Auth `user` table sit in the relay's Postgres in plaintext.
§5.3 ("Only ever handles ciphertext and stores only encrypted blobs... A
compromised relay host cannot read session content") and the §5 diagram
caption ("sees only ciphertext; stores encrypted blobs") aren't made false by
this — both already say "session content" rather than "everything" — but a
reader who only skims §5 would come away thinking the claim is unconditional.
§9's backup/DR policy also predates the new Better Auth tables and the
wrapped-AMK escrow blob and should say explicitly that they're covered.

```markdown
Append to the end of §5.3's ciphertext-only bullet: "(see §8's account-login
bridge bullet for the one narrow, deliberate exception once account login
lands: account-scoped session metadata and the Better Auth `user` table sit in
Postgres in plaintext — session/resource *content* remains ciphertext-only.)"

Append to the §5 architecture diagram's "sees only ciphertext; stores
encrypted blobs" caption: "(except account-scoped session metadata, once
account login lands — see §8)."

Append one sentence to §9's backup/DR paragraph: "The nightly encrypted dump
also covers the Better Auth tables (`user`/`session`/`account`/`verification`)
and the wrapped-AMK escrow blobs introduced in §8 — losing them without backup
would strand every registered user's recovery-code bootstrap path (their only
escrowed-AMK copy would be gone), so they are not optional any more than the
device registry is."
```

---

## Item 2 — NEW §7.26 "Connected accounts & integrations"

**Placement:** Insert as a new subsection **after §7.25** (the last existing
`§7.x`), i.e. renumber nothing — add it as `### 7.26 Connected accounts &
integrations`. Cross-reference it from §7.7 ("Agent configuration: MCP servers
& plugins") and from the revised §7.10 (Item 3 below), since both consume the
`ConnectedAccount` concept this section defines.

**Why:** research (`multi-account`) shows this is a distinct concern from
login (Item 1) — it's an integration-token registry, not an identity check —
and that emdash already ships almost the exact shape needed for GitHub, while
Jira has zero multi-account precedent anywhere in the four reference tools and
needs the same treatment applied fresh.

````markdown
### 7.26 Connected accounts & integrations

Login (§8) answers "which human is using loombox." This is the separate
question of "which external GitHub/Jira/etc. identities has this human linked,
and which one does a given project use." A user can connect **multiple
accounts of the same kind** — several personal and org GitHub accounts,
several Jira sites — and pick, per project and per capability, which
connected account acts on its behalf.

- **Data model — `ConnectedAccount`,** generalized from emdash's shipped
  `GitHubAccountRegistry`
  (`emdash/apps/emdash-desktop/src/main/core/github/accounts/
  github-account-registry.ts:57-190`) into a provider-agnostic shape:

  ```ts
  type ConnectedAccount = {
    id: string;                 // `${provider}:${host-or-site}:${providerAccountId}`
    provider: 'github' | 'jira' | string;  // extensible
    host: string;                // github.com | github.mycorp.com | myteam.atlassian.net
    providerAccountId: string;   // GitHub numeric user id, or Atlassian accountId —
                                 // never login/email (both are mutable/SSO-reassignable)
    label: string;               // derived from an identity call, not free text
    avatarUrl?: string;
    credentialSource:
      | 'device_flow' | 'cli_import' | 'oauth_broker'   // GitHub-style
      | 'oauth_3lo' | 'api_token'                        // Jira-style
      | 'fine_grained_pat';                               // manual fallback, either provider
    scopes: string[] | null;     // introspectable for OAuth flows; null for Basic-auth tokens
    capabilities: string[];      // gates UI features (comments/transitions/boards/sprints/...)
    connectedAt: number;
    updatedAt: number;
    secretRef: string;           // e.g. `connected-account-token:${id}` — never the token itself
  };
  ```
  (No synced `nodePresence` map — see "Node-locality" below for why that's
  computed lazily instead of kept as a field on this type.)

  Only the metadata row (no secret) syncs through the relay so a picker
  renders from any device; the token itself is resolved through the
  executing node's own OS keyring (`@napi-rs/keyring`, §8's "Secrets at rest
  on the node"), the same rule as SSH keys and provider tokens — connected
  accounts are the same class of secret and follow the same rule, never the
  relay's blob store.
- **GitHub — connect flow (default: OAuth App Device Authorization Grant).**
  Ship the RFC 8628 device flow as the default connect path (public OAuth App
  client, no client secret needed — safe to ship in an open-source binary),
  the same mechanism emdash already ships
  (`emdash/apps/emdash-desktop/src/main/core/github/services/
  github-device-flow-service.ts:1-114`), requesting `repo`, `read:user`,
  `read:org`, and (new, for Projects v2 support in §7.10) `read:project`.
  Two more paths onto the same registry: **`gh` CLI import**
  (`github-cli-account-import.ts:56-92`, one shot imports every host+account
  the local `gh` CLI already holds, including GitHub Enterprise Server hosts)
  and a **manual fine-grained PAT paste**, needed specifically for orgs that
  enable OAuth App access restrictions (real, enabled-by-default per GitHub's
  own docs) which can block the device flow outright. Identity resolution for
  all three paths is `GET /user`, keyed on the returned numeric `id`
  (`github-identity-client.ts:28-56`) — never `login`. A GitHub App
  (installation-scoped, finer-grained, better rate limits) is a v2+ upgrade
  path for org-scale least privilege, not the v1 mechanism.
- **Jira — connect flow (two paths, both multi-account, unlike emdash's
  current singleton).** emdash's Jira integration today stores exactly one
  `{siteUrl, email}` row (`emdash/apps/emdash-desktop/src/main/core/jira/
  jira-connection-service.ts:8,21,39-56`) — connecting a second site
  overwrites the first, and it keys on the mutable `email` even though the
  identity call it already makes (`GET /rest/api/3/myself`) returns a stable
  `accountId`. loombox's registry fixes both: key on `(siteUrl, accountId)`,
  and support two connect paths: (a) **API token** (Basic auth,
  `base64(email:token)`, Atlassian's account-scoped token model — the
  zero-infrastructure default, generalized to multiple registry rows), and
  (b) **Jira OAuth 2.0 (3LO)** (`developer.atlassian.com/cloud/jira/platform/
  oauth-2-3lo-apps/`) as the upgrade path, specifically because one consent
  can register **several sites in a single grant**: after the redirect-code
  exchange, call `GET https://api.atlassian.com/oauth/token/
  accessible-resources` to enumerate every `{cloudId, url, name}` the grant
  covers. 3LO requires loombox to register and hold its own Atlassian OAuth
  app — a real, ongoing maintenance cost, called out explicitly rather than
  assumed free.
- **Per-project binding, one pinned account per capability.** Generalizes
  emdash's `ProjectSettings.githubAccountId` tri-state field and its resolver
  (`project-github-auth-context-resolver.ts:51-102`: absent key =
  unconfigured/never asked, explicit `null` = disabled/opted-out, a string =
  the pinned `ConnectedAccount.id`) into a per-capability map:
  `{ github?: string | null; jira?: string | null; [capability: string]:
  string | null | undefined }`. Resolution hard-fails on a host/site mismatch
  (mirroring `github-api-auth-service.ts:40-67`'s
  `githubApiAccountHostMismatch` guard) rather than silently falling back —
  falling back to a different human's credentials for a write action is a
  correctness/security bug. **Any write-back action** (comment, transition,
  status change — the features §7.10's live mode adds) requires an
  **explicit pin**, never a silent default-account fallback; a silent default
  is acceptable only for read-only actions. Before letting a user disconnect
  an account still pinned somewhere, scan all project settings and warn
  (generalizes `count-projects-using-github-account.ts:17-33`).
- **Node-locality — a real gap this area introduces, kept lazy rather than a
  new synced subsystem.** Unlike emdash (one desktop process), loombox runs
  execution nodes on multiple machines (§5.1-5.2). Connecting a GitHub/Jira
  account on one node does not make its secret usable by a session running on
  another node — each executing node needs its own local copy (its own
  device-flow run / CLI import / pasted token), exactly like SSH keys today.
  Rather than syncing a per-node presence map through the relay for this
  (over-engineering for the realistic solo-operator topology of §9 — one or
  two nodes, devbox + Mac), the check is computed **lazily, at the point of
  use**: when the project picker or a write action targets a given node, it
  asks that node (already reachable for §7.21's node/target health check)
  whether it holds a local secret for the project's pinned `connectionId`, and
  warns before a session on an uncredentialled node silently fails a tracker
  write. Same user-visible warning, no synced subsystem to keep consistent.
- **Boundary with login (§8) and with agent MCP sessions (§7.7).** "Logging
  into loombox" (Google/GitHub via Better Auth, §8) and "connecting a
  GitHub/Jira account here" are different tokens, different stores, different
  flows, mirroring emdash's own `signIn(provider)` vs
  `linkProviderAccount(provider)` split
  (`emdash-account-service.ts:95-171`) — logging out of loombox itself must
  not disconnect any `ConnectedAccount`, and disconnecting one GitHub account
  must not touch the loombox session. Separately, a **connected account** (used
  by loombox's own native tracker / live tracker features, §7.10) and an
  **agent's own remote-MCP OAuth session** (e.g. Atlassian's hosted MCP
  server, already in loombox's MCP catalog per §7.7) are kept as
  deliberately separate credentials — an agent might reasonably get
  read-only MCP access while loombox's own write-back uses a separate, more
  privileged account. A connected account may be *offered* as a one-click
  prefill source for an MCP server's credential fields, per §7.7's "explicit
  per-server grant" rule, but is never wired in automatically.
````

---

## Item 3 — REVISES §7.10 (Tracker integration) and §7.14 (PR & CI lifecycle)

**Placement:** Replace the entire current §7.10 body (heading, all bullets)
with the block below. §7.14 gets one added paragraph at the end (its existing
bullets are otherwise unchanged) — placement is noted inline.

**Why:** research (`tracker-model`) grounds dropping two-way sync entirely:
there is no local mirror to keep consistent, so the §14 "conflict handling"
question this created becomes moot rather than solved. The native/live split
also resolves the multi-account crossing point from Item 2 (`connectionId`)
and gives exact, verified API surfaces for Jira (two separate REST bases plus
OAuth 3LO cloud routing) and GitHub (REST + GraphQL Projects v2 with the
field-option-id lookup the old spec only gestured at).

````markdown
### 7.10 Tracker integration — native local, or live external, per project

Every project chooses, once, how it tracks work — there is **no background
sync and no local mirror of an external tracker**:

```ts
type TrackerMode =
  | { kind: 'native' }
  | { kind: 'live'; provider: 'github' | 'jira'; connectionId: string; target: GitHubTarget | JiraTarget };

type GitHubTarget = { owner: string; repo: string; projectNumber?: number }; // optional Projects v2 board
type JiraTarget   = { cloudId: string; projectKey: string };
```

`connectionId` names a `ConnectedAccount` from §7.26 — this section never
performs an OAuth flow or stores a token itself; it consumes a resolved
credential (`{token}` for GitHub, `{token, cloudId}` for Jira, via
`resolveCredential(connectionId)`) from that area. That is a hard interface
boundary.

- **Native mode — loombox's own local ticketing.** Data model copies
  Nimbalyst's post-refactor, schema-driven shape
  (`nimbalyst/packages/runtime/src/core/TrackerRecord.ts:36-70`) rather than
  its older flat `tracker_items` row
  (`nimbalyst/docs/nimbalyst-schema.prisma:71-82`): a `fields` bag (all
  business data, no privileged field names), a `system` object (author,
  linked commits/PRs/sessions, activity, comments), and a handful of real,
  indexed SQL columns (`id`, `primary_type`, `type_tags`, `issue_number`,
  `archived`, timestamps) around one JSONB blob — the split that lets a
  kanban board, priority sort, or assignee filter work identically whether
  the type is a built-in Task/Bug/Epic or a project-defined custom type with
  its own `roles` mapping (`title`/`workflowStatus`/`priority`/`assignee`/...,
  per `nimbalyst/UserDocs/creating-custom-trackers.md`). Agents access native
  projects through `tracker_list`/`tracker_get`/`tracker_create`/
  `tracker_update`/`tracker_link_session` MCP tools, reusing that contract
  shape (`nimbalyst/design/trackers/unified-tracker-system.md:259-336`). No
  `syncStatus`/team-sync columns are needed — loombox's native tracker is
  per-operator, not multi-user collaborative.
- **Live mode — work directly against the external tracker, full feature
  set, no import step.** Every read and write is a synchronous API call
  against GitHub or Jira; the external system stays sole source of truth.
  loombox may hold a short-lived, request-scoped in-memory cache (de-dupe two
  widgets rendering the same issue in one render pass) but **never persists
  an authoritative local snapshot** — there is nothing analogous to
  Nimbalyst's import/`TrackerSnapshot` step for a live-mode project. If a
  node/target or the external API is unreachable or rate-limited, the
  tracker view shows an explicit **connectivity-error state**, and any agent
  tool call needing tracker data fails with a retryable error surfaced in the
  attention inbox (§7.13) — it does not fall back to a queued local write,
  because no local write log exists to replay. This is a deliberate scope
  cut versus the old two-way-sync ambition: correctness and simplicity over
  offline tracker writes.
  - **Jira**, full feature set: two separate REST bases —
    `/rest/api/3/...` (issues, comments, transitions) and
    `/rest/agile/1.0/...` (boards, sprints, epics) — both confirmed from the
    live OpenAPI specs
    (`developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`,
    `developer.atlassian.com/cloud/jira/software/swagger.v3.json`). Use
    `POST /rest/api/3/search/jql` (the modern replacement for the deprecated
    `GET /rest/api/3/search` — emdash's own history shows this migration was
    already needed and fixed there, `jira-issue-provider.ts:248`); discover
    transitions via `GET .../issue/{key}/transitions` before posting one;
    comments and transition `fields.resolution`/`update.comment` bodies are
    **Atlassian Document Format (ADF)**, not markdown — write a minimal
    `{type:'doc', version:1, content:[...]}` doc (the inverse of emdash's
    read-side `flattenAdf()`, `jira-issue-provider.ts:326-345`). Sprints:
    `GET /rest/agile/1.0/board/{id}/sprint` to list, `POST
    /rest/agile/1.0/sprint/{sprintId}/issue {issues:[...]}` to move issues
    into a sprint, `POST`/`PUT /rest/agile/1.0/sprint[/{id}]` to
    create/start/close one. For **OAuth 3LO** connections (§7.26), every
    call — both REST bases — is routed through
    `https://api.atlassian.com/ex/jira/{cloudId}/rest/...`, not the site's
    own hostname, using the `cloudId` discovered via
    `accessible-resources`; for API-token connections, calls go straight to
    the site.
  - **GitHub**, full feature set: REST for issues/comments/labels/
    milestones/assignees (`docs.github.com/en/rest/issues/*`), GraphQL for
    **Projects v2** (the sprint/board analog), confirmed against the public
    schema (`docs.github.com/public/fpt/schema.docs.graphql`):
    `Mutation.addProjectV2ItemById` (line 26747, input
    `{contentId, projectId}`, line 824) links an issue/PR onto a board;
    `Mutation.updateProjectV2ItemFieldValue` (input at line 69107,
    `{projectId, itemId, fieldId, value}`) moves a card between columns
    (set a single-select field to a `singleSelectOptionId`) or into an
    iteration (set an iteration field to an `iterationId`). **A required
    extra round trip**: there is no "set by name" mutation, so a
    `singleSelectOptionId`/`iterationId` must first be resolved from that
    field's `options`/`iterations` (`ProjectV2SingleSelectField`, line 41809,
    `.options` around line 41838; `ProjectV2IterationField`, line 41514) —
    budget for this lookup and for
    GitHub's GraphQL rate limits (5,000 pts/hr primary, 2,000 pts/min
    secondary) in any batched board update. GitHub has no built-in
    "transition" concept; a transition is `PATCH .../issues/{n}
    {state, state_reason}`, so `transitions` on the GitHub backend degrades
    to a fixed two-state set rather than a discovered per-project workflow
    like Jira's.
- **Pluggable `TrackerBackend` interface**, the extension point for both
  built-in backends and future ones, reframing Nimbalyst's read-only,
  one-shot `trackerImporter` SDK shape
  (`nimbalyst/packages/extension-sdk/src/types/trackerImporter.ts:1-149`)
  into full CRUD plus comments/transitions/boards/sprints, with capability
  flags so the UI knows what a given backend actually supports:

  ```ts
  interface TrackerBackendCapabilities {
    comments: boolean; transitions: boolean; boards: boolean; sprints: boolean;
    labels: boolean; milestones: boolean; customFields: boolean;
  }
  interface TrackerBackend {
    readonly id: 'github' | 'jira';
    readonly capabilities: TrackerBackendCapabilities;
    listBindings(connectionId: string): Promise<TrackerBinding[]>;
    list(binding: TrackerBinding, filter: TrackerListFilter): Promise<TrackerListPage>;
    get(binding: TrackerBinding, externalId: string): Promise<TrackerItemLive>;
    create(binding: TrackerBinding, fields: Record<string, unknown>): Promise<TrackerItemLive>;
    update(binding: TrackerBinding, externalId: string, fields: Record<string, unknown>): Promise<TrackerItemLive>;
    addComment?(binding: TrackerBinding, externalId: string, body: string): Promise<void>;
    listTransitions?(binding: TrackerBinding, externalId: string): Promise<TrackerTransition[]>;
    transition?(binding: TrackerBinding, externalId: string, transitionId: string): Promise<void>;
    listBoards?(binding: TrackerBinding): Promise<TrackerBoard[]>;
    listSprints?(boardId: string): Promise<TrackerSprint[]>;
    moveToSprint?(sprintId: string, externalIds: string[]): Promise<void>;
  }
  ```

  A `TrackerBackend` runs server-side (in the node/supervisor), never in a
  client — it holds bearer tokens, mirroring Nimbalyst's own rationale for
  running importer RPCs in the backend module, not the renderer
  (`trackerImporter.ts:28-34`).
- **Delivery order within v2 — phased, not one undifferentiated block.** The
  API surface above is large (two Jira REST bases plus 3LO cloud routing;
  GitHub REST plus GraphQL Projects v2 with its mandatory field-option-id
  lookup) and it lands on top of v1's own hardest engineering item (per-device
  E2E, §14). Ship it in three slices rather than committing to full
  Jira-sprint/board and GitHub-Projects-v2 parity as one v2 deliverable:
  (1) issues + comments (both providers, no boards/sprints/Projects v2 yet) —
  the highest-value, lowest-surface slice; (2) transitions (Jira workflow
  discovery, GitHub's two-state PATCH); (3) boards/sprints (Jira agile REST)
  and GitHub Projects v2 last, since it carries the extra option/iteration-id
  lookup and its own rate-limit budgeting. Each slice is independently
  shippable behind the same `TrackerBackend` interface and capability flags.
- **What "done better" now means.** The differentiator is no longer "sync
  both ways" (superseding the earlier framing) — it's working **live, with
  full native feature parity** (Jira sprints/boards/comments/transitions;
  GitHub's analogous set including Projects v2), no import step, no stale
  local copy, *and* a project can opt out of an external tracker entirely via
  a first-class native one. Neither Nimbalyst (import-only, explicitly
  one-way, `unified-tracker-system.md:473`: "Linear import: One-way only...
  No sync-back") nor emdash (read-only `IssueProvider`, no comments/
  transitions/boards/sprints at all, `emdash/apps/emdash-desktop/src/shared/
  issue-providers.ts:25-34`) attempts either half of this.
````

**Append to §7.14 (PR & CI lifecycle), after its existing bullet list, as a new
paragraph** (no other change to §7.14):

```markdown
PR linkage works uniformly across both tracker modes from §7.10: for a
`native` project, a merged PR is recorded on the tracker item's own
`system.linkedPullRequests`/`linkedCommitSha` fields; for a `live` project,
the same event is written back through that provider's `TrackerBackend`
(a GitHub PR auto-links via its own issue-closing keywords; a Jira issue gets
an explicit comment/link via `addComment`/`update`). Either way, a red CI
check or a review request lands in the attention inbox (§7.13) the same way,
regardless of which tracker mode the project uses.
```

---

## Item 4 — REVISES §12 (Roadmap)

**Placement:** Two edits inside the existing v1 and v2 bullets (find-and-append
within each), no new milestones.

**Why:** login/AMK bootstrap is the fix for the QR-friction complaint and is
cheap enough to land in v1 alongside the E2E envelopes already scoped there —
though it does stack a new key-custody primitive on top of v1's own
already-hardest engineering item, which is called out below rather than left
implicit. Connected accounts and the native/live tracker split are naturally
v2 work since v2 is already where tracker integration lands, phased per Item
3's delivery-order note. The WebAuthn PRF convenience unlock and the
server-managed key-custody opt-out are **not** in either milestone — both were
drafted and cut (see §14).

```markdown
In the **v1 — core cockpit** bullet, after "...per-device E2E envelopes;"
insert: "account login (Google/GitHub OAuth via a self-hosted Better Auth
instance mounted on the relay), with account-scoped session-list metadata
(`GET /api/devices`/`/api/sessions` filtered by the logged-in account) and a
recovery-code-escrowed Account Master Key as the default new-device bootstrap
path (QR pairing kept as the fast path when two devices are physically
together) — this is the fix for "see my sessions without scanning a QR every
time," not a removal of device-level E2E bootstrap. Note: this stacks a new
key-custody primitive (AMK generation, key-tree derivation, recovery-code
escrow) directly on top of the per-device E2E envelope work §14 already flags
as v1's hardest area; that's an accepted, explicit risk tradeoff for v1
(both are needed for the cockpit to be useful at all), not an oversight — see
§14's updated risk note;"

In the **v2 — trackers, git, editor, polish** bullet, replace "Two-way GitHub
Issues/Projects + Jira integration;" with: "per-project choice of a native
local tracker or a live external one (GitHub Issues/Projects v2, or Jira incl.
sprints/boards/comments/transitions) with no local sync/mirror, via a
pluggable `TrackerBackend`, delivered in the three slices from §7.10 (issues +
comments, then transitions, then boards/sprints/Projects v2); and a
connected-accounts registry (§7.26) for linking multiple GitHub/Jira accounts
and pinning one per project/capability." (No WebAuthn PRF unlock and no
server-managed key-custody mode in v1 or v2 — both deferred, see §14.)
```

---

## Item 5 — REVISES §14 (Open questions & risks)

**Placement:** (a) rewrite the existing "Multi-device E2E key distribution"
bullet in place; (b) delete the existing "Two-way tracker sync conflict
handling" bullet (the design in Item 3 makes it moot, not resolved — note
that explicitly rather than silently dropping it); (c) add five new bullets:
two carried over from Item 5's original three (account-scoped metadata
storage, OAuth broker centralization, live-tracker rate limits), plus two new
residual-risk bullets and two "deferred design" bullets for the pieces Item 1
cut out of the active §8 design.

```markdown
- **Multi-device E2E key distribution** is narrower than previously stated:
  the four reference tools do contain partial precedent (Happy's
  recovery-code manual-restore path,
  `happy/packages/happy-app/sources/app/(app)/restore/manual.tsx:74-108`;
  Nimbalyst's dual `legacy-e2e`/`server-managed` key-custody mode,
  `nimbalyst/docs/SYNC_JWT_MODEL.md:57-77`, though that split only exists on
  Nimbalyst's team-org lane, not its personal one) — the actual gap none of
  them closes is **OAuth identity plus zero-knowledge key custody,
  reconciled**, which §8's Account Master Key (AMK) + HMAC-SHA512 key-tree
  derivation design now specifies. The remaining risk shifts from "is there a
  design" to "does the implementation of AMK bootstrap, key-tree derivation,
  and revocation-triggered re-wrap-fan-out actually hold up under a
  lost-device/rebuilt-relay drill" — still real engineering risk, now scoped.
  It is also, by construction, v1's single riskiest dependency stack: account
  login, AMK custody, and per-device E2E envelopes all land in the same
  milestone (§12) rather than being sequenced apart — accepted explicitly for
  v1 rather than discovered later, but worth re-checking if v1 slips.

- ~~Two-way tracker sync conflict handling~~ — **superseded, not resolved:**
  §7.10 drops two-way sync entirely (native-local or live-external-no-mirror
  per project), so there is no local copy to merge against and this question
  is moot rather than answered. Two narrower, real questions replace it (see
  below).

- **Account-scoped session-list metadata storage:** is it stored in the
  relay's Postgres in cleartext (v1-simple, recommended — §8 already accepts
  this as a bounded, explicit exception to "ciphertext only") or encrypted to
  a per-account shared key (stronger, adds real complexity for arguably
  little gain given the operator already trusts their own relay)? A decision
  to make explicitly, not fall into.

- **OAuth broker centralization vs. self-registered apps:** emdash's own
  login/link flows go through a centrally-run hosted broker it operates
  (`auth.emdash.sh`) — convenient, but in tension with loombox's
  self-hosted-and-you-own-it thesis (§3/§11). Decide explicitly whether each
  self-hoster registers their own Google/GitHub OAuth Apps and Jira 3LO app
  (more setup, fully self-contained) or loombox centralizes a broker the way
  emdash does (less setup, one more piece the project itself operates)
  — record the choice here rather than defaulting into one silently.

- **Live-tracker rate limits & backoff:** GitHub GraphQL's 2,000 pts/min
  secondary limit and Jira Cloud's own per-app/per-user limits bound how
  aggressively a live-mode project can be polled or batch-updated; since
  there is no local write queue to smooth over a 429 (§7.10's deliberate
  scope cut), the retry/backoff-with-jitter policy needs to be solid before
  live mode ships, not added after.

- **Residual risk: a compromised relay can serve a tampered PWA during the
  recovery-code ceremony.** §9's topology has no separate web host — the PWA
  client is very likely served *by* the self-hosted relay itself. A
  compromised or coerced relay operator/process could therefore serve
  malicious JS to a logged-in browser specifically during recovery-code entry
  and capture the code as it's typed, unwrapping the AMK client-side without
  ever touching the relay's stored ciphertext. This is the standard "the
  server can always serve you different code" caveat that applies to every
  browser-based E2E system (Signal Web, WhatsApp Web) and it's lower-risk here
  because the relay operator and the account owner are typically the same
  person, but the zero-knowledge claim shouldn't imply protection against this
  scenario without saying so. No action item, just an explicit disclosure.

- **Residual risk: OAuth account compromise now leaks session metadata.**
  Because account-scoped session-list metadata (§8's bridge bullet) becomes
  visible on OAuth login alone, phishing or token theft against the user's
  Google or GitHub account now leaks session/project/provider/status metadata
  without ever touching a device key or the Recovery Code. That's a
  deliberate, bounded, honestly-disclosed tradeoff (no session *content* is
  exposed this way), but it is a genuinely new attack vector this addendum
  introduces — today, with device-only pairing, there is no single-credential
  path to any metadata at all. Worth a line in the eventual security-review
  checklist, not just a bullet in §8.

- **Deferred: server-managed key-custody opt-out.** A per-account
  `keyCustodyMode: 'e2e' | 'server-managed'` toggle (mirroring Nimbalyst's
  `legacy-e2e`/`server-managed` split, `nimbalyst/docs/SYNC_JWT_MODEL.md:71-77`,
  `OrgKeyService.ts:702-774`, behind a `KekProvider`-shaped abstraction) was
  drafted for §8 and **deliberately cut from v1/v2**: none of the four
  original user asks requested it, and — unlike Nimbalyst's team-org lane,
  where a real second human (an org admin) sometimes needs server-mediated
  recovery — loombox's whole topology is one self-hosting operator who is
  also the only relay admin, so the tradeoff this toggle exists to sell
  (convenience over key custody) has no genuine second-party beneficiary here.
  It also sits in direct tension with §2's TL;DR, which positions loombox
  specifically against Nimbalyst's own server-managed escape hatch — building
  the same escape hatch into loombox, even off by default, undercuts that
  differentiator. Status: **won't-do for now; reconsider only if a real
  self-hoster asks for it**, with this honest-tradeoff copy kept intact for if
  it's ever built: a status chip, a required acknowledgement checkbox before
  flipping it, copy stating plainly that in this mode the relay operator
  could technically read content, and audit-logged access.

- **Deferred: WebAuthn PRF convenience unlock.** A code-free unlock layered on
  the AMK escrow (register a passkey with a PRF extension, use the PRF output
  through HKDF as a second wrapping key for a second escrowed AMK blob,
  requiring Better Auth's passkey plugin specifically for its
  `extensions`/`clientExtensionResults` exposure) was drafted for §8's device
  lifecycle and **deliberately cut from v1/v2**: recovery-code escrow alone
  fully answers "see my sessions without a QR," the PRF path adds a second
  escrowed blob and a hard dependency on a specific plugin's PRF exposure, and
  2026 platform support still has real gaps (Firefox-Android, some CTAP2
  security keys) for a benefit — skipping one 11-group code entry per new
  device — that's marginal for a solo user with a handful of devices. Status:
  **backlog, far future**; grounding kept for if it's revisited: PRF mechanics
  and support matrix at `developers.yubico.com/WebAuthn/Concepts/
  PRF_Extension/` and `corbado.com/blog/passkeys-prf-webauthn`; Better Auth's
  passkey plugin vs. Stytch's fully-wrapped SDK (no extensions pass-through)
  at `docs.better-auth.com/docs/plugins/passkey` and
  `stytch.com/docs/sdks/webauthn/register`.
```

---

## Item 6 — REVISES §15 (Graduation & backlog: epics/labels)

**Placement:** Two small edits inside the existing epics list and labels list.

```markdown
In the **Epics** bullet, add to the parenthetical list: "account & login
(OAuth via Better Auth, Account Master Key custody, device bootstrap)" and
"connected accounts / integrations registry (§7.26)" — both new epics,
alongside the existing "tracker integration" epic, which is re-scoped per
§7.10 (native-local vs. live-external, `TrackerBackend`) rather than removed.

In the **Labels** bullet, add `auth` (account login, OAuth, AMK/key-custody
work) and `accounts` (connected-accounts registry, §7.26) to the area label
set.
```

---

## Item 7 — REVISES §16 (Grounding & references)

**Placement:** (a) add a new heading **"Login, accounts & key custody"**
right after the existing **"Crypto, devices & secrets"** heading's bullet list
(before "**Agent interaction (ACP) — corrections applied**"); (b) revise two
existing lines under **"Providers, trackers, terminals, input"** in place
(the Jira line and the "Two-way tracker write-back generally" line).

```markdown
**Login, accounts & key custody**
- OAuth login, self-hosted — **Better Auth** (MIT): Fastify mounting recipe
  (`docs/content/docs/integrations/fastify.mdx`), `socialProviders`
  config + `/api/auth/callback/:provider` (`docs/content/docs/concepts/
  oauth.mdx`), session directory (`listSessions`/`revokeSession`,
  `concepts/session-management.mdx`), Bearer plugin (`plugins/bearer.mdx`,
  confirmed as the mechanism for converting an `Authorization: Bearer` header
  into an internal session — chosen deliberately over the JWT plugin, which
  Better Auth's own docs describe as for handing tokens to a separate
  third-party service, not as a session-auth replacement) — all via context7
  `/better-auth/better-auth`. Deliberately not Stytch/Clerk/WorkOS (SaaS-only,
  cannot self-host — ruled out against §3/§11) nor Supabase Auth/GoTrue (self-
  hostable but a separate Go binary/container, not an embeddable Node
  library).
- Provider-side OAuth app setup — GitHub OAuth Apps
  (`docs.github.com/en/apps/oauth-apps/building-oauth-apps/
  authorizing-oauth-apps`); Google OAuth 2.0 web-server flow
  (`developers.google.com/identity/protocols/oauth2/web-server`).
- Account Master Key escrow shape — Signal's PIN + Secure Value Recovery
  precedent for a server-escrowed, guess-limited encrypted key blob
  (`signal.org/blog/improving-registration-lock/`,
  `github.com/signalapp/SecureValueRecovery2`), adapted to a high-entropy
  generated code so no enclave-based rate limiter is required; WhatsApp's
  multi-device model (`engineering.fb.com/2021/07/14/security/
  whatsapp-multi-device/`) confirms QR-from-an-existing-device does **not**
  solve first-device bootstrap and is not a template to copy as the only
  path.
- AMK-derivation mechanism — Happy's actual key-tree construction,
  `deriveSecretKeyTreeRoot`/`deriveSecretKeyTreeChild`
  (`happy/packages/happy-app/sources/encryption/deriveKey.ts:8-30`, 45 lines
  total), an **HMAC-SHA512 BIP32-style tree** (`hmac_sha512(chainCode, data)`
  per child), not RFC 5869 HKDF — corrected here after the first draft
  mis-cited both the path (`sources/auth/deriveKey.ts`, which doesn't exist)
  and the mechanism (labeled "HKDF"). Recovery-code formatting reused as-is:
  `secretKeyBackup.ts:81-102` (`formatSecretKeyForBackup`, base32
  dash-grouped, 1Password-secret-key-style); QR hand-off reference shape:
  `hooks/useConnectAccount.ts:22-50`.
- WebAuthn PRF convenience unlock — **deferred, not part of the active v1/v2
  design** (see §14's "Deferred: WebAuthn PRF convenience unlock" bullet,
  which carries the full grounding: Better Auth's passkey plugin vs. Stytch's
  fully-wrapped SDK, and the PRF mechanics/2026 support-matrix citations).
  Better Auth is chosen here for the OAuth/Bearer-session need above, which
  stands on its own regardless of whether PRF is ever built.
- Connected-account registry shape (GitHub) — emdash `GitHubAccountRegistry`
  (`github-account-registry.ts:57-190`), device flow
  (`github-device-flow-service.ts:1-114`), CLI import
  (`github-cli-account-import.ts:56-92`), per-project tri-state resolver
  (`project-github-auth-context-resolver.ts:51-102`). GitHub App vs OAuth
  App vs fine-grained PAT tradeoffs:
  `docs.github.com/en/apps/oauth-apps/building-oauth-apps/
  differences-between-github-apps-and-oauth-apps`,
  `docs.github.com/en/organizations/restricting-access-to-your-
  organizations-data/about-oauth-app-access-restrictions`.
- Connected-account registry shape (Jira) — no in-repo precedent (emdash's
  `jira-connection-service.ts` is single-account); Jira OAuth 2.0 (3LO) and
  multi-site discovery via `accessible-resources`:
  `developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/`; granular
  Jira Software scopes: `developer.atlassian.com/cloud/jira/software/
  scopes-for-oauth-2-3LO-and-forge-apps/`; account-scoped API tokens:
  `support.atlassian.com/atlassian-account/docs/
  manage-api-tokens-for-your-atlassian-account/`.
```

```markdown
Under **"Providers, trackers, terminals, input"**, replace:

  "Jira two-way — emdash `jira-http-client.ts` (auth/GET) + Jira Cloud REST v3
  transitions/comment endpoints (discover transition IDs first). *(write-back
  novel)*"
  "Two-way tracker write-back generally — *(novel: define trigger, conflict
  policy, idempotency keys)*."

with:

- Native tracker data model — Nimbalyst's post-refactor `TrackerRecord`
  (`packages/runtime/src/core/TrackerRecord.ts:36-70`) and its rationale
  (`design/trackers/unified-tracker-system.md:150-336`), superseding its own
  older flat `tracker_items` row (`docs/nimbalyst-schema.prisma:71-82`); MCP
  tool contract reused verbatim.
- Live Jira backend — two separate REST bases confirmed from the live
  specs, `developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`
  (`/rest/api/3/...`, incl. exact transition/comment request bodies in ADF)
  and `developer.atlassian.com/cloud/jira/software/swagger.v3.json`
  (`/rest/agile/1.0/...`, boards/sprints/epics); OAuth 3LO `cloudId` routing
  via `api.atlassian.com/ex/jira/{cloudId}/rest/...`. `(write path itself is
  novel; the endpoints are fully grounded)`
- Live GitHub backend, Projects v2 — exact GraphQL shapes from the public
  schema `docs.github.com/public/fpt/schema.docs.graphql`:
  `Mutation.addProjectV2ItemById` (line 26747, input line 824),
  `Mutation.updateProjectV2ItemFieldValue` (input line 69107),
  `ProjectV2SingleSelectField` (line 41809, `.options` around line 41838),
  `ProjectV2IterationField` (line 41514) — supersedes the old spec's bare
  mutation-name citation with exact input/output shapes and the
  field-option-id lookup requirement.
- Pluggable `TrackerBackend` interface — structurally modeled on Nimbalyst's
  `trackerImporter` SDK (`packages/extension-sdk/src/types/
  trackerImporter.ts:1-149`), reframed from one-shot import to full CRUD +
  comments + transitions + boards/sprints; the capability-flag map is a
  novel extension of emdash's shallower, read-only
  `ISSUE_PROVIDER_CAPABILITIES` (`emdash/apps/emdash-desktop/src/shared/
  issue-providers.ts:5-67`).
- "Live, no sync" behavior (no local mirror, explicit connectivity-error
  state, no write queue) — *(novel: this is the scope cut that replaces the
  old two-way-sync design; there is no conflict-merge policy to design
  because there is no local copy to merge against)*.
```
