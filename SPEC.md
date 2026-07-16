# loombox — product spec

> Self-contained specification. Written to be read by a fresh agent or person in a
> brand-new repository with zero prior context. It is the graduation artifact: it
> seeds a dedicated repo plus a GitHub Project (epics, milestones, labels, issues)
> from which agents build the product in incremental versions.
>
> The full "best-of teardown" of the four tools that inspired loombox
> (emdash, Happy, HAPI, Nimbalyst), with file-level citations, lives in
> `research/planning-brief.md`.

---

## 1. TL;DR

**loombox is a self-hosted cockpit for coding agents.** It runs multiple agents in
parallel on machines you control (your laptop *or* a remote box over SSH), each in
an isolated workspace, and lets you watch and steer every session from a desktop
browser or your phone, over a relay you host yourself and that is cryptographically
unable to read your data.

One line: **emdash's SSH-orchestrated parallel worktrees, in your pocket, over a
relay you host and encrypt yourself, with voice on your own keys.**

The name is the metaphor: a **loom** weaves many parallel threads into one cloth.
loombox weaves many parallel agent sessions into one shipped product.

## 2. Why this exists (the gap)

Four existing tools each nail one slice and, by their absence, prove the others are
missing (see `research/planning-brief.md` for the source-grounded detail):

- **emdash** (Apache-2.0) — excellent SSH-remote, multi-worktree orchestration. No
  mobile, no sync, no encryption, no voice.
- **Happy** (MIT) — a genuinely self-hostable sync relay + cross-platform mobile
  client with real client-side E2E crypto. No worktree parallelism; voice is
  hardcoded to the maintainers' account behind a paywall.
- **HAPI** (AGPL-3.0) — bring-your-own-key, multi-backend voice and a multi-provider
  agent hub. No SSH; self-hosting drops E2E entirely.
- **Nimbalyst** (MIT client, closed server) — a clean server-blind E2E wire protocol
  and a tidy tracker-import pattern. Agent execution never leaves localhost; the
  real sync server is not open source.

No single tool combines: *agents run where I want (local or my devbox)* + *I steer
from my phone* + *I own the relay and it structurally cannot read my data* + *voice
runs on keys I hold*. loombox is that combination, built for **one self-hosting
power user first**, not as a team product.

This holds permanently, not just at launch — see §11 for the explicit
guarantee. A managed-cloud edition (§17), if and when it ships, is an
additional convenience for people who'd rather not run their own
Postgres/Redis/Docker; it changes nothing about who can read your data
(§17.3).

## 3. Users & scope

- **Primary user:** a single self-hosting developer who already runs a remote dev
  box and wants to orchestrate agents on it and continue from anywhere.
- **Not in scope (v1):** teams, org permissioning, multi-tenant SaaS, a hosted
  managed relay — see §17 for the later, additive managed-cloud edition of
  exactly this, gated well past v1. The default, and the permanent guarantee
  (§11), is that the user runs their own relay; §17 only ever adds an
  optional managed alternative, never a replacement.
- loombox is open-source (MIT) so a user can self-host every component.

## 4. Brand

- **Name:** `loombox` (always lowercase). Domain `loombox.dev`; GitHub org/repo
  `loombox`; npm scope `loombox`. Part of a `-box` product family with `pitchbox`.
- **Metaphor:** the loom — warp and weft threads woven into cloth. Parallel agent
  sessions are threads; the finished product is the cloth.
- **Logo:** a minimal monoline mark — interwoven warp/weft lines forming (or passing
  through) a square "box". Reads as both a woven grid and a container. Works as a
  single-color glyph at favicon size.
- **Visual style:** dark-mode-first (it is a dev tool). Ink/paper monochrome base
  plus one warm "thread" accent (a loom-thread hue — warm coral/amber), used
  sparingly for active state and the woven motif. Woven-thread lines are the
  recurring motif: loading and "agent working" states animate as threads being
  woven. Complementary to, but visually distinct from, pitchbox.
- **Typography:** a clean grotesk for UI (e.g. Inter); a monospace (e.g. JetBrains
  Mono) for agent output, code, and diffs.
- **Tone of voice:** plain, technical, unhyped. No emoji in product chrome.

## 5. Architecture

Three kinds of process, plus the agents themselves:

```
   ┌─────────── clients (E2E devices) ───────────┐
   │  web-PWA on desktop browser   web-PWA on phone │
   └───────────────┬───────────────┬──────────────┘
                   │  (ciphertext)  │
                   ▼                ▼
            ┌──────────────────────────────┐
            │   RELAY  (self-hosted)         │   sees only ciphertext;
            │   prodbox: Docker + Caddy      │   fans out messages;
            │   public https/wss subdomain   │   stores encrypted blobs
            └───────────────┬────────────────┘
                            ▲  (ciphertext, outbound conn)
                            │
            ┌───────────────┴────────────────┐
            │   ORCHESTRATOR NODE (a daemon)  │   holds SSH creds & agent I/O;
            │   runs on Mac and/or devbox     │   is itself an E2E device
            └───────┬─────────────────┬───────┘
                    │ target: local   │ target: ssh:<host>
                    ▼                 ▼
             agent in worktree   agent in worktree on remote host
```

### 5.1 Orchestrator node

A daemon (with an optional local desktop UI) that owns and drives agent sessions.
It can run on the user's Mac, headless on the devbox (systemd), or both. Each node:

- Manages **sessions**, each running one agent in a chosen workspace.
- Spawns agents on one of its **execution targets** (§5.2).
- Holds the only copy of any SSH credentials it uses (never sent to relay/clients).
- Connects **outbound** to the relay and registers as an E2E device.

Running a node directly on the devbox with a `local` target = agents run on the
devbox with no SSH hop. Running a node on the Mac with an `ssh:devbox` target = the
classic "desktop drives the remote box" model. Both are supported by the same code;
which to run is a deployment choice. Add a node on any machine to add capacity.

### 5.2 Execution targets

The core abstraction that delivers "local *and* SSH, like emdash":

- **`local`** — run the agent on the machine the node runs on.
- **`ssh:<host>`** — run the agent on a remote host over SSH: pooled/reconnecting
  SSH transport, a login-shell environment capture that fixes the
  non-interactive-shell PATH problem (see §9), and remote worktree/filesystem
  operations. (Design reimplemented clean-room; emdash's `core/ssh/*` is the
  reference, not the source.)

A session picks a target at creation. The set of targets a node exposes is published
to the relay so clients can start sessions anywhere. Adding an `ssh:` target is a guided
flow — autodetect, a persistent pooled connection, and automatic remote provisioning of
the supervisor (§7.23).

### 5.3 Relay

Self-hosted on prodbox (Docker + Caddy for TLS on a public subdomain, e.g.
`relay.loombox.dev`). It:

