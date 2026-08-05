# loombox next to Zed — a complete read, 2026-08-05

Written against loombox v0.5.0 (`6d88562`, tag `v0.5.0`) running on the local dev loop,
and against zed-industries/zed `main` read on the same day. Zed is GPL-family and
loombox is MIT clean-room, so nothing here is copied: this is mechanisms, values and
behaviour, described, with the file that proves each one.

The companion artifact `index.html` (build it with `node build.mjs`) holds every choice
that is Lorenzo's to make. This document is the reasoning behind it, plus the list of
work that needs no decision and went straight to the board.

---

## 0. The honest framing

Zed is an editor that grew an agent panel. loombox is an agent cockpit that has never
had an editor. That is not a gap to close by imitation: three quarters of what makes
Zed feel like a developer tool has nothing to do with editing, and the quarter that
does (buffers, multibuffers, hunk-level review) is exactly the part where loombox's
architecture differs on purpose, because our agent writes into a worktree on a remote
node rather than into a buffer the client owns.

So the useful question is not "how do we look like Zed". It is: which of Zed's
ingredients are portable to a client that never holds the file, and which of our own
capabilities does the current UI hide.

Three of those ingredients turn out to be portable and cheap: the colour ground, the
density, and the action-plus-binding model. Two are portable and expensive: the review
surface and the context picker. Two cannot be ported at all: GPU text rendering and
zero-latency access to the filesystem.

---

## 1. The look

### 1.1 The direction of layering is inverted

Zed's One Dark, verified in `assets/themes/one/one.json`:

| surface | Zed One Dark | loombox today (`deck.css`) |
| --- | --- | --- |
| window ground / title bar / status bar | `#3b414d` | bg `#0a0c0f` |
| panels (project, agent) | `#2f343e` | surface `#0e1114` |
| the content well (editor) | `#282c33` | canvas sits on bg |
| the chrome rail | n/a (chrome IS the ground) | rail `#08090b`, the darkest thing on screen |
| border | `#464b57` opaque | `rgb(255 255 255 / 16%)` alpha hairline |
| hover | `#363c46` fill step | mostly border and opacity changes |
| selected | `#454a56` fill step | 2px accent bar plus faint tint |

Two structural differences, not taste differences:

1. **Zed puts the content at the bottom of the stack and floats the chrome above it.**
   loombox does the opposite: the rail is darker than the canvas, so the chrome reads
   as a hole rather than as a frame. In Lorenzo's screenshots of Zed the eye lands on
   the thread because the thread is the darkest, most saturated surface in the window.
   In loombox at 1728px the eye lands nowhere.
2. **Zed's dark is a blue-grey with real chroma at roughly 25% lightness. loombox's dark
   is near-black at roughly 5%.** Near-black forces every separation to be carried by
   alpha hairlines, which is why the current UI needs three shadow tiers to express a
   layer ladder that Zed expresses with three background values and no shadows at all.

This is decision **A1**. It is the single change with the largest visual return, and it
is a token-layer change: `deck.css` plus the shadow usage, not a component rewrite.

### 1.2 Density

| measure | Zed | loombox today |
| --- | --- | --- |
| chrome text | `TextSize::Default` = 0.825rem ≈ 13.2px | 15.2px (`typography.css` base) |
| code / buffer | 15px monospace | 13.6px (`--text-code-size`) |
| default button height | 22px (`ButtonSize::Default`) | 32px, 44px under a coarse pointer (`IconButton.svelte`) |
| list row | in the 22–24px register | 40px (`--nav-row-height`) |
| top chrome | title bar plus a 22px status bar | 48px topbar, no status bar |
| spacing | 4px grid, with a 0.75× / 1.0× / 1.25× density multiplier | fixed 9-step scale, no multiplier |

Note the inversion that matters: **Zed's UI text is smaller than its code text; ours is
larger.** Zed treats chrome as furniture and code as the subject. We treat prose as the
subject, which is defensible for a transcript, and then apply the same generosity to the
session list, where it costs a third of the sidebar.

Decision **A2**. The cheap version is chrome-only: rows and controls tighten, transcript
prose does not move.

### 1.3 Monospace as a signal

Zed is sans in the chrome and mono in the buffer, but every identifier a developer
scans — path, branch, host — sits in a context where mono is already the norm. loombox
uses JetBrains Mono only inside code, diffs, the terminal and a few data fields. The
project path in our topbar is Inter. Small thing, large effect on whether the window
reads as an instrument. Decision **A4**.

---

## 2. Chrome and layout

### 2.1 There is no status bar, and we have more to say than Zed does

Zed's status bar is a permanent line of state: dock toggles and diagnostics counts on
the left, cursor position, language, indentation on the right. Nothing there is
essential, and yet removing it would make the window feel like a document viewer.

