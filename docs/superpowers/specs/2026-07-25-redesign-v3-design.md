# loombox redesign v3 — design spec ("one sidebar, one timeline, one Style")

Status: agreed with Lorenzo (2026-07-25). Builds on
`docs/superpowers/specs/2026-07-25-redesign-v2-design.md` (the Style/token architecture,
the icon system, the shared primitives), which shipped in #494-#501. v2 got the bones
right and the finish wrong: this spec is the finish, plus the three structural calls v2
deferred.

The evidence base is a real audit, not a reading of the source: the production build was
driven in Chromium against a real relay + fake node (`apps/web/tests-e2e/`'s harness) and
captured in 17 screenshots across Deck/Loom/Studio × dark/light × 390/1024/1440/1920.

## 0. What the audit found first: three functional bugs

These were fixed before any styling work, because the audit could not proceed past them.

1. **The shipped PWA could not decrypt anything.** `packages/crypto/src/session-envelope.ts`
   called `Buffer.from(...)`; Vite does not polyfill `Buffer` for the browser build, so
   every `openJson` — session private metadata, every `session_update`, every permission
   request, terminal frames, target fs listings — threw `Buffer is not defined`. The UI
   rendered "This device's key can't read these sessions" for a perfectly valid AMK. This
   is also why every session-flow Playwright spec sits at `test.describe.fixme` with a note
   blaming the headless devbox. Fixed with a `Buffer`-free `packages/crypto/src/base64.ts`
   used by `session-envelope` / `amk-handoff` / `pairing` / `recovery-escrow`, and
   `browser-safety.test.ts` extended to forbid `Buffer` the same way it already forbids
   `node:crypto`.
2. **Four user preferences were clobbered on every load.** In Svelte 5 `onMount` is itself
   a user effect scheduled in declaration order, so `+page.svelte`'s four persistence
   `$effect`s — declared above `onMount` — wrote each compile-time default over the stored
   value before `onMount` read it back. A self-hoster's Relay URL, the pinned Drawer, and
   the Sessions column's width + collapsed state never survived a reload. Fixed with a
   `preferencesRestored` gate.
3. **Escape closed nothing.** `Overlay.svelte` bound `onkeydown` to the backdrop element,
   which only fires when focus is already inside the overlay — true for `Dialog` (focus
   trap), false for the account menu and the Drawer, the two surfaces v2 added Escape for.
   Moved to `window` with a module-level stack so nested overlays close one layer per press.

## 1. Decisions made (with Lorenzo)

- **One sidebar.** The icon rail and the Sessions column merge into a single sidebar.
- **One Style.** Deck only, dark + light, art-directed. `loom.css` / `studio.css` and the
  Style axis are deleted, not kept as dead options.
- **One transcript metaphor.** A full-width timeline with a left gutter (Zed / Claude Code
  register), not chat bubbles. The blue right-aligned user bubble goes.
- Kept from v2 and not reopened: the azure accent + presets, the Warp & Weft `BrandMark`,
  Inter + JetBrains Mono, `WovenLoader`, the shared `Button`/`IconButton`/`Card`/`Dialog`/
  `Overlay`/`EmptyState`/`ErrorNotice` primitives, the Drawer-as-single-content-surface IA.

## 2. Defects this spec closes

Grouped by surface; every one was observed in a screenshot of the running build.

### Header
- `A1` `.connection-dot` is an 8.8px unlabeled dot, green whenever things are fine — it
  spends the app's highest-attention pixels saying nothing.
- `A2` The account trigger renders the raw account id in monospace, truncated. No avatar,
  no name, no email.
- `A3` A two-item popover (Appearance / Sign out) dims the entire app behind a 40% scrim.
- `A4` The three-zone header's centre zone (the target-health dot cluster) is empty in the
  common case.
- `A5` Global errors render as a bare `<p class="error">` ("Failed to fetch") with no
  context and no action, instead of `ErrorNotice`.

### Sidebar
- `B1` Two overlapping navigations. The rail's "Sessions" item does nothing visible above
  1024px (it only toggles the sheet on narrow viewports).
- `B2` "Add target" (secondary) and "New session" (primary) sit side by side in a 288px
  column and both wrap onto two lines.
- `B3` Every session row carries a permanently visible second button ("Target status") that
  squeezes the title down to a single character.
- `B4` The status badge prints the raw enum (`PERMISSION_REQUIRED`) and overflows the row.
- `B5` `provider · projectPath · targetId` on one truncated line; no grouping by default.
- `B6` No search/filter in the list (only ⌘K).
- `B7` 9px rail labels that wrap onto two lines; "Command" in the rail and the ⌘ icon in the
  header are the same action under two names.
- `B8` The collapse control is still the literal `«`/`»` glyph (v2's wave-2 TODO).
- `B9` On mobile the sessions sheet's backdrop covers the tab bar, so the tab that opened it
  cannot close it.

### Canvas
- `C1` `.transcript-toolbar { justify-content: space-between }` with four children spreads
  Export / Files / Terminal / Config across the full canvas width.
- `C2` That toolbar duplicates three of the Drawer's six tabs, themselves reachable from the
  rail.
- `C3` No max measure: ~150-character lines at 1440px.
- `C4` Mixed metaphors — user bubble right, agent card full-width.
- `C5` `USER` / `AGENT` / `THOUGHT` uppercase labels inside the content; the thought row is a
  half-width pill aligned to nothing.
- `C6` Tool calls are inconsistent: `read`/`search` show a kind chip, `edit` does not; status
  is grey body text rather than a visual state.
- `C7` A permission's `rawInput` is printed as raw JSON instead of the command.
- `C8` Native `<select>` elements sit beside a custom segmented control in one bar.

### Drawer
- `D1` Six text tabs wrap onto two rows; the active one is distinguished only by an underline.
- `D2` The Targets panel repeats its own title plus Refresh/Close inside a drawer that already
  has a title and a close button.
- `D3` Drawer, account menu and dialogs share one scrim with no depth hierarchy.

### System
- `E1` Deck / Loom / Studio differ only in hue; they do not vary density, type scale or shape
  as v2's spec promised.
- `E2` Light theme surfaces do not separate (`#eef1f5` canvas vs `#ffffff` surface vs
  `#e2e6ec` rail, hairlines at 14%).
- `E3` Icons do not carry their concept: Sessions is a speech bubble, Inbox a down arrow,
  Command a cross that reads as "add".
- `E4` Density is inverted — 56px session rows, a cramped canvas.

## 3. The target design

### 3.1 Sidebar (replaces rail + Sessions column)

One column, `--sidebar-width` (default 288px, drag-resizable 240–420px, persisted), with a
collapsed icon-only mode at 56px (persisted). Top to bottom:

1. **Brand row** — `BrandMark` + wordmark, and the collapse toggle as a real icon.
2. **Primary action** — a full-width `New session` primary button with a `⌄` split that
   opens a small menu: *Add target*, *Connect a node*. Never two competing CTAs.
3. **Filter** — a compact search input filtering the session list by title / project /
   target (client-side, same `fuzzy.ts` the palette uses).
4. **Session list** — grouped by project by default (collapsible group headers with a
   count), rows as specified in 3.2.
5. **Spacer**, then **secondary nav**: Inbox (with count), Nodes & targets (with health
   dot), Settings. Compact 32px rows, icon + label, same visual language as a session row
   but muted.
6. **Account row** — avatar (initial in an accent-tinted square), display name or email,
   `⋯`. Opens an anchored popover (no scrim) with Appearance, Settings, Sign out.

The `Sessions` rail item disappears (the sidebar *is* the sessions surface). `Command`
disappears from the nav — ⌘K is a keyboard affordance advertised in the search input's
placeholder and in the header icon, not a third nav entry.

Narrow viewports (`< --bp-tablet`) keep the existing bottom tab bar, but the sessions sheet
gets a close affordance that is not covered by its own backdrop (B9).

### 3.2 Session row

Two lines, 44px, hover-revealed actions:

```
● │ Refactor the relay routing table            2m
  │ loombox · ssh:build-server                  ⋯
```

- Leading `StatusDot` with the session status tone; `pulse` only while `working`.
- Title on one line, ellipsised, `--text-body`.
- Meta line: project basename `·` target id, `--text-muted`, `--text-small`, middle-truncated.
- Right: relative activity time, replaced on hover/focus by a `⋯` `IconButton` opening the
  row menu (Target status, Copy session id, …). No permanently visible second button.
- Status is communicated by the dot plus a **human label** in the row's `title`/`aria-label`
  (`Awaiting your input`, `Needs permission`, `Working`, `Error`, `Exited`) — never the raw
  enum, and never a badge wide enough to overflow the row.

### 3.3 Header

Two zones, not three:

- **Left** — the selected session's title, then a muted `project · target` breadcrumb.
- **Right** — the session's own controls (Files / Terminal / Config as `IconButton`
  toggles), `⌘K`, and nothing else. Both the account menu and the brand move to the sidebar.
- **Connection state** is rendered only when it is *not* healthy: a compact chip
  (`Reconnecting…` / `Offline`) with a retry action, using `--color-warning` /
  `--color-danger`. When `status === 'open'` the header shows nothing. The green dot is gone.
- Global errors use `ErrorNotice` with an action, placed under the header, not a bare `<p>`.

### 3.4 Canvas and transcript

- `.items` gets `max-width: 90ch; margin-inline: auto;` — long-form prose stops running to
  1500px, code/diff blocks keep their own wider treatment via a `--measure-wide` escape.
- The transcript toolbar's `space-between` becomes a right-aligned `IconButton` cluster, and
  the Files/Terminal/Config duplicates are removed (they live in the header per 3.3).
- **One timeline metaphor.** Every item is a full-width row with a fixed left gutter
  (`--gutter: 2rem`) carrying the role glyph. No bubble, no right alignment, no uppercase
  role label in the content flow; the role is the gutter glyph plus an `sr-only` label.
- **Thoughts** collapse into a single quiet gutter row (`Thought for 1s`, expandable),
  aligned to the same gutter as everything else.
- **One tool-call anatomy** for every kind: `[kind icon] title … [status]`, expandable body.
  The kind chip is either always present or never; status is a `StatusDot` + label, not grey
  body text. `rawInput` renders through the widget registry (command, diff, path list) and
  falls back to a formatted key/value list — raw `JSON.stringify` output is never shown.

### 3.5 Controls

A new `ui/Select.svelte` primitive (button + anchored listbox, keyboard operable, `Overlay`-
backed, tokens only) replaces every native `<select>`: `ConfigBar`, `NewSessionDialog`
(provider), and any config panel that uses one. One control language per bar.

### 3.6 Drawer

- Tabs become icon + label on a single row that scrolls horizontally rather than wrapping;
  the active tab gets a filled surface, not just an underline.
- Panels lose their internal titles and their own Close buttons (`TargetStatusView`'s
  header collapses to just its Refresh action) — the drawer owns the title and the close.
- Z-index tiers get real separation: popover (no scrim) < drawer overlay < modal.

### 3.7 Style, tokens, icons

- `loom.css` / `studio.css`, `$lib/style.ts`, its tests, the Appearance Style section and
  the `data-style` attribute are deleted. `deck.css` collapses into the base palette layer.
  `tokens.css` keeps owning structure.
- Light is re-tuned for real separation: a cooler canvas, a genuinely lighter surface, a
  distinctly darker sidebar, and hairlines that read on paper (≈18/28% rather than 7/14%).
- Icons that fail to carry their concept are redrawn on the same 20×20 / 1.6px grid:
  `sessions` (stacked rows), `inbox` (tray), `command` (⌘ loop), plus the missing
  `collapse-chevron` use sites that still render `«`/`»`.

## 4. Waves

1. **Contracts (inline, first):** this spec, the token/icon/label contracts below, the three
   bug fixes (done).
2. **Parallel, by file ownership:**
   - shell — `+page.svelte` (sidebar, header, canvas, drawer, session rows, errors/empties)
   - transcript — `MessageItem`, `ToolCallRow`, `GenericToolRow`, `tool-widgets/*`,
     `PlanCard`, `DiffViewer`
   - controls — new `ui/Select.svelte`, `ConfigBar`, dialogs' selects
   - style — `tokens.css`, `deck.css`, delete `loom.css`/`studio.css`/`style.ts`,
     `AppearanceSettings`, `style-reference`
   - attention — `PermissionCard`, `PermissionQueueBar`, `AttentionInbox`,
     `TargetStatusView`
   - icons — `icons/icon-paths.ts`, `icons/Icon.svelte`
3. **Verification:** the Playwright audit harness re-run across both themes and four
   viewports, full `pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm test`, PR.

### Cross-slice contracts

- **Tokens are the only interface.** No component hard-codes a colour, radius, duration or
  spacing value. Every token name in `tokens.css` / `deck.css` today keeps its name; the
  style slice may only change *values* and may add `--measure`, `--measure-wide`,
  `--gutter`, `--sidebar-width`.
- **Icon names** are fixed and additive-only: `sessions`, `inbox`, `targets`, `command`,
  `settings`, `close`, `collapse-chevron`, `chevron-down`, `search`, `more`, `plus`,
  `copy`, `attach`, `file`, `folder`, `terminal`, `pin`, `refresh`, `check`, `alert`.
  Consumers pass `name` + optional `class`; nothing else.
- **Session status labels** live in one exported map in `$lib/copy.ts`
  (`SESSION_STATUS_LABELS`), human-readable, reused by the sidebar, the palette and the
  inbox. No surface re-derives its own wording from the enum.
- **`Select` API:** `{ value, options: { id, label, hint? }[], onChange, label, disabled?,
  size?, dataTestId? }`. Renders a button + anchored listbox; no native `<select>` anywhere
  in the app afterwards.
- Behaviour is preserved everywhere: existing Vitest specs must stay green as written; where
  a test asserts a removed affordance, the test moves to the replacement, it is not deleted.

## 5. Out of scope

New protocol messages, node/relay/supervisor changes, the mobile Capacitor shell beyond
responsive behaviour, new accent presets, and any change to the crypto boundary beyond the
`Buffer` fix already made.
