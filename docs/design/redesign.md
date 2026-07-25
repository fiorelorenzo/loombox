
# loombox redesign: "Warp Deck" — a unified design-language spec

## 0. Synthesis and thesis

Three directions were judged against the actual codebase. Scores (workflow-fit / modern-original / implementability):

- **Cockpit ("Warp Deck")** — 7 / 7 / 6. Best overall balance: keeps the rail → list → canvas → drawer cockpit shape the product actually needs (multi-session, multi-target monitoring), grounds its motion vocabulary in the real `tokens.css`/`WovenLoader`, and self-identifies the one genuinely risky refactor (panel consolidation) as its own isolated PR.
- **Calm ("Single Thread")** — 5 / 7 / 7. Cheapest to build and most disciplined on restraint (accent-as-meaning, elevation-with-a-job, one focus-ring token), but its "recede everything but one thread" thesis actively fights loombox's spec framing of parallel sessions and node/target monitoring — it was marked down hardest exactly where this product differs from a single-thread chat app.
- **Tactile ("Live Loom")** — 7 / 8 / 4. The most original motion vocabulary (formalizes `WovenLoader`'s `stroke-dasharray` technique into a reusable "thread-draw" primitive for anything that fills or reveals) but its implementability score is the lowest of the three: several of its component merges (folding `QueuedPromptBar` into `MessageItem` as a variant, rewriting `MessageItem`'s DOM for real bubble alignment inside a merged component) reach further into markup/prop contracts than a restyle should, risking the "behavior and tests must be preserved" constraint.

**Warp Deck is Cockpit's structure, disciplined by Calm's restraint, animated by Tactile's thread-draw technique.** Concretely, three grafts on top of the Cockpit base:

1. **From Calm:** accent is reserved for meaning, never chrome; status signaling on list rows defaults to a quiet left-edge stripe, not a tinted card, so a long inbox or target list stays scannable instead of busy; every panel converges through one elevation ladder with a documented job per tier (now written into `/style-reference` as a real section, not left implicit).
2. **From Tactile:** `WovenLoader`'s existing `stroke-dashoffset` weave technique is formalized into **thread-draw**, a second reusable motion primitive (not a new component, not a change to `WovenLoader` itself) used for progress meters, the active-nav indicator, and the permission card's one-time border reveal — this is the concrete answer to "extend its motion language app-wide."
3. **A fix to Cockpit's own biggest workflow gap:** collapsing Files/Terminal/Config/Targets into one single-tab drawer loses the ability to watch terminal output and node health while steering a session — a real desktop pattern in the current stacked-aside layout. Warp Deck keeps the one-tab-at-a-time drawer as the *default* (mobile/tablet, and desktop below 1280px) but adds a **pinned mode** at ≥1280px: the drawer can be docked as a persistent third column instead of an overlay, so a power user can keep Terminal open while switching sessions. Target health additionally gets a compact, always-visible cluster of `StatusDot`s in the header (not buried in a drawer tab) so node/target state is glanceable without opening anything.

The result stays unmistakably not-Nimbalyst (no kanban, no card-grid-of-agents dashboard) while fixing the score sheet's actual complaint about Cockpit: monitoring doesn't get worse, it gets a documented escape hatch.

Everything below is additive on top of what's locked: `#3b9df7` azure accent, the 6-preset theme system + `deriveAccentPalette`'s hover/active/subtle/contrast formula, the Warp & Weft `BrandMark`/`BrandLockup`, Inter (`--font-ui`) + JetBrains Mono (`--font-mono`), and `WovenLoader`'s two variants/two sizes/reduced-motion contract — none of these are rewritten, only extended.

---

## 1. Layout model