- Authenticates nodes and client devices.
- Fans out session state and messages between a node and its clients.
- **Only ever handles ciphertext** and stores only encrypted blobs (§8). A
  compromised relay host cannot read session content. (See §8's account-login bridge bullet for the one narrow, deliberate exception once account login lands: account-scoped session metadata and the Better Auth `user` table sit in Postgres in plaintext — session/resource *content* remains ciphertext-only.)
- Dispatches push notifications (self-owned VAPID keys, §7.11).

### 5.4 Clients

**Web-PWA first** (one client for both desktop browser and phone). It lists all
sessions across all of the user's nodes/targets and lets the user view live output,
send follow-up prompts, approve/deny tool calls, review diffs, browse files, and
watch usage. A thin native mobile wrapper is a later addition, not a launch blocker.

### 5.5 Provider layer

Agents are driven through a layered ACP architecture, not one monolithic
adapter:

- **Generic ACP core** (`packages/providers/core`) owns everything ACP itself
  standardizes, for every provider alike: `initialize`/capability negotiation,
  `session/new`/`session/resume` + replay, the append-by-`messageId` message/
  thought reducer, `tool_call`/`tool_call_update` (diffs, display-only
  terminals), `plan_update`, `usage_update`, `session/request_permission`,
  config-option-driven model/mode/reasoning selection, `session/list`, and
  cancellation (§7.24 renders all of it). A provider that implements nothing
  beyond the ACP spec still gets a fully working cockpit through this core
  alone.
- **Capability negotiation gates the UI, not provider branding.** Every
  optional affordance — image/audio attach, an MCP-server picker, additional-
  directories, session delete — lights up or greys out per session based on
  that session's own negotiated capabilities from `initialize`, so a plain
  generic-ACP session that happens to support images behaves identically to a
  Claude Code one that does.
- **Per-provider adapter modules** (`packages/providers/claude`,
  `packages/providers/codex`, `packages/providers/gemini` reserved, one small
  package each) add exactly the two things ACP deliberately leaves to the
  client: an `enrich(update, raw)` hook that promotes a vendor's `_meta`
  fields into a small, fixed set of first-class core fields — starting with
  Claude Code's `_meta.claudeCode.parentToolUseId` → `parentToolCallId`
  (§7.24, v2 on the roadmap) — and the provider-specific UI wiring (a bespoke
  per-tool-name widget table, the permission button set/verbs that provider's
  agent actually offers, and any image hand-off quirk, §7.25). A module that
  adds neither simply falls back to the generic tier everywhere: no-op
  `enrich`, `ToolKind`-generic tool rows, a plain Allow/Deny permission pair.
- **Generic ACP adapter** (`packages/providers/generic`) is what any other
  ACP-speaking agent gets automatically — flat tool-call list, `ToolKind`-
  generic rows, plain permission buttons, `ResourceLink` for file/image
  references — which is what makes adding a future ACP agent (OpenCode-
  family, etc.) near-free: register a provider id, and write an `enrich`/
  widget module later only if that agent's own conventions turn out to
  warrant one.
- v1 ships **Claude Code + Codex** adapter modules (Codex's ACP completeness
  verified at build time, §10/§12). A **Gemini** adapter module is the next
  one reserved, ahead of any long-tail generic-ACP provider, since it is a
  major CLI worth its own bespoke module rather than leaving to the generic
  tier (roadmap: §12). loombox deliberately does not chase provider breadth
  for its own sake (§11).

### 5.6 Agent-supervisor

On every executing host, a small **agent-supervisor** daemon owns the agent processes:
it spawns each agent as a child process (ACP JSON-RPC over piped stdio, not a PTY),
persists a structured, resumable transcript to disk,
survives client/node disconnects, and emits events. A node connects supervisors to the
relay: when the node runs on the executing host (a `local` target, e.g. the resident
devbox node) node and supervisor are co-located; for an `ssh:` target the node deploys
and drives a supervisor on the remote host. The supervisor is what makes sessions
persistent and autonomously continuable (§7.22).

## 6. Core concepts / data model

- **Node** — a daemon instance; an E2E device with an identity keypair.
- **Supervisor** — a per-host daemon that owns agent processes and persists their
  transcripts, so sessions survive disconnects (§5.6, §7.22).
- **Target** — `local` or `ssh:<host>`, exposed by a node.
- **Project** — **any folder**, local or remote. It does **not** have to be a git
  repository (this is a deliberate difference from emdash and a nod to Nimbalyst).
  Git features (branches, worktrees) are offered only when the folder is a git repo.
- **Session** — one agent working inside one workspace derived from a project.
- **Worktree (optional)** — when the project is a git repo, a session may run in an
  isolated git worktree (like emdash) **or** directly in the working directory. The
  user chooses per session; worktree is not mandatory.
- **Run / turn** — a unit of agent execution within a session (prompt → tool calls →
  output), with captured usage (§7.9).
- **Device** — a node or a client; each has its own keypair in the E2E mesh (§8).

## 7. Features

### 7.1 Session lifecycle (worktree-optional, folder-not-repo)

Create a session by choosing: a node, a target (local/ssh host), a project folder,
a provider (Claude Code/Codex), and — if the folder is a git repo — whether to
isolate in a new worktree or work in place. Non-git folders are fully supported;
they simply don't offer the worktree/branch options. Sessions can be paused,
resumed, and reconnected (a session survives a dropped client; the node keeps it
alive).

### 7.2 Multi-agent parallel orchestration

Many sessions run concurrently across targets, each isolated (separate worktree or
separate folder). A board/list view shows all of them with live status. This is the
"loom": parallel threads visible at a glance.

- **Same-folder safety:** because a project can be a plain folder with no worktree
  (§6), two sessions may not run in place on the same folder at once — the second is
  queued or refused with a warning; using worktrees removes the restriction.
- The board supports **pin, tag, archive, and filter** to keep many projects manageable.

### 7.3 Mobile / web companion

From the PWA (desktop or phone) the user can, for any session: watch live output,
send follow-up prompts, approve or deny tool-call permission requests, review diffs,
read files, and switch device mid-session with state preserved (borrowing Happy's
per-session invalidate/caching approach as inspiration).

- **Stop/interrupt** any running agent turn with one tap (desktop and mobile), distinct
  from post-hoc rollback (§7.20).
- **Offline actions:** a follow-up prompt composed offline queues and sends on
  reconnect; a stale approve/deny is discarded with a "no longer applies" note rather
  than silently applied, since the tool call may have expired or been resolved on
  another device.
- **Mobile approval cards** show a condensed diff/command summary with actionable
  buttons (OS-actionable push where allowed).
- **Keyboard & command palette** are a cross-cutting requirement: a fuzzy
  jump-to-session/project quick-switcher plus shortcuts for the common actions.
- **Touch affordances for transcript widgets.** On a touch pointer
  (`pointer: coarse`), tool-call cards, permission buttons, and plan checklist
  items get enlarged hit targets and haptic feedback on tap (the Vibration
  API where available) for confirm/deny actions specifically, since those are
  irreversible.
- **Narrow-viewport permission footer.** On a narrow viewport the permission
  card's button row collapses to its two primary actions (typically Allow /
  Deny) plus an overflow control for the rest of that provider's option set
  (§7.24), rather than cramming every button into one row.
- **Scrollable option lists.** Any option list rendered inline on mobile (a
  model picker, an `options[]` permission list longer than the primary
  buttons) caps its height and scrolls internally, so it never pushes the
  actionable buttons off-screen on a small display.

### 7.4 File tree & integrated editor

A file-tree panel for any project (local or on an `ssh:` target): browse the tree and
open files in an **integrated editor** with syntax highlighting and light quick-edit,
plus an inline/split **diff viewer** for reviewing agent changes. Remote files are
browsed and opened over the same transport as the session. Not a full IDE; deep
editing stays in the user's real editor.

### 7.5 Integrated terminals (local + SSH)

Full PTY terminals on any target: a shell where the node runs (`local`) or a shell on
a remote `ssh:` host. Terminals are exposed through the relay, so they are reachable
from the PWA on desktop and phone. Multiple terminals per project, sharing the
session's working directory / worktree.

### 7.6 Git management (AI-assisted)

Full git control for a project that is a repo, with the AI in the loop: view the
commit graph and branch tree; inspect staged/unstaged changes and per-file diffs;
stage, unstage, and discard hunks; commit (with AI-generated messages); create,
switch, and merge branches; stash; and push. AI assists explain a diff, draft a
commit or PR description, and help resolve conflicts. emdash and Nimbalyst do parts of
this; loombox makes it first-class and works on both local and remote (`ssh:`)
targets.

### 7.7 Agent configuration: MCP servers & plugins

Per-project and global configuration of the coding agents: add and enable **MCP
servers** (quick-add presets, secret handling), manage agent **plugins/extensions**,
set permission allow/deny rules, and choose provider/model per session. Modeled on
Nimbalyst's MCP configuration, generalized across providers through the ACP layer. An
added MCP server receives project secrets only by explicit per-server grant, never
automatically, and its output is treated as untrusted input (§7.17).

### 7.8 Port forwarding (automatic + manual, SSH)

For `ssh:` targets, forward ports between the remote host and the client:
**automatic** detection and forwarding of a dev server an agent starts (open it in
your local browser or from the phone), plus **manual** port-forward rules. emdash's
port-forward tunnel is the reference; reimplemented clean-room.

### 7.9 Agent usage monitoring

