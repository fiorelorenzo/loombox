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

One category this scoping advice does not cover: a changeset written last,
after `pnpm format:check` already ran clean, reaches CI unformatted (three
PRs did exactly this — issue #723). `pnpm install` installs a git hook
(`.githooks/pre-commit`, wired via the repo's `prepare` script) that
reformats a staged `.changeset/*.md` file with Prettier and re-stages it, so
there's nothing to remember here either; see CONTRIBUTING.md's changeset
section for the mechanics and the `--no-verify` bypass.

## Working in a worktree, next to other agents

**`pnpm test` needs no services and isolates nothing, because there is nothing to
isolate.** Every suite here is hermetic: a relay under test binds `port: 0`
(`fanout.test.ts`, every `node-daemon-*.test.ts`), and Postgres itself is stood in
for by `pg-mem`/`ioredis-mock` rather than a real container (`migrate.ts`'s own
doc comment explains why `CREATE TABLE _migrations` checks
`information_schema.tables` instead of `IF NOT EXISTS` — `pg-mem` doesn't support
the combo). No `vitest.config.ts` in the repo, root or per-package, overrides
`fileParallelism`, so `pnpm test` already runs files in parallel within one
worktree, and two worktrees running it at the same time do not collide, because
neither touches anything outside its own process. The exception is a couple of
tests gated behind `LOOMBOX_TEST_PG_URL` (`store-postgres.test.ts`,
`backup-restore.integration.test.ts`) that opt into a real Postgres you start and
point at yourself — skipped by default, not part of `pnpm test` or CI, so ignore
them unless you're touching backup/restore.

**`scripts/dev.sh` is a singleton, not one per worktree.** Its Postgres
(`deploy/dev/docker-compose.yml`) runs under the fixed compose project
`loombox-dev` on `127.0.0.1:5435`, and the ports it starts as host processes —
relay 8790, web 5173, inspectors 9230/9231 — are hardcoded constants in
`scripts/dev.sh`, not env-configurable (the GitHub OAuth callback is registered
against `5173`/`8790` specifically, see "Running the whole thing locally" below).
Two worktrees running `scripts/dev.sh` at once fight over the same container,
volume and ports: the script's own preflight reports the squatter by name instead
of picking a new one, so the second run just fails loudly. Treat the dev loop as
one shared resource across every worktree on this box — coordinate who has it up,
rather than expecting a second copy to work.

**No submodule, no private dependency.** Every `@loombox/*` package is
`workspace:*` (`package.json`), there is no `.gitmodules`, and the marketing site
is a genuinely separate repo (`loombox-landing`) this one never checks out. A
fresh worktree runs `pnpm install` and is ready.

**Two of CI's jobs can't be reproduced on this box.** `desktop`
(`.github/workflows/ci.yml`) matrices across `macos-latest`/`windows-latest`/
`ubuntu-latest`; this devbox is Linux, so only the Ubuntu leg is checkable here —
a change under `apps/desktop` still needs the real CI run (or
`scripts/mac-desktop.sh`, see below) before you can say the other two pass.
`release-node.yml`/`release-desktop.yml` sign with `secrets.SUPERVISOR_SIGNING_KEY`
and platform certificates this box doesn't have either.

**Migrations are hand-rolled, so landing two in one wave is a normal merge
conflict, not a journal trap.** `packages/relay/src/migrations.ts` is a plain
TypeScript array with no `generate` command and no meta/journal file beside it
(contrast the drizzle-generated migrations in pitchbox or canonry): two agents
each appending the next `NNNN_` entry produce an ordinary two-sided git conflict
at the same array position, resolved by keeping both blocks and renumbering the
second — not the unmergeable auto-generated-file collision a `drizzle-kit
generate` journal produces.

**Merging deploys, and nothing deletes your branch for you.** A push to `main`
triggers `deploy-preview.yml` immediately, with no CI gate
(`deploy-preview.yml`'s own comment explains the choice) — a PR that merges red
still reaches preview within minutes. There is no branch protection (`gh api
repos/fiorelorenzo/loombox/branches/main/protection` returns 404, and
`repos/fiorelorenzo/loombox/rulesets` is empty) and `delete_branch_on_merge` is
off, so a merged branch stays on `origin` until you delete it yourself (`git push
-d origin <branch>`).

## Checking the PWA here, headless (the Mac is only for Electron)

Most UX/UI work needs no Mac at all. This box has **Chrome 149 and Playwright's own
chromium installed** (what it lacks is a GUI, not a browser), and `http://localhost`
is a secure context, so `crypto.subtle` exists and the app's E2E crypto works
headless with no TLS cert and no Chromium flags. Verified on the real app: a headless
tab reaches a fully decrypted cockpit, and clicks, typed keystrokes and ARIA
snapshots all go through the app's own handlers.

Two routes, pick by what you are checking.

**Specs, screenshots, regressions → `tests-e2e`.** Each spec stands up its own
throwaway relay, account and fake encrypted node, so it needs no dev loop, no OAuth
and no AMK juggling:

```bash
pnpm --filter @loombox/web exec playwright test tests-e2e/pwa-shell.spec.ts
```

It really does run here (measured: 4/4 in 20s). Do not run it while `scripts/dev.sh`
is up — it builds, and they share `.svelte-kit/`.

**Iterating by hand against the real loop → seed a headless tab.** Two commands, and
the second one is the whole point of `scripts/dev-browser-seed.mjs`: a fresh browser
profile is a new device with no session (login is GitHub OAuth, unclickable headless)
and no AMK, so it resolves both — the bearer token the app keeps in `localStorage`
(reusing a live Better Auth session or minting one) and the account AMK, recovered
from `LOOMBOX_RECOVERY_CODE` through the relay escrow with `@loombox/node`'s own
bootstrap, the same crypto path the app's new-device flow drives.

```bash
scripts/dev.sh --no-mac          # relay + node + web on localhost
pnpm dev:browser-seed            # -> ~/.loombox/dev-browser-seed.json (0600)
pnpm dev:browser-seed --force-new-session   # ignore a live session, mint a fresh one
```

Then, in the `browser` tool (`{"action":"open","url":"http://localhost:5173"}` first):

```js
const seed = JSON.parse(require('node:fs').readFileSync('/home/dev/.loombox/dev-browser-seed.json', 'utf8'));
await tab.evaluate((s) => {
  localStorage.setItem('loombox:auth-session', JSON.stringify({ token: s.token, accountId: s.accountId }));
  localStorage.setItem('loombox:relay-url', s.relayUrl);
  localStorage.setItem(`loombox:amk:${s.accountId}`, s.amkBase64);
}, seed);
await tab.goto(seed.webUrl);
```

The seed file is read inside the tool's own code on purpose: the token and the AMK
never pass through the transcript. For the same reason, **never hand-type the Recovery
Code into the app in an agent session** — the ARIA snapshot of that input reports its
`value`, so the code ends up in the log.

What the script deliberately does not do is create the account: only a real GitHub
OAuth sign-in does that. So right after `scripts/dev.sh --fresh` you need one sign-in
from a browser someone can click (the desktop app on the Mac), and every headless run
after that reuses the account.

What still genuinely needs the Mac: the Electron shell itself (main/preload, window,
menus, deep links, notifications, auto-update) and judging macOS type rendering or
real trackpad/retina feel. Everything else — layout, flows, dark/light, mobile
viewports, live agent turns against the dev node — is drivable from here.

Two habits worth keeping from the Mac notes, since they apply identically: `tab.fill`
times out on this app's textarea (use `tab.click(selector)` then
`page.keyboard.type(...)`), and assert on state the app derives (an enabled submit
button, a filtered list) so a pass means the app reacted rather than that you mutated
its DOM. And stop short of anything with real side effects: creating a session really
does spawn an agent on the node.

## Design and UI

No Tailwind here: components read every value through a CSS custom property, so a hardcoded number in a component's `<style>` is the violation to flag. The structural token layer (spacing, radius, shadow, z-index, motion, focus-ring geometry, breakpoints) is `apps/web/src/lib/styles/tokens.css`; the color palette (backgrounds, surfaces, borders, text, the accent "thread", status colors) is deliberately split out into `apps/web/src/lib/styles/deck.css` - retuning scale is one file, retuning palette is the other.

`apps/web/src/routes/style-reference` is already the `/design` gallery: colors, spacing, radius, icon sizes, dialog geometry, elevation, motion and every UI primitive rendered together on one page. Point `uishot` there (via the headless routes above) when reviewing the design system as a whole, not at a random app screen.

Dark mode is real and is the default: `:root` ships dark (`color-scheme: dark`), and `prefers-color-scheme: light` plus an explicit, persisted `[data-theme="light"]` (`theme.ts`) both flip it - so a light/dark `uishot` pair should genuinely differ. For the dev command, port and how to reach a rendered page headless (no Mac, no OAuth needed for `tests-e2e` specs), see "Checking the PWA here, headless" above (`scripts/dev.sh` → web on `5173`); that's also where `/style-reference` and any other route are reachable from.

**Claude Design is where a new design question gets drawn; the repo is where its answer lives.** Claude Design is a Beta / research preview product on Lorenzo's Max plan — a project's menu is Rename, Duplicate, Delete only, no version history, no restore, no diff — so a canvas is never the source of truth, only a drawing. Two project kinds, named consistently:

- **`loombox design system`** — one durable project for the whole design language (tokens, primitives, motion). Hand-maintained, long-lived.
- **`loombox · <surface>`** — one disposable project per surface (e.g. `loombox · drawer`, `loombox · onboarding`). Never hand-maintained: when it goes stale, regenerate it from the repo with "Start from code," don't patch the canvas.

**Where an answer lives:** in `docs/design/DECISIONS.md`, one row per decision, in the format `| ID | Round | Question | Answer | Rule it creates |`. `Rule it creates` is usually empty; it's filled only when the decision produced something a component can violate (e.g. "a raw hex in a component is a violated rule" once that's the rule). A row with a rule binds an implementer; a row without one is context. An agent implementing with omp must never need to open Claude Design to know what was decided — read that table.

**Implementation starts from the export archive's `github.md` screen map plus the decision row, never from the export's CSS.** "Project archive" export is a zip with the canvas, assets, and a `github.md` mapping each artboard to the repo files behind it — use that map to find what to touch. The export's CSS is raw hex literals with zero `var(--token)`, even when every color used is one of the repo's own tokens: the values transfer, the token layer does not, so nothing gets implemented by pasting an export's CSS. Route it back through `tokens.css`/`deck.css`.

**When not to open a Claude Design project at all:** a fix inside an existing surface whose structure stays the same (spacing, a wrong token, a broken breakpoint, a missing state, copy) goes straight to implementation and a render — no canvas needed. Anything that's a rule rather than a picture goes straight into `DECISIONS.md`. Nothing client-confidential ever goes on a canvas: it's one personal account inside an organization named after a client's address, and sharing is organization-scoped.

**The render gate does not move.** `uishot` (with `--axe --fail-on serious`) and `uislop` still gate implementation — the canvas is not the product. See the `ui-brief-first` / `ui-design-tokens` / `ui-visual-review` skills for the pipeline itself.


## Testing the desktop app on the Mac (from the devbox)

The Electron desktop app (`apps/desktop`) can only render on the Mac (the devbox has
Chrome but no GUI), so this is the route for Electron-specific work — see the section
above for everything else. Do not ask the human to run anything by hand: launch it
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
- Labels follow one taxonomy, identical in every repo: exactly one `type:*`
  (`feature`, `fix`, `refactor`, `test`, `chore`, `ci`, `docs`, `design`,
  `security`, `spike`), exactly one of `priority:P0`-`priority:P3`, and one or
  more `area:*` naming the surfaces the change touches. `epic` and `flagship`
  (an epic, and headline work) are the only unprefixed labels. Priority is
  deliberately in two places, the `Priority` board field and the `priority:*`
  label, so set both.
- `area:*` values here: `accounts`, `attachments`, `auth`, `client`, `cloud`,
  `crypto`, `editor`, `git`, `inbox`, `infra`, `landing`, `mcp`, `node`,
  `notifications`, `observability`, `permissions`, `persistence`, `protocol`,
  `providers`, `provisioning`, `relay`, `resources`, `supervisor`, `terminal`,
  `tests`, `trackers`, `transcript`, `voice`. Add one only when the surface
  really is new, and never reintroduce an unprefixed or differently shaped
  label.
- `redesign`, `redesign-v2` and `wave-1`-`wave-7` are process markers (a
  workstream, and the parallel-agent batches), not taxonomy. Leave them off a
  new issue unless you are actually scheduling a wave.
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

# Fill these three in; everything below runs as written, no placeholders to edit
ISSUE=123                 # the issue you are working on
EPIC=456                  # its parent epic
STATUS="In Progress"      # Todo | In Progress | Done

PROJECT_ID=$(gh project view 4 --owner fiorelorenzo --format json --jq '.id')
STATUS_FIELD=$(gh project field-list 4 --owner fiorelorenzo --format json \
  --jq '.fields[] | select(.name=="Status") | .id')
OPTION_ID=$(gh project field-list 4 --owner fiorelorenzo --format json \
  --jq ".fields[] | select(.name==\"Status\") | .options[] | select(.name==\"$STATUS\") | .id")
ITEM_ID=$(gh project item-list 4 --owner fiorelorenzo --format json --limit 500 \
  --jq ".items[] | select(.content.number==$ISSUE) | .id")
gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id "$STATUS_FIELD" --single-select-option-id "$OPTION_ID"

# New issue: create, put it on the board, hang it off its epic.
# `gh issue create` prints the new issue's URL, so capture it and reuse it.
ISSUE_URL=$(gh issue create -R fiorelorenzo/loombox --title "..." --body "..." \
  --label "type:fix,priority:P1,area:node")
gh project item-add 4 --owner fiorelorenzo --url "$ISSUE_URL"
gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){subIssue{number}}}' \
  -f p="$(gh issue view $EPIC -R fiorelorenzo/loombox --json id --jq '.id')" \
  -f c="$(gh issue view "$ISSUE_URL" --json id --jq '.id')"
```

`item-edit` is idempotent, so re-setting a value that is already correct is a
fine way to make sure the board is right. An issue can have only one parent: to
move it to a different epic, pass `replaceParent: true` in the same mutation.
