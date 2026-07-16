# loombox spec addendum — managed-cloud edition (revised)

Ready-to-paste additions to `ideas/loombox/spec.md`. Each block below states exactly
where it goes (REVISES an existing passage — verbatim quote given so it can be
located — or FOLLOWS one). This revision responds to a critique pass: §17 is
trimmed hard (it was ~200 new lines for something explicitly gated past v3; it's
now one compact section), the "self-hosting is permanent" message is stated once
(§11) and cross-referenced everywhere else instead of restated, two citations are
fixed (Supabase per-project-isolation claim hedged as community-reported; the dead
Cal.com license-key link replaced with an honest note about its narrowed posture),
§3's internal contradiction is resolved by revising the sentence in place, and a
real honesty gap is closed: who serves/builds the client PWA under managed-cloud,
and the residual browser-delivered-E2E trust caveat that follows from it.

---

## 1. REVISION of §11 — replace one bullet (do this first; it's now the one
   authoritative statement of the permanence guarantee — §2/§3/§17 all just
   point back to it instead of restating it)

Locate this exact bullet in "## 11. Non-goals (won't, at least for v1)":

> - A hosted/managed relay-as-a-service.

Replace it with:

```markdown
- A hosted/managed relay-as-a-service **is not a v1 goal** — v1 ships only the
  self-hosted relay. **Stated once, plainly, as the permanent guarantee:
  self-hosting stays free and possible for as long as loombox exists** — not
  a launch-only constraint, and not something a later edition erodes. §17
  specifies a planned, later, additive managed-cloud edition of the same
  codebase, deliberately deferred past v1–v3 and gated on the self-hosted
  AMK/account-login model surviving real use first (§14). Whether or when it
  ships, it can only ever run *alongside* the self-hosted path (§2/§3), never
  replace it.
```

---

## 2. REVISION of §2 — append one short clause after the final paragraph

Locate the end of §2:

> No single tool combines: *agents run where I want (local or my devbox)* + *I
> steer from my phone* + *I own the relay and it structurally cannot read my
> data* + *voice runs on keys I hold*. loombox is that combination, built for
> **one self-hosting power user first**, not as a team product.

Append immediately after it (still within §2, no new heading):

```markdown
This holds permanently, not just at launch — see §11 for the explicit
guarantee. A managed-cloud edition (§17), if and when it ships, is an
additional convenience for people who'd rather not run their own
Postgres/Redis/Docker; it changes nothing about who can read your data
(§17.3).
```

---

## 3. REVISION of §3 — revise the existing bullet in place (do not append a
   new bullet after it; the old draft did that and left the original sentence
   standing in unresolved tension with it)

Locate this exact bullet in "## 3. Users & scope":

> - **Not in scope (v1):** teams, org permissioning, multi-tenant SaaS, a hosted
>   managed relay. The whole point is the user runs their own relay.

Replace it with:

```markdown
- **Not in scope (v1):** teams, org permissioning, multi-tenant SaaS, a hosted
  managed relay — see §17 for the later, additive managed-cloud edition of
  exactly this, gated well past v1. The default, and the permanent guarantee
  (§11), is that the user runs their own relay; §17 only ever adds an
  optional managed alternative, never a replacement.
```

(No other change to §3 — the rest of its bullet list is untouched.)

---

## 4. NEW §17 — place after the current §16 (end of document)

The current file ends at §16 ("Grounding & references"). Append the following as a
new top-level section, `## 17. Deployment editions: self-hosted & managed cloud`.
This is deliberately compact — a decision record for a far-future edition (§12),
not a build spec.