Per-session and aggregate tracking of context-window usage, tokens, and estimated
cost, with a live meter (inspired by Nimbalyst's usage tracking). Surfaces when a
session is near its context limit and shows spend over time per project/provider.

Any `usage_update` attributable to a nested/subagent tool call (§7.24) is
excluded from a session's live context-fill *percentage* — folding it in
would make the meter visibly bounce between the parent's real context size and
a much smaller subagent one every time a subagent runs. Subagent usage is
still included in the cumulative cost figure and the per-project/provider
spend-over-time view, since that same rollup is what §7.16's spend caps
consume — a runaway subagent must still be able to trip a cost cap.

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

### 7.11 Notifications (desktop + mobile, presence-aware)

Self-owned Web Push (VAPID keys the operator holds; no vendor push relay) to **both
desktop and mobile**. Delivery is **presence-aware** (inspired by Happy and
Nimbalyst): events go to the device you are actively using, fall back to push on the
others, and are suppressed on a session you are actively watching. It notifies on the
things that need you — a tool call awaiting approval, a session finished or errored, a
CI failure, a review request — the same events that populate the attention inbox
(§7.13). Per-project **mute** and **quiet-hours** let the user tune what interrupts them.

### 7.12 Voice (deferred to post-v1)

Bring-your-own-key voice: talk to a session, hear responses, approve tool calls by
voice. Backend-abstracted (ElevenLabs / a realtime API / local) driven by the
operator's own keys. Designed from HAPI's approach but **clean-room** — no HAPI code
(AGPL-3.0, see §13). Deferred because no existing tool has self-hosted + E2E +
BYO-key voice working together; the core cockpit loop is proven first.

### 7.13 Cross-project attention inbox

One unified view across every project and node of what needs the user *now*: pending
tool-call approvals, sessions that finished or errored, failing CI, and review
requests. This is what makes many projects manageable at once — the user works from
the inbox instead of polling each session. Items are actionable inline (approve/deny,
open, reply) and drive the push notifications (§7.11).

### 7.14 PR & CI lifecycle

Close the loop from prompt to merged: open a pull request from a session's branch,
watch CI checks, surface failures back to the agent (which can auto-iterate a fix),
handle review comments, and merge. GitHub first (via `gh`), GitLab later. A red check
or a review request lands in the attention inbox (§7.13).

PR linkage works uniformly across both tracker modes from §7.10: for a
`native` project, a merged PR is recorded on the tracker item's own
`system.linkedPullRequests`/`linkedCommitSha` fields; for a `live` project,
the same event is written back through that provider's `TrackerBackend`
(a GitHub PR auto-links via its own issue-closing keywords; a Jira issue gets
an explicit comment/link via `addComment`/`update`). Either way, a red CI
check or a review request lands in the attention inbox (§7.13) the same way,
regardless of which tracker mode the project uses.

### 7.15 Test & verification runner

A first-class surface to run a project's tests/lint/build (not just a raw terminal),
stream results, and let the agent iterate on failures automatically until green.
Per-project commands are configured once (or auto-detected). Feeds the PR/CI loop and
the inbox.

### 7.16 Concurrency & resource governance

Running many agents at once must not melt the host. Per-target concurrency caps, a
queue for overflow, and resource awareness (CPU/RAM/disk per target — e.g. the
devbox's 8 cores / 16 GB) so sessions are throttled or queued instead of OOM-ing.
Shows current load and lets the user set limits per target.

- **Spend caps:** a per-project and per-session cost cap that auto-pauses the session
  and raises it in the attention inbox (§7.13) — governance covers dollars, not only
  CPU/RAM (§7.9 is meter-only).
- **Fan-out backpressure:** bounded per-client output queues with drop-oldest + a
  resync marker on overflow, so a slow client (a phone on cellular) never blocks faster
  clients or the supervisor's own persistence.

### 7.17 Agent guardrails, sandboxing & per-project secrets

Autonomous agents hold real credentials and run real commands, so loombox provides a
per-project **permission policy** (allow/deny command and network patterns), optional
**sandboxing** of agent execution, and **secret/env injection scoped per project**
(for running servers and tests) that never reaches the relay or clients. Guardrails
matter most when agents run unattended across many projects.

- **Sandboxing target:** design toward namespace/bind-mount scoping to the session's
  worktree (OS containers where available; a documented weaker fallback on macOS).
  "Optional" must not mean "off by default" once it ships (v2).
- **Untrusted content:** tracker/issue and MCP content is untrusted *input*, never
  operator instruction. The approve/deny gate (§7.3) catches only what the agent
  surfaces via ACP `session/request_permission`, which ACP makes agent-discretionary
  (MAY, not MUST) — so the **hard guardrails and sandboxing above are the enforcement
  that does not depend on the agent cooperating**, not the interactive gate.

### 7.18 Session templates, project instructions & prompt library

Speed across many projects: reusable **session templates/presets** (a "bugfix" or
"feature" session with target, provider, MCP set, and starting prompt in one click);
**per-project agent instructions** (surface and edit the project's
`AGENTS.md`/`CLAUDE.md`); and a reusable **prompt/snippet library**.

### 7.19 Session history, search & replay

A searchable archive of every session's transcript and actions (audit: what each agent
did, when, at what cost), with the ability to **fork or replay** a past session as the
start of a new one. Search runs **client-side**, over content a device has already
decrypted (the relay stays ciphertext-only, §8); cross-device completeness is bounded
by what each device has synced.

### 7.20 Checkpoint & rollback

Snapshot a session's workspace (worktree state) at a point in time and **roll back** an
agent's changes safely if a run goes wrong, independent of git commits. For non-git
projects (§6), a checkpoint is a filesystem snapshot / content-hash of the working set
rather than a git state.

### 7.21 Node & target health / observability

A status view of nodes and targets: reachability, agent-process health, and each
target's CPU/RAM/disk (the devbox included), so the user can see why a session stalled
and whether a target is overloaded (pairs with §7.16). The **relay** also exposes a
`/health` endpoint watched by an external uptime check, since alerting can't depend on
the relay itself.

### 7.22 Persistent sessions & offline continuation

Agents keep working when you close loombox or shut down your laptop, and you resume
where they left off when you reopen it.

- **The loombox agent-supervisor owns every session.** A small purpose-built daemon on
  the executing host spawns and owns the agent process (the ACP agent as a child process
  over piped stdio; a PTY is used only for the interactive terminals of §7.5), buffers and persists a
  structured, resumable transcript to disk, survives client and node disconnects,
  exposes attach/resume, and emits completion/attention events independently of any
  connected client. This is the persistence primitive — not tmux. (tmux/screen is kept
  only as a zero-install fallback for a remote host where the supervisor binary can't be
  dropped.)
- **On `ssh:` targets**, the node deploys and launches the supervisor on the remote
  host; the agent runs under it and survives the SSH link dropping and the driving node
  exiting.
- **For true autonomous continuation *and* notification while your PC is off**, run a
  **resident node** (systemd) on the always-on executing host (the devbox). Because
  that node stays connected to the relay, agents keep working *and* the supervisor's
  events reach the relay → push to your phone even with the laptop off (§7.11). This is
  the recommended topology (see §14). Without a relay-connected node on the host, the
  supervisor still keeps the agent *alive* and buffered for resume, but can't push until
  a node re-attaches.
- On reopening loombox, live sessions reconnect through the relay and re-attach with
  their buffered output; sessions that finished while you were away are waiting in the
  attention inbox (§7.13).

### 7.23 SSH connection setup & remote auto-provisioning

Getting an `ssh:` target working is one guided flow, not manual server setup:

1. **Connect.** You install the loombox app on your Mac/PC (it bundles a node). To add a
   remote target you enter the connection details, with **autodetect**: loombox reads
   your `~/.ssh/config`, offers known hosts, and picks up your keys and ssh-agent, so in
   the common case you just choose a host.
2. **Verify & persist.** loombox tests the connection and keeps it **pooled and
   persistent** with keep-alive and automatic reconnect (emdash's connection-manager
   approach), so a flaky link or a sleeping laptop doesn't force a re-setup.
3. **Auto-provision.** Once verified, loombox **sets up the components it needs on the
   remote automatically**: it detects the remote OS/arch, installs or copies the
   **agent-supervisor** (and bootstraps the runtime the agent CLI needs if missing),
   handling the non-interactive-shell PATH problem (§9) so `node`/the agent resolve. The
   bootstrap is **idempotent** and re-runs on version change; it shows exactly what it
   installs, and nothing runs on the remote without your confirmation. Optionally it also
   installs loombox as a **resident node** (systemd) on the remote, which is what enables
   autonomous continuation and offline notifications (§7.22).

After this, the remote is a first-class target: start sessions on it from desktop or
phone with no further setup.

- **Signed supervisor:** the node ships a pinned public key; supervisor releases are
  signed (minisign/sigstore) and verified before execution, distributed via GitHub
  Releases with published checksums — the bootstrap never runs unverified remote code.
- **Keeping targets current:** when a target is outdated (detected via the protocol
  version handshake, §10), the PWA offers a one-tap "update this target".
- **Removing a target:** a decommission action stops/disables the remote units, revokes
  the device key, and offers to clean up installed files.
- **First run without SSH:** the common local case is its own guided first-run — point
  at an existing relay or self-host one with a single command, auto-register the node,
  and start a first `local` session — not only the `ssh:` flow above.

### 7.24 Agent transcript & interaction UX (the ACP rendering contract)

This is the primary interface, not a secondary feature: how thinking, tool
calls, plans, and permissions render is what "steer from a phone" (§7.3) and
"watch many sessions" (§7.2) actually feel like day to day. It is built
directly on ACP's own session/update vocabulary, so it applies uniformly
across providers rather than needing a bespoke per-provider transcript format.

- **One reducer, append-only by id (the v1 baseline).** ACP v1 — the stable
  protocol Claude Code, Codex, and Zed actually speak today — streams every
  message and thought as `ContentChunk` appends keyed by `messageId`
  (`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk`): a
  chunk with the same id appends to that item, a new id starts a new one.
  `tool_call` / `tool_call_update` already carry real patch/diff semantics in
  v1 and are handled as described below. The same reducer runs identically for
  a live stream and for replayed history on reconnect (§7.22) — there is no
  separate "replay renderer." *Forward-compat note:* ACP v2 (schema present in
  the repo but explicitly marked as not yet released) adds `user_message` /
  `agent_message` / `agent_thought` variants alongside the chunk streams, which
  patch-replace a full message object by `messageId` rather than only
  appending. Track this as a v2-protocol-support item when v2 ships — do not
  build the v1 baseline reducer around upsert/patch semantics it will never
  exercise.
- **Thinking/reasoning.** A live "Thinking Ns" header while
  `agent_thought_chunk` is streaming (ticking timer from first chunk), settling
  to a static "Thought for Ns" the instant real message content starts arriving
  for that turn — reasoning never blocks or delays the answer rendering behind
  it. Collapsed by default once done, expandable on tap; visually muted/
  de-emphasized from assistant text. Scope transcript-item ids by turn + kind,
  not raw `messageId` alone, since a provider may reuse ids across a thought
  and a message within the same turn.
- **Streaming mechanics.** Decouple chunk arrival from render/animation rate (a
  small smoothing buffer) so a fast, low-latency agent doesn't cause per-frame
  jank; keep item ids stable across ticks so a virtualized transcript never
  remounts a row mid-stream and loses scroll position.
- **Mid-turn composer state.** While a turn is streaming, the composer stays
  enabled, not disabled: a submitted prompt queues as the next turn rather than
  interrupting the current one, and is shown in the transcript in a pending
  "queued" state until the agent picks it up. This is distinct from the
  explicit Stop button (§7.3), which cancels the in-flight turn outright.
  Queuing (not interrupting, not blocking) is the default because ACP has no
  "insert into the middle of a turn" primitive; interrupting-to-redirect is
  just Stop followed by a new prompt.
- **Tool calls, two tiers in v1.** (1) A per-provider, per-tool-name bespoke
  widget table for the handful of tools worth custom rendering (Claude's
  Edit/Write/Bash/TodoWrite; Codex's patch/diff/bash), each wrapped in its own
  error boundary so one bad widget can't take down the transcript. (2) A
  generic `ToolKind`-driven fallback row (`read`/`edit`/`delete`/`move`/
  `search`/`execute`/`think`/`fetch`/`other`) for anything without a bespoke
  widget — the guaranteed baseline for the generic ACP adapter tier (§5.5).
  Suppress the generic row for a tool call already covered by a bespoke diff/
  edit widget so streaming never briefly shows a duplicate placeholder. *A
  third tier — a summarized burst/group card for large tool-call bursts and
  subagent groups — is real but secondary to getting these two solid; it
  ships in v2 alongside the subagent-tree work it's paired with (§12).*
- **Diffs.** ACP **v1**'s Diff is `{path, oldText, newText}` — render that with
  client-side line diffing and syntax-aware coloring; the richer structured `changes[]`
  (operation, old/new path) is an ACP **v2**-only shape, gated like the other v2 bullets
  above. Fall back to structural-only rendering when patch text is absent (binary/symlink
  changes still need a diff card, not a blank one).
  This is the same viewer §7.4 already specifies — a tool-call diff and a
  working-tree diff are the same component.
- **Display-only terminals.** A tool call's terminal content (as opposed to
  the user-opened terminals of §7.5) reuses the same terminal component,
  buffering partial UTF-8/ANSI escape sequences across output chunks rather
  than decoding chunk-by-chunk.
- **Plans, rendered twice from one truth.** ACP replaces a plan's entire entry
  list on every update, so there is exactly one current plan per session at
  any moment — never diff it client-side. Render it in two places from that
  same data: inline in the transcript at the point it was emitted (collapsible
  checklist, shimmering while the turn generating it is still active) and in
  a persistent per-session sidebar (grouped pending/in-progress/completed, a
  completion bar) so it stays visible after the user has scrolled away. Feed
  the same "N of M items left" figure into the attention inbox (§7.13). *The
  persistent sidebar ships in v2; inline plan rendering alone covers v1
  (§12).*
- **Subagents and nested tool-call trees (v2).** ACP has no native subagent
  concept — only a draft, unstable proxy-chains RFD exists. What is real today
  (Claude Code) is a vendor `_meta` field (`_meta.claudeCode.parentToolUseId`)
  that a provider adapter promotes into a first-class `parentToolCallId` via
  its `enrich()` hook (§5.5). Any item referenced as another's parent renders
  as a collapsible, recursively-nestable group: auto-collapsed with an
  auto-scrolling preview while a child is running, full expand on demand, and
  every child dispatches to its own native tier-1/2 renderer with no special-
  casing (a diff produced by a subagent looks exactly like a top-level diff,
  just indented). A session/provider that never populates a parent link (the
  generic ACP tier, and Codex until an equivalent signal is confirmed)
  degrades to a flat list automatically — the tree view is a rendering of the
  data, not a mode toggle. On a narrow viewport, replace inline nesting with a
  terse "last 3 tool calls + N more" summary that opens a detail view, since
  indentation does not scale under phone widths. *Ships in v2 (§12); v1 always
  renders the flat list.*
- **Tool-call permissions.** A FIFO queue, one focused card at a time,
  rendered inline at the tool call / composer site — never a blocking modal,
  since loombox is a multi-session cockpit and a modal on one session must not
  stop the user from watching another. Button set and verbs are provider-
  adapted through the same adapter module that owns the `enrich` hook (§5.5):
  e.g. Claude's Allow-once / Allow-all-edits / Bypass-everything / Allow-for-
  session / Deny versus Codex's Yes / Yes-for-session / Stop-and-explain (an
  abort, not a deny) — the generic ACP tier maps the protocol's own
  `options[]`/`kind` vocabulary (`allow_once`/`allow_always`/`reject_once`/
  `reject_always`) onto a plain Allow/Deny (+ "always") pair. Render fields off the
  request's `toolCall` (a `ToolCallUpdate` — title, rawInput, content, locations; ACP
  has no `subject` field) directly on the card, so the mobile approval card (§7.3)
  shows the real command or diff summary rather than one re-derived from the
  tool-call content array. Surface the session's permission mode right next
  to the queue so switching it pre-empts future prompts instead of clicking
  through each one.
  - *Cross-session surfacing:* the per-session FIFO queue is the single
    source of truth. The attention inbox (§7.13) shows a live, session-scoped
    view onto the same queue state, not a separate copy — resolving a request
    from either surface resolves it everywhere, and a request already
    resolved on another device is removed from the inbox rather than left to
    go stale.
  - *Nested visibility:* a pending permission request whose tool call sits
    inside a collapsed subagent group (§7.24 above) forces that group's
    ancestor chain open, and additionally always surfaces a copy of the card
    at the top-level composer site regardless of collapse state — a pending
    approval must never be hidden behind a fold.
  - *Multi-request ordering:* on Stop, every open request in that session is
    resolved as cancelled immediately (optimistic, don't wait for the agent's
    own update) — a spinner must never dangle past the moment Stop was
    pressed. On a plain Deny of one request while others from the same turn
    are still queued, the rest are left queued and surfaced one by one as
    normal (the agent decides whether to replan and its next tool calls, if
    any, generate their own requests) — loombox does not guess whether a deny
    invalidates a sibling request.
  - *Keyboard shortcuts:* per §7.3's cross-cutting shortcuts requirement, the
    focused permission card binds digit keys `1`..`n` to the request's own
    `options[]` in order, and `Esc` defers (leaves it queued, moves focus
    away) without resolving it.
