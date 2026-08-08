# @loombox/desktop

## 0.3.1

### Patch Changes

- Updated dependencies [00ebc5d]
- Updated dependencies [e96daf9]
- Updated dependencies [58921ae]
- Updated dependencies [383d46f]
- Updated dependencies [ac3cc2f]
- Updated dependencies [7ac47be]
  - @loombox/node@0.10.0

## 0.3.0

### Minor Changes

- 03d047b: Side-by-side production/preview desktop installs (issue #866, epic #863)

  One `electron-builder.ts` config, parameterised by `LOOMBOX_DESKTOP_ENV` (`production`, the default, or `preview`), produces two distinct artifacts instead of a forked config that would drift.

  - `src/main/environment.ts` is the single table every value that has to differ lives in: `appId` (`com.loombox.desktop` vs `com.loombox.desktop.preview`), `productName` (`loombox` vs `loombox Preview` — dock, menu bar, window title, tray tooltip and menu items), the `userData` directory name (`loombox` vs `loombox-preview`, set explicitly via `app.setPath('userData', …)` rather than left to Electron's own productName-derived default, which doesn't vary in dev), the deep-link scheme (`loombox` vs `loombox-preview`, registered via `electron-builder.ts`'s `protocols` and `app.setAsDefaultProtocolClient`), and the default PWA origin (`app.loombox.dev` vs `preview.loombox.dev`).
  - `src/main/chrome-badge.ts` + `src/main/window.ts`: a preview-only ribbon stamped onto the loaded page from the main process on every real navigation, independent of the PWA's own content — the "obvious at a glance" marker beyond the title bar.
  - `electron-builder.ts` also sets `executableName` explicitly (electron-builder's own Linux default comes from `package.json`'s `name` field, not `productName`) and a per-environment `directories.output` (`release/production/` vs `release/preview/`) so packaging both from one checkout never has the second run's staging directory clobber the first's.
  - `apps/desktop/package.json` gains `dev:preview` and `package:{mac,linux,win}:preview` scripts, each just the existing script with `LOOMBOX_DESKTOP_ENV=preview` — every existing invocation is unchanged and still builds production.

  `preview.loombox.dev` does not resolve yet (#865 builds the preview web deployment); pointing a preview build's default at it now is still correct.

  Verified: `pnpm --filter @loombox/desktop exec vitest run` (12 files, 64 passed — `environment.test.ts` and `chrome-badge.test.ts` are new, `config.test.ts` gained preview-URL cases), `pnpm --filter @loombox/desktop typecheck` (0 errors, now also covering `electron-builder.ts`), `pnpm exec eslint` on every changed file (clean), full `pnpm format:check` (clean). A real `electron-builder --linux --dir` dry run ran for both `LOOMBOX_DESKTOP_ENV` values on this devbox: `electron-builder.ts` loads through electron-builder's own config loader (not just this package's test harness) and produced two independently populated trees, `release/production/linux-unpacked/loombox` and `release/preview/linux-unpacked/loombox-preview`.

  Not verified here, and cannot be from this headless Linux devbox: both `.app`s actually installed and launched side by side on a real Mac, each with its own Dock entry; signing into one and confirming the other's `localStorage`/AMK stays untouched; a `loombox://…` link opening production and a `loombox-preview://…` link opening preview. Needs `pnpm run package:mac` / `package:mac:preview` and `scripts/mac-desktop.sh` on the real Mac.

- f80dbe9: macOS-local resident node provisioning, and the supervisor-backend seam every platform fills in (issue #654, epic #653)

  Importing a local project on macOS with no node yet now installs, starts, pairs, and announces one — the desktop app's own "Set up a node on this Mac" control, no shell.

  - `packages/node/src/supervisor-backend.ts` is new: the platform seam every resident-node backend implements — `install`/`start`/`stop`/`status`/`uninstall`/`survivesReboot`, nothing above it spelling `unit`, `plist`, `systemctl`, or `launchctl`. Two implementations wired: `packages/node/src/launchd/launchd-supervisor-backend.ts` (macOS-local, wrapping the existing `launchd-provisioning.ts` plan/execute mechanism unchanged) and `packages/node/src/ssh/systemd-supervisor-backend.ts` (the `ssh:` path, wrapping the existing `systemd-provisioning.ts` unchanged). #658 (Linux local) and #659 (Windows local) each add one new file implementing this same interface.
  - `packages/node/src/local/provision-local-node.ts` is new: composes the shared zero-touch pairing primitives the `ssh:` reference (`provision-and-pair.ts`) already uses — `target_identity`, `mint_node_token`, `amk_handoff`, all reused unchanged — with a `SupervisorBackend.install()` call for THIS machine, dispatched through an injected backend so #658/#659 only ever add a backend, never touch this orchestration.
  - `packages/node/src/node-release.ts` is new: `createLocalFsNodeReleaseSource`, the A1-2 versioned-bundle (`~/.loombox/versions/<version>/` + `current` symlink) fetch side for a locally-staged release.
  - `apps/desktop/src/main/provisioning/provision-local-node-bridge.ts` + a new `provisionLocalNode` IPC channel (`apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc/handlers.ts`) wire the above for real: resolves the node-bundle version from `@loombox/node`'s own `package.json`, a real launchd `SupervisorBackend`, and a real local-filesystem `fetchArchive`.
  - `apps/web/src/lib/local-node-provision.ts` is new: the renderer-side trigger, reached only from inside the desktop shell on macOS. `apps/web/src/lib/components/AddProjectDialog.svelte`'s zero-target empty state offers "Set up a node on this Mac" there instead of the plain no-nodes message; `+page.svelte` supplies the callback using this device's own already-unlocked auth token and AMK (decision C1-2: a one-shot device token plus wrapped AMK, consumed and deleted on the node's first boot, no durable secret at rest). Everywhere else (a PWA tab, another platform, not yet signed in) the empty state is unchanged.
  - Decision D1-1 ("the desktop app is the only install surface, no CLI") holds: nothing here adds a `loombox-node` CLI or a headless-host install path.

  Verified: `pnpm --filter @loombox/node exec vitest run` (149 files, 1627 passed, 1 skipped), `pnpm --filter @loombox/node typecheck` (0 errors), `pnpm --filter @loombox/desktop exec vitest run` (10 files, 40 passed), `pnpm --filter @loombox/desktop typecheck` (0 errors), `pnpm --filter @loombox/web exec vitest run` (169 files, 2070 passed), `pnpm --filter @loombox/web typecheck` (0 errors), `pnpm exec eslint` on every changed file (clean), full `pnpm format:check` (clean).

  Not verified here, and cannot be from this machine (Linux devbox): the plist is asserted as a string in `launchd-supervisor-backend.test.ts`/`launchd-provisioning.test.ts`, never loaded by real `launchd`; `createLaunchdSupervisorBackend`'s `launchctl` calls only ever run against a fake `LaunchdIo` in tests; the full "import a project → node installed, running, paired, announced" path has not run end to end against a real filesystem/keychain/launchd. Needs `scripts/mac-desktop.sh` on the real Mac.

- 3ead9d7: Uninstall on the supervisor-backend seam (issue #814, epic #653; decision E1-3): `uninstallNode()` revokes a node's own device on the relay and tears down its local install through the platform's `SupervisorBackend`, removing the state dir and OS keyring entry by default (`keepData` is the explicit opt-out). `packages/node/src/ssh/decommission.ts` moves onto the same seam instead of hand-rolling its own systemctl/rm sequence, so the unit and its versioned bundle are now genuinely gone by default too. The desktop app's Nodes page gains a real Uninstall action on a local node's own row, behind a confirmation that names what is destroyed (session history and project secrets, unrecoverable from the relay) and a keep-data checkbox.
- 91491bc: Issue #657 (epic #653): the relay now declares and enforces a compatibility window, and the desktop shell updates itself.

  `@loombox/protocol` gains `compatibilityWindowV1` (a relay's declared oldest-served node/client build, both bounds independently optional) and `isBelowCompatWindow`, backed by `compareBuildVersions` — the one place in this package allowed to compare build versions by order rather than equality, unlike #655's `buildIdentityMismatch`. `@loombox/node`'s `ssh/target-update-monitor.ts` now re-exports `compareBuildVersions` as its own `compareVersions` instead of keeping a second copy of the identical algorithm.

  `@loombox/relay` reads the window from `LOOMBOX_MIN_NODE_VERSION`/`LOOMBOX_MIN_CLIENT_VERSION` (both unset by default — no behavior change for any relay running today) and refuses, via the existing `update_required` path #108 already uses for an incompatible protocol version, a peer whose `buildIdentity.version` is strictly below the floor for its role. A peer at or above the floor is unaffected — #655's own "Behind" badge is still what surfaces that gap, not a refusal. `/health` now echoes `build`/`compatWindow` when the relay is configured with either, so "is this deployment self-consistent" is answerable with one unauthenticated `curl`, no SSH — see `docs/deploy-relay.md`'s new "production update path" section and `scripts/check-relay-freshness.sh`.

  `@loombox/desktop` now updates itself via `electron-updater` against a GitHub Releases feed (`electron-builder.ts`'s new `publish` config, channel-split so production and preview builds can never cross-update). `autoDownload`/`autoInstallOnAppQuit` are forced off: the tray's "Check for Updates" only ever detects a newer build, and "Restart to Update" is the one explicit, user-consented click that downloads and installs (epic #653's "no auto-update without consent"). Unverified from this headless devbox — real launchd/Squirrel/AppImage update mechanics only exercise on a real install; see the desktop README's "Self-update" section for exactly what is and isn't proven.

### Patch Changes

- Updated dependencies [24c9e77]
- Updated dependencies [c301908]
- Updated dependencies [4f73638]
- Updated dependencies [304c608]
- Updated dependencies [c0491de]
- Updated dependencies [4284906]
- Updated dependencies [7542bb1]
- Updated dependencies [ac4167f]
- Updated dependencies [8ed4dd1]
- Updated dependencies [f80dbe9]
- Updated dependencies [5977937]
- Updated dependencies [3ead9d7]
- Updated dependencies [465de4f]
- Updated dependencies [2bc3501]
- Updated dependencies [98463e9]
- Updated dependencies [91491bc]
- Updated dependencies [b6fee51]
- Updated dependencies [b389ef8]
- Updated dependencies [4785b56]
- Updated dependencies [f57b4d5]
- Updated dependencies [7104b07]
- Updated dependencies [312b3a8]
- Updated dependencies [18f2885]
- Updated dependencies [079f922]
- Updated dependencies [7cb3efa]
- Updated dependencies [6e912f5]
  - @loombox/node@0.9.0

## 0.2.7

### Patch Changes

- 9a47212: Versioned JS bundle for the node runtime, and its install layout (SPEC §16; issue #817, decision A1-2)

  `pnpm bundle:node`/`pnpm bundle:supervisor` produce a self-contained esbuild bundle for each package (`node-pty`/`@napi-rs/keyring` external, their prebuilt binaries copied beside the bundle), and `pnpm package:node-release` packages both into the versioned release shape:

  - `scripts/lib/bundle-package.mjs` bundles `format: 'esm'`, `platform: 'node'`, with a `createRequire`/`__dirname`/`__filename` banner — without it, esbuild's own CJS-interop shim for a bundled CJS dependency's `require()` (`ssh2` calls `require('net')` and reads `__dirname` internally) throws `Dynamic require of "net" is not supported` the moment the bundle runs with no ambient `require`, which every copied-out standalone bundle has. `bakeBuildCommit: true` now actually works: `build-identity.ts`'s `readNodeBuildIdentity()` read `LOOMBOX_BUILD_COMMIT` through an aliased `env` variable, invisible to esbuild's `define`, so a baked bundle was silently falling through to a real (always-failing, no checkout present) `git rev-parse` at runtime; it now reads the literal `process.env.LOOMBOX_BUILD_COMMIT` expression `define` can actually replace. `readOwnVersion()` also now checks its own bundle directory for `package.json` before the dev-checkout's "one directory up", matching the bundle's flat layout.
  - New `packages/node/src/install-layout.ts`: resolve/stage/activate/rollback for `~/.loombox/versions/<version>/` + a `current` symlink, mirroring `scripts/deploy-prod.sh`'s proven `releases/<sha>` + `releases/current` shape (`ln -sfn`, no invented mechanism). Two drivers behind one interface — `createLocalInstallLayoutDriver()` (real `node:fs`, for a machine installing its own node) and `createRemoteInstallLayoutDriver()` (a `RemoteTransport`, ready for the ssh path), both exercised in `install-layout.test.ts` including a real second-version-beside-the-first flip-and-rollback.
  - New `packages/node/src/ssh/local-fs-artifact-source.ts`: a real, working `SupervisorArtifactSource` backed by a local directory tree — a GitHub Releases fetch is a follow-up (out of reach from this pass), so this is what actually satisfies the interface today, not a stub. `apps/desktop`'s `provision-target-bridge.ts` now wires a real `resolveSupervisorArtifactDeps()` (pinned Ed25519 public key + this source + `@loombox/supervisor`'s own version); `resolveProvisionTargetDeps()` still returns `undefined` — honestly, not the artifact half's fault — because the resident-node relay/identity config it also needs has no source until #398/#399 land.
  - `scripts/package-node-release.mjs` + `.github/workflows/release-node.yml`: packages both artifacts on every `vX.Y.Z` tag (linux-x64 + darwin-arm64, the two `RemoteOsArch` values this codebase recognizes), signing the supervisor artifact with `SUPERVISOR_SIGNING_KEY` when set (`scripts/generate-supervisor-signing-key.mjs` generates the keypair).

  Verified: copied `packages/node/dist/` to a directory with no monorepo and no other `node_modules`, ran it with a stripped `PATH`-only env — `node node.mjs --version` prints `{"version":"0.7.0","commit":"<real HEAD sha>"}` with no `.git` anywhere reachable and no `LOOMBOX_BUILD_COMMIT` set at runtime; a plain `node node.mjs` loads the entire module graph (ssh2, node-pty, keyring) and fails only on missing `LOOMBOX_RELAY_URL`/etc, never a module-resolution error. `pnpm --filter @loombox/node exec vitest run` (115 files, 1260 passed), `pnpm --filter @loombox/desktop exec vitest run` (9 files, 36 passed), the new `scripts` vitest project (`pnpm exec vitest run --config scripts/vitest.config.ts`, real end-to-end bundle build + standalone run), `pnpm --filter @loombox/node typecheck`, `pnpm --filter @loombox/desktop typecheck`, `pnpm exec eslint` on every touched file, full `pnpm format:check`.

- Updated dependencies [7b8e591]
- Updated dependencies [edb3752]
- Updated dependencies [d2741e2]
- Updated dependencies [4e090fc]
- Updated dependencies [e42b8d1]
- Updated dependencies [8948531]
- Updated dependencies [3dcb133]
- Updated dependencies [93c1ffd]
- Updated dependencies [c8a9381]
- Updated dependencies [12cc8ec]
- Updated dependencies [9a47212]
- Updated dependencies [ac5b075]
- Updated dependencies [9400cb4]
- Updated dependencies [05f8339]
- Updated dependencies [eb16820]
- Updated dependencies [e087fb9]
- Updated dependencies [ed2392d]
  - @loombox/node@0.8.0

## 0.2.6

### Patch Changes

- Updated dependencies [584520e]
- Updated dependencies [a0fb0a6]
- Updated dependencies [0c46b48]
- Updated dependencies [8a3fcda]
- Updated dependencies [97598db]
- Updated dependencies [ff1fb1e]
- Updated dependencies [7ad7274]
- Updated dependencies [79f55e0]
- Updated dependencies [6d3ad95]
- Updated dependencies [6325366]
- Updated dependencies [900bc5c]
- Updated dependencies [d03fc5d]
- Updated dependencies [166551b]
- Updated dependencies [757fa0e]
- Updated dependencies [dace883]
- Updated dependencies [89355b1]
- Updated dependencies [109184d]
- Updated dependencies [4291dc3]
  - @loombox/node@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies [6f90259]
- Updated dependencies [e6c44d0]
- Updated dependencies [9b5f66a]
- Updated dependencies [6f5dbe0]
  - @loombox/node@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [35f3924]
  - @loombox/node@0.5.1

## 0.2.3

### Patch Changes

- Updated dependencies [51ef3ac]
- Updated dependencies [a1038bf]
- Updated dependencies [cce97a8]
  - @loombox/node@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/node@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [535a2ee]
- Updated dependencies [e89b263]
- Updated dependencies [a006a1e]
- Updated dependencies [a3c21b7]
- Updated dependencies [2592c10]
- Updated dependencies [99e3583]
- Updated dependencies [7fc92d2]
- Updated dependencies [344b4c7]
- Updated dependencies [934301d]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
  - @loombox/node@0.3.0

## 0.2.0

### Minor Changes

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

### Patch Changes

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

- Updated dependencies [c907512]
- Updated dependencies [ac64679]
- Updated dependencies [aad37f8]
- Updated dependencies [804933f]
- Updated dependencies [fa0dbd1]
- Updated dependencies [a449b22]
  - @loombox/node@0.2.0

## 0.1.0

### Minor Changes

- 9eff82e: Make the desktop shell's dev-server override actually work, and unbreak `vite dev`. `resolvePwaUrl` now accepts a `--pwa-url=<url>` argv flag (which `open --args` delivers) instead of relying only on `LOOMBOX_DESKTOP_PWA_URL`, which a LaunchServices-started app on macOS 26 never inherits from `launchctl setenv` — so `scripts/mac-desktop.sh`'s documented `PWA_URL=` override silently loaded production. Separately, `@xterm/xterm` is now SSR-bundled: as an external CommonJS dep its named `Terminal` import made `vite dev` 500 on every page.

### Patch Changes

- Updated dependencies [c0d6291]
- Updated dependencies [4f7dcd4]
- Updated dependencies [c86aa72]
- Updated dependencies [10df3db]
- Updated dependencies [8f305d0]
- Updated dependencies [3705e0b]
- Updated dependencies [fcb76fc]
  - @loombox/node@0.1.0