Four zones, one shell (`AppShell`, realized inside `+page.svelte`'s markup, not necessarily a new route-level component — see Issue 1):

```
┌──────┬────────────────┬─────────────────────────────┬───────────────┐
│ Rail │  Sessions       │   Transcript (canvas)        │  Drawer        │
│ 56px │  (18rem,        │                               │  (overlay      │
│ icon │  resizable,     │                               │  ≤1279px,      │
│ only │  collapsible    │                               │  pinnable      │
│      │  to 3.5rem      │                               │  column        │
│      │  "selvage")     │                               │  ≥1280px)      │
└──────┴────────────────┴─────────────────────────────┴───────────────┘
```

- **Rail** (far left, 56px, icon-only): Sessions, Inbox (badge count), Nodes & Targets (badge on unhealthy, plus the always-visible compact `StatusDot` cluster described above), Command (`⌘K`), Settings — pinned bottom. Selected item gets a 2px accent left-bar, never a filled background, keeping the rail visually quiet. This replaces the scattered `inboxOpen`/`targetStatusOpen`/`appearanceSettingsOpen`/`notificationSettingsOpen` header toggle buttons with one nav idiom.
- **Sessions column**: same data/model, wrapped in a drag-resizable width (persisted to `localStorage`, default `18rem`), collapsible to a 3.5rem icon-only "selvage rail" (status dot + first-letter avatar, tooltip on hover) via `Mod+B` or an edge control. Sessions cluster under their `targetId`/node as a collapsible group header (mono, small-caps) when more than one target is active.
- **Canvas**: the transcript, unconstrained width (unlike Calm's 672px cap — tool-call/diff review is a core desktop task and must not be squeezed). Internal content still uses a consistent `--space-lg` rhythm and a real chat/tool visual tier (see §6).
- **Drawer**: replaces the six independently-toggled inline panels (Files, Terminal, Config, Inbox, Target-status, Settings) with tabs of one component. Below 1280px it's an overlay (doesn't reflow the canvas); at ≥1280px it can be pinned as a persistent column (toggle, persisted per-user). Only one tab visible at a time in overlay mode; pinned mode allows two docked tabs stacked vertically for power users who need e.g. Terminal + Targets simultaneously.
- **Responsive collapse**: below 1024px, rail becomes a bottom tab bar (4 icons + `⌘K` as a 5th "search" tab). Below 768px, Sessions becomes a full-height sheet reached via a header "Sessions" affordance, dismissed on pick. Below 768px, Drawer becomes a bottom sheet (`60vh`, swipe-down or explicit close) instead of a column. Below 480px, the composer's mini-toolbar (mode/attach/context meter) collapses under a single "···" expand affordance.

Breakpoints (new tokens, `lib/viewport.ts` gets siblings to its existing `NARROW_VIEWPORT_BREAKPOINT_PX = 480`):

```
--bp-mobile: 480px    /* existing NARROW_VIEWPORT_BREAKPOINT_PX, reused */
--bp-tablet: 768px
--bp-desktop: 1024px
--bp-wide: 1280px     /* drawer pin threshold */
```

**Header** collapses from centered-lockup + absolutely-positioned-actions (fragile, no collision handling) to a standard 3-zone sticky bar: left = `BrandMark` only once signed in (full `BrandLockup` reserved for sign-in/onboarding, where nothing competes for attention) + current session title once selected; center = the compact target-health `StatusDot` cluster; right = connection-status dot, `⌘K` trigger, one account/settings menu (sign out, appearance, notifications, nodes & targets, inbox — icon button + dropdown). That is 3 persistent zones instead of the current 8-button wrap.

---

## 2. Motion system — "Shuttle Motion," extending the weave

New token layer in `tokens.css` (strictly additive):

```css
/* Durations */
--duration-instant: 80ms;   /* press feedback */
--duration-fast:    140ms;  /* hover, toggle, focus ring, status crossfade */
--duration-base:    220ms;  /* drawer, card entrance, transcript item arrival */
--duration-slow:    360ms;  /* onboarding step transitions, page-level narrative */
--duration-weave:   640ms;  /* reserved: permission-card entrance, thread-draw fills */

/* Easings */
--ease-beat:     cubic-bezier(0.4, 0, 0.2, 1);     /* default: toggles, crossfades, symmetric motion */
--ease-shuttle:  cubic-bezier(0.32, 0.72, 0, 1);    /* entrances: fast-out, settles — drawer/sheet slide */
--ease-tension:  cubic-bezier(0.16, 1, 0.3, 1);     /* dialogs: snap-then-ease */
--ease-exit:     cubic-bezier(0.4, 0, 1, 1);        /* exits: accelerate out, never lingers */

/* Focus */
--color-focus-ring: var(--color-border-strong);     /* hairline shift, NOT accent — accent stays reserved for meaning */
--focus-ring-width: 2px;
--focus-ring-offset: 2px;
```

Named transitions, each with one fixed job (documented on `/style-reference` under a new "Motion" section, next to the existing `WovenLoader` gallery):

| Name | Where | Motion | Timing |
|---|---|---|---|
| **beat-in** | new transcript item, list row appearing | 4px upward slide + fade | `--duration-base` / `--ease-beat`; staggered 20ms/item, capped at 5, **only** on initial history load — never on live streaming appends, which get a single un-staggered beat-in |
| **shuttle-in / shuttle-out** | Drawer open/close, mobile Sessions sheet, bottom sheets | translate from the panel's edge + fade | in: `--duration-base`/`--ease-shuttle`; out: `--duration-fast`/`--ease-exit` |
| **thread-lift** | modal open (Dialog primitive: palette, new-session, add-target, file picker) | backdrop fades independently at `--duration-fast`/`--ease-beat`; card `scale(0.97→1)` + fade | `--duration-base` / `--ease-tension` |
| **tension-press** | button/row `:active` | background darkens ~8%, `scale(0.98)` — no bounce, no overshoot; bounce is reserved for nothing in this product | `--duration-instant` / `--ease-beat` |
| **status-crossfade** | a status dot/badge changing state (working → permission_required, health flipping) | color/background crossfade, no snap | `--duration-fast` / `--ease-beat` |
| **thread-draw** | anything that *fills* or *reveals*: CPU/RAM/disk meter bars, the permission card's one-time top-edge border sweep, the active-nav/active-tab indicator, focus-ring appearing | `stroke-dashoffset` (SVG) or an equivalent `background-position`/`clip-path` sweep — the literal technique already used by `WovenLoader`, formalized as a second reusable primitive rather than a new motif | `--duration-weave` / linear for continuous fills, `--duration-weave`/`--ease-tension` for one-time reveals (permission card border) |

`WovenLoader` itself is **not modified** beyond one additive prop (`variant="skeleton"`, Issue 3) reusing its existing warp/weft stroke geometry for transcript-loading placeholder rows — same file, same two locked variants, same reduced-motion contract, one more use of geometry that already exists.

All durations collapse to `0ms` / transforms to `none` under `prefers-reduced-motion: reduce`, in one global rule in `tokens.css` (zeroing the `--duration-*` custom properties), exactly matching `WovenLoader`'s existing per-component contract — one reduced-motion story for the whole app, not a patchwork.

---

## 3. Elevation ladder (gives the existing, mostly-unused `--shadow-*` tokens a documented job)

| Tier | Background | Border | Shadow | Used by |
|---|---|---|---|---|
| `flat` | `--color-surface` | `--color-border-subtle` | none | agent message rows, generic list rows, hairline-divided rows |
| `raised` | `--color-surface-raised` | `--color-border` | `--shadow-sm` | session rows (selected), tool-call rows, `PlanCard`, target cards, MCP/plugin config cards |
| `floating` | `--color-surface-raised` | `--color-border-strong` (+ warning/accent ring on state) | `--shadow-lg` | `PermissionCard`, Dialog, Drawer (overlay mode), Command Palette |

This becomes a new documented section on `/style-reference` (currently absent). Status color usage on list rows (inbox items, target health) defaults to a **left-edge stripe**, not a full tinted background — per Calm's discipline — so a long list stays scannable; `PermissionCard` is the one deliberate exception, since it is meant to interrupt and earns the full `floating` tier plus the thread-draw border sweep.

---

## 4. Component treatment

New shared primitives in `lib/components/ui/` (closing the "zero shared components" gap):

- **`Button.svelte`** — `primary` (solid accent fill, `accent-contrast` text), `secondary` (1px `border-strong`, transparent), `ghost` (text-only, underline on hover), `danger` (danger border/text). All get `tension-press` on press, `--duration-fast` hover shift, `--color-focus-ring` focus (never accent).
- **`IconButton.svelte`** — 32px hit target (44px under `(pointer: coarse)`, the existing convention), `aria-pressed` for toggle state (accent-subtle bg + accent border when active). Replaces the six near-identical `.inbox-toggle`/`.target-status-toggle`/etc. rulesets in `+page.svelte`.
- **`Card.svelte`** — `elevation: 'flat' | 'raised' | 'floating'` prop mapping to §3. Everything currently hand-rolling `border + radius + background` composes this.
- **`Dialog.svelte`** — shared chrome (backdrop + `thread-lift` panel + header/body/footer slots + Esc/backdrop-click/focus-trap) for `CommandPalette`, `NewSessionDialog`, `AddTargetWizard`, `FileReferencePicker` — once, instead of four hand-rolled near-duplicates.
- **`EmptyState.svelte`** — dimmed `BrandMark` (14% opacity, 4rem) + one-sentence explanation + one primary `Button` CTA slot. Used identically by empty sessions, empty inbox, empty targets, pre-select transcript.
- **`ErrorNotice.svelte`** — `Card elevation="raised"` + danger-subtle tint + message + a `retryable` boolean prop (secondary Retry button vs. plain fatal text).
- **`StatusDot.svelte`** — color + optional pulse (via thread-draw) while `working`, `status-crossfade` on state change, proper reduced-motion fallback. Shared by session rows, the header's target-health cluster, and `TargetStatusView`.

**Rows** (session list, inbox items, target cards): quiet hairline-divided rows, not boxed cards by default; selected/active state is a 2px left accent bar + subtle background tint (echoing a highlighted thread on a warp, not a "selected card" pattern).

**Inputs**: composer becomes an auto-growing `<textarea>` (1–8 rows, Enter sends / Shift+Enter newline), bringing it to parity with `NewSessionDialog`'s existing textarea. Flat style, no inner shadow; focus = `--color-focus-ring` border strengthening via thread-draw, not a colored glow.

---

## 5. Icon system

A small hand-drawn SVG set (20×20 viewBox, 1.5px stroke, rounded caps/joins), matched to `BrandMark`'s stroke weight so icons read as part of the same drawn system as the logo rather than a bolted-on library. `currentColor` throughout. Covers: sessions, inbox, nodes/targets, files, terminal, settings, command, send, attach, copy, check, close, chevron, warning, retry, stop. Replaces the raw unicode glyphs (`⧉ ✓ ▸ ▾ ☑ ☐ ×`) and the all-text-pill toolbar.

---

## 6. Major surfaces reshaped

- **Transcript** — fixes the dead `align-self` bug by making `MessageItem`'s root the actual flex item driving alignment (role-driven `justify-content`), giving `user` turns a real right-aligned `accent-subtle` bubble (max-width 70ch) against left-aligned `agent`/`thought` rows. Tool calls, diffs, and plans stay full-canvas-width (`raised` tier) — a deliberate tier signal: chat is conversational and bubble-bound, tool output is structural and wide. New items animate with `beat-in`; a tool call finishing streaming gets a single `thread-draw` border pulse (accent → neutral) as its "done" signal.
- **Composer** — auto-growing textarea; `AttachmentBar` collapses to a paperclip `IconButton` that only expands into a chip row once something's attached; `ConfigBar`'s mode toggle + context/cost meter move into a slim toolbar row directly above the composer. `QueuedPromptBar` becomes a `state="queued"` styling of the same bubble treatment (dashed accent ring) rather than an independently-maintained look-alike.
- **Permissions** — `PermissionCard` promoted to `floating` tier, gets the one-time `thread-draw` top-edge border sweep on mount (640ms, once, never looping — distinct from the continuous `working` weave), option buttons get keycap-style shortcut chips. `PermissionQueueBar` keeps its correct one-at-a-time FIFO model unchanged.
- **Node/target status** — moves into the Drawer's "Targets" tab (pinnable at ≥1280px) *plus* the always-visible compact header `StatusDot` cluster, so losing the drawer doesn't mean losing at-a-glance health. Meter bars switch from a flat `width` transition to `thread-draw`'s traveling sweep.
- **Onboarding** — `OnboardingGate`/`RecoveryCodeCard`/`RecoveryCodeEntryForm` adopt `EmptyState`'s dimmed-`BrandMark` language; step transitions (`choose` → `first-device`/`new-device`) get the `--duration-slow` page-level crossfade instead of an instant `if/else` swap. `/device` reuses the same shell language.
- **Terminal** — `InteractiveTerminal` (the xterm canvas itself, untouched) moves into the Drawer's "Terminal" tab, inheriting `shuttle-in`/`shuttle-out`, pinnable alongside Targets on wide desktop.
- **Settings** — Appearance/Notifications/Push consolidate into the Drawer's "Settings" tab (or the account menu), reachable from the header's single account menu instead of two always-visible header buttons. Preset-swatch markup, radiogroup, and custom-hex input in `AppearanceSettings` are preserved as-is, re-skinned onto `Button`/`IconButton`.
- **Command palette** — reskinned onto `Dialog`, `thread-lift` entrance, leading glyphs from the icon set per row instead of text tags.
- **Transcript loading** — between selecting a session and `transcript.items` populating, show `WovenLoader variant="skeleton"` placeholder rows instead of a bare spinner line, so "history decrypting" reads distinctly from "genuinely empty."

---

## 7. Rollout discipline (risk mitigation, carried from all three source concepts)

The Drawer/rail consolidation (six independently-toggled `+page.svelte` booleans → one `activeDrawer` state, plus the header collapse) is the single highest-leverage move and the single riskiest refactor — it changes markup structure and Svelte state in the file every other surface also touches. It ships **first, alone, as Issue 1**, test-first, before any per-surface visual polish lands on top of it. Per-surface issues thereafter should touch their own component files only; the two exceptions that still touch `+page.svelte` (Sessions rail, Composer) are explicitly sequenced into their own later waves rather than run in parallel with each other or with Issue 1, to avoid merge collisions in the app's largest file.
