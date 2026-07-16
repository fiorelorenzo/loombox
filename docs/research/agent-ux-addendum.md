# loombox spec addendum — agent interaction, provider architecture, rich input

Final, critique-applied version. Each block below is ready to paste into
`ideas/loombox/spec.md` at the placement noted. Sourced against the real ACP
schema (`schema/v1/schema.json`, stable — what Claude Code/Codex/Zed speak
today; `schema/v2/schema.json`, unreleased) and real code in emdash, happy,
hapi, nimbalyst, and Zed's agent panel as the ACP reference client.

Changes from the synthesis, per the critique (all applied, not just noted):

- The transcript reducer is now scoped to **ACP v1** (append-only `ContentChunk`
  streams keyed by `messageId`) as the v1 baseline; the v2 `UserMessage`/
  `AgentMessage`/`AgentThought` full-replace/patch model is called out
  explicitly as a *forward-compat addendum*, not baseline architecture,
  because v2's schema carries no published release yet.
- The `model_config is not yet stable` claim is removed — verified false:
  `docs/rfds/updates.mdx` shows the RFD moved to Completed and stabilized
  2026-06-24, and `model_config` is present in both `schema/v1/schema.json`
  and `schema/v2/schema.json` identically. The bullet now talks generically
  about unknown/future config-option categories instead.
- §7.9's revision is split: only the *live percentage meter* excludes subagent
  usage; the cumulative cost rollup that feeds §7.16's spend caps keeps it,
  so a runaway subagent still trips the cap.
- The fabricated §7.3 cross-reference (haptics, `pointer: coarse`, capped-height
  lists, a two-button-plus-overflow footer — none of which exist in §7.3 today)
  is removed from the cross-reference and turned into an actual, separately
  placed addition to §7.3.
- The supervisor-as-independent-E2E-device / direct-blob-connection design is
  **deferred**, with a note, rather than decided as a side effect of the image
  feature — v1 proxies attachment bytes through the existing node↔supervisor
  channel.