loombox has state that is genuinely load-bearing and currently either hidden or
scattered: relay connection, node and target health, session lifecycle (queued,
starting, working, awaiting input, permission required, disconnected, error — all of
them already on the wire), context and cost, queued session count, build identity. Today
these live in the topbar's right cluster, inside `ConfigBar`, or nowhere. Decision
**B1**.

### 2.2 One canvas, no tabs

Zed's centre is a pane with tabs; the agent thread is one of them, files and diffs are
others, and any of them can be split. loombox's centre shows exactly one session and
nothing else; files open in a right-hand panel tree without a viewer. Lorenzo's own
screenshots show him working with `README.md` and a preview tab open next to the thread.

This is the largest structural question in the artifact (**B2**), and it is the one with
the worst mobile story, which is why it is a decision and not a proposal.

### 2.3 The empty state is 70% of the window

Measured on the running app at 1728×1080: with a fresh session the canvas is a void with
a floating composer in it. Zed fills the same space with thread history and keyboard
hints. Decision **B4**.

---

## 3. The thread

### 3.1 Feature-by-feature

| capability | Zed | loombox today | evidence |
| --- | --- | --- | --- |
| streaming text and thoughts | yes, thoughts have a three-state display setting | yes, paced reveal, one global expanded boolean | `text-pacer.ts`, `MessageItem.svelte`, v8 B2-1 |
| markdown, code, syntax | yes | yes, stable-prefix streaming parse, lazy grammars | `markdown.ts` |
| tool cards | icon, title, status, disclosure, truncated output, bespoke widgets for edit/terminal/fetch/search/plan | one-line rows, three bespoke widgets (edit/write diff, bash, todo), classified generic row | `tool-widgets.ts`, v7 C1-1 |
| plan | collapsible step tree | flat card, replaced wholesale per update | `PlanCard.svelte` |
| permissions | inline, flat or dropdown options, pattern variant, modes auto-answer | FIFO queue, allow/reject once/always, undo linger, digit keys | `PermissionCard.svelte`, `PermissionQueueBar.svelte` |
| **turn-level edit review** | Edits bar with file count and ±lines, per-file rows, Reject All / Keep All, multibuffer review with per-hunk control | **nothing** — diffs live only inside the tool card that made them | `EditWriteWidget.svelte` |
| **@-mentions** | files, symbols, threads, skills, rules, diagnostics, drag-drop, paste | **placeholder promises it, picker not wired** | composer placeholder in `+page.svelte` |
| **slash commands** | yes, including MCP prompts | **no** | — |
| **follow mode** | yes, plus an "agent is editing this" affordance | no | — |
| **checkpoints / fork / rewind** | yes | filed, not built | #268, #603 |
| token and cost | session ring, warning at 85% of context | session meter in `ConfigBar`, no per-tool attribution | `ConfigBar.svelte` |
| notifications when backgrounded | OS notification and sound | web push, attention inbox | `push-notifications.ts` |

### 3.2 The review gap is the one Lorenzo will feel first

Every screenshot he sent shows the Edits bar. It answers a question our UI cannot
answer at all: *what did this turn change, in total?* Right now you reconstruct it by
scrolling the transcript and opening each edit card.

