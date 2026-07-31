# @loombox/web

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
