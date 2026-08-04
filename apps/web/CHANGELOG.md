# @loombox/web

## 0.1.8

### Patch Changes

- d6fa86b: Add the Badge and Row UI primitives, give Button arbitrary data-_/aria-_ passthrough, and migrate the safe call sites off their hand-rolled duplicates

  `Badge` replaces four slightly-different hand-rolled badges (MCP server config's secret badge, the target picker's kind/unreachable badges, and the target status view's kind/agent-health badges — the last of which now composes the real `StatusDot` instead of redrawing it). `Row` is the new shared leading/content/trailing list-row shape, adopted first by the attention inbox. `Button` now accepts arbitrary `data-*`/`aria-*` attributes without letting a caller override the props it already owns, which is what let the permission card's overflow toggle move onto it. Also migrated: the add-target wizard's back link, the onboarding choice cards (now `Card` + `Button`), the diff viewer's outer card, and the recovery code card's now-unnecessary wrapper div. Both new primitives are covered on `/style-reference`.

- 9379bde: Give the composer a visible resting surface and a real focus ring

  The composer textarea had no border, no background, no padding and no
  radius (`+page.svelte:4509-4519`), and the one hairline in the whole footer
  belonged to `.canvas-footer`, shared with the plan card, the queued-prompt
  bar and the permission card. Against that, the composer read as plain text
  run against the page background rather than an input.

  Worse, it had no focus indicator at all. A comment at the old
  `:4528-4531` claimed "the focus ring lives on the strip", but no
  `:focus-within` rule targeting the composer existed anywhere in the file.
  At-rest and focused screenshots were byte-identical (md5 match), on both
  desktop and phone: clicking into the composer changed nothing on screen,
  a WCAG 2.4.7 failure.

  `.composer-field` (the textarea plus its controls row: attach, pickers,
  the context/cost figures, Send) now carries a border, `--color-surface-raised`,
  `--radius-md` and real padding, the same vocabulary `ui/TextArea` already
  gives the inbox reply box and the New Session dialog fields. A
  `:focus-within` rule on that same box uses the existing focus-ring token,
  so the ring stays lit while the textarea, the attach button or a picker
  inside the strip holds focus. Send moves from `variant="secondary"` to
  `primary`, so the most-used action in the product is no longer the
  quietest button on the screen.

  The composer's own textarea stays borderless and transparent: its surface
  is the field box around it now, and a second nested border would double
  the chrome. Nothing about the docked-field layout changes, the composer
  still ends the timeline aligned to the same role gutter every transcript
  row uses.

- 3a839c4: Add Windows and Linux electron-builder targets, with icons generated from the same mark

  `apps/desktop/electron-builder.yml` gets a `win` block (NSIS installer plus a portable
  build, `assets/icon.ico`) and a `linux` block (AppImage plus deb, `category:
Development`, `assets/icons`), alongside the existing `mac` block. `package:win` and
  `package:linux` join `package:mac` in `apps/desktop/package.json`.

  Every new icon is generated, not drawn: `gen-brand-assets.mjs` now also emits
  `assets/icon.ico` (rasterized PNG sizes packed into one `.ico` via `png-to-ico`, since
  `@resvg/resvg-js` only renders PNG), the Linux icon set `assets/icons/<N>x<N>.png`
  electron-builder's linux target reads, and a colored (azure) tray glyph pair
  (`assets/tray-icon-azure{,@2x}.png`) alongside the existing macOS template pair. The
  template PNGs themselves are untouched.

  `createTray`'s call site (`src/main/index.ts`) now picks the platform-appropriate tray
  icon via a new pure `pickTrayIconPath` (`src/main/tray-icon.ts`): the macOS `Template`
  image on darwin, which the OS tints itself, and the colored render everywhere else,
  since Windows and a dark Linux panel apply no tinting at all.

  CI coverage for all three platforms is a follow-up (#567).

- 8177b63: Give the mode segments a role a screen reader can read

  `ConfigBar`'s mode control (Auto | Plan) was a `role="group"` wrapping two
  plain `Button`s, with the current mode marked only by a background tint via a
  `selected` class. A screen reader heard "Auto, button. Plan, button." with no
  way to tell which one was current, the one fact the control exists to carry.

  It is now a `role="radiogroup"` of `role="radio"` segments with `aria-checked`
  and a roving `tabindex` (WAI-ARIA APG's radio group pattern): Tab enters the
  group once, landing on the checked segment, and Left/Up and Right/Down move
  both the focus and the selection, wrapping at the ends.

  I picked radiogroup over the topbar panel switch's `aria-pressed` (`Button`'s
  `pressed` prop from the earlier topbar fix) because the two controls mean
  different things. Mode is mutually exclusive and always has exactly one value,
  which is what a radio group is for. The panel switch is not: `toggleDrawer` in
  `+page.svelte` closes the open panel on a second click of its own segment, so
  "none selected" is a real, reachable state there, which is exactly what
  `aria-pressed` (independently on/off, legitimately all-off) describes and a
  radio group cannot. The panel switch keeps `aria-pressed`; I am not touching
  it here, and I do not think it needs to change either, since it is not a
  radio group by nature. `Button` gained plain pass-through `role`,
  `ariaChecked`, `tabindex` and `onkeydown` props to carry this without a
  hand-rolled `<button>` inside `ConfigBar`, so the segmented-control idiom
  stays one shared primitive; every existing call site is unaffected.

  `ConfigBar.test.ts` now asserts the selected mode through the accessibility
  tree (`getByRole('radio', { checked })`), not the class name, which is what
  let this ship unmarked.

- a98b97c: Put the task title first in the New session dialog and make the starting prompt optional. The form now reads Title, Agent, Workspace, Starting prompt, and the title is the field the dialog focuses on open: what identifies a session on the board is the task, not the first thing you happened to say to the agent. The starting prompt drops its `required` mark, shrinks from six rows to three, and its help text now says it can be sent later from the composer instead. Pressing Create with everything blank creates a session titled after the project folder, with no prompt sent at all (previously the dialog sent an empty string). `RelayClient.createSession` already typed `prompt` as optional and only sent the follow-up when non-empty, and the node already fell back to the project folder's basename for an empty title, so this is a dialog-only change.
- 7a5d6a0: Move Nodes into Settings, give Settings real section navigation

  Nodes & targets was a sidebar destination competing with Inbox for
  attention, even though it is setup, not somewhere you go while working:
  you visit it to add a target, connect a node, or find out why one is
  unhealthy. It now lives inside Settings as its own section, alongside
  Appearance, Notifications and Push. `sidebar-destinations` carries Inbox
  alone; the mobile tabbar drops its Nodes item too.

  Settings outgrew a flat `<h2>` stack once a fourth, differently-shaped
  section (infrastructure with its own actions and live polling, next to
  three per-device preference panels) moved in, so `SettingsPage` gets real
  section navigation: a left sub-nav at `--bp-tablet` and above, a
  horizontally-scrolling segmented control below it.

  Two things had to survive the move rather than get dropped silently:

  - The health dot `hasUnhealthyTarget` used to light on the sidebar's Nodes
    row moved onto the account-menu trigger and its "Settings" entry, so an
    unhealthy target is still visible without opening Settings. It is a
    boolean-driven dot, not an inbox item, so it can't accumulate one per
    poll and clears the moment every target recovers.
  - The ⋯ "Target status" deep link (`openTargetStatus`) still lands on the
    right target, highlighted — it now switches to Settings with the Nodes
    section selected instead of its own destination.

  The account-menu entry reads "Settings" instead of "Appearance &
  settings", and the command palette gains "Open nodes and targets" now
  that Nodes is one click deeper than before.

  `docs/superpowers/specs/2026-07-25-ia-v4-design.md` gets an amendment note
  recording that Nodes is no longer a primary destination, since its §3.1
  listed it as one.

- a9dcef0: Give the Files and Terminal panels a bounded wait and a real failure state

  Both panels sat on an indefinite spinner when a node stopped answering. The
  Files panel's loading branch (`FileTreePanel.svelte`) had no failure path at
  all, and the terminal (`InteractiveTerminal.svelte`) initialised
  `status = 'opening'` and only ever left it once the PTY handshake completed. A
  node that had died looked exactly like one that was briefly slow, forever.
  The v6 audit hit both with a fake node that never answers: the panels just
  said "Loading…" and "Connecting…" and stayed there.

  Both now bound the wait to 10 seconds, matching every other request-shaped
  `RelayClient` default. A directory or a terminal still waiting when its own
  timer fires gets a retryable `ErrorNotice`, worded to match what the shell
  already says elsewhere: "the node may be asleep, offline, or on an older
  relay" is `DirectoryPicker`'s exact phrasing from issue #505, not a third
  convention. For the terminal the wording is deliberately careful, since a
  timeout there does not mean the PTY open failed, only that this client
  stopped waiting: "this isn't necessarily a failure, we simply stopped
  waiting". A late real answer, however long after the deadline, still lands
  and clears the failure state, and a directory or terminal that resolves
  just under the deadline never shows an error at all.

  Retry re-requests rather than only dismissing the notice. The Files panel
  calls `onExpand` again, the same lever `expandDirectory`'s own doc comment
  already describes for retrying a directory that came back `'error'`. The
  terminal asks the node to close whichever attempt just timed out and opens
  a genuinely new one, since `RelayClient.openTerminal` treats every call as
  an additional terminal with its own id; the keystroke/output/resize wiring
  now reads the current terminal id at send time instead of one captured at
  mount, so it follows a retry rather than staying pinned to the stale one.

  Covered by fake-timer unit tests in `FileTreePanel.test.ts` and
  `InteractiveTerminal.test.ts`: a silent node reaching the failure state
  within the deadline, a slow-but-alive node answering just under it never
  tripping the error, and retry actually re-requesting rather than just
  clearing the flag.

- 23f8d41: Right workbench sidebar: Files/Config sub-tabs, docked, no dead pin at 1280px

  Two things, closed together because the second bug lived entirely inside the first fix.

  **#573**: the workbench panel's pin control was visible and inert at exactly
  1280px, because `viewport.ts:38`'s `isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX)`
  built `(max-width: 1280px)` and `+page.svelte`'s own CSS built
  `(min-width: 1280px)` for the same decision, both true at 1280 itself. Fixed
  `isNarrowViewport` with an `exclusive` option that subtracts a fixed epsilon
  (`EXCLUSIVE_BREAKPOINT_EPSILON_PX = 0.02`) from the breakpoint before building
  the query, so the two sides of a boundary decision partition the pixel to
  exactly one side. Covered directly in `viewport.test.ts` at 1279/1280/1281,
  with a `matchMedia` stub that actually evaluates the query string rather than
  returning one fixed value regardless of it.

  **#571**: the Drawer's Files/Terminal/Config panel was `position: fixed` by
  default (a modal-strength scrim on every open, `Overlay.svelte:135-141`, and
  the same scrim strength as the New Session dialog), with the "pushes instead
  of covers" behavior gated behind a pin control nobody could find, off by
  default, and dead at the exact width above. Rebuilt on `$lib/dock-panel.svelte.ts`
  (#570), the same shared behaviour the left sidebar runs on: collapse,
  drag-resize, persistence, no second implementation. Docked (no scrim at all)
  at/above `--bp-desktop` (1024px); a side sheet at 768-1023px; a bottom sheet
  below 768px, unchanged from before. Open by default at/above `--bp-wide`
  (1280px) once a session is selected, and sticky to whatever the user actually
  chooses (open/close, or a drag-resize) from the first real interaction on.

  Files and Config are sub-tabs inside the panel's own header now (a
  `radiogroup`, the same mutually-exclusive-always-one-selected idiom
  `ConfigBar`'s mode switch already uses), not a second copy of the topbar's
  former three-button switch. The topbar keeps exactly one control for the
  sidebar itself; the panel choice lives only in its own header. Both panels
  stay mounted (the native `hidden` attribute) once a session/project exists,
  so switching Files to Config never remounts the other one.

  The terminal leaves this panel entirely. Its own bottom dock is issue #572,
  not built here — closing this PR means the terminal is temporarily
  unreachable from the app until #572 lands; `InteractiveTerminal.svelte` and
  its `openTerminal`/PTY logic are untouched and unchanged, just unmounted from
  this component.

- 1d3056e: Give the terminal its own bottom dock, horizontal instead of a 340px-wide overlay column

  The terminal used to be the third tab of the right-hand panel, so it got a
  narrow vertical column for something inherently wide and short, and
  opening it meant giving up Files/Config since only one panel tab could be
  open at a time.

  It is its own bottom dock now (design spec `2026-08-03-cockpit-v6-design.md`
  §3.1-§3.3), built on the shared `DockPanel` behaviour (`edge: 'bottom'`)
  issue #570 extracted: full canvas width, drag-resizable height (12rem
  minimum), toggleable and closed by default, height and open state
  persisted per user (`localStorage`, matching every other dock). It sits
  below the left sidebar, transcript, composer and right sidebar, all of
  which stay visible and interactive while it is open — it never scrims.

  `InteractiveTerminal.svelte` now loads `@xterm/addon-fit` and calls
  `fitAddon.fit()` on mount and on every `ResizeObserver` notification for
  its container, so a continuous drag reflows the terminal to real cols/rows
  (not just a CSS height change), coalesced to one `fit()` per render frame
  regardless of how many `pointermove` events the drag fires. Collapsing the
  dock no longer unmounts the terminal or kills its PTY: it stays mounted,
  hidden by height/transform, so a collapse/reopen round trip keeps the same
  terminal and its scrollback.

  Below 1024px it becomes a bottom sheet with a backdrop, reusing the
  sessions sidebar's own always-mounted/CSS-transform mechanism (not a
  second one), and follows the same one-panel-at-a-time rule the left and
  right sidebars already have below that width.

- d09e12b: Stop a tool call with no `id` from wearing the "awaiting permission" outline

  `+page.svelte` computed `awaitingPermission={permissionHead?.toolCall.id === item.id}`. With no permission in flight, `permissionHead` is `undefined` and the optional chain short-circuits to `undefined`; if the transcript item's own `id` is also `undefined`, the comparison is `undefined === undefined`, true, and the row painted the amber `outline: 2px solid var(--color-warning)` even though nothing was pending. `item.id` is reachable as `undefined` from real traffic: the transcript payload is opaque ciphertext to the protocol, and the client casts the decrypted JSON with `openJson<AcpSessionWireEvent>` rather than parsing it with Zod, so nothing rejects a `tool_call` that omits `id`. The comparison now short-circuits on `permissionHead !== undefined` first.

  The same shape turned up twice more in a sweep of every optional-chain/possibly-undefined equality comparison across the web client and its shared protocol reducer. `RelayClient.discardStalePermissionForToolCall` compared `request.toolCall.id === event.id`; a malformed `tool_call_update` with no `id` could match a pending permission request whose own `toolCall.id` was equally malformed (the paired `permission_request` payload goes through the same unvalidated cast), cancelling it and publishing a false "resolved on another device" notice. `@loombox/providers-core`'s `reduceToolCall` looked up an existing transcript row by `item.id === update.id`; two unrelated malformed tool calls with no `id` would merge into a single row, the second silently overwriting the first's title/status. Both now refuse to match when the incoming `id` is `undefined`, so a malformed event always ends up in its own row/no-op rather than colliding with an earlier one.

- e526691: Tool-call cards: one level of chrome instead of two

  A tool call used to render as two nested boxes: a bordered card with a
  header line, wrapping a second inset surface (`--color-fill-subtle`) for
  the payload. For a call whose entire payload was a single fact already
  named in its title (`Read apps/web/src/lib/terminal.ts` whose `rawInput`
  was that same path again), that was a lot of chrome for one line of text,
  and a run of several tool calls in a row read as a stack of boxes rather
  than a conversation with work in it.

  `tool-widgets/ToolCard.svelte` now takes a required `surface` prop instead
  of always drawing a border: `surface={true}` keeps the v5 bordered-card
  treatment for content with no surface of its own (`TodoWidget`'s checklist,
  `GenericToolRow`'s own multi-line output or multi-entry `rawInput`);
  `surface={false}` draws nothing but layout, for a single-line row or for a
  widget whose body already carries its own surface (`BashWidget`'s
  `TerminalOutput`, `EditWriteWidget`'s `DiffViewer`) — never both at once.
  `GenericToolRow` decides "one line or a block" from the payload's own
  shape (does it contain a newline, does it carry more than one key/value
  pair) and folds a single-line payload directly onto the header line,
  dropping it entirely when it only repeats what the title already said.

  Status also moves: a new shared `ToolCallStatus` component drops the
  "Completed" caption once a card has settled (the dot alone still carries
  it to screen readers via its own `aria-label`) and makes "Failed" the one
  state allowed to shout — bold, `--color-danger`, on its own chip — so a
  failure in a run of otherwise-quiet completed calls is what actually draws
  the eye.

  The bespoke widgets (bash, edit/write, todo) keep their own visual
  language unchanged; only the redundant outer frame goes.

- c97a2cf: Add the `TrackerMode` config and the pluggable `TrackerBackend` extension point (SPEC §7.10)

  `@loombox/protocol` gets `v1/tracker.ts`: Zod-validated `githubTarget`/`jiraTarget` and the `trackerMode` discriminated union (`{kind:'native'}` or `{kind:'live', provider, connectionId, target}`), exported and registered in `schemasV1` alongside every other v1 schema. The exported `TrackerMode` type keeps SPEC's literal `target: GitHubTarget | JiraTarget` shape (not correlated to `provider` at the type level, exactly as specced), but the schema adds a `superRefine` cross-check so a GitHub-shaped target submitted under `provider: 'jira'` (or the reverse) is rejected at parse time, since that correlation is clearly the spec's intent even though its type block does not encode it.

  `@loombox/shared` gets its first real export: `TrackerBackend` and `TrackerBackendCapabilities`, plus the `TrackerBinding`/`TrackerListFilter`/`TrackerListPage`/`TrackerItemLive`/`TrackerTransition`/`TrackerBoard`/`TrackerSprint` shapes those methods reference. `list`/`get`/`create`/`update`/`listBindings` are required; `addComment`/`listTransitions`/`transition`/`listBoards`/`listSprints`/`moveToSprint` are optional, matching SPEC §7.10's phased delivery (issues/comments first, transitions next, boards/sprints last). A type-level `satisfies TrackerBackend` check in `tracker-backend.test.ts` proves a stub implementing only the required methods still satisfies the interface with every optional method absent, and fails to compile if that ever stops being true.

  `apps/web` gets `$lib/tracker-mode-store.ts`, a per-project persisted `TrackerMode` (localStorage today, same injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`). `get()` returns `TrackerMode | undefined`: an unset project, or one whose stored value no longer validates, both read as `undefined`, never silently coerced to `{kind:'native'}`. No consumer wires this store into the UI yet; that is issue #212's job.

- 23e157d: Render Markdown in the transcript instead of printing it literally

  `MessageItem.svelte` interpolated `displayText` straight into a `<p>` with
  `white-space: pre-wrap`, so a fenced code block showed its own backtick
  fences and a `-` list showed dashes with no markers. There was no Markdown
  dependency anywhere in `apps/web`. This was the largest finding of the v6
  cockpit audit: most turns of real substance from a coding agent contain code
  or a list, or both.

  Agent and user turns now go through a real pipeline: `remark-parse` +
  `remark-gfm` for CommonMark plus tables/strikethrough/task lists,
  `remark-rehype` (without `allowDangerousHtml`, so a literal `<script>` or
  `<img onerror=…>` typed by the agent is dropped before it ever becomes an
  element rather than escaped-and-shown or executed), `rehype-sanitize` on
  GitHub's own default schema (strips a `javascript:` link/image protocol),
  then two small trusted plugins that run after sanitisation on purpose (an
  external-link `target`/`rel` setter and a table-scroll wrapper), and finally
  `rehype-highlight` with an explicit ~18-language `highlight.js` subset
  (`typescript`, `javascript`, `python`, `bash`, `json`, `go`, `rust`, `sql`,
  css/yaml/xml/markdown/dockerfile/java/cpp/csharp/ruby/diff and their common
  aliases) rather than every grammar it ships. `$lib/markdown.ts` documents the
  full ordering and why each step has to come where it does.

  The transcript streams character by character (`TextPacer`, issue #137), and
  re-running that whole pipeline on every 32ms reveal tick does not hold up on
  a long turn. `splitStreamingMarkdown` finds the last point in the revealed
  text where every block that has opened has also closed — the end of a
  closing fence, or a blank line outside any fence — and only that "stable"
  prefix is parsed; `MessageItem` only re-runs the real render when that
  boundary itself advances, not on every tick. A still-open fenced code block
  renders as a plain monospace box (the same code surface `GenericToolRow`'s
  `.output` and `BashWidget`'s terminal already use, not a second visual
  language) and is only syntax-highlighted the instant its closing fence
  arrives, so a half-typed fence never flickers through a half-tokenised
  state. Everything else (lists, tables, headings, emphasis) is styled with
  Deck tokens directly in `MessageItem.svelte`'s own `<style>` block, not a
  library stylesheet; a wide table scrolls horizontally inside its own wrapper
  instead of stretching the transcript row.

  `PlanCard` and tool-call output are explicitly out of scope here: `$lib/markdown`
  is a plain, reusable module, but `ToolCallRow.svelte`/`PlanCard.svelte` and
  the `tool-widgets/` tree were being worked on concurrently by other agents
  during this change, so wiring them in is left as a small follow-up rather
  than risking a collision.

  Bundle cost, measured with `vite build` on `apps/web`: the client JS under
  `_app/immutable` goes from 813,029 bytes raw / 231,245 bytes gzip to
  1,144,276 bytes raw / 332,795 bytes gzip (+331,247 raw, +101,550 gzip, about
  +44% gzip) — almost entirely inside the cockpit route's own chunk
  (`nodes/2.*.js`, 265,788 bytes gzip on its own), which the client only loads
  once a session is actually opened, not on first paint of the sign-in/inbox
  screens.

- 6b1465e: Replace the YOU/CLAUDE/TOOL gutter words with a glyph and a surface

  The transcript gutter used to hold a `--text-caption-size` uppercase word
  per row — `You`, the provider's name, or `Tool` — muted further to
  `opacity: 0.5` on a thought. Only the user turn got a surface of its own;
  an agent turn had none at all, so a long answer ran as an unbounded stream
  of prose against the page background (v6 audit finding T3), and on the
  phone that prose read low-contrast enough to pass as disabled text
  (finding T5).

  Settled with Lorenzo 2026-08-03: attribution by surface and glyph, not by
  a label. Not a colour-only rail (fails for colour-blind readers), not a
  circular avatar (drags the transcript toward chat), not spacing alone.

  - An agent/thought turn now draws a small decorative provider glyph
    (`icon-paths.ts`'s new `provider-claude`/`provider-codex`/`provider-gemini`/
    `provider-ohmypi`/`provider-generic` marks, sourced from `$lib/providers`'s
    existing `PROVIDER_LABELS`) and sits on its own quiet `--color-surface`,
    so it reads as a bounded block instead of loose prose.
  - The user turn keeps what already worked: the raised surface and the
    gutter's accent bar. It never had a glyph and still doesn't.
  - A tool call's gutter drops the "Tool" word — the tool-kind icon already
    said it, and that column was already `aria-hidden` as a whole, so
    nothing accessible is lost.
  - A visually-hidden label (`.sr-only`, the same short word v5 painted
    visibly) carries the role to assistive tech on every turn, in the same
    reading-order position a sighted v5 reader's eye used to land on first.
  - Consecutive turns from the same speaker (skipping over any tool calls in
    between) no longer repeat the visible glyph — `$lib/transcript-attribution.ts`'s
    `showsAttribution` decides this in `+page.svelte`'s transcript loop — but
    the accessible label and each turn's own surface never get suppressed,
    only the glyph does.
  - The composer's gutter follows suit: no more caption-case "YOU", just the
    same accent bar a `user` transcript row draws on its own gutter, still
    aligned to the exact column every row shares.

  Measured on the real rendered page at 390px (both themes, `--color-surface`
  background against `--color-text-primary` prose): dark 15.5:1, light
  17.8:1 — both well past the WCAG AA minimum of 4.5:1 for body text.

- fc2c12e: Fix the per-session usage meter and add a near-context-limit warning (SPEC §7.9, issue #248)

  The composer's context/cost meter (`ConfigBar.svelte`, previously wired up for the model/mode/reasoning-effort bar) is SPEC §7.9's live usage meter — this doesn't add a second one, it fixes and extends the one already there. Three real bugs, all in `@loombox/providers-core`, none visible from `ConfigBar.svelte`'s own diff:

  - `AcpClient` was reading a raw `usage_update` wire event for field names (`tokensUsed`/`contextWindow`/`costUsd`) that don't exist on ACP's real shape. The protocol's actual `UsageUpdate` is `{used, size, cost}` with `cost: {amount, currency} | null` (agentclientprotocol.com/protocol/v1/schema) — so the meter never actually populated against a real ACP agent. Fixed in `client.ts`'s wire mapping; a non-USD `cost.currency` is left unconverted (`costUsd: undefined`) rather than mislabeled as dollars.
  - `cost.amount` is documented as the session's running cumulative total, not a per-update delta — the reducer was summing it, double-counting every update after the first. `cumulativeCostUsd` now tracks the latest reported total (`Math.max` against the previous value, guarding only against an out-of-order delivery ever making it visibly shrink).
  - A subagent tool call's `usage_update` reports its own, much smaller context window. The reducer now freezes the parent's `tokensUsed`/`contextWindow` across a subagent-attributed update instead of letting it overwrite them (previously masked by a UI-side guard, which just traded "the meter shows the wrong number" for "the meter shows nothing" while the subagent tool call was in flight) — the percentage no longer bounces either way. The subagent's cost is still folded into the cumulative figure, since ACP's own cumulative total already includes it.

  The subagent/parent split has no protocol support — ACP's `usage_update` carries no tool-call linkage at all — so it stays a documented client-side heuristic (`UsageRecord.attributedToSubagent`'s doc comment in `transcript.ts` spells out what it keys on and the two known ways it can misfire).

  New: a near-context-limit warning on the meter itself, at the newly-exported `CONTEXT_NEAR_LIMIT_THRESHOLD` (80%) — grounded against real-world auto-compaction thresholds observed on Claude Code (reported anywhere from ~80% to ~95% depending on source/version), so the warning fires before the earliest point any of them might silently compact. Carried to assistive tech via a `.sr-only` span (the meter's percentage track stays `aria-hidden`).

  Cost stays whatever the agent process itself reports via ACP's `cost.amount` — there is no per-token price table anywhere in this repo, and none is added here; a provider that omits `cost` simply doesn't move the cumulative figure for that update rather than getting an invented number.

  No aggregate spend-over-time view (issue #249) and no spend caps (issue #251) ship here — those build on `cumulativeCostUsd`, not the other way around. The broader attention-inbox surfacing of a near-limit session (issue #250) is separate too; this issue's own acceptance only asked for the warning on the meter itself.

- 00ca502: Invert the dock icon and PWA home-screen icons to a white tile with the azure mark

  `squircleTileSvg` (`apps/web/scripts/gen-brand-assets.mjs`) drew an azure tile
  with the mark punched out in near-black `ACCENT_CONTRAST`. That read wrong in
  the Dock: the mark disappeared into the fill instead of standing on it.

  The tile is now white and the mark is stroked in the existing `AZURE` token
  (`#3b9df7`), same geometry, padding and corner radius, just the two fills
  swapped. `TILE_BG` moved from the old dark `#0b0d10` to `#ffffff` and is now
  shared by `apple-touch-icon-180.png` and `maskable-512.png` too, so the app
  icon is the same object on macOS, iOS and Android instead of a per-target
  accident. The maskable-icon spec only requires an opaque background, not a
  particular color, and its safe zone is about content placement, not
  contrast, so nothing in the spec pushed back on white.

  The menu-bar tray icons (`tray-iconTemplate.png`, `tray-iconTemplate@2x.png`)
  are untouched: they stay alpha-only template images tinted by macOS, and a
  colored tile there would render as an opaque blob.

- Updated dependencies [5118b26]
- Updated dependencies [a449b22]
- Updated dependencies [d09e12b]
- Updated dependencies [c97a2cf]
- Updated dependencies [fc2c12e]
  - @loombox/protocol@0.2.0
  - @loombox/providers-core@0.2.0
  - @loombox/crypto@0.0.2

## 0.1.7

### Patch Changes

- c4ed67e: Give the linked-device screen a way out, and the sign-in button a visible wait

  Three things a real first run on a fresh dev loop turned up, all on the two
  screens you meet before the cockpit.

  The `/device` card ended in "you can close this tab and return to the node",
  which is only true in a browser. In the desktop shell there is no tab and no
  address bar, so approving a device left you looking at a screen you could not
  leave, with a linked node you could not go and use. Both terminal states
  (approved and denied) now end in an `Open loombox` button.

  "Sign in with GitHub" gave no feedback while it worked. The click costs a round
  trip to the relay before the browser leaves for GitHub, and against a hosted
  relay that gap is long enough to read as a dead button, so it now shows its
  `loading` state until the redirect happens (and drops back, naming the failure,
  if the relay rejects the attempt).

  That exposed the third: `WovenLoader` hardcoded `color: var(--color-accent)`,
  which inside a filled `primary` `Button` is exactly the button's own background.
  Measured on the sign-in gate: button background and all five thread strokes both
  `rgb(31, 127, 208)`, so every attribute said "busy" and nothing showed on
  screen. The loader takes a `tone` prop now (`accent` by default, `inherit` for a
  loader inside a filled control) and `Button` passes `inherit`.

## 0.1.6

### Patch Changes

- efc16d9: Say why a GitHub sign-in failed instead of doing nothing

  `AuthStore.signInWithGithub` called Better Auth's `signIn.social` and ignored
  what came back. That client reports failures in `{ error }` rather than throwing
  (the two email/password paths beside it already check it), so a relay with no
  GitHub provider configured answered `404 PROVIDER_NOT_FOUND`, the promise
  resolved as if a redirect had started, and the button was simply dead: no
  navigation, no message, nothing in the UI to explain it.

  That is the exact state a relay starts in without `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` in its env, so the message names both the relay's URL and
  the missing pair rather than passing Better Auth's bare "Provider not found"
  through. The `/device` approval page's own sign-in button never caught anything
  either, so it turned a failure into an unhandled rejection; it now shows the
  same notice the cockpit does.

  `scripts/dev.sh` grows a matching preflight: a non-empty client id is not a real
  one, and this loop ran for three days on a hand-exported placeholder, where
  every process came up healthy and the only symptom was github.com's own error
  page at the end of the redirect. GitHub's device-code endpoint distinguishes an
  unregistered client id (`Not Found`) from a real app (`device_flow_disabled`)
  with no user session and no secret, so the loop now refuses to start on a client
  id GitHub has never heard of, and prints how to register one.

## 0.1.5

### Patch Changes

- e2fdd7a: Give the topbar's controls names, and let the phone have its width back

  The cockpit's topbar carried five grey icon-only buttons in a row: three that
  open one drawer between three panels, one that copies the transcript, one that
  opens the command palette. Nothing said the first three were the same drawer,
  nothing said which one was open, and no word for any of them existed anywhere on
  screen, only a `title` a pointer had to hover for and a touch device never gets.

  The three panel toggles are now one bordered segmented group with a selected
  segment, and each control says its name in words wherever the topbar has the
  room (measured: at 1280px the whole cluster with every word visible is 344px of
  a 992px topbar). Below that the words go and the accessible names stay, since
  they are props on the buttons rather than the hidden spans.

  Three defects came out of building it, all pre-existing:

  - The Drawer, as an overlay, started at `top: 0` and covered the topbar's whole
    control cluster, backdrop included. A click aimed at the palette landed on the
    Drawer's own pin button, and the switch could not be used while a panel was
    open. It starts below the topbar now, and the backdrop dims the canvas only.
  - The Drawer's header carried a second copy of the same three-way switch, also
    labelled "Panels". It states which panel is open instead, so there is one
    switch, in one place, whether the panel is open, closed, overlaid or pinned.
  - The composer's text column sat 7.6px right of the transcript's: `.composer-row`
    added a `gap` on top of the same role gutter every transcript row uses, so the
    textarea began at 486.2px while the prose above it began at 493.8px.

  On a phone the timeline's role column collapses and each turn's word (`YOU`,
  `CLAUDE`, `TOOL`) moves above its content. That column spent 84px of a 390px
  screen on a six-letter word and left the prose a 244px measure; it is 316px now.
  Every surface sharing the column moves at the same breakpoint, so the timeline
  keeps one left edge.

  `Button` gains `pressed` (a real `aria-pressed` toggle, matching `IconButton`'s)
  and `title`; `CopyButton` gains `prominent` for a standalone call site where its
  half-opacity resting state read as disabled.

## 0.1.4

### Patch Changes

- 0c27349: Fold the composer's toolbar into one row under the text

  The composer had two strips: a mini-toolbar above it (paperclip, model/mode
  pickers, context/cost) and a keyboard hint below the textarea. They are now one
  row directly under the text, inside the field's own column, so everything about
  the turn you are composing reads in one place.

  The paperclip moved into that row, which means the drop zone now wraps the field
  instead of sitting beside it. That fixes two things that silently did nothing
  before: dropping a file on the textarea, and pasting an image into it. Only the
  strip above was ever a live target.

  The meter reports the context in use against its maximum (`76k / 200k`) instead
  of a bare percentage, with a 3px track that tints amber at 80% and red at 95%,
  and the agent's own name now stands in front of the model picker where the word
  "Model" used to be. On a phone the pickers still collapse behind a "···", but
  the cost and context stay on screen: the old strip hid the lot, so the first
  thing to disappear was the number a user watches.

  The `Enter to send` hint is screen-reader only now. It stays the textarea's
  accessible description, it just no longer spends a row of pixels on a sentence
  read once in a lifetime.

## 0.1.3

### Patch Changes

- 2840683: Take the theme toggle off the signed-out screens.

  The gate shell pinned a theme control to a corner of every pre-cockpit screen
  (checking session, sign-in, onboarding, `/device`). It was there on the reasoning
  that a blinding light screen is hard to sign in through, but the saved preference
  is already applied by the time any of those screens paint, and its default
  (`system`) follows the OS, so the control changed nothing for almost everyone
  while being the only button on screen that was not the point of the screen.

  Appearance stays where it belongs, in the cockpit's own settings after sign-in.

- 9f6d04a: Spend a dot only where a dot means something.

  The header already worked this way: a healthy connection shows nothing, because
  "a permanently green dot in the app's highest-attention corner spent those pixels
  saying nothing". Three surfaces still ignored that rule.

  Session rows drew a status dot for every tone including the neutral ones (no
  status yet, awaiting input, exited), so the common case was an identical grey
  speck in the row's leading indent and the dot could not be read as meaning
  anything. It now appears for the three tones that do mean something (working,
  needs permission, error), into a grid column that holds its width either way, so
  a title never jogs sideways when its session starts working. The status label
  still reaches a screen reader on every row.

  Transcript turns and queued prompts drew a 4px dot above the role word: muted for
  an agent, accent for the user. On a right-aligned gutter it landed over the
  label's last letter, unattached to anything. The accent moved onto the word
  itself, so the cue survives and the speck does not.

  Also in the sidebar: the account button showed the full address truncated
  mid-domain while the menu it opens repeated the whole thing one line above, and
  "Sign out" was styled as a destructive action. The button carries a short
  identity now, and signing out is a normal menu item.

  `StatusDot`'s two diameters became tokens, since a caller reserving the dot's
  slot needs the same number the component uses.

## 0.1.2

### Patch Changes

- fe8da63: Give the signed-out gate a composition it never had.

  Checking session, sign-in, first-run onboarding and the `/device` approval page
  now share one centred layout (`GateShell`): brand lockup, tagline, then that
  screen's own floating `Card`, on a low-contrast woven field, with a single theme
  control in the corner.

  They had no layout before. `main` was a top-aligned padded column, under a
  comment claiming the pre-cockpit screens kept "the original padded, centered
  column layout" when that rule had no `justify-content`, no `align-items` and no
  `max-width`. So the sign-in card sat directly under the header with two thirds
  of the window empty below it, and the "Checking session…" line was stranded in
  the top-left corner (x=15, y=106 in a 1280x860 window) while the lockup above
  it was centred: two alignment systems on one screen.

  Four other things went with it:

  - The brand mark was drawn twice, about 110px apart, once coloured in the
    lockup and once dimmed inside `EmptyState`. Onboarding added a third copy.
  - `EmptyState` was the wrong primitive for a front door. Its documented job is
    empty sessions, empty inbox, empty targets, so it dressed the sign-in screen
    as "nothing here yet" instead of "welcome".
  - The waiting weave was `WovenLoader`'s default `sm` (1em, so 12px), the size
    meant for sitting inline in a button. It is `md` now, the 2.5rem motif
    `/style-reference` documents, centred in the panel.
  - The Relay URL override was a hand-rolled `<label>` plus a raw `<input>`
    beside the app's own `Field` and `Input`. It now uses those, folded into a
    disclosure so it stays available to self-hosters without competing with the
    one action everyone else is here for.

  The panel keeps the same position and width in every state, so resolving the
  session swaps the panel's contents without moving anything on screen. That is
  covered by a Playwright spec rather than a unit test, since jsdom has no layout.

  The gate's "Appearance" toggle is gone (it opened the whole accent and style
  panel before the app knew who you were, and in the cockpit that lives in the
  account menu). The theme toggle stays, since reading a blinding light screen
  well enough to sign in is a real need.

- ea6cbe7: Fix the app hanging on "Checking session…" for every visit after the first.

  `+page.svelte`'s `onMount` syncs this device's notification preferences into the
  service worker before it restores the session. It posted the `$state` object
  itself, which is a proxy, and structured clone cannot clone a proxy, so
  `postMessage` threw `DataCloneError: #<Object> could not be cloned` and took the
  rest of `onMount` with it. The session was never restored, so the app sat on the
  "Checking session…" screen forever, with no `/api/auth/get-session` request ever
  made.

  It only happened from the second visit on, because a service worker does not
  claim the page that registered it: on the first load `navigator.serviceWorker
.controller` is still null and the sync is a no-op. That is also why no test
  caught it, since none of them loaded the app twice in one browser context.

  Found on production (app.loombox.dev) by driving the deployed app in a real
  browser: unregistering the worker made the same page work immediately, and an
  in-page error capture installed before hydration showed the `DataCloneError`.

  The message now carries a `$state.snapshot`, and the whole sync is wrapped in a
  `try`/`catch`: syncing notification preferences has no business being able to
  stop someone signing in. Both a unit test (the posted payload must survive
  `structuredClone`) and a Playwright spec (a second visit, with the worker
  controlling the page, still reaches the sign-in button) cover it.

## 0.1.1

### Patch Changes

- fb4e08e: Draw the sidebar's show/hide control as a panel, not a disclosure chevron.

  The control that shuts the Sessions column reused `collapse-chevron`, the glyph
  eight disclosure rows already use, so one mark meant two unrelated things. It
  also pointed down for a column on the left, and its `scaleX(-1)` state variant
  was a no-op: the chevron's path is symmetric about x=32, so both states drew an
  identical glyph and the button never showed which one it was in.

  It now uses a new `sidebar-panel` glyph that names the surface being toggled,
  the convention in VS Code, Zed and Linear. It is deliberately never mirrored:
  flipping it would move the marked column to the right, which reads as "the
  panel moves to the other side" rather than "the panel is shut". State is
  carried by `IconButton`'s own `aria-pressed` styling and the label, which a new
  test now holds to, since they are the only things that distinguish the two
  states.

  The control is also always visible now, just quiet until the sidebar is hovered
  or holds focus. It used to be `opacity: 0` until then, which meant the only
  pointer affordance for closing the column was invisible unless you happened to
  hover the header.

## 0.1.0

### Minor Changes

- c0d6291: Make projects real, and give the cockpit one navigation instead of two.

  `Project` is now a first-class thing in the client rather than a `projectPath` string buried in each session's encrypted envelope, so you pick a folder once and spawn sessions into it. Sessions are listed in a tree under their project, and Inbox, Nodes and Settings became pages in the main area instead of drawer tabs that the sidebar also linked to. The drawer keeps only what belongs to the open session: Files, Terminal, Config.

  On the wire, a session's private envelope gains an optional `worktree` field, which is SPEC 7.1's per-session isolate-or-work-in-place choice finally reaching the client, and the target fs listing gains an optional `gitRepo` flag so the picker knows whether to offer it. Both are additive, so a node or client older than its peer keeps parsing. The node also stops requiring a git repository for in-place sessions, which SPEC 6 has always said it should support.

- c86aa72: Survive a node restart, bound the agent spawn, and make the surface coherent

  A node restart no longer forgets every session it owns, so rows stop pointing at sessions nobody tracks and worktrees stop leaking. The agent spawn is bounded, and a session is announced as soon as its worktree exists rather than only once the agent is up.

  The node status numbers were wrong: CPU was a load average mislabelled as utilisation, and RAM counted reclaimable page cache as used. Both fixed, and the reading now carries the machine's hostname, platform and arch so a target called "Local" says which machine it is.

  On the client: one page title instead of two, one Settings entry instead of three, a real form language instead of eight copies of the same hand-rolled input, dense node rows instead of three progress bars, and a transcript that states who is speaking with a composer that is part of it rather than a chat box bolted underneath.

- edf90ad: Say something true when a new session times out: the node cuts the worktree before the agent is up and only announces afterwards, so a timeout there is not evidence the session failed. The dialog no longer shows the raw wire identifier, and no longer claims it did not happen.
- 8f305d0: Survive a relay restart, follow the agent, and let a session be archived.

  A relay redeploy used to brick every node until someone restarted it by hand: a
  peer built on the WHATWG WebSocket cannot send a transport-level ping, so nodes
  and clients now probe liveness with a `ping`/`pong` pair the relay answers and
  advertises as a `heartbeat` capability, and both reconnect with backoff from a
  single handler wired to close _and_ error.

  The transcript now follows the agent's newest output instead of sitting pinned
  at the first frame, detaching when you scroll up to read.

  Sessions can be archived from the row menu, optionally taking their git
  worktree and branch with them, so a project stops accumulating one worktree per
  session that nobody would ever prune by hand.

- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.

### Patch Changes

- 60378d7: One `<h1>` per view, naming the view rather than the app. The sidebar wordmark was a heading too, so every screen carried two and one of them was always wrong: the app's name never changes, so it cannot be the heading of what you are looking at. The session view's title in the topbar takes the role the three destination pages already had.
- 9eff82e: Make the desktop shell's dev-server override actually work, and unbreak `vite dev`. `resolvePwaUrl` now accepts a `--pwa-url=<url>` argv flag (which `open --args` delivers) instead of relying only on `LOOMBOX_DESKTOP_PWA_URL`, which a LaunchServices-started app on macOS 26 never inherits from `launchctl setenv` — so `scripts/mac-desktop.sh`'s documented `PWA_URL=` override silently loaded production. Separately, `@xterm/xterm` is now SSR-bundled: as an external CommonJS dep its named `Terminal` import made `vite dev` 500 on every page.
- 604a6f4: Stop the New session dialog wiping what you type. Its reset effect called `resetForm()`, which reads the `providers` prop, and a Svelte 5 `$effect` tracks reads made inside the functions it calls — so the reset re-ran whenever `providers` changed identity, which `+page.svelte` does on every re-render (it derives the list from the polled target status). Measured against the deployed relay, a prompt typed into the open dialog was wiped within a second, repeatedly. The reset now fires on the closed-to-open transition instead, which also covers `open` being re-assigned the same `true`.
- 55161ed: Give `@loombox/providers-core` a browser-safe entry point (`@loombox/providers-core/browser`) and move `McpServerSecretMissingError` out of `client.ts` into `mcp-secret-grants.ts`, beside the logic that raises it. The barrel exports `AcpClient`/`PermissionQueue`/`ConfigOptionStore`, which extend Node's `EventEmitter`; `vite build` tree-shakes them away, but `vite dev` evaluates every module it serves, so the web app painted a healthy page and then died on hydration with `Cannot access "node:events.EventEmitter" in client code`. `apps/web` now imports the browser entry, and a test asserts nothing reachable from it imports a `node:` builtin.
- Updated dependencies [c0d6291]
- Updated dependencies [c86aa72]
- Updated dependencies [8f305d0]
- Updated dependencies [55161ed]
- Updated dependencies [a36e07a]
- Updated dependencies [fcb76fc]
  - @loombox/protocol@0.1.0
  - @loombox/providers-core@0.1.0
  - @loombox/crypto@0.0.1
