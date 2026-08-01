# AGENTS.md — building loombox

`SPEC.md` is the source of truth. **Read it fully before implementing anything.** This
file is the build-convention layer on top of it.

## Layout — a pnpm monorepo (SPEC §10.1)

- `apps/web` — the web-PWA client (**SvelteKit**, wrapped with **Capacitor** for
  `apps/mobile`; no Expo/React Native, no Tauri).
- `apps/mobile` — the mobile app (the same SvelteKit PWA via Capacitor; later phase).
- `packages/node` — the orchestrator node daemon.
- `packages/supervisor` — the agent-supervisor (owns the ACP agent as a child process
  over piped stdio; PTYs are only for the interactive terminals).
- `packages/relay` — the self-hostable relay (Fastify + WebSocket + Postgres + Redis +
  Better Auth; shipped as a Docker image + compose).
- `packages/protocol` — the versioned Zod wire schema (shared).
- `packages/crypto` — E2E crypto primitives (shared).
- `packages/providers` — layered ACP: `core` + `claude` / `codex` / `gemini`
  (reserved) + `generic` fallback.
- `packages/shared` — shared types and utilities.
- `tooling/`, `scripts/` — dev tooling and useful scripts.

The marketing landing page lives in a **separate repo** (`loombox-landing`, SvelteKit,
hosted on prodbox).

## Conventions

- **Greenfield, clean-room.** Inspired by emdash / Happy / Nimbalyst (and ACP / Zed),
  but **fork or import no code**. **HAPI is AGPL-3.0 — design inspiration only; never
  clone or copy it into this build environment** (treat this as a hard process gate).
- **License: MIT** throughout the core (SPEC §13). Only cloud-only glue (billing,
  provisioning, admin) would ever go in a separately licensed package.
- **Testing / CI:** **Vitest** (unit/integration) + **Playwright** (PWA e2e). Every
  package ships tests from commit one; the GitHub Actions workflow
  (`.github/workflows/ci.yml`) gates merge on lint + format + typecheck + test +
  a GPL/AGPL license scan. See **Local verification** below for how to run the
  minimal covering subset locally and let CI be the full gate.
- **Releases:** **Changesets** + GitHub Releases (semver + changelog).
- **Grounding:** SPEC §16 maps every non-trivial mechanism to a real reference or
  example — consult it before building a mechanism from scratch, and prefer the cited
  approach.

## Local verification: CI is the gate, run the minimal covering subset

CI (`.github/workflows/ci.yml`) runs the full `pnpm lint` + `pnpm format:check` +
`pnpm -r typecheck` + `pnpm test` + license scan on every push and PR to `main`.
That is the actual merge gate: keep `main` green and let CI run the whole matrix.
Locally, do NOT re-run the full suite for every change. Run just enough to catch
an obviously broken change in the code you touched, then rely on CI.

