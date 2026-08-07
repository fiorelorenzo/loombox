# @loombox/desktop

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