- **Model, mode & reasoning effort.** One persistent bar next to the composer,
  not a settings modal, bound directly to the session's negotiated ACP config
  options: `model` and any `model_config` options (model-related parameters
  such as context size or speed/quality trade-offs, stabilized in ACP) and
  `thought_level` (kept as its own selector, a peer config category)
  rendered together near the model picker per ACP's own recommendation,
  `mode` as its own segmented control since it drives the permission behavior
  above, the context/cost meter (§7.9) anchored at the end of the same bar.
  Always re-render the full control set from the complete config-option list
  — on a user change or an unprompted `config_option_update` (e.g. an
  automatic fallback to a cheaper model after a rate limit, which should also
  land in the attention inbox, §7.13) — never patch one control in isolation.
  An unrecognized or future config-option category still renders generically
  rather than being hidden, since the schema explicitly reserves
  non-underscore-prefixed unknown category names for future ACP variants.
  Provider/agent choice stays locked once a session exists; switching provider
  is a new-session action.
- **Copy & export.** Every transcript item — a diff, a raw tool command/output,
  a thought, a message — gets a copy affordance (icon on hover/long-press),
  in both the bespoke-widget tier and the generic fallback tier. This is a
  small but heavily used affordance in every comparable tool (Zed's agent
  panel, emdash) and should not be an afterthought.