```markdown
## 17. Deployment editions: self-hosted & managed cloud

Everything above (§1–§16) describes **one codebase** with **two deployment
editions** of its relay tier. Self-hosting is the product's permanent
guarantee (§11), not a phase a managed edition replaces. This whole edition
is explicitly **far future** (§12), gated on v1's AMK/account-login model
surviving a real self-hosted lost-device/rebuilt-relay drill (§14) before any
multi-tenant ops land on top of it.

### 17.1 Same codebase, different operator

The managed-cloud relay is **the identical `packages/relay` Docker image**
self-hosters already run (§9/§10), operated once, at scale, by
loombox-the-company — same node/supervisor/protocol/crypto packages, no
fork. Standard practice, not a novel pattern: Sentry's cloud is "a
multi-region deployment... built from the same source code as self-hosted"
(develop.sentry.dev/application-architecture/overview/); PostHog's
self-hosted build goes through "our standard CI/CD pipeline" before also
becoming available for self-hosted instances (posthog.com/docs/self-host).
What differs is only *who* runs the container and *how many* accounts' rows
sit in its database.

### 17.2 Multi-tenancy: reuse `owner_account_id`, invent nothing new

§8 already added the column a multi-tenant relay needs — device registry
`owner_account_id`, filtered `WHERE owner_account_id = session.user.id`. For
managed-cloud this predicate becomes the tenant boundary: extend the same
`account_id` scoping to every account-scoped table (metadata, blob store,
wrapped-AMK escrow, push subscriptions — §7/§8), and namespace Redis
pubsub/fan-out channels by account so shared infra cannot cross-deliver.

**Decision: launch on shared multi-tenant Postgres + Redis, row/channel-
scoped by `account_id`** (the Sentry/PostHog model), **not** dedicated
container-per-tenant. Some products do the latter — Gitea Cloud is explicitly
"single-tenant, region-based... not multi-tenant" (about.gitea.com/products/cloud/);
Supabase Cloud's per-project isolation is also often cited here, but that
specific claim turns out to be community-reported
(github.com/orgs/supabase/discussions/38048), not stated on Supabase's own
self-hosting docs — treat it as a weaker data point, not documented
precedent. Per-account data here is small encrypted blobs and metadata rows,
not an analytics-scale write stream, so the noisy-neighbor case for dedicated
instances is weak. A dedicated-instance tier is left as a possible later
paid/enterprise SKU.

### 17.3 "Managed but still E2E" — the precise, honest scope

Content ciphertext, key derivation, and credential custody are unchanged by
who operates the relay (§8): the AMK never leaves a device except wrapped;
session/resource content, SSH credentials, and provider credentials never
reach any relay, self-hosted or managed. What a managed operator can see is
*identical* to what a self-hoster's own relay already sees (§8's bridge
bullet — not a new exposure): account-scoped session-list metadata and the
Better Auth `user` table. The one thing that changes is *who* that operator
is.

**The one honest gap "same relay code" doesn't cover: who serves the client
PWA.** §5.4's web-PWA is what performs the AMK unwrap and every encrypt/
decrypt operation, in the browser. In self-host, the person running the
relay and the person served the PWA bundle are the same trusted user. In
managed-cloud, loombox-the-company plausibly also serves that PWA bundle,
not just the relay — and whoever builds/serves the client is structurally
able to ship a subtly different build to one targeted user. That's the
standard residual-trust caveat of any browser-delivered E2E product (it's
why Signal/WhatsApp lean on native app-store review and reproducible builds
rather than resting their E2E claim on server-code parity alone). "Same
relay code" is not "same trust in every respect," and the managed-cloud
pitch should say so rather than let relay-code parity imply it. A concrete
mitigation (reproducible/verifiable PWA builds, and/or treating a signed
native mobile wrapper, §12, as the trusted client rather than a live browser
bundle) is left as a design question for whenever this edition is actually
built, not resolved here.

### 17.4 Not hosted execution

Managed-cloud hosts the **relay tier only** (§5.3/§8/§10's existing
self-hostable process list) — never the orchestrator node or
agent-supervisor. SSH credentials, provider credentials, and the unwrapped
AMK stay off loombox-the-company's infrastructure in both editions, because
the node only ever connects *outbound* to the relay (§5.1) — the same
hosted-coordination-plane shape as Tailscale's or Cloudflare Tunnel's control
servers. A managed-cloud user still needs their own compute to run agents
on; a future "loombox runs your agents" tier would be a structurally
different, much larger trust commitment (it would require holding/brokering
credentials it structurally cannot see today) and is explicitly **not** part
of this edition, or implied by it.

### 17.5 Licensing: stay MIT

§13 commits loombox to MIT throughout. Direct consequence: MIT permits
anyone, not only loombox-the-company, to stand up a competing managed
loombox-relay, since there's no reciprocity clause. Other OSS products close
this differently — Cal.com and Plausible relicensed to AGPL specifically to
require sharing source if run as a service (though Cal.com's own self-host
posture has since narrowed: its license-key docs now redirect to `cal.diy`,
which describes itself as "the open source community edition of Cal.com,"
"strictly recommended for personal, non-production use," "use at your own
risk" — a cautionary data point on how far this kind of split can drift,
worth naming rather than citing silently as clean precedent); Sentry uses a
two-year non-compete Functional Source License auto-converting to
Apache-2.0/MIT, scoped only to the components powering its own hosted web
app; PostHog stays MIT and relies on self-host being operationally harder at
scale instead of a license gate.

**Decision: do not relicense the relay/protocol/crypto/node/supervisor
packages — they stay MIT.** Relicensing to protect the managed business
would cut against §2's own differentiation from Nimbalyst ("the real sync
server is not open source") and undermine the trust story, which is only
checkable if self-hosters can read the relay's code. If freerider protection
is ever wanted, the pattern to imitate is Cal.com's `/ee` split: new
cloud-only glue (billing, provisioning, an admin dashboard) in a separately
licensed package — never the relay/crypto core.

### 17.6 Portability, and why this stays gated

Moving a node/client between self-host and managed-cloud is config, one
level up from §7.23's execution-target pattern: point at the new relay URL,
then re-run one of §8's two AMK-bootstrap paths against the new account.
Relay-side history (session data, device registry rows) does not move
automatically — same codebase doesn't imply data portability, which is why
Sentry ships a dedicated "Moving to SaaS" migration guide
(docs.sentry.io/concepts/migration/) rather than treating it as a config
flip. Ship the free re-point/re-bootstrap path on day one; treat a
full-history export/import tool as a separate later roadmap item.

This entire edition sits behind v1–v3 shipping and surviving real use (§12):
building multi-tenant ops on top of an AMK/account-login model that hasn't
yet survived a real lost-device/rebuilt-relay drill (§14) would stack an
unforced risk on an already-accepted one.
```

