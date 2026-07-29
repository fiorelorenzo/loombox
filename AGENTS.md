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
# once: the dev server the app will load, bound to the tailnet so the Mac reaches it
#   (via hub/tmux, not a bare backgrounded shell — an orphaned `vite dev` holds the port for days)
pnpm --filter @loombox/web exec vite dev --host "$(tailscale ip -4 | head -1)"

scripts/mac-desktop.sh --debug     # launch + open CDP/inspector + forward both here
scripts/mac-desktop.sh --reload    # reload the app window, ~2s, no relaunch
PWA_URL=https://app.loombox.dev scripts/mac-desktop.sh --debug   # debug the prod bundle
```

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

Things that cost real time to find out, so do not re-derive them:

- **A fresh origin is a new device.** The dev server is a different origin from
  `app.loombox.dev`, so it has its own empty `localStorage`: no session, no AMK, and it
  lands on the sign-in screen. Onboard it once through SPEC §8's real "new device"
  recovery-code path and it persists; do not script copying the AMK across origins.
  The relay only accepts that origin because it is in `LOOMBOX_TRUSTED_ORIGINS` on
  prodbox (one env var drives both Better Auth's CSRF check and the CORS allowlist).
  A devbox tailnet-IP change means updating it there too.
- **`screencapture` over SSH does not work**, even with Screen Recording granted — it
  fails `could not create image from display`. Use a CDP screenshot (renderer only, no
  macOS permission needed, and deterministic). Accessibility *does* work, so window
  title/geometry is available:
  `ssh mac 'osascript -e "tell application \"System Events\" to tell (first process whose name contains \"Electron\") to get {name, position, size} of first window"'`
- **`launchctl setenv` cannot deliver env to the app.** `launchctl getenv` reads the
  value straight back, which makes it look like it worked, but a LaunchServices-started
  app on macOS 26 does not inherit it. That is why the URL override is the
  `--pwa-url=` argv flag (`open --args` does deliver). Do not "fix" it back to env.
- **A plain-http dev origin is not a secure context**, so `crypto.subtle` is missing
  and the app cannot generate or unwrap an AMK — every session stays unreadable.
  `--debug` therefore also passes
  `--unsafely-treat-insecure-origin-as-secure=<origin>` plus its required
  `--user-data-dir` (a dedicated `~/.loombox-desktop-debug` profile, so the dev
  origin's session persists and the normal profile is untouched). Verified with a real
  AES-GCM round trip in the window, not just a feature check.
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

## Deploying the web PWA fast (no Docker build)

```bash
scripts/deploy-web.sh    # build locally -> rsync build/ -> restart web on prodbox
```

The prod web container bind-mounts the host's `build/` dir (a prodbox-local
`deploy/web/docker-compose.live.yml` overlay), so a web deploy is just an adapter-node
build on the devbox plus rsync plus a container restart, in well under a minute. Avoid
`docker compose build web` on the shared prodbox: it is slow and has repeatedly served
a **stale, cached** build (a rebuild silently reused an old source COPY layer, so the
deployed bundle lacked the just-pushed fix). Verify a web deploy by fetching the served
chunk hash, not by trusting that the build ran.

## Build order

Ship in milestone order — **v0** (validation spike) → **v1** (core cockpit) → **v2**
(trackers / git / editor / auth / connected accounts) → **v3** (voice / native / reach).
See SPEC §12 and the GitHub Project. Do not build later-milestone work before its
milestone.