- **Cross-references.** §7.9's live *percentage* meter (not its cumulative
  cost figure — see §7.9) must exclude any `usage_update`
  attributable to a subagent tool call from the parent's number. §7.19's
  search should run over this same underlying event model with the CSS Custom
  Highlight API, so it works against a virtualized transcript without
  touching the DOM, and should explicitly document which collapsed item kinds
  it does or doesn't match inside. §7.3 gains its own new mobile-interaction
  details for this transcript (see §7.3); this section's
  widgets are built to honor them, not to restate them.

### 7.25 Rich input & attachments (images, local and over SSH)

Image content in an ACP prompt is a base64 content block traveling over the
same JSON-RPC channel the executing host already uses to talk to the agent
process — so "works over SSH" is not a new agent-transport feature to build.
The actual work is entirely on loombox's own side: getting bytes from the
client device to the executing host through the E2E relay, and each
provider's own hand-off quirk.

- **Attach (client, instant, no network).** Paste, drop, or file-pick produces
  an immediate local preview (an object URL plus a thumbhash placeholder) and
  a client-side magic-byte + size check that rejects an oversized or
  unsupported file before any upload is attempted. Defaults: 10 MB per image,
  20 images per prompt, png/jpeg/gif/webp identified by sniffed magic bytes —
  never by the file's declared `mimeType` or extension, since mobile pickers
  routinely misreport both (defaults follow happy's own image-handling limits,
  `packages/happy-server/sources/storage/processImage.ts` and
  `packages/happy-app/sources/hooks/useImagePicker.ts`).
  - *HEIC/HEIF (deferred past v1):* real client-side HEIC decode is not
    reliably available in a web PWA — Chrome and Firefox have no native HEIC
    decode path at all (a canvas `drawImage` of a HEIC blob simply fails);
    only Safari can decode it. happy's own HEIC handling runs through
    `expo-image-manipulator`, a React Native native module, which does not
    transfer to a browser context. v1 rejects a HEIC/HEIF file client-side
    with a clear "convert and re-upload" message; real conversion (a bundled
    WASM decoder, or server-side conversion) is revisited once it's clear how
    often the single user actually hits it from a camera roll.
- **Encrypt and upload (client, optimistic).** Encrypt the attachment
  client-side with the session's derived blob key (the same per-device E2E
  scheme as everything else, §8) and upload it to the relay's blob store,
  addressed by an opaque ref, ciphertext only, size-capped server-side as a
  second line of defense. Start this the moment a file is attached, not
  deferred until send, so the round trip is hidden behind ordinary typing
  latency — this matters most for a phone on cellular talking to an `ssh:`
  target. A tiny encrypted "file event" (ref, mimeType, name, dimensions,
  thumbhash — never the bytes) rides the normal session channel; the bytes
  themselves must stay off the live session/update fan-out entirely so a
  multi-megabyte blob can never starve another client's resync marker under
  the bounded-queue backpressure rule (§7.16).
  - *Upload failure & retry:* the composer blocks sending a prompt that has
    an attachment still mid-upload or failed; a failed or interrupted upload
    (a dropped phone connection mid-transfer) shows a per-attachment failed
    state with a manual retry action and auto-retries once on reconnect. The
    file event for that attachment is only ever sent once the blob upload has
    confirmed — a broken ref must never reach the agent.
- **Deliver to the executing host (v1: proxied, not a new device class).**
  The agent-supervisor (§5.6, always co-located with the target, `local` or
  `ssh:`) fetches the ciphertext by ref through the existing node↔supervisor
  control channel and decrypts it locally — the same connection already used
  for everything else the supervisor does, not a new direct supervisor-to-
  relay path. This is a deliberate v1 scoping choice: giving the supervisor
  its own independent E2E device identity and a direct connection to the
  relay's blob endpoint (bypassing the node) is a real future option — it
  would shave one hop of latency and is worth revisiting — but it's also a
  non-trivial addition to the single hardest open problem the spec already
  flags (§14, multi-device E2E key distribution), and it silently assumes
  every `ssh:` target host has its own outbound route to the public relay,
  which isn't true of a host only reachable via a jump host with egress
  firewalled to the node's IP. Defer that design to when multi-device E2E key
  distribution itself is tackled (§14), rather than deciding it implicitly as
  a side effect of the image feature.
- **Hand off to the agent (provider-adapted, always local IPC once
  decrypted).** The Claude Code adapter builds an inline base64
  `ContentBlock::Image`, gated on the session's negotiated `image` prompt
  capability, re-sniffing the actual bytes rather than trusting the declared
  mimeType — no filesystem write (verify at build time whether the chosen
  Claude Code ACP adapter actually advertises `session.prompt.image`, §10/
  §12). The Codex adapter **also builds an inline base64 image**: the current
  `codex-acp` adapter converts an image block into a `data:` URL exactly like Claude
  (verified against its source), so the two adapters' image hand-off is unified, not
  special-cased. A supervisor-owned temp file (outside the project/worktree, 0700 dir /
  0600 file, random name, deleted at end of turn, 24-hour sweep) is kept only as a
  **defensive fallback** for an adapter that genuinely requires a local path. Any
  generic ACP adapter without the `image` capability writes the same temp
  file and sends a `ContentBlock::ResourceLink` instead — protocol-guaranteed
  for every ACP agent, not a per-CLI text convention.
- **`@file` references are a different, cheaper surface.** A picker backed by
  the file-tree panel (§7.4) inserts a `ResourceLink`/`EmbeddedResource` for a
  file that already lives on the target — this costs nothing beyond the
  reference itself, since the agent reads its own filesystem directly. Only a
  file that originates on the client device (camera roll, clipboard) needs
  the pipeline above, for either target kind.

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