---

## 5. Addition to §12 — roadmap

Locate the "**Far future.**" bullet in §12 (currently ends "...a secondary
control channel (e.g. Telegram).").  Append to the end of that same bullet
(comma-joined, matching its existing list style):

```markdown
; a **managed-cloud edition** (§17) — the identical relay image, operated
  once by loombox-the-company, multi-tenant via `account_id` scoping of the
  same Better Auth column §8 already introduces — explicitly gated on v1's
  AMK/account-login model having survived a real self-hosted lost-device/
  rebuilt-relay drill (§14) before multi-tenant ops are layered on top.
```

---

## 6. Additions to §14 — open questions & risks

Add two new bullets to §14 (place alongside the other "residual risk" /
"decide explicitly" bullets, e.g. immediately after the existing "OAuth broker
centralization vs. self-registered apps" bullet):

```markdown
- **Multi-tenancy blast radius, if/when the managed-cloud edition (§17)
  ships:** the same `account_id`-scoping query that is a near-no-op in
  self-host (one account) becomes the entire tenant boundary in
  managed-cloud — a missed `WHERE owner_account_id = ...` filter on any
  account-scoped table or Redis channel stops being a same-account bug and
  becomes a cross-tenant metadata leak. §17.2 already decides shared,
  row-scoped Postgres/Redis over dedicated-per-tenant instances; the open
  risk is operational, not architectural — require an explicit
  cross-tenant-isolation test suite before any managed-cloud launch, not
  just code review.
- **MIT means anyone can host a competing "managed loombox," not only
  loombox-the-company.** §13's MIT choice has no reciprocity clause, so a
  third party is free to stand up their own hosted loombox-relay service
  from the same source. This is a known, accepted consequence of keeping
  the trust-critical relay/crypto code auditable (§8), not an oversight to
  close later by relicensing — §17.5 records the decision to stay MIT and
  contrasts it with Cal.com/Plausible's AGPL and Sentry's FSL, which exist
  precisely to prevent this.
```

---

## 7. Addition to §16 — grounding & references

Add a new subsection at the end of §16 (after the existing "**Build &
client**" subsection), matching the section's existing citation-list style:

```markdown
**Managed-cloud edition (§17)**
- Same-codebase self-host + SaaS precedent — Sentry
  (develop.sentry.dev/application-architecture/overview/) and PostHog
  (posthog.com/docs/self-host).
- Dedicated-instance-per-tenant alternative (rejected for launch, §17.2) —
  Gitea Cloud (about.gitea.com/products/cloud/, explicitly single-tenant).
  Supabase Cloud's per-project isolation is often cited as a second example
  but is community-reported only (github.com/orgs/supabase/discussions/38048),
  not found stated on Supabase's own self-hosting docs — a weaker data
  point, not a documented precedent.
- PostHog's honest self-hosted-vs-Cloud scale disclosure, the model for
  §17.3's own honesty discipline — posthog.com/docs/self-host/open-source/disclaimer.
- Licensing precedent for §17.5 — Cal.com's AGPLv3 relicense
  (cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition); note
  its `/ee` license-key docs now redirect to `cal.diy`, whose own framing
  ("community edition... personal, non-production use... at your own risk")
  is a narrower self-host posture than the AGPL relicense alone suggests, so
  treat it as a cautionary data point, not clean precedent. Plausible's
  narrower AGPL split (plausible.io/blog/community-edition). Sentry's
  Functional Source License, a two-year non-compete auto-converting to
  Apache-2.0/MIT, confirmed scoped only to the components powering the main
  Sentry/Codecov web apps, not the whole product
  (blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/,
  open.sentry.io/licensing/).
- Portability precedent for §17.6 — Sentry's "Moving to SaaS" guide
  (docs.sentry.io/concepts/migration/), an official step-by-step migration
  doc. Cal.com's "Transitioning From Cloud To Self-Hosted" post
  (cal.com/blog/transitioning-from-cloud-to-self-hosted-scheduling-a-step-by-step-guide)
  shows the same "not a config flip" framing but reads closer to content
  marketing than an official migration doc — a weaker peer citation than
  Sentry's, noted rather than presented as an equally authoritative pair.
- Hosted-coordination-plane precedent for §17.4 — Tailscale's coordination
  server and Cloudflare Tunnel's control plane, both outbound-only from
  user-controlled infrastructure.
```