Scope by **amount** (narrow to your diff), never by **category**: if CI runs
typecheck + lint + format + test for a package, run all of them scoped to your
change, do not drop one because it seems slow or unrelated. That is the classic
green-locally / red-CI trap (we hit it once when a scoped Prettier glob skipped a
`.mjs` fixture that CI's full `format:check` caught).

```bash
# Tests - filter to the file(s)/pattern you touched, not the whole suite
pnpm --filter @loombox/<pkg> exec vitest run src/foo.test.ts
pnpm --filter @loombox/<pkg> exec vitest run -t "pattern"

# Typecheck - tsc is whole-project by nature; scope to the workspace(s) you touched
pnpm --filter @loombox/<pkg> typecheck

# Lint - `pnpm lint` hardcodes `.` (whole repo); call eslint directly on changed files
pnpm exec eslint packages/<pkg>/src/foo.ts

# Format - prefer the FULL `pnpm format:check` before pushing: it is cheap and
# checks every extension (incl. .mjs/.js fixtures), which a scoped .ts-only glob misses
pnpm format:check
```

Reach for the full unscoped `pnpm lint && pnpm format:check && pnpm -r typecheck &&
pnpm test` (exactly what CI runs) only right before opening or merging a PR, for a
repo-wide change, or for anything touching the wire protocol (`packages/protocol`)
or crypto (`packages/crypto`). Note: this is a private free-tier GitHub repo, so a
branch-protection rule cannot mark the check "required"; the gate is procedural,
CI runs on every PR and we never merge a red one, always via a feature branch + PR,
never a direct push to `main`.

## Testing the desktop app on the Mac (from the devbox)

The Electron desktop app (`apps/desktop`) can only render on the Mac (the devbox is
headless — no GUI, no Chrome). Do not ask the human to run anything by hand: launch it
for them with one command from the devbox.

```bash
scripts/mac-desktop.sh                 # the branch we're on now (auto-published to origin)
scripts/mac-desktop.sh some-branch     # a specific branch already on origin
PWA_URL=http://localhost:5173 scripts/mac-desktop.sh   # point the app at a dev server
```

It publishes the branch under development, hard-resets the Mac's checkout to it,
reinstalls, stops any running dev instance, and relaunches the Electron window in the
Mac's GUI session (via `open`/LaunchServices — `launchctl asuser` needs root over SSH).
Everything is auto-detected; override with `MAC_HOST`, `LOOMBOX_MAC_REPO`, `PWA_URL`.
The desktop shell comes from the branch; the UI it loads is the deployed PWA
(`app.loombox.dev`) unless `PWA_URL` overrides it. So to test unmerged **web** changes,
either deploy them to `app.loombox.dev` first or point `PWA_URL` at a dev server.

Note the shell comes from **origin**, since the Mac hard-resets to it: a desktop-side
change you have not pushed will not be there. And that reset discards uncommitted work
in the Mac's checkout.

## Debugging the desktop app on the Mac (from the devbox)

```bash
scripts/mac-desktop.sh --dev       # one command: the local loop here + the window there
scripts/mac-desktop.sh --dev --debug   # + CDP/inspector forwarded back to this box
scripts/mac-desktop.sh --reload    # reload the app window, ~2s, no relaunch
PWA_URL=https://app.loombox.dev scripts/mac-desktop.sh --debug   # debug the prod bundle
```

`--dev` is the whole session in one command: it brings the loop up here (postgres,
relay, node daemon, web, against the **dev** GitHub OAuth app in `.env.dev.local`),
launches the app on the Mac pointed at it, and then holds the terminal while both
run. Quitting the app on the Mac stops the loop here; Ctrl+C here quits the app
there. Nothing is left running on either side, which matters on this shared box —
a leaked `vite dev` holds its port for days. It reuses a loop you already have up
rather than starting a second one, and leaves that one alone on the way out.
Postgres survives on purpose (it holds the account and its sessions, so a restart
does not mean signing in again); `--dev --fresh` wipes it, `scripts/dev.sh --stop`
stops it.

The older two-step form still works and is what `--dev` runs underneath:

```bash
scripts/dev.sh                     # the local loop (relay + node + web) this box serves
scripts/mac-desktop.sh --hmr       # launch pointed at it — edit apps/web here, the window updates
scripts/mac-desktop.sh --debug     # + CDP/inspector forwarded here (implies --hmr)
```

`--hmr` is the live-reload loop, and it needs no CDP, so it is not gated behind
`--debug`'s arbitrary-JS access. The window loads `http://localhost:5173`, which the
reverse SSH forwards `scripts/dev.sh` opens (the launcher re-opens them when the Mac
cannot reach the port, since a slept laptop takes the tunnel down) carry back to this
box's `vite dev`. Measured on the real window: an edit here reached the Mac in **71ms**,
and a `window.__hmrProbe` planted beforehand survived it, so the module is hot-swapped
rather than the page reloaded. `localhost` is also why it needs no Chromium flags — see
the two bullets on secure contexts below. What it does not cover is the shell itself:
Electron main/preload come from the Mac's checkout, so a change there still means
re-running the launcher.

`--debug` adds two argv flags and forwards both ports to this box, so the Mac's window
is drivable from here:

- **renderer** on `127.0.0.1:9222` — DOM, console, network, `evaluate`, screenshots.
  Point omp's `browser` tool at it: `{"action":"open","app":{"cdp_url":"http://127.0.0.1:9222"}}`,
  then `tab.evaluate` / `tab.screenshot` / `tab.click` as if the app were local.
- **main process** on `127.0.0.1:9229` — the Electron/Node inspector, for
  `Runtime.evaluate` against main-process state (verified: reading `process.argv` back
  out of the running app). The main process currently logs nothing, and stdout is lost
  through `open` anyway, so the inspector is the way to see it.

It is opt-in on purpose: CDP is arbitrary JS in the app's context, which means the AMK
in `localStorage` and every decrypted session. Ports are loopback on both ends. The
forward is idempotent — a live one is reused, a stale one replaced — and it must use
the **same** local port number, because CDP hands back a `webSocketDebuggerUrl` of
`ws://127.0.0.1:<remote-port>` that clients then use verbatim.

You can also **drive** it, not just read it: clicks, real keystrokes, keyboard-only
combobox and radio interaction all reach the app's own handlers. Verified end to end
against the deployed PWA — `Cmd+K` opened the palette and the app moved focus into its
input, typing narrowed the results to "No matches.", and a whole New session form was
filled (prompt, Agent switched with `ArrowDown`/`Enter`, workspace radio, title) until
the app enabled its own submit button. That last part is the check worth copying: assert
on state the app derives, so a passing result means the app reacted rather than that you
mutated its DOM.

Two practical notes. `tab.fill` times out on this app's textarea even though the element
is visible, hit-testable and stable — use `tab.click(selector)` then
`page.keyboard.type(...)`, which works. And stop short of anything with real side
effects: creating a session really does spawn an agent on the node.

Things that cost real time to find out, so do not re-derive them:

- **A fresh origin is a new device.** The dev server is a different origin from
  `app.loombox.dev`, so it has its own empty `localStorage`: no session, no AMK, and it
  lands on the sign-in screen. Onboard it once through SPEC §8's real "new device"
  recovery-code path and it persists; do not script copying the AMK across origins.
  Whichever relay that origin talks to must carry it in `LOOMBOX_TRUSTED_ORIGINS` (one
  env var drives both Better Auth's CSRF check and the CORS allowlist): the dev relay
  gets `http://localhost:5173` from `scripts/dev.sh`, and prodbox's carries
  `https://app.loombox.dev` plus this box's tailnet dev origin (so a devbox tailnet-IP
  change means updating it there too).
- **`screencapture` over SSH does not work**, even with Screen Recording granted — it
  fails `could not create image from display`. Use a CDP screenshot (renderer only, no
  macOS permission needed, and deterministic). Accessibility *does* work, so window
  title/geometry is available:
  `ssh mac 'osascript -e "tell application \"System Events\" to tell (first process whose name contains \"Electron\") to get {name, position, size} of first window"'`
- **`launchctl setenv` cannot deliver env to the app.** `launchctl getenv` reads the
  value straight back, which makes it look like it worked, but a LaunchServices-started
  app on macOS 26 does not inherit it. That is why the URL override is the
  `--pwa-url=` argv flag (`open --args` does deliver). Do not "fix" it back to env.
- **`localhost` is a secure context, a tailnet IP is not**, and that decides the whole
  HMR route. On `http://<tailnet-ip>:5173` `isSecureContext` is false, so `crypto.subtle`
  is missing and the app can neither generate nor unwrap an AMK: every session stays
  unreadable behind onboarding. Reaching the same dev server as `http://localhost:5173`
  through the reverse tunnel needs no exemption at all (verified on the window:
  `isSecureContext: true`, `crypto.subtle` present, launched with only `--pwa-url`), and
  it is what the dev relay expects anyway — it sends `Access-Control-Allow-Origin` for
  `http://localhost:5173` and no header at all for a tailnet origin, so those responses
  are blocked. The tunnel carries 8790 too, so `ws://localhost:8790/ws` opens from the
  Mac's renderer (verified) and the OAuth callback registered on localhost:8790 holds.
- **One route still needs the insecure-origin exemption**: pointing the window at
  `http://<devbox-tailnet-ip>:5173` to iterate against the PRODUCTION relay, which does
  trust that exact origin. `PWA_URL=http://<ip>:5173 scripts/mac-desktop.sh` passes
  `--unsafely-treat-insecure-origin-as-secure=<origin>` plus the `--user-data-dir`
  Chromium requires alongside it (`~/.loombox-desktop-debug`, so that origin's session
  persists and the normal profile is untouched). Verified with a real AES-GCM round trip
  in the window, not just a feature check. It is applied by URL shape, so it no longer
  takes `--debug`, and `--hmr` never goes through it.
- **Client code must import `@loombox/providers-core/browser`, never the barrel.** The
  barrel exports `AcpClient`/`PermissionQueue`/`ConfigOptionStore`, which extend Node's
  `EventEmitter`; `vite build` tree-shakes them away, but `vite dev` evaluates every
  module and `node:events` is an empty stub in the client, so the app painted fine and
  then died on hydration ~5s later with `Cannot access "node:events.EventEmitter"`.
  Watch for indirect paths: a pure module importing one symbol (an error class) out of
  a Node-only module drags the whole graph back in.
- **Do not trust an empty `page.on('console')`** when driving the app over
  `app.cdp_url`: those listeners never fire against an attached Electron renderer, so
  a page that is loudly erroring looks silent. That cost real time here. Install the
  capture in the page instead, before hydration:
  `page.evaluateOnNewDocument(() => { window.__cap = []; ... })`, then read
  `window.__cap`. That is what finally surfaced the error above.
- **Do not run `pnpm --filter @loombox/web build` (or the Playwright suite, which
  builds) while the dev server is up.** They share `.svelte-kit/`, and rewriting it
  under the running server thrashes the window with a burst of reloads — measured: ~10
  reload events per sync, repeating — and can 500 a request that lands mid-rewrite.
- **A remote GUI launch must redirect its stdio.** The app inherits ssh's
  descriptors, and ssh does not close the session while anything still holds its
  stdout, so `open ... --args ...` without `>/dev/null 2>&1` blocks the whole script
  after printing "launched" until the app exits (observed as a 15-minute hang).
- **Do not pipe this launcher through `head`.** `scripts/mac-desktop.sh --hmr | head -8`
  closes the pipe early, so ssh dies of EPIPE and the remote flow is cut mid-way — in one
  run right before its `pkill`, so the previous instance survived and two windows stacked.
  It reads exactly like a bug in the stop step, and it is not: the same run redirected to
  a file goes 1 instance in, 1 instance out. Redirect and read the file.
- **A renderer can be left wedged by a CDP client that detached mid-flight**, and it
  fails asymmetrically: `Page.*` and `Target.*` keep answering while
  `Runtime.evaluate` never replies at all. A `Page.navigate` unwedges it. So treat
  "cannot read the page" as "navigate", never as a fatal error — that is why
  `mac-desktop-cdp.mjs` bounds every request and returns `null` instead of throwing.

## Shipping to prod: a `v*` tag, not a script

```bash
git tag -a v0.2.0 -m "..." && git push origin v0.2.0   # this is the deploy
```

`.github/workflows/deploy-prod.yml` takes it from there, on a self-hosted runner that
lives on prodbox (the box takes SSH only over Tailscale, so a runner sitting on it and
talking outbound is what makes this work at all). It refuses a tag whose `ci.yml` run
is not a completed success, builds the web bundle on a GitHub-hosted runner, and hands
it to `scripts/deploy-prod.sh`, which unpacks it into `releases/<sha>`, flips
`releases/current`, rebuilds only the images whose inputs actually changed, health-gates
the result, and rolls back if the gate fails. **`/opt/apps/loombox/DEPLOYED.json` is the
answer to "what is live"** — tag, commit, when, and the input hashes the next deploy
compares against. Read it instead of guessing; the deploy dir is not a git checkout.

`scripts/deploy-web.sh` is the fast ITERATION path, not a release: it builds locally and
puts prod on its own `releases/iter-<sha>-<stamp>` directory, leaving the tagged release
intact beside it and printing the one command that goes back. After running it, prod is
off-tag and `DEPLOYED.json` describes the tag rather than the running bytes.

Avoid `docker compose build web` on the shared prodbox: it is slow and has repeatedly
served a **stale, cached** build (a rebuild silently reused an old source COPY layer, so
the deployed bundle lacked the just-pushed fix). Never accept a green `curl` as proof a
deploy landed either. Both scripts compare SvelteKit's own build identity
(`client/_app/version.json`) between the artifact and what the public site serves, which
is the only check that actually distinguishes "deployed" from "still serving the old one".

## Running the whole thing locally (relay + node + web)

```bash
scripts/dev.sh            # relay + node daemon + web, HMR, both inspectors
scripts/dev.sh --stop     # ...including the dev Postgres
scripts/mac-desktop.sh --dev   # the same loop + a desktop window on the Mac, one command
```

Production parity on purpose: real Postgres, real Better Auth, real device-authorization
flow for the node. Ports are fixed because the GitHub OAuth callback is registered
against them (postgres 5435, relay 8790, web 5173, inspectors 9230/9231), and the script
preflights each one and names whatever is squatting it. Everything is on `localhost`
because `http://localhost` is a secure context per spec, so WebCrypto works with no
certificate and no Chromium flags; from the Mac the script opens the reverse forwards so
the same URLs resolve there. See CONTRIBUTING.md for the one-time OAuth App setup.

## Build order

Ship in milestone order — **v0** (validation spike) → **v1** (core cockpit) → **v2**
(trackers / git / editor / auth / connected accounts) → **v3** (voice / native / reach).
See SPEC §12 and the GitHub Project. Do not build later-milestone work before its
milestone.

## The GitHub Project is the source of truth

Current state and future roadmap live on **Project #4 "loombox roadmap"** (owner
`fiorelorenzo`), not in this file, not in SPEC, and not in a chat transcript.
SPEC says what loombox is, the board says where it stands. Keeping the board
current is part of doing the work, not paperwork at the end: it is how Lorenzo
sees state without reading session logs, so a board that lags reality is worse
than no board.