## 8. Security & trust model

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
- **SSH credentials never leave the node** that uses them. The relay and phone never
  hold the SSH key; the phone steers a session *through the relay protocol*, it does
  not connect to the devbox directly.
- **Self-owned push** (VAPID), no third-party push relay.
- **Agent guardrails & scoped secrets** (§7.17): a per-project permission/sandbox
  policy for what autonomous agents may run, and env/secrets scoped per project and
  injected only on the executing node — never sent to the relay or clients.
- **Secrets at rest on the node** use OS-native storage via a native keyring binding
  usable from a headless Node daemon (`@napi-rs/keyring`, not Electron `safeStorage`
  which is Electron-only) — macOS Keychain, libsecret/keyring on Linux; on a headless box with no keyring session, fall back to
  permission-scoped encryption tied to the node's own keypair. Covers SSH keys,
  provider tokens, and per-project secrets.
- **Provider credentials** (Claude Code/Codex tokens) are held per node/target, not
  shared through the relay; concurrent multi-session use respects the provider's own
  auth.
- **No telemetry by default.** loombox collects no usage analytics — your data stays
  yours; any analytics would be strictly opt-in.
- **Public-relay abuse limits:** per-IP connection/enrollment rate limits and a
  storage-exhaustion cap protect the public endpoint.
- **Public but locked-down relay:** reachable over the public internet via Caddy +
  Let's Encrypt, but useful only to authenticated, key-holding devices.
- **Transport-only fallback** is a *conscious* option, not a default: because the
  user is both relay operator and sole end user, a v0/spike may run transport-only
  (TLS + Tailscale WireGuard) before per-device E2E lands — but shipping v1 without
  E2E is a deliberate downgrade, to be chosen explicitly, never fallen into.

## 9. Self-host topology (the reference deployment)

- **Node on the devbox** (headless Debian) running agents with a `local` target,
  and/or a **node on the Mac** with `ssh:devbox`.
- **Relay on prodbox** (Docker + Caddy + Cloudflare-managed DNS), public subdomain,
  Tailscale available for the private path.
- **`mise`/PATH gotcha (must handle):** on a headless box, runtime managers (mise →
  node) and agent CLIs are not on PATH in non-interactive/SSH shells. The `ssh:`
  target's environment capture must source a login shell (or explicitly
  `eval "$(~/.local/bin/mise activate bash)"`) so `node`/the agent CLI resolve. A
  node with a `local` target on the devbox sidesteps this entirely (it runs in a
  normal login environment). Both paths must be handled and tested.
- **Relay data lifecycle:** a retention policy (TTL / size cap, prunable via a CLI) and
  a backup/DR line — a nightly encrypted dump to off-box storage with a tested restore.
  The relay is the sole copy of session history and the device registry, so this is not
  optional. The nightly dump also covers the Better Auth tables (`user`/`session`/`account`/`verification`) and the wrapped-AMK escrow blobs from §8 — without them every user's recovery-code bootstrap path is stranded.
- **Session ownership across nodes:** a session is owned by one node via a renewable
  **lease**; a second node may attach read-only while the lease is live and reclaim it
  on expiry (an explicit action in the PWA), so a Mac node and a devbox node never fight
  over the same supervisor.

## 10. Proposed tech stack (greenfield)

Greenfield, clean-room (no forks, no imported code from the four sources — design
inspiration only). Proposed, to be confirmed in the repo:

- **Node daemon:** TypeScript/Node (matches the ACP + agent-CLI ecosystem), packaged
  as a CLI/daemon; optional Electron shell for the desktop-local UI later.
- **SSH:** a maintained Node SSH library, with a pooled connection manager.
- **Relay:** TypeScript service (Fastify + a WebSocket layer), Postgres for encrypted
  blobs + metadata, Redis for fan-out/pubsub; shipped as a Docker image with a
  compose file for prodbox.
- **Client:** a PWA in **SvelteKit** (installable, offline-tolerant), wrapped with
  **Capacitor** for `apps/mobile`, so web and mobile are one codebase and consistent
  with the SvelteKit landing repo. (No Expo/React Native: those are native-first; a
  web-first product shares more by wrapping the same PWA.)
- **Protocol:** a versioned, Zod-typed wire schema shared across node/relay/client as
  one package. The protocol version is negotiated **once per connection** (like ACP's
  `initialize` handshake); relay/node/client declare a supported range at connect and
  the relay surfaces "update required" instead of failing silently (rollout order:
  relay → nodes → clients).
- **Crypto:** vetted primitives (tweetnacl/libsodium-class + AES-256-GCM), per-device
  ECDH key wrapping.
- **Agent-supervisor:** a small TypeScript/Node daemon deployable to any executing host
  (including remote `ssh:` hosts), owning agent PTYs and persisting transcripts.
- **Providers:** an ACP-generic backend on the **Agent Client Protocol (ACP)** reference
  types; Claude Code + Codex adapters in v1. Codex's ACP support is verified at build
  time — if incomplete, v1 ships Claude Code only and Codex lands once it's ready (§12).
- **Package manager / monorepo:** **pnpm** workspaces (see §10.1).
- **Testing / CI:** **Vitest** for unit/integration and **Playwright** for PWA e2e;
  every package ships tests from commit one; a **GitHub Actions** workflow gates merge
  on lint + typecheck + test.
- **Release / versioning:** **Changesets** + GitHub Releases (semver + changelog) across
  the monorepo; supervisor binaries are signed (§7.23).

### 10.1 Repositories & monorepo layout

Two repositories:

**`loombox`** — the product monorepo, a **pnpm** workspace. Proposed packages:

- `apps/web` — the web-PWA client.
- `apps/mobile` — the mobile app: the same SvelteKit PWA wrapped with Capacitor, later
  phase.
- `packages/node` — the orchestrator node daemon.
- `packages/supervisor` — the loombox agent-supervisor.
- `packages/relay` — the self-hostable relay server (+ its Dockerfile / compose).
- `packages/protocol` — the versioned Zod wire schema (shared).
- `packages/crypto` — E2E crypto primitives (shared).
- `packages/providers` — the layered ACP provider architecture: `core`
  (generic ACP session/message/tool-call/permission/config-option handling),
  `claude`, `codex`, `gemini` (reserved), and `generic` (fallback for any
  other ACP-speaking agent) — see §5.5.
- `packages/shared` — shared types and utilities.
- `tooling/` and `scripts/` — dev tooling and useful scripts.

**`loombox-landing`** — a separate repo for the marketing landing page, built in
**SvelteKit** (`@sveltejs/adapter-node`) and hosted on **prodbox** (Docker + Caddy on
`loombox.dev`), exactly like pitchbox and embertold. Kept out of the product monorepo.

## 11. Non-goals (won't, at least for v1)

- Team/multi-user collaboration, org permissioning, social features.
- A hosted/managed relay-as-a-service **is not a v1 goal** — v1 ships only the
  self-hosted relay. **Stated once, plainly, as the permanent guarantee:
  self-hosting stays free and possible for as long as loombox exists** — not
  a launch-only constraint, and not something a later edition erodes. §17
  specifies a planned, later, additive managed-cloud edition of the same
  codebase, deliberately deferred past v1–v3 and gated on the self-hosted
  AMK/account-login model surviving real use first (§14). Whether or when it
  ships, it can only ever run *alongside* the self-hosted path (§2/§3), never
  replace it.
- Matching emdash's ~30 or HAPI's 7 provider breadth.
- A full IDE / rich collaborative editor (only a viewer + diff + light edit).
- Copying any code from HAPI (AGPL-3.0) — design inspiration only.
- Vendor-locked voice.
- Full accessibility conformance (screen-reader/keyboard/contrast audits) beyond
  baseline semantic markup — deferred past v1, not ignored.

## 12. Roadmap (incremental versions)

Each milestone is a shippable increment; a fresh agent session builds them in order.

