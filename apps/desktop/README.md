# @loombox/desktop

The Mac desktop app shell (issue #403, epic #8): an Electron menubar app that

1. shows the loombox PWA in a `BrowserWindow` (loads `https://app.loombox.dev` by
   default, overridable for local dev — see below),
2. sits in the menubar with an optional launch-at-login setting, and
3. exposes a typed **native bridge** giving the sandboxed PWA the native powers it
   can't have on its own: SSH auto-provisioning of a remote node (driving
   `@loombox/node`'s `provision()`/`decommission()`, issue #400) and
   spawning/supervising a **local** node process on this Mac.

This is a scaffold: the shell, the IPC bridge contract, and the pieces of it that
`@loombox/node` already implements are wired up and tested. The rest — auto-detecting
SSH hosts, minting a node token (#398), handing off the account's AMK (#399), the
single in-app confirmation that's supposed to sit in front of all of it — is typed and
stubbed with `TODO`s pointing at the follow-up issues; see `src/shared/bridge.ts`'s
doc comments for exactly what's real today versus stubbed.

## Why this can only be built and run on a Mac

This package was scaffolded on a **headless Linux devbox with no display and no
Electron runtime** — `tsc`/`vitest`/`eslint` all run here and are part of this repo's
normal CI gate, but Electron itself was never launched to write this code, and can't
be launched here to verify it. Everything below (`pnpm dev`, `pnpm run package:mac`,
signing, notarization) needs to be run and verified on an actual Mac.

## Running it (on a Mac)

```bash
pnpm install                        # from the repo root
pnpm --filter @loombox/desktop dev  # launches `electron .`
```

Like every other package in this monorepo, `@loombox/desktop` ships as raw TypeScript
run through `tsx` rather than a compiled dist — `packages/node`'s own `"start": "tsx
src/main.ts"`, `packages/relay`'s Docker image literally running `tsx src/main.ts` in
production. `package.json#main` (`src/main/bootstrap.cjs`) and the preload script
(`src/preload/bootstrap.cjs`) are tiny plain-CommonJS shims that register tsx's
require hook (`require('tsx/cjs')`, tsx's own documented recipe) and then `require()`
the real `.ts` entry point, so Electron — which needs a file it can load directly, not
a `.ts` one — gets one.

**This exact mechanism is unverified**: this scaffold was written on a headless box
with no Electron runtime (see above), so nothing here has actually launched a real
`BrowserWindow`. The main-process half (`electron -r`-equivalent via the bootstrap
shim) is a well-established pattern; the preload half is the part most likely to need
adjustment — Electron's sandboxed preload loading is stricter than a plain `require()`
in some configurations. If `pnpm dev` fails to load the preload script on a first run,
the fallback is to precompile `src/main` + `src/preload` with `esbuild` (already a
transitive dependency of this monorepo's tooling, see `pnpm-workspace.yaml`'s
`onlyBuiltDependencies`) into real `.js`, and point `package.json#main` /
`window.ts`'s `preloadPath` at that instead — the `LoomboxBridgeApi` contract in
`src/shared/bridge.ts` doesn't change either way.

By default the window loads `https://app.loombox.dev` (the production PWA — see
`deploy/web/README.md`). To point it at a local `pnpm --filter @loombox/web dev`
server instead:

```bash
LOOMBOX_DESKTOP_PWA_URL=http://localhost:5173 pnpm --filter @loombox/desktop dev
```

## The native-module rebuild caveat

This package depends on `@loombox/node` (to drive `provision()`/`decommission()` —
see "The bridge" below), whose own dependency tree pulls in native (compiled) Node
addons:

- **`node-pty`** (via `@loombox/supervisor`) — real PTYs for interactive terminals.
- **`@napi-rs/keyring`** (via `@loombox/node` directly) — OS-native secrets storage
  (macOS Keychain).

Both are compiled against whatever Node ABI they were installed with (plain Node 22 on
this devbox). Electron bundles its **own** Node/V8 build with a different ABI, so
running this app for real needs those two addons rebuilt against Electron's ABI first
— `electron-rebuild` (the `@electron/rebuild` package) is the standard tool for this;
run it after `pnpm install` and before `pnpm dev`/`pnpm run package:mac` (not yet wired
into this package's scripts — add an `electron-rebuild` postinstall step or a `pnpm
rebuild:electron` script once this is verified working on a Mac).

(`ssh2`'s own optional native accelerators are disabled repo-wide —
`pnpm-workspace.yaml`'s `allowBuilds` skips `cpu-features`/`ssh2` builds on purpose —
so `ssh2` itself runs in its pure-JS fallback and needs no rebuild.
`better-sqlite3` is used by `@loombox/relay`/`@loombox/web`, not by `@loombox/node`, so
it isn't part of this package's dependency tree at all.)

## Building & distributing

```bash
pnpm --filter @loombox/desktop run package:mac   # electron-builder --mac
```

`electron-builder.yml` packages `src/**` + `node_modules/**` + `package.json` as-is
(no separate compile step — see "Running it" above for why) into a `.dmg` and a `.zip`
(universal) under `apps/desktop/release/`. `pnpm run build` / `pnpm run typecheck` are
both just `tsc --noEmit` (this repo's convention for TS-source-shipped packages — see
e.g. `packages/node`'s own `"build"` script), run before packaging to catch a type
error, not to produce output packaging depends on.

**Code signing and notarization need Lorenzo's Apple Developer ID certificate** —
electron-builder auto-discovers a keychain identity by default; set `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` (or an API-key equivalent) as env vars
before running `package:mac` to notarize. Without a certificate the build still
produces an unsigned app (fine for local testing, not for distribution — Gatekeeper
will refuse to open it on another Mac).

The bundle id is `com.loombox.desktop`. `assets/icon.png` and
`assets/tray-iconTemplate{,@2x}.png` are **placeholder art** (a simple crossing-bars
mark) generated for this scaffold — swap them for real branding before shipping.

## The bridge

`src/shared/bridge.ts` defines the typed contract both sides share:

- `listSshHostCandidates()` — **TODO stub.** `@loombox/node`'s
  `src/ssh/host-candidates.ts` (`discoverSshTargets`) already does this
  (autodetect from `~/.ssh/config` + ssh-agent), but isn't part of that package's
  public `index.ts` export surface yet — that's a one-line change to a different
  package, out of this scaffold's scope (issue #403 is `apps/desktop`-only).
- `provisionTarget(request)` — **really wired.** `src/main/provisioning/
provision-target-bridge.ts` calls `@loombox/node`'s real `provision()`
  (issue #400); see its tests for a real run against `@loombox/node`'s own
  `FakeTransport`. What's still missing is _what to call it with_: a signed
  supervisor-release artifact source + pinned public key (SPEC §16 — not built
  yet) and the resident node's relay/identity config, which the mint-token (#398)
  and AMK-handoff (#399) flows are meant to supply. Until then,
  `resolveProvisionTargetDeps()` always returns `undefined` and the bridge reports
  `notConfigured: true` rather than guessing.
- `spawnLocalNode()` / `stopLocalNode()` — the child-process supervision itself
  (`src/main/local-node/process-manager.ts`) is real and tested against a real
  child process. What command to actually launch (`@loombox/node`'s built CLI +
  its required env) is TODO for the same reason as above; set
  `LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND` as a local-dev-only escape hatch in the
  meantime.
- `status()` — aggregates app version, the launch-at-login setting, and the local
  node's current status.

## Architecture

```
src/
  shared/bridge.ts        # the IPC contract both processes share
  main/
    bootstrap.cjs          # package.json#main; registers tsx, then requires index.ts
    index.ts              # app entry: tray + window + IPC handlers (needs a real Electron runtime)
    window.ts              # the BrowserWindow that loads the PWA
    tray.ts                 # menubar/tray presence
    login-item.ts            # launch-at-login (app.setLoginItemSettings), testable via a fake `app`
    config.ts                 # resolvePwaUrl()
    status.ts                  # status() bridge method
    ssh-candidates.ts           # listSshHostCandidates() TODO stub
    local-node/
      process-manager.ts        # real child-process supervision
      bridge.ts                  # spawnLocalNode/stopLocalNode, wraps the manager
    provisioning/
      provision-target-bridge.ts # drives @loombox/node's real provision()
    ipc/
      handlers.ts                # registers every bridge channel on ipcMain
  preload/
    bootstrap.cjs            # webPreferences.preload target; registers tsx, then requires index.ts
    index.ts                  # contextBridge.exposeInMainWorld('loombox', ...)
```

Every file under `main/` other than `index.ts`, `window.ts`, and `tray.ts` (and
`preload/index.ts`) takes the Electron API surface it needs as an injectable
parameter (e.g. `login-item.ts`'s `LoginItemApp`, `ipc/handlers.ts`'s `IpcMainLike`)
instead of importing `electron` directly, so it's unit-testable on a machine with no
Electron runtime at all — which is exactly the constraint this scaffold was built
under. `pnpm --filter @loombox/desktop test` never launches Electron.