**Status is a claim about reality, keep it true.**

- Before you write code for an issue, move it to `In Progress`. If what you are
  about to do has no issue, create one first (see below), then start.
- Move it to `Done` only when the change is merged and verified (and for
  deploy-affecting work, verified on prod the way "Shipping to prod" describes),
  not when the code is written. Merged but something is still open? Say so in a
  comment and leave it `In Progress`.
- Board fields, the same four on every one of Lorenzo's roadmap boards on
  purpose: `Status` (`Todo` / `In Progress` / `Done`), `Priority` (P0-P3),
  `Effort` (S/M/L/XL) and `Parallel` (Yes/No, whether a parallel agent can take
  the issue without colliding with other work). Set all four on anything you
  file. Never write a value that is not already an option, read the schema
  instead of guessing, and never add, rename or drop a field on this board
  alone: the convention is shared across the projects.
- `Priority` and the `p0`/`p1`/`p2` labels say the same thing here: the field
  was backfilled from the labels, and the other repos keep both too, so set
  both when you file or re-triage an issue.

**Comment when a reader would want to know.** A decision taken, an approach
tried and abandoned, a blocker hit, a surprise in the code, a scope change, a
finding that invalidates the issue as written. One comment per meaningful turn
in the work, not one per commit, and no routine progress narration.