- **v0 — validation spike.** One node on the devbox, one Claude Code session in a
  worktree (`local` target), output relayed to a minimal PWA that can view and send
  a follow-up prompt. Transport-only over Tailscale, no E2E yet. *Goal: prove "see
  and steer a devbox session from my phone" end to end.* Acceptance: from a phone on
  the tailnet, start nothing but observe a running session and inject one prompt that
  the agent acts on. v0 data is disposable — no migration path to v1 is expected.
- **v1 — core cockpit.** Execution-target abstraction (`local` + `ssh:`) with guided SSH
  setup (autodetect from `~/.ssh/config` + persistent pooled connection) and automatic
  remote provisioning of the supervisor; multi-
  session + optional worktree + open-any-folder; relay with device auth; per-device
  E2E envelopes; account login (Google/GitHub OAuth via a self-hosted Better Auth
  instance on the relay) with account-scoped session-list metadata and a recovery-code-
  escrowed Account Master Key as the default new-device bootstrap (QR kept as the fast
  path) — the fix for "see my sessions without a QR every time"; public Caddy subdomain; integrated terminals (local + `ssh:`) and
  automatic/manual port forwarding on `ssh:` targets; PWA (session list, live view,
  steer, approve/deny tool calls, basic diff view); self-owned VAPID push with desktop + mobile presence-aware routing; persistent
  detached sessions via the loombox agent-supervisor (survive node/client restart on
  `local` and `ssh:` targets) with resume-on-reopen; a basic cross-project attention inbox;
  per-target concurrency caps; per-project env/secret injection; basic node/target
  health; providers Claude Code + Codex on ACP (Codex only if its ACP support is ready by then,
  else Claude Code only). Also in v1: a first-class agent-interaction transcript per §7.24 (append-by-id reducer for
  messages, thinking, tool calls, and plans; two-tier tool-call/diff rendering —
  bespoke widgets plus a generic `ToolKind` fallback; an inline FIFO permission
  queue with provider-adapted button sets, cross-session surfacing into the
  attention inbox, and nested-visibility/cancellation/keyboard-shortcut rules; a
  config-option-driven model/mode/reasoning-effort picker) — this is core
  interaction UX for v1, not later polish; client-side image attach with
  compression/format checks (HEIC/HEIF rejected with a clear message, real
  conversion deferred), gated on the negotiated ACP image capability and
  transported as an encrypted relay blob proxied through the existing
  node↔supervisor channel + ACP content block per §7.25, so it works identically
  on `local` and `ssh:` targets. Acceptance: run parallel sessions across a `local` and an
  `ssh:` target, steer any from the phone over the public E2E relay, with the SSH key
  never leaving the node.
- **v2 — trackers, git, editor, polish.** per-project choice of a native local tracker or a live external one (GitHub
  Issues/Projects v2, or Jira incl. sprints/boards/comments/transitions) with no local
  sync, via a pluggable `TrackerBackend` (three slices per §7.10) + a connected-accounts
  registry (§7.26) for linking multiple GitHub/Jira accounts pinned per project; AI-assisted git management (commit graph, branch tree, staged/unstaged,
  commits); MCP/plugin & agent configuration; usage/cost monitoring; file tree +
  integrated editor + richer diff review; device-switch polish; session
  reconnect/resume hardening (resident-daemon semantics); PR & CI lifecycle; test &
  verification runner; agent guardrails/sandboxing; session templates + project
  instructions + prompt library; session history/search + fork/replay;
  checkpoint/rollback; richer cross-project attention inbox & observability; subagent/nested tool-call tree rendering and the tier-3 tool-call burst/
  group summary card (§7.24, Claude-adapter-specific, degrading to a flat list
  elsewhere); a Gemini provider adapter module (§5.5); an expanded per-tool-name
  bespoke widget registry; a persistent plan sidebar; client-side transcript
  search via the CSS Custom Highlight API (§7.19, §7.24).
- **v3 — voice & reach.** BYO-key voice (clean-room); native mobile wrapper; more
  ACP providers.
- **Far future.** Multiple simultaneous devbox targets; **multi-agent collaboration**
  (planner/implementer/reviewer roles, or best-of-N racing a task with a pick-best);
  **scheduling and webhook-triggered/headless runs** (nightly maintenance, or a tracker
  ticket that auto-spins a session); a marketplace of tracker/importer extensions;
  optional team mode; structural (AST-aware) diffing; a secondary control channel
  (e.g. Telegram); a **managed-cloud edition** (§17) — the identical relay image, operated
  once by loombox-the-company, multi-tenant via `account_id` scoping of the
  same Better Auth column §8 already introduces — explicitly gated on v1's
  AMK/account-login model having survived a real self-hosted lost-device/
  rebuilt-relay drill (§14) before multi-tenant ops are layered on top.

## 13. Provenance & licensing

loombox is greenfield and MIT-licensed. It borrows **design only** from:

- **emdash** (Apache-2.0) — SSH/worktree/mise-PATH mechanics; provider-agnostic ACP.
- **Happy** (MIT) — relay + PWA architecture, E2E crypto primitives, push
  suppression.
- **Nimbalyst** (MIT client) — per-device E2E protocol shape, tracker-importer SDK
  pattern (and its anti-patterns to avoid: single-machine execution, closed server).
- **HAPI** (**AGPL-3.0**) — BYO-key voice *idea only*. **Do not copy or clone HAPI
  into the build environment.** A process gate (checklist/review step) enforces no
  AGPL contamination.

Apache-2.0 and MIT permit clean-room reuse of ideas; the deliberate choice to rewrite
rather than fork keeps licensing clean and avoids a permanent multi-upstream
maintenance burden.

## 14. Open questions & risks

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
- **Resident-daemon reconnect/resume** (session survives a fully-offline desktop)
  interacts with the "SSH cred stays on the node" rule; running the node on the
  always-on devbox is the clean answer and should be the recommended topology.
  Autonomous continuation keeps the agent alive via tmux/supervisor, but *notifying*
  while your PC is off requires the executing host to hold a relay connection — i.e. a
  resident node on that host (see §7.22).
- **PWA background push/voice limits** on iOS may motivate the native wrapper sooner.
- **Agent guardrail/sandbox model** on a headless box (how much isolation per session
  without a container per agent) is an open design point — agents run unattended with
  real credentials.