The honest complication: Zed can offer Keep All / Reject All because the editor owns the
buffer and applies the edit itself. Our agent writes into a worktree on the node, so
reject means reverting on disk, which is the git checkpoint work (#603, #268). That
splits cleanly into a read-only summary we can build now and a keep/reject that has a
prerequisite, which is exactly how decision **C1** is framed.

---

## 4. Agents, MCP and policy

### 4.1 Zed's model, compressed

- Any ACP binary can be an agent: `agent_servers.<name> = { command, args, env,
  default_mode, default_config_options }`. Claude, Codex and Gemini are entries of that
  same shape, not special cases.
- MCP servers are project-scoped settings with two shapes, stdio and http, and stdio
  carries a `remote` boolean deciding which host runs the process.
- Two separate concepts govern tools: **profiles** decide which tools exist for a thread
  (per-tool booleans plus per-MCP-server toggles), **tool permissions** decide the
  approval mode (confirm / allow / deny) with `always_allow` and `always_deny` regex
  lists, addressing MCP tools as `mcp:<server>:<tool>`.
- MCP coverage: tools yes, prompts yes as slash commands, resources listed but unusable,
  sampling and elicitation not at all.
- Remote MCP over SSH is broken in Zed by their own admission (their issue #34402): the
  `remote` flag assumes the same binary at the same path on both machines.

### 4.2 loombox's model, compressed

- Two agents in the registry (Claude Code, Codex) plus test providers, chosen at session
  creation and immutable after. No way to add a binary.
- MCP config exists twice and does nothing: client-side per-project records in
  `localStorage` (`mcp-server-store.ts`, six quick-add presets and a custom form in the
  Config panel) and node-side config plus secret grants (`mcp-config-store.ts`, #187,
  #189). **No server is ever launched and no MCP tool ever reaches an agent** (#211,
  #627).
- Policy exists node-side as per-project command and network globs
  (`permission-policy.ts`) with no user interface. Request-time approval is the only
  control a user actually has.
- Config options (model, thinking, mode) are agent-declared per session and persist
  nowhere.

### 4.3 Where we are better positioned than Zed, if we choose it

Zed's remote-MCP problem is a consequence of a laptop-first architecture bolted onto
SSH. We already run a node process on the target with a session worktree, a secret
store and a supervisor. Deciding that an MCP server runs *next to the worktree* is not
a workaround for us, it is the natural placement, and it makes a filesystem or git MCP
server actually correct instead of pointed at the wrong machine. That is decision
**D2**, and it is the one place in this whole review where we can be straightforwardly
better rather than merely equal.

---

## 5. Speed

### 5.1 What Zed's speed is made of

GPU scene graph rendering to Metal/Vulkan/DirectX, a glyph atlas instead of text layout,
no DOM, no GC, everything virtualized, and no blocking work on the UI thread. Published
keystroke-to-pixel around 2ms, cold start 0.4–0.6s. Two of those four are unavailable to
any browser client and one of them (zero-RTT access to the files) is unavailable to any
remote client by definition.

### 5.2 What we are leaving on the table anyway

| technique | loombox today | file |
| --- | --- | --- |
| transcript windowing or `content-visibility` | neither; every item ever received stays mounted | `+page.svelte:3439` |
| decrypt off the main thread | no, `crypto.subtle` on the main thread | `relay-client.ts`, `packages/crypto/src/aead.ts` |
| batched decrypt of a burst | no, one envelope at a time | `relay-client.ts` |
| history refetch after a reconnect gap | no, resubscribe only | `relay-client.ts` |
| terminal write flow control | no, unbounded `xterm.write` | `InteractiveTerminal.svelte` |
| paced reveal | yes, 32ms ticks, 2–35% of backlog | `text-pacer.ts` |
| memoized streaming markdown | yes | `markdown.ts` |
| lazy syntax grammars | yes (#574, #600) | `markdown.ts` |

The first row is the one that decides whether an hour-long session stays usable on a
phone. The paced reveal is the one that decides whether a fast agent *feels* fast, and
it is currently tuned for safety. Decisions **E1** and **E2**; the worker question is
**E3** and has a real threat-model dimension, since moving decryption into a worker
moves AMK-derived key material into a second context.

---

## 6. Keyboard

Zed: every capability is a named action, keymaps are JSON with context predicates
(`Editor && vim_mode == normal`, ancestor matching with `>`), the palette fuzzy-matches
the entire action registry and prints each action's binding beside it, and multi-key
sequences have a one-second window. The palette is not a feature, it is the
discoverability mechanism for the whole application.

loombox: `⌘K` opens a palette over sessions plus, measured live on v0.5.0, exactly two
actions — "Open attention inbox" and "Open nodes and targets". The inbox has `j`/`k` and
digit shortcuts, a permission card takes digits and `Esc`. There is no action registry,
no binding shown anywhere in the UI, and no user keymap. Section **F**.

---

## 7. What loombox already has that Zed does not

Worth keeping in view while reading the rest, because these are the reasons not to
simply become Zed:

- **Sessions that keep running when the client is closed**, on a machine that is not the
  one you are looking at. Zed's agent dies with the window.
- **A phone client** on the same protocol, with push notifications and an attention
  inbox that spans projects.
- **A relay that cannot read anything** — per-session, per-target and per-project keys
  derived from an account master key, so the server is a router, not a reader.
- **Tracker integration**, native and live (GitHub/Jira), inside the same window as the
  agent.
- **A node per machine with a supervisor**, which is why remote MCP placement is a
  design choice for us and a bug for them.
- **Multi-target sessions**: local and `ssh:` hosts, with provider availability probed
  per target.

Nothing in the parity work should cost any of these.

---

## 8. Defects found while measuring, not filed before

Verified on the running dev loop, not inferred:

1. **A session that never got an agent is indistinguishable from one waiting for you.**
   Two brand-new sessions on a local target: the node logged `dropped prompt_inject …
   it has no live agent`, and the client showed no error, no spinner and no state, while
   the sidebar and the inbox both said "Awaiting you" / "Needs attention". The machine
   has 96 cores, so the concurrency gate was not the cause. Whatever the root cause, the
   client-side hole is its own defect: failures on the node are invisible in the UI.
2. **The terminal printed a line of `$$$$…` before the first prompt on a *local*
   target**, which is the half of #704 that was recorded as not reproduced.

---

## 9. How this splits

**Needs Lorenzo:** everything in `index.html` — A1–A4 (the look), B1–B4 (chrome), C1–C6
(the thread), D1–D5 (agents, MCP, policy), E1–E3 (speed), F1–F3 (keyboard).

**Needs nobody:** the defects in §8, the transcript's missing `content-visibility`
floor, batched decrypt, reconnect history refetch, terminal write flow control, and the
board hygiene that comes with a new workstream. Those went to the board directly, under
the Zed-parity epic.