**File the work you discover.** When something real surfaces mid-task or in a
conversation with Lorenzo (a flake you tripped over, a follow-up the fix
implies, a UX gap you noticed), open an issue for it instead of silently
widening the current change or letting it evaporate. Then say in the current
issue that you split it out, with a link.

**Conventions for a new issue.** Match what the board already shows, do not
invent a parallel style:

- Title is a plain descriptive sentence naming the actual defect or change, e.g.
  `node-daemon-ssh.test.ts leaks real setsid-detached echo-acp-agent.mjs
  processes on every run`. Specific beats short.
- Labels are lowercase and unprefixed here: a kind (`bug`, `feat`, `chore`,
  `docs`, `spike`, `test`), a priority (`p0`, `p1`, `p2`) and the component(s)
  (`client`, `node`, `relay`, `crypto`, `protocol`, `providers`, `permissions`,
  `supervisor`, `transcript`, `terminal`, `editor`, `mcp`, `auth`, `trackers`,
  `ci`, `security`, `testing`, `observability`, `infra`, `cloud`, ...).
  `wave-N` is only for issues actually scheduled into a parallel-agent wave.
  `epic` goes on epics only.
- Milestone: one of the milestones still open (`v2`, `v3`, `far-future`) when
  the work belongs to a spec milestone, see Build order above. Post-v1 issues
  usually carry no milestone and are grouped by epic instead, so do not invent
  one to fill the field.