- **Resource scheduling policy** (how to throttle/queue many concurrent agents against
  the devbox's real CPU/RAM limits) needs defining.
- **Remote auto-provisioning trust** (§7.23): installing components on the remote must
  be transparent (show what it installs), idempotent, and verify the supervisor binary —
  never opaque remote code execution.
- **Provider ToS / rate limits:** many concurrent automated CLI sessions may hit
  subscription rate limits or ToS limits; check per provider before relying on heavy
  parallelism.
- Effort is real: greenfield + full E2E + public relay is the most ambitious of the
  approaches considered; the phased roadmap exists to keep it shippable.

## 15. Graduation & backlog (how this spec is used)

This spec graduates to two repos: **`loombox`** (the pnpm product monorepo, at
`~/Progetti/loombox`) and **`loombox-landing`** (the SvelteKit marketing site hosted on
prodbox), both private on GitHub and seeded from this file (see §10.1). From the
monorepo, a GitHub Project is populated so another agent session can build the product
autonomously:

- **Milestones** = the roadmap versions (v0 … v3).
- **Epics** = the major subsystems (node daemon, execution targets, relay, E2E
  protocol, SSH connection & remote provisioning, PWA client, ACP core & capability negotiation, provider adapters (Claude/Codex/Gemini/generic), agent transcript & interaction UX, rich input & attachments,
  integrated terminals, git integration,
  agent configuration (MCP/plugins), port forwarding, cross-project attention inbox,
  PR/CI lifecycle, test & verification runner, concurrency & resource governance,
  guardrails/sandboxing/secrets, account & login (OAuth via Better Auth, Account Master Key custody, device bootstrap), connected accounts / integrations registry, tracker integration, usage monitoring, session
  templates & project instructions, session history/search, checkpoint & rollback,
  editor/file-tree/diff, node/target observability, session persistence & resume,
  notifications, voice, multi-agent orchestration, scheduling/automation, monorepo
  scaffolding & CI, landing site (SvelteKit on prodbox), brand/design system). The `PWA client` epic owns the app shell (navigation, session
  list, device switch, offline action queueing, §7.3); `agent transcript & interaction
  UX` owns the §7.24 surface (reducer, thinking, tool cards, plans, subagent trees,
  permission queue, model/mode bar).
- **Labels** = area (`node`, `provisioning`, `relay`, `client`, `protocol`, `crypto`,
  `providers`,
  `terminal`, `git`, `mcp`, `editor`, `transcript`, `permissions`, `attachments`, `trackers`, `inbox`, `ci`, `testing`,
  `resources`, `security`, `observability`, `persistence`, `auth`, `accounts`, `landing`, `infra`, `voice`,
  `design`), type
  (`feat`, `bug`,
  `chore`, `spike`, `docs`), and priority.
- **Issues** = concrete, agent-executable tasks under each epic, ordered so v0 ships
  first and each later version builds on the last. P2 polish/hardening items threaded
  through the spec become lower-priority backlog issues.

The end state loombox is built to produce — agents autonomously working a GitHub
Project into incremental releases — is the same workflow used to build loombox itself.

## 16. Grounding & references (nothing left to chance)

A multi-agent grounding audit (10 areas, adversarially verified; full per-claim
evidence in `research/grounding-audit.md`) checked every mechanism against real source.
Most of the spec is grounded in the reference tools; the items below are the ones with
**no in-repo precedent** — each names the real external reference or example to build
against, so none is left to chance. Items marked *(novel)* have no precedent anywhere
and must be designed and tested fresh.

**Execution, supervisor & provisioning**
- Resident daemon (systemd) on Linux — hapi's `docs/guide/installation.md` systemd
  user-unit templates (`Type=simple`/`Restart=always`/`KillMode=process`) + `systemd.service(5)`.
- SSH-deploy-then-detach supervisor (survives disconnect) — POSIX `setsid`/`nohup` detach
  (or systemd `KillMode=process`); precedent: mosh / VS Code Remote-SSH persistent server. *(novel plumbing)*
- Idempotent re-provision on version bump — ACP `initialize.protocolVersion` handshake as the
  version-check pattern; the install-then-verify recipe is *(novel)*.
- Signed supervisor binary — **minisign** (pinned Ed25519 key, matches "pinned public key") or
  sigstore/cosign; distribute via GitHub Releases + checksums (hapi `release.yml` shows checksums).
- Auto port-forward — emdash `preview-servers/terminal-url-detector.ts` (PTY-output URL sniff + probe,
  not port-table scan) + `port-forward-tunnel.ts`.

**Relay, protocol & scale**
- Relay stack (Fastify + WS + Postgres + Redis) — happy-server `sources/main.ts` + `Dockerfile.server`.
- Compose file for prodbox — copy Lorenzo's own **pitchbox** compose overlays (happy-server ships k8s, not compose).
- Protocol version negotiated once per connection — ACP `initialize` handshake; carry it in Socket.IO `handshake.auth`.
- Fan-out backpressure — Node `stream` highWaterMark + ring buffer keyed by a `seq`, or adopt socket.io
  `connectionStateRecovery` (happy-server has the plumbing, disabled). *(pick one)*
- Session ownership across nodes — Postgres `pg_advisory_lock` (heartbeat + expiry) or Redis `SET NX PX` lock. *(novel for this app)*
- Relay backup/DR — `pg_dump --format=custom | age/gpg | rclone/restic` off-box on a systemd timer + a restore drill (Postgres backup docs). *(novel)*
- Retention — scheduled `DELETE … WHERE updated_at < now()-retention` or partition `DROP` (blob TTL: S3/MinIO lifecycle).
- Public-relay abuse limits — `@fastify/rate-limit` (per-IP) + a per-account storage-quota job. *(quota is novel)*

**Crypto, devices & secrets**
- E2E envelope crypto — nimbalyst `TrackerEnvelopeCrypto.ts`/`ECDHKeyManager.ts` (P-256/WebCrypto, AAD-bound) — pick ONE curve
  (don't blend with happy's X25519/tweetnacl); the spec's "ECDH P-256" is grounded in nimbalyst only.
- QR device pairing — happy `hooks/useConnectTerminal.ts` + `ui/auth.ts` (the audit's `authQRStart.ts` cite was wrong).
- Short-code pairing — **RFC 8628** (OAuth 2.0 Device Authorization Grant); no in-repo precedent.
- Revoke + rotate keys — compose happy `machinesRoutes.ts` DELETE with nimbalyst `archiveCurrentOrgKey`+`generateAndStoreOrgKey`;
  add a relay-rebuild re-enrollment integration test. *(composition is novel)*
- Secrets at rest — `@napi-rs/keyring` (headless Node; not Electron `safeStorage`); decide fail-closed vs 0600-file fallback.
- Self-owned VAPID push — grounded: hapi `hub/config/vapidKeys.ts` + `pushService.ts` (the `web-push` npm pkg) + RFC 8291/8292
  (Expo push in happy-server does NOT apply — web-PWA target).

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

**Agent interaction (ACP) — corrections applied**
- v1 Diff is `{path, oldText, newText}`; `changes[]`/`operation` is **v2** (fixed §7.24).
- Permission request carries `toolCall`, **no `subject` field** (fixed §7.24).
- ACP permission is agent-discretionary (**MAY**, not MUST) — hard guardrails/sandbox are the real enforcement (fixed §7.17).
- `usage_update` is session-level (no per-tool attribution) — subagent-exclusion is a client-side heuristic, flag it.
- Gemini ACP: the ACP registry lists Gemini CLI 0.50.0, but emdash drives Gemini via plain CLI, not ACP — **verify its ACP flag at build time** before promising the module.
- Tool-widget tiers grounded — nimbalyst `CustomToolWidgets/` + `ToolWidgetErrorBoundary.tsx`; the `ToolKind` generic-row rendering is new UI.
- Copy affordance — emdash `chat-ui/CopyButton.tsx`; keyboard shortcuts on permission cards are *(novel small UX)*.

**Providers, trackers, terminals, input**
- Generic ACP fallback tier — grounded in ACP baseline (`ContentBlock::Text`/`ResourceLink` + 4 permission kinds); the zero-code
  fallback *package* is a novel architectural choice (every reference pairs "speaks ACP" with a bespoke module).
- GitHub Projects v2 — GitHub GraphQL (`addProjectV2ItemById`, `updateProjectV2ItemFieldValue`); budget for field-option-ID lookups + GraphQL cost limits. *(novel)*
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
- Terminals over relay — hapi `hub/socket/handlers/terminal.ts` message shape (create/write/resize/close, keyed by session+terminalId) — **clean-room, AGPL** — + node-pty + `@xterm/xterm` + ssh2 drain/backpressure (emdash `ssh2-pty.ts`).
- Test runner — nimbalyst `playwright/testRunner.ts` (state shape); command auto-detection heuristic is *(novel)*.
- Image hand-off — grounded inline base64 for both Claude (`claude-agent-acp` `acp-agent.ts`) and Codex (`codex-acp` `CodexAcpClient.ts`); magic-byte sniffing via `file-type` npm; format allow-list from Anthropic vision docs.
- Offline composer outbox — IndexedDB outbox (NOT Background Sync — no iOS/Safari support). *(novel)*
- Actionable mobile push — Notifications API `actions[]` + `event.action` (MDN); iOS 16.4+ only. *(novel here)*
- Presence-aware per-session suppression — model on nimbalyst per-doc awareness (`CollabLexicalProvider.ts`) scoped per session. *(novel)*
- MCP per-server secret grant — *(novel: define ACL/approval semantics; reference tools store env inline per server)*.

**Build & client**
- SvelteKit PWA — `@vite-pwa/sveltekit` + hapi `web/src/sw.ts` as a hand-rolled SW example; needs a v0/v1 spike (adapter-node + PWA).
- Capacitor wrap — Capacitor official docs (`cap init`/`add`/`sync`); spike before the v3 mobile phase.
- Release/versioning — **Changesets** (`@changesets/cli` + action); deliberate departure from emdash/happy/hapi (none use it).
- Resource sampling — emdash `resource-monitor/resource-sampler.ts` (`pidusage`); disk-per-target via `check-disk-space`. *(disk novel)*

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