- HEIC/HEIF client-side conversion is **deferred** (no reliable canvas-based
  decode in a web PWA on Chrome/Firefox; happy's own HEIC handling is a React
  Native native module, not a browser API, so it doesn't transfer) — v1
  rejects HEIC/HEIF client-side with a clear re-upload message.
- Tier-3 burst/group summary cards move to v2, alongside the subagent-tree work
  they're actually paired with; v1 ships tiers 1 and 2 only.
- The redundant non-goal echo ("does not chase a large provider count") now
  cites §11 instead of restating it.
- An epic-boundary note is added so "agent transcript & interaction UX" and
  "PWA client" don't silently overlap.
- Seven missing-piece gaps are closed with concrete rules: mid-turn compose
  state, cross-session permission surfacing vs. the attention inbox, nested/
  collapsed-group permission visibility, queued-permission cancellation
  ordering, permission keyboard shortcuts, attachment upload retry, and
  transcript copy/export.
- Citations in this document use the real file paths verified against the
  cloned trees (`happy/packages/happy-server/sources/storage/processImage.ts`,
  `happy/packages/happy-app/sources/hooks/useImagePicker.ts` — not the
  nonexistent `ImageCompressor.ts`).

---

## Addition 1 — new §7.24: Agent transcript & interaction UX

**Placement:** insert as a new subsection after the existing §7.23 (SSH
connection setup & remote auto-provisioning) and before §8 (Security & trust
model). Does not renumber anything.

```markdown
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
- **Diffs.** Render the structured `changes[]` (path, operation, old/new path)
  unconditionally; layer syntax- and diff-aware coloring over the optional
  patch text when present; fall back to structural-only rendering when it is
  absent (binary/symlink changes still need a diff card, not a blank one).
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
  `reject_always`) onto a plain Allow/Deny (+ "always") pair. Render the
  request's structured `subject` (the referenced tool call, or a bare
  `command`/`cwd`) directly on the card, so the mobile approval card (§7.3)
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
  `thought_level` (kept as its own selector for backward compatibility)
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
  cost figure — see the §7.9 revision below) must exclude any `usage_update`
  attributable to a subagent tool call from the parent's number. §7.19's
  search should run over this same underlying event model with the CSS Custom
  Highlight API, so it works against a virtualized transcript without
  touching the DOM, and should explicitly document which collapsed item kinds
  it does or doesn't match inside. §7.3 gains its own new mobile-interaction
  details for this transcript (see the §7.3 addition below); this section's
  widgets are built to honor them, not to restate them.
```

---

## Addition 2 — §7.3 addition: mobile interaction details for the transcript

**Placement:** append as new bullets at the end of the existing §7.3 (Mobile /
web companion) section, after its current "Keyboard & command palette" bullet.
(These details did not previously exist anywhere in the spec; §7.24 above
references this addition rather than an already-specified §7.3.)

```markdown
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
```

---

## Addition 3 — §7.9 revision (subagent usage split: percentage vs. rollup)

**Placement:** append at the end of the existing §7.9 paragraph.

```markdown
Any `usage_update` attributable to a nested/subagent tool call (§7.24) is
excluded from a session's live context-fill *percentage* — folding it in
would make the meter visibly bounce between the parent's real context size and
a much smaller subagent one every time a subagent runs. Subagent usage is
still included in the cumulative cost figure and the per-project/provider
spend-over-time view, since that same rollup is what §7.16's spend caps
consume — a runaway subagent must still be able to trip a cost cap.
```

---

## Addition 4 — new §7.25: Rich input & attachments (images, local and over SSH)

**Placement:** insert as a new subsection immediately after §7.24 (and its
§7.3 companion addition), before §8 (Security & trust model).

```markdown
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
  §12). The Codex adapter writes the decrypted bytes to a **supervisor-owned
  runtime/state directory that is never inside the project's folder or
  worktree** (0700 directory, 0600 file, a random filename, deleted as soon
  as the consuming turn ends, with a 24-hour sweep as a crash safety net) and
  passes a local-path input item, since Codex's own surface takes a path, not
  inline data (verify Codex's actual requirement at build time too). Any
  generic ACP adapter without the `image` capability writes the same temp
  file and sends a `ContentBlock::ResourceLink` instead — protocol-guaranteed
  for every ACP agent, not a per-CLI text convention.
- **`@file` references are a different, cheaper surface.** A picker backed by
  the file-tree panel (§7.4) inserts a `ResourceLink`/`EmbeddedResource` for a
  file that already lives on the target — this costs nothing beyond the
  reference itself, since the agent reads its own filesystem directly. Only a
  file that originates on the client device (camera roll, clipboard) needs
  the pipeline above, for either target kind.
```

---

## Addition 5 — §5.5 revision (replaces existing body in full)

**Placement:** replace the current one-paragraph body of §5.5 (Architecture >
Provider layer) in full with this text.

```markdown
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
```

---

## Addition 6 — §10.1 revision (packages/providers layout)

**Placement:** replace the existing `packages/providers` bullet in §10.1's
monorepo package list.

```markdown
- `packages/providers` — the layered ACP provider architecture: `core`
  (generic ACP session/message/tool-call/permission/config-option handling),
  `claude`, `codex`, `gemini` (reserved), and `generic` (fallback for any
  other ACP-speaking agent) — see §5.5.
```

---

## Addition 7 — §12 roadmap revisions

**Placement (v1 bullet):** insert this clause into the existing v1 bullet,
right before the sentence "Acceptance: run parallel sessions across a `local`
and an `ssh:` target...".

```markdown
a first-class agent-interaction transcript per §7.24 (append-by-id reducer for
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
on `local` and `ssh:` targets;
```

**Placement (v2 bullet):** append this clause to the existing v2 bullet, just
before its closing period.

```markdown
; subagent/nested tool-call tree rendering and the tier-3 tool-call burst/
group summary card (§7.24, Claude-adapter-specific, degrading to a flat list
elsewhere); a Gemini provider adapter module (§5.5); an expanded per-tool-name
bespoke widget registry; a persistent plan sidebar; client-side transcript
search via the CSS Custom Highlight API (§7.19, §7.24)
```

---

## Addition 8 — §15 revision (epics, epic-boundary note, and labels)

**Placement:** in §15's Epics parenthetical list, replace the single
`provider/ACP layer` item with the two items below, and add the two new epics
alongside them. In §15's Labels list, add the three new labels below. Add the
boundary note as a new sentence directly after the Epics bullet.

```markdown
Epics — replace `provider/ACP layer` with:
- `ACP core & capability negotiation`
- `provider adapters (Claude, Codex, Gemini, generic)`

Epics — add:
- `agent transcript & interaction UX`
- `rich input & attachments`

Epic boundary note (new sentence after the Epics bullet): the `PWA client`
epic owns the app shell — navigation, session list, device switch, offline
action queueing (§7.3); `agent transcript & interaction UX` owns everything
specified in §7.24 — the reducer, thinking, tool cards, plans, subagent trees,
the permission queue, and the model/mode bar. The composer and permission-card
*layout* is transcript-epic work; the shell it's mounted inside is PWA-client
work.

Labels — add:
- `transcript`
- `permissions`
- `attachments`
```

---

## Notes on what was deferred (and why), for the record

- **Supervisor-as-independent-E2E-device + direct blob connection** — real,
  worth doing, deferred to when §14's multi-device E2E key distribution is
  tackled head-on. v1 proxies through the existing node↔supervisor channel
  (Addition 4).
- **Full HEIC/HEIF client-side conversion** — no reliable browser-native path
  today; v1 rejects with a message, revisit with a WASM decoder or
  server-side conversion once usage data justifies the cost (Addition 4).
- **Tier-3 burst/group summary cards + subagent tree rendering** — both real,
  both v2, both riding together since the burst card's main use case (large
  subagent groups) doesn't exist in v1's flat-list world (Additions 1, 7).
- **Persistent plan sidebar** — v2; inline plan rendering alone is sufficient
  for v1 (Addition 1).
- **Gemini provider adapter module** — v2, reserved package slot exists from
  v1 (Addition 5).
```