- **Every issue hangs off an epic.** Epics are titled `Epic: Name` (the older
  SPEC-derived ones, #8 to #39, predate that prefix) and carry the `epic` label.
  The post-v1 buckets are #558 client UX, #559 node daemon reliability, #560
  test-suite reliability, #561 deployment and container runtime, plus the
  feature epics #11 to #37 for spec work. If none of them fits, create a new
  epic (`Epic: Name`, `epic` label, one per coherent area) and parent the issue
  to it. An issue with no parent is a defect in the board.

```bash
# Read the schema, never guess an option value
gh project field-list 4 --owner fiorelorenzo --format json
gh label list -R fiorelorenzo/loombox --limit 100

# Ids you need to move a card (fetch once, reuse)
PROJECT_ID=$(gh project view 4 --owner fiorelorenzo --format json --jq '.id')
gh project field-list 4 --owner fiorelorenzo --format json \
  --jq '.fields[] | select(.name=="Status") | {id, options}'
ITEM_ID=$(gh project item-list 4 --owner fiorelorenzo --format json --limit 500 \
  --jq '.items[] | select(.content.number==<ISSUE>) | .id')

gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id <STATUS_FIELD_ID> --single-select-option-id <OPTION_ID>

# New issue: create, put it on the board, hang it off its epic
gh issue create -R fiorelorenzo/loombox --title "..." --body "..." \
  --label "bug,p1,node"
gh project item-add 4 --owner fiorelorenzo --url <ISSUE_URL>
gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){subIssue{number}}}' \
  -f p="$(gh issue view <EPIC> -R fiorelorenzo/loombox --json id --jq '.id')" \
  -f c="$(gh issue view <NEW>  -R fiorelorenzo/loombox --json id --jq '.id')"
```

`item-edit` is idempotent, so re-setting a value that is already correct is a
fine way to make sure the board is right. An issue can have only one parent: to
move it to a different epic, pass `replaceParent: true` in the same mutation.
